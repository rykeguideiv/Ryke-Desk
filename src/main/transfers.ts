/**
 * Leitura e escrita em disco dos arquivos que atravessam a sessão.
 *
 * O renderer é quem controla o ritmo (ele enxerga o bufferedAmount do
 * DataChannel), então o envio é por "puxada": o renderer pede o próximo
 * pedaço quando o canal tem espaço. O processo principal só cuida do disco —
 * e é aqui que ficam as travas contra nome malicioso e tamanho excessivo,
 * porque nada que vem da rede pode escolher onde gravar.
 */
import { createWriteStream, WriteStream } from 'node:fs';
import { open, mkdir, unlink, stat, statfs, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';


// Caracteres proibidos em nome de arquivo no Windows, mais os de controle.
// Espaço fica de fora: "Relatório final.pdf" deve continuar com o espaço.
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;
// Nomes que o Windows reserva para dispositivos, em qualquer extensão.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Reduz o que veio da rede a um nome de arquivo simples e seguro.
 * Descarta qualquer componente de caminho: "..\\..\\Windows\\System32\\x.dll"
 * vira "x.dll".
 */
export function sanitizeFileName(raw: string): string {
  let name = basename(raw.replace(/[/\\]+/g, sep)).replace(ILLEGAL, '_').trim();
  // O Windows também não aceita ponto ou espaço no fim do nome.
  name = name.replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'arquivo';
  if (RESERVED.test(name)) name = `_${name}`;
  // Deixa folga para o sufixo " (12)" sem estourar o limite do sistema.
  if (name.length > 200) {
    const ext = extname(name).slice(0, 20);
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

/** Acha um caminho livre em `dir`, virando "foto.png" em "foto (2).png". */
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate; // não existe: é nosso
    }
  }
  return join(dir, `${stem} (${randomUUID().slice(0, 8)})${ext}`);
}

type Incoming = {
  id: string;
  path: string;
  stream: WriteStream;
  expected: number;
  written: number;
};

type Outgoing = {
  id: string;
  path: string;
  handle: FileHandle;
  size: number;
};

export class Transfers {
  private incoming = new Map<string, Incoming>();
  private outgoing = new Map<string, Outgoing>();

  private downloadDir: string;

  constructor(downloadDir: string) {
    this.downloadDir = downloadDir;
  }

  setDownloadDir(dir: string): void {
    this.downloadDir = dir;
  }

  // ── recebimento ──

  /**
   * Abre o arquivo de destino.
   *
   * @param relPath caminho dentro da pasta de origem, quando é uma pasta que
   *   está sendo enviada. Recria a árvore no destino.
   */
  async begin(id: string, rawName: string, size: number, relPath?: string): Promise<{ path: string }> {
    if (!Number.isFinite(size) || size < 0) throw new Error('tamanho inválido');
    if (this.incoming.has(id)) throw new Error('transferência duplicada');

    // O tamanho não tem teto, mas o disco tem. Conferir aqui é o que substitui
    // o antigo limite de 500 MB — e é uma conferência de verdade, contra o
    // espaço que existe, em vez de um número escolhido no chute.
    await this.conferirEspaco(size);

    await mkdir(this.downloadDir, { recursive: true });
    const path = relPath ? await this.caminhoNaArvore(relPath) : await uniquePath(this.downloadDir, sanitizeFileName(rawName));

    const stream = createWriteStream(path, { flags: 'wx' });
    await new Promise<void>((res, rej) => {
      stream.once('open', () => res());
      stream.once('error', rej);
    });

    this.incoming.set(id, { id, path, stream, expected: size, written: 0 });
    return { path };
  }

  /** @returns total de bytes já gravados */
  async write(id: string, chunk: Buffer): Promise<number> {
    const entry = this.incoming.get(id);
    if (!entry) throw new Error('transferência desconhecida');

    // Um remetente hostil poderia mandar mais bytes do que anunciou para
    // encher o disco; cortamos exatamente no tamanho combinado.
    if (entry.written + chunk.length > entry.expected) {
      await this.abort(id, 'remetente enviou mais bytes do que o anunciado');
      throw new Error('excedeu o tamanho anunciado');
    }

    if (!entry.stream.write(chunk)) {
      await new Promise<void>((res) => entry.stream.once('drain', () => res()));
    }
    entry.written += chunk.length;
    return entry.written;
  }

  /** Fecha o arquivo e confere que chegou inteiro. */
  async finish(id: string): Promise<{ path: string; size: number }> {
    const entry = this.incoming.get(id);
    if (!entry) throw new Error('transferência desconhecida');
    this.incoming.delete(id);

    await new Promise<void>((res, rej) => entry.stream.end((err?: Error) => (err ? rej(err) : res())));

    if (entry.written !== entry.expected) {
      await unlink(entry.path).catch(() => {});
      throw new Error(`arquivo incompleto: ${entry.written} de ${entry.expected} bytes`);
    }
    return { path: entry.path, size: entry.written };
  }

  /** Cancela e apaga o arquivo parcial — nada de deixar lixo na pasta. */
  async abort(id: string, _reason: string): Promise<void> {
    const entry = this.incoming.get(id);
    if (!entry) return;
    this.incoming.delete(id);
    await new Promise<void>((res) => {
      entry.stream.once('close', () => res());
      entry.stream.destroy();
    });
    await unlink(entry.path).catch(() => {});
  }

