import {
  FILE_CHUNK_SIZE,
  FILE_BUFFER_HIGH,
  FILE_BUFFER_LOW,
  type FileControl,
} from '../../../shared/protocol';

/**
 * Transferência de arquivos sobre o DataChannel da sessão.
 *
 * Uma transferência ativa por sentido: assim os blocos binários que chegam
 * pertencem sempre ao arquivo anunciado por último, e não precisamos gastar
 * cabeçalho em cada bloco de 16 KB. O resto fica na fila.
 *
 * O controle de fluxo é a parte que não pode falhar: sem observar o
 * `bufferedAmount`, empurrar um arquivo grande de uma vez estoura a memória do
 * Chromium e derruba a sessão inteira, tela junto.
 *
 * NÃO HÁ LIMITE DE TAMANHO. O que existia (500 MB) era arbitrário — os bytes
 * nunca passam inteiros pela memória, então nada na arquitetura precisava
 * dele. Quem protege o disco de quem recebe é `transfers.ts`, conferindo
 * espaço livre de verdade e cortando o remetente que passar do que anunciou.
 */

export type Direction = 'enviando' | 'recebendo';
export type TransferState = 'aguardando' | 'ativo' | 'concluido' | 'recusado' | 'cancelado' | 'erro';

export type TransferView = {
  id: string;
  name: string;
  size: number;
  direction: Direction;
  transferred: number;
  state: TransferState;
  message?: string;
  /** Caminho em disco, preenchido ao concluir. */
  path?: string;
  /** Bytes por segundo, média móvel. */
  rate: number;
};

/** Origem dos bytes de um envio — arquivo solto na janela ou escolhido em disco. */
export interface ChunkSource {
  name: string;
  size: number;
  /**
   * Caminho deste arquivo DENTRO da pasta que está sendo enviada.
   *
   * `Fotos/2026/praia.jpg`. Só existe quando a origem é uma pasta; é o que faz
   * a árvore chegar montada do outro lado em vez de virar um monte de arquivos
   * soltos na pasta de downloads.
   */
  relPath?: string;
  /** Sempre respaldado por um ArrayBuffer comum — é o que o DataChannel aceita. */
  read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>;
  close(): Promise<void>;
}

/** Arquivo arrastado para a janela ou colado: os bytes já estão no renderer. */
export function sourceFromFile(file: File): ChunkSource {
  return {
    name: file.name,
    size: file.size,
    async read(offset, length) {
      const slice = file.slice(offset, offset + length);
      return new Uint8Array(await slice.arrayBuffer());
    },
    async close() {},
  };
}

/** Arquivo escolhido no diálogo ou copiado no Explorador: mora em disco. */
export function sourceFromDisk(handle: { id: string; name: string; size: number; relPath?: string }): ChunkSource {
  return {
    name: handle.name,
    size: handle.size,
    relPath: handle.relPath,
    read: (offset, length) => window.ryke.files.read(handle.id, offset, length),
    close: () => window.ryke.files.closeSend(handle.id),
  };
}

export type ClipboardBatch = { id: string; index: number; total: number };
type Outgoing = { view: TransferView; source: ChunkSource; clipboard: ClipboardBatch | null };
type Incoming = { view: TransferView; clipboard: ClipboardBatch | null; legadoClipboard: boolean };

export class FileEngine {
  private channel: RTCDataChannel;
  private notify: () => void;

  /**
   * AQUI MORAVA O DEFEITO QUE DERRUBAVA A SESSÃO.
   *
   * Cada bloco recebido ou enviado chamava `notify()`, e `notify` redesenha a
   * árvore React inteira. Num arquivo de 50 GB isso são MILHÕES de renders —
   * o laço de eventos do renderer não faz mais nada, o pulso da sessão para de
   * ser respondido, a vigilância conclui (corretamente!) que a sessão morreu,
   * e no meio disso o processo pode simplesmente ficar sem memória e morrer.
   * Quando o renderer morre, o computador some da malha: era por isso que,
   * depois da queda, ninguém mais respondia naquele número.
   *
   * O progresso agora é agrupado. Quatro atualizações por segundo é mais do
   * que o olho aproveita numa barra de progresso, e é a diferença entre
   * redesenhar 4 vezes por segundo e 300 mil.
   */
  private progressoAgendado = false;
  private static readonly PROGRESSO_MS = 250;

  /**
   * Progresso: pode esperar, pode ser agrupado, pode ser descartado.
   *
   * Usado só para "andou mais um bloco". Mudança de ESTADO — começou,
   * terminou, falhou — continua avisando na hora, por `notify()` direto: essas
   * são poucas, e atrasá-las deixaria a tela mentindo sobre o que está
   * acontecendo.
   */
  private notificarProgresso(): void {
    if (this.progressoAgendado) return;
    this.progressoAgendado = true;
    window.setTimeout(() => {
      this.progressoAgendado = false;
      if (!this.closed) this.notify();
    }, FileEngine.PROGRESSO_MS);
  }

  private queue: Outgoing[] = [];
  private active: Outgoing | null = null;
  private incoming: Incoming | null = null;
  private closed = false;
  /**
   * Ids cancelados enquanto o envio já estava em curso.
   *
   * Um conjunto à parte, e não uma leitura de `view.state`: o laço de envio é
   * assíncrono e quem cancela é outro trecho de código: se olhássemos o campo
   * que o próprio laço acabou de escrever, o cancelamento passaria batido.
   */
  private cancelled = new Set<string>();
  /** Conclusão observável, usada para só mandar o Ctrl+V depois do arquivo pronto. */
  private conclusoes = new Map<string, (ok: boolean) => void>();
  /** Caminhos recebidos de uma mesma seleção, publicados juntos no CF_HDROP. */
  private lotesClipboard = new Map<string, { paths: string[]; total: number }>();

  /** Histórico exibido na interface, do mais recente para o mais antigo. */
  readonly views: TransferView[] = [];

  constructor(channel: RTCDataChannel, notify: () => void) {
    this.channel = channel;
    this.notify = notify;
    this.channel.binaryType = 'arraybuffer';
    this.channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW;
  }

  /**
   * Controle e bytes trafegam pelo MESMO canal, de propósito.
   *
   * Cada DataChannel é um fluxo SCTP independente: a ordem só é garantida
   * dentro de um deles. Mandando o "terminei" por um canal e os blocos por
   * outro, o aviso ultrapassa o último bloco e o arquivo chega truncado —
   * exatamente um bloco a menos. Aqui o `file-done` é sempre a última coisa
   * na mesma fila, depois de todos os bytes.
   */
  private sendControl(msg: FileControl): void {
    if (this.channel.readyState === 'open') this.channel.send(JSON.stringify(msg));
  }

  /**
   * Porta de entrada única do canal de arquivos.
   *
   * Cada mensagem é tratada de forma assíncrona (gravar em disco é uma ida ao
   * processo principal), e o evento `onmessage` não espera por isso. Sem esta
   * fila, o tratamento do "terminei" começaria enquanto a gravação do último
   * bloco ainda estivesse em voo — e o arquivo seria fechado faltando
   * exatamente um bloco. Encadear tudo numa promessa só garante que o
   * processamento respeite a mesma ordem da chegada.
   */
  private fila: Promise<void> = Promise.resolve();

  accept(data: ArrayBuffer | string): void {
    this.fila = this.fila.then(async () => {
      if (typeof data === 'string') {
        let msg: FileControl;
        try {
          msg = JSON.parse(data) as FileControl;
        } catch {
          return; // mensagem malformada do outro lado: ignorar
        }
        await this.handleControl(msg);
      } else {
        await this.handleBinary(data);
      }
    }).catch((err) => {
      console.error('[arquivos] falha ao processar mensagem:', err);
    });
  }

  // ─────────────────────────── envio ────────────────────────────

  /**
   * Põe um arquivo na fila de envio. Sem teto de tamanho — ver o topo deste
   * arquivo e `transfers.ts` para o que protege o disco de quem recebe.
   */
  async enqueue(source: ChunkSource, clipboard: ClipboardBatch | null = null): Promise<boolean> {
    const view: TransferView = {
      id: crypto.randomUUID(),
      // Numa pasta, o caminho relativo é o nome útil: cinco arquivos chamados
      // "capa.jpg" em cinco subpastas seriam cinco linhas idênticas na tela.
      name: source.relPath ?? source.name,
      size: source.size,
      direction: 'enviando',
      transferred: 0,
      state: 'aguardando',
      rate: 0,
    };
    this.push(view);
    this.queue.push({ view, source, clipboard });
    this.pumpQueue();
    return new Promise<boolean>((resolve) => this.conclusoes.set(view.id, resolve));
  }

  private concluir(id: string, ok: boolean): void {
    this.conclusoes.get(id)?.(ok);
    this.conclusoes.delete(id);
  }

  private pumpQueue(): void {
    if (this.active || this.closed) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    this.sendControl({
      t: 'file-offer',
      id: next.view.id,
      name: next.source.name,
      size: next.source.size,
      relPath: next.source.relPath,
      fromClipboard: next.clipboard !== null,
      clipboardBatch: next.clipboard?.id,
      clipboardIndex: next.clipboard?.index,
      clipboardTotal: next.clipboard?.total,
    });
  }