  /**
   * Cabe no disco?
   *
   * Sem teto de tamanho, esta é a única defesa real contra encher o disco de
   * quem recebe — e é melhor do que o teto era, porque um limite fixo tanto
   * recusava uma transferência legítima de 50 GB quanto deixava passar 500 MB
   * num disco com 100 MB livres.
   *
   * A folga de 64 MB evita entregar o sistema operacional a um disco
   * exatamente zerado, que é onde o Windows começa a falhar de formas
   * criativas.
   */
  private async conferirEspaco(size: number): Promise<void> {
    try {
      await mkdir(this.downloadDir, { recursive: true });
      const fs = await statfs(this.downloadDir);
      const livre = fs.bavail * fs.bsize;
      const FOLGA = 64 * 1024 * 1024;
      if (size + FOLGA > livre) {
        throw new Error(
          `não há espaço em disco: o arquivo tem ${(size / 1024 ** 3).toFixed(1)} GB e restam ${(livre / 1024 ** 3).toFixed(1)} GB`,
        );
      }
    } catch (err) {
      // `statfs` não existe em todo sistema de arquivos. Falhar a conferência
      // não pode impedir a transferência — na pior hipótese o disco enche e o
      // erro aparece na hora da gravação, que é o comportamento anterior.
      if (err instanceof Error && err.message.startsWith('não há espaço')) throw err;
    }
  }

  /**
   * Recria a árvore da pasta de origem dentro da pasta de downloads.
   *
   * Cada segmento é higienizado, e no fim conferimos que o caminho resolvido
   * continua DENTRO do destino. Os dois passos são necessários: o primeiro
   * tira `..` e caracteres proibidos, o segundo é a rede de segurança para
   * qualquer coisa que o primeiro não tenha previsto — link simbólico, nome
   * reservado do Windows, codificação estranha. Um caminho vindo do outro
   * computador não merece confiança nenhuma.
   */
  private async caminhoNaArvore(relPath: string): Promise<string> {
    const segmentos = relPath
      .split(/[\\/]+/)
      .map((s) => sanitizeFileName(s))
      .filter((s) => s.length > 0 && s !== '.' && s !== '..');

    if (segmentos.length === 0) throw new Error('caminho inválido');

    const arquivo = segmentos.pop()!;
    const pasta = join(this.downloadDir, ...segmentos);

    const raiz = resolve(this.downloadDir);
    if (resolve(pasta) !== raiz && !resolve(pasta).startsWith(raiz + sep)) {
      throw new Error('caminho fora da pasta de downloads');
    }

    await mkdir(pasta, { recursive: true });
    return uniquePath(pasta, arquivo);
  }

  // ── envio ──

  async openForSend(path: string): Promise<{ id: string; name: string; size: number }> {
    const full = resolve(path);
    const info = await stat(full);
    if (!info.isFile()) throw new Error('só é possível enviar arquivos, não pastas');

    const handle = await open(full, 'r');
    const id = randomUUID();
    this.outgoing.set(id, { id, path: full, handle, size: info.size });
    return { id, name: basename(full), size: info.size };
  }

  /** Lê um pedaço para o renderer empurrar no DataChannel. */
  async readSlice(id: string, offset: number, length: number): Promise<Buffer> {
    const entry = this.outgoing.get(id);
    if (!entry) throw new Error('envio desconhecido');
    const buffer = Buffer.allocUnsafe(Math.min(length, Math.max(0, entry.size - offset)));
    if (buffer.length === 0) return buffer;
    const { bytesRead } = await entry.handle.read(buffer, 0, buffer.length, offset);
    return bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  }

  /**
   * Todos os arquivos de uma pasta, com o caminho relativo de cada um.
   *
   * O caminho relativo começa NO NOME DA PASTA — `Fotos/2026/praia.jpg`, e não
   * `2026/praia.jpg`. É o que faz a pasta chegar inteira do outro lado, com o
   * nome dela, em vez de o conteúdo se espalhar pela pasta de downloads.
   *
   * Links simbólicos são ignorados de propósito: seguir um deles poderia
   * levar a varredura para fora da pasta escolhida — no limite, para o disco
   * inteiro — sem que ninguém tivesse pedido isso. Pastas vazias também não
   * entram, porque o protocolo transporta arquivos, e uma pasta sem arquivo
   * nenhum não tem o que transportar.
   */
  async listarPasta(raiz: string): Promise<{ path: string; relPath: string; size: number }[]> {
    const base = resolve(raiz);
    const info = await stat(base);
    if (!info.isDirectory()) throw new Error('não é uma pasta');

    const encontrados: { path: string; relPath: string; size: number }[] = [];
    const nomeDaRaiz = basename(base);

    const andar = async (pasta: string, prefixo: string): Promise<void> => {
      const itens = await readdir(pasta, { withFileTypes: true });
      for (const item of itens) {
        // `isSymbolicLink` antes de qualquer outra coisa: um link para "C:\"
        // dentro da pasta transformaria isto numa varredura do disco inteiro.
        if (item.isSymbolicLink()) continue;
        const caminho = join(pasta, item.name);
        const rel = `${prefixo}/${item.name}`;
        if (item.isDirectory()) {
          await andar(caminho, rel);
        } else if (item.isFile()) {
          const st = await stat(caminho).catch(() => null);
          if (st) encontrados.push({ path: caminho, relPath: rel, size: st.size });
        }
      }
    };

    await andar(base, nomeDaRaiz);
    return encontrados;
  }

  async closeSend(id: string): Promise<void> {
    const entry = this.outgoing.get(id);
    if (!entry) return;
    this.outgoing.delete(id);
    await entry.handle.close().catch(() => {});
  }

  /** Fecha tudo ao encerrar a sessão, sem deixar arquivo pela metade. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.incoming.keys()].map((id) => this.abort(id, 'sessão encerrada')));
    await Promise.all([...this.outgoing.keys()].map((id) => this.closeSend(id)));
  }
}