  private async transmit(entry: Outgoing): Promise<void> {
    const { view, source } = entry;
    view.state = 'ativo';
    this.notify();
    this.sendControl({ t: 'file-start', id: view.id });

    const startedAt = performance.now();
    let offset = 0;

    try {
      while (offset < source.size) {
        if (this.closed || this.cancelled.has(view.id)) throw new Error('cancelado');

        // Espera o buffer drenar antes de enfileirar mais. É isto que
        // permite mandar 500 MB sem estourar a memória do processo.
        if (this.channel.bufferedAmount > FILE_BUFFER_HIGH) {
          await this.waitForDrain();
          continue;
        }

        const chunk = await source.read(offset, FILE_CHUNK_SIZE);
        if (chunk.length === 0) break;
        this.channel.send(chunk);
        offset += chunk.length;

        view.transferred = offset;
        const elapsed = (performance.now() - startedAt) / 1000;
        view.rate = elapsed > 0.2 ? offset / elapsed : 0;
        this.notificarProgresso();
      }

      this.sendControl({ t: 'file-done', id: view.id });
      // O estado final só vira "concluído" quando o outro lado confirmar que
      // gravou o arquivo (file-saved) — antes disso não há garantia nenhuma.
      view.state = 'ativo';
      view.message = 'Finalizando…';
    } catch (err) {
      if (this.cancelled.has(view.id)) {
        view.state = 'cancelado';
        view.message = 'Cancelado';
      } else {
        view.state = 'erro';
        view.message = err instanceof Error ? err.message : String(err);
      }
      this.sendControl({ t: 'file-abort', id: view.id, reason: view.message ?? 'erro' });
      this.concluir(view.id, false);
    } finally {
      await source.close();
      this.notify();
      this.active = null;
      this.pumpQueue();
    }
  }

  private waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.channel.removeEventListener('bufferedamountlow', done);
        resolve();
      };
      this.channel.addEventListener('bufferedamountlow', done);
      // Rede muito lenta pode demorar; o tempo limite evita travar para sempre
      // caso o evento se perca.
      setTimeout(done, 5000);
    });
  }

  // ───────────────────────── recebimento ────────────────────────

  /** Mensagens JSON de controle vindas do outro lado. */
  async handleControl(msg: FileControl): Promise<void> {
    switch (msg.t) {
      case 'file-offer':
        return this.onOffer(msg);

      case 'file-accept': {
        if (this.active?.view.id === msg.id) void this.transmit(this.active);
        return;
      }

      case 'file-reject': {
        if (this.active?.view.id === msg.id) {
          this.active.view.state = 'recusado';
          this.active.view.message = msg.reason;
          await this.active.source.close();
          this.active = null;
          this.concluir(msg.id, false);
          this.notify();
          this.pumpQueue();
        }
        return;
      }

      case 'file-start':
        return; // o próximo binário já é deste arquivo

      case 'file-done':
        return this.onDone(msg.id);

      case 'file-saved': {
        const view = this.views.find((v) => v.id === msg.id);
        if (view) {
          view.state = 'concluido';
          view.message = undefined;
          view.transferred = view.size;
          view.path = msg.path;
          this.notify();
        }
        this.concluir(msg.id, true);
        return;
      }

      case 'file-abort': {
        if (this.incoming?.view.id === msg.id) {
          await window.ryke.files.abort(msg.id, msg.reason);
          this.incoming.view.state = 'cancelado';
          this.incoming.view.message = msg.reason;
          this.incoming = null;
          this.notify();
        }
        if (this.active?.view.id === msg.id) {
          this.active.view.state = 'cancelado';
          this.active.view.message = msg.reason;
          this.notify();
        }
        this.concluir(msg.id, false);
        return;
      }
    }
  }

  private async onOffer(msg: Extract<FileControl, { t: 'file-offer' }>): Promise<void> {
    if (this.incoming) {
      this.sendControl({ t: 'file-reject', id: msg.id, reason: 'já há uma transferência em andamento' });
      return;
    }
    // Sem teto de tamanho: quem recusa, e por um motivo concreto, é o disco —
    // `files.begin` confere o espaço livre logo abaixo e explica o que falta.
    const view: TransferView = {
      id: msg.id,
      name: msg.relPath ?? msg.name,
      size: msg.size,
      direction: 'recebendo',
      transferred: 0,
      state: 'ativo',
      rate: 0,
    };

    try {
      await window.ryke.files.begin(msg.id, msg.name, msg.size, msg.relPath);
    } catch (err) {
      view.state = 'erro';
      view.message = err instanceof Error ? err.message : String(err);
      this.push(view);
      this.sendControl({ t: 'file-reject', id: msg.id, reason: view.message });
      return;
    }

    this.push(view);
    const loteValido =
      typeof msg.clipboardBatch === 'string' &&
      Number.isInteger(msg.clipboardIndex) &&
      Number.isInteger(msg.clipboardTotal) &&
      (msg.clipboardIndex ?? -1) >= 0 &&
      (msg.clipboardTotal ?? 0) > 0 &&
      (msg.clipboardIndex ?? 0) < (msg.clipboardTotal ?? 0);
    this.incoming = {
      view,
      clipboard: loteValido
        ? { id: msg.clipboardBatch!, index: msg.clipboardIndex!, total: msg.clipboardTotal! }
        : null,
      legadoClipboard: msg.fromClipboard === true && !loteValido,
    };
    this.receiveStart = performance.now();
    this.sendControl({ t: 'file-accept', id: msg.id });
  }

  private receiveStart = 0;

  /** Blocos binários crus do canal de arquivos. */
  async handleBinary(data: ArrayBuffer): Promise<void> {
    const entry = this.incoming;
    // Bloco sem transferência ativa é resto de algo cancelado: descartar.
    if (!entry) return;

    try {
      const written = await window.ryke.files.write(entry.view.id, new Uint8Array(data));
      entry.view.transferred = written;
      const elapsed = (performance.now() - this.receiveStart) / 1000;
      entry.view.rate = elapsed > 0.2 ? written / elapsed : 0;
      this.notificarProgresso();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      entry.view.state = 'erro';
      entry.view.message = reason;
      this.incoming = null;
      this.sendControl({ t: 'file-abort', id: entry.view.id, reason });
      this.notify();
    }
  }

  private async onDone(id: string): Promise<void> {
    const entry = this.incoming;
    if (!entry || entry.view.id !== id) return;
    this.incoming = null;

    try {
      const { path } = await window.ryke.files.finish(id);
      entry.view.state = 'concluido';
      entry.view.path = path;
      entry.view.transferred = entry.view.size;
      // Veio de um Ctrl+C do outro lado: então tem de dar para colar deste
      // lado. Sem isto o arquivo chegava e ficava parado na pasta de
      // downloads, e o Ctrl+V numa pasta qualquer não fazia nada — que é
      // exatamente o "não copia" relatado.
      if (entry.clipboard) {
        const lote = this.lotesClipboard.get(entry.clipboard.id) ?? {
          paths: new Array<string>(entry.clipboard.total),
          total: entry.clipboard.total,
        };
        lote.paths[entry.clipboard.index] = path;
        this.lotesClipboard.set(entry.clipboard.id, lote);
        if (lote.paths.filter(Boolean).length === lote.total) {
          const colou = await window.ryke.files.copiarParaAreaDeTransferencia(lote.paths);
          entry.view.message = colou ? `${lote.total} itens prontos para colar (Ctrl+V)` : undefined;
          this.lotesClipboard.delete(entry.clipboard.id);
        }
      } else if (entry.legadoClipboard) {
        const colou = await window.ryke.files.copiarParaAreaDeTransferencia([path]);
        entry.view.message = colou ? 'Pronto para colar (Ctrl+V)' : undefined;
      }
      this.sendControl({ t: 'file-saved', id, path });
    } catch (err) {
      entry.view.state = 'erro';
      entry.view.message = err instanceof Error ? err.message : String(err);
      this.sendControl({ t: 'file-abort', id, reason: entry.view.message });
    }
    this.notify();
  }

  // ─────────────────────────── controle ─────────────────────────

  cancel(id: string): void {
    this.cancelled.add(id);
    if (this.active?.view.id === id) {
      this.active.view.state = 'cancelado';
      this.sendControl({ t: 'file-abort', id, reason: 'cancelado pelo remetente' });
    } else if (this.incoming?.view.id === id) {
      void window.ryke.files.abort(id, 'cancelado pelo destinatário');
      this.incoming.view.state = 'cancelado';
      this.incoming = null;
      this.sendControl({ t: 'file-abort', id, reason: 'cancelado pelo destinatário' });
    } else {
      const idx = this.queue.findIndex((q) => q.view.id === id);
      if (idx >= 0) {
        const [removed] = this.queue.splice(idx, 1);
        removed.view.state = 'cancelado';
        void removed.source.close();
        this.concluir(id, false);
      }
    }
    this.notify();
  }

  private push(view: TransferView): void {
    this.views.unshift(view);
    if (this.views.length > 50) this.views.length = 50;
    this.notify();
  }

  async dispose(): Promise<void> {
    this.closed = true;
    if (this.incoming) {
      await window.ryke.files.abort(this.incoming.view.id, 'sessão encerrada');
      this.incoming.view.state = 'cancelado';
      this.incoming = null;
    }
    for (const entry of [this.active, ...this.queue]) {
      if (!entry) continue;
      if (entry.view.state === 'ativo' || entry.view.state === 'aguardando') entry.view.state = 'cancelado';
      await entry.source.close();
    }
    this.active = null;
    this.queue = [];
    for (const concluir of this.conclusoes.values()) concluir(false);
    this.conclusoes.clear();
    this.lotesClipboard.clear();
    this.notify();
  }
}
