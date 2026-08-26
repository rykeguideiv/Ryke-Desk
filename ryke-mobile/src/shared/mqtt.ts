/**
 * Cliente MQTT 3.1.1 mínimo, sobre WebSocket.
 *
 * Por que escrever em vez de instalar: o Ryke Desk já carrega a assinatura de
 * comportamento de uma ferramenta de acesso remoto e é examinado com lupa por
 * antivírus. Cada dependência a mais é código de terceiro dentro do instalador
 * que eu não li. O pedaço de MQTT que precisamos — conectar, assinar tópico,
 * publicar, manter vivo — cabe em um arquivo e não muda desde 2014.
 *
 * Escopo deliberado: só QoS 0. Entrega "no máximo uma vez", sem confirmação.
 * Parece pouco, mas a repetição que interessa aqui não é a do corretor e sim a
 * de publicar a mesma mensagem em vários corretores ao mesmo tempo (ver
 * malha.ts). QoS 1 protegeria contra a perda em um corretor; publicar em três
 * protege contra o corretor inteiro sair do ar.
 *
 * A conexão entra por injeção (`abrir`) porque este arquivo roda nos dois
 * mundos: WebSocket do navegador na interface, pacote `ws` nos testes em Node.
 *
 * Referência: MQTT Version 3.1.1, OASIS Standard.
 */

// ───────────────────────────── Codificação ─────────────────────────────

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGREQ = 12;
const PINGRESP = 13;
const DISCONNECT = 14;

/**
 * O campo "remaining length" do MQTT é um inteiro de tamanho variável: sete
 * bits de dados por byte, o oitavo diz "tem mais". Quatro bytes no máximo,
 * o que dá 256 MB — muito além do que trafega aqui.
 */
function tamanhoVariavel(valor: number): number[] {
  const saida: number[] = [];
  let n = valor;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte = byte | 0x80;
    saida.push(byte);
  } while (n > 0);
  return saida;
}

function lerTamanhoVariavel(dados: Uint8Array<ArrayBuffer>, inicio: number): { valor: number; bytes: number } | null {
  let multiplicador = 1;
  let valor = 0;
  let i = inicio;
  for (let volta = 0; volta < 4; volta++) {
    if (i >= dados.length) return null; // pacote ainda incompleto
    const byte = dados[i++];
    valor += (byte & 0x7f) * multiplicador;
    if ((byte & 0x80) === 0) return { valor, bytes: i - inicio };
    multiplicador *= 128;
  }
  return null;
}

/** Strings no MQTT vão sempre com dois bytes de tamanho na frente. */
function texto(valor: string): number[] {
  const bytes = new TextEncoder().encode(valor);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

function montar(tipo: number, flags: number, corpo: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(tipo << 4) | flags, ...tamanhoVariavel(corpo.length), ...corpo]);
}

// ─────────────────────────────── Cliente ───────────────────────────────

/**
 * O mínimo de WebSocket de que precisamos. Declarado à mão porque o tipo do
 * DOM e o do pacote `ws` não são o mesmo, e este arquivo atende aos dois.
 */
export type Soquete = {
  binaryType: string;
  send(dados: ArrayBufferView | ArrayBuffer): void;
  close(): void;
  addEventListener(evento: 'open', fn: () => void): void;
  addEventListener(evento: 'message', fn: (ev: { data: unknown }) => void): void;
  addEventListener(evento: 'close', fn: () => void): void;
  addEventListener(evento: 'error', fn: (ev?: unknown) => void): void;
};

export type AbrirSoquete = (url: string, subprotocolos: string[]) => Soquete;

export type OpcoesMqtt = {
  url: string;
  abrir: AbrirSoquete;
  /** Identificador do cliente. O corretor derruba conexões com o mesmo. */
  clientId: string;
  /** Segundos entre pulsos. Corretor derruba em 1,5× isso sem notícia. */
  keepalive?: number;
  aoConectar?: () => void;
  aoMensagem?: (topico: string, carga: Uint8Array<ArrayBuffer>) => void;
  aoFechar?: (motivo: string) => void;
};

export class ClienteMqtt {
  private opcoes: OpcoesMqtt;
  private ws: Soquete | null = null;
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private proximoPacote = 1;
  private pulso: ReturnType<typeof setInterval> | null = null;
  private assinados = new Set<string>();
  private encerrado = false;
  private pronto = false;

  constructor(opcoes: OpcoesMqtt) {
    this.opcoes = opcoes;
  }

  get conectado(): boolean {
    return this.pronto;
  }

  /** Só o host, para a tela de diagnóstico não expor caminho nem porta. */
  get nome(): string {
    try {
      return new URL(this.opcoes.url).host;
    } catch {
      return this.opcoes.url;
    }
  }

  conectar(): void {
    this.encerrado = false;
    let ws: Soquete;
    try {
      // O subprotocolo "mqtt" é obrigatório; sem ele os corretores públicos
      // fecham a conexão logo depois do aperto de mão.
      ws = this.opcoes.abrir(this.opcoes.url, ['mqtt']);
    } catch (err) {
      this.opcoes.aoFechar?.(`não abriu: ${String(err)}`);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      const keepalive = this.opcoes.keepalive ?? 45;
      const corpo = [
        ...texto('MQTT'),
        4, // nível do protocolo (3.1.1)
        0x02, // sessão limpa; sem usuário, senha ou testamento
        keepalive >> 8,
        keepalive & 0xff,
        ...texto(this.opcoes.clientId),
      ];
      this.enviar(montar(CONNECT, 0, corpo));
    });

    ws.addEventListener('message', (ev) => this.receber(ev.data));
    ws.addEventListener('close', () => this.derrubar('conexão fechada'));
    ws.addEventListener('error', () => this.derrubar('erro de rede'));
  }

  private enviar(pacote: Uint8Array<ArrayBuffer>): void {
    try {
      this.ws?.send(pacote);
    } catch {
      this.derrubar('falha ao escrever');
    }
  }

  private derrubar(motivo: string): void {
    if (this.pulso !== null) {
      clearInterval(this.pulso);
      this.pulso = null;
    }
    const estavaVivo = this.ws !== null;
    this.ws = null;
    this.pronto = false;
    this.buffer = new Uint8Array(0);
    this.assinados.clear();
    if (estavaVivo && !this.encerrado) this.opcoes.aoFechar?.(motivo);
  }

  /**
   * WebSocket entrega quadros, não pacotes MQTT. Um quadro pode trazer meio
   * pacote ou três inteiros, então acumulamos e só consumimos o que estiver
   * completo.
   */
  private receber(dados: unknown): void {
    let chegou: Uint8Array<ArrayBuffer>;
    if (dados instanceof ArrayBuffer) chegou = new Uint8Array(dados);
    else if (ArrayBuffer.isView(dados)) {
      const v = dados as ArrayBufferView;
      chegou = new Uint8Array(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength);
    } else return;

    const junto = new Uint8Array(this.buffer.length + chegou.length);
    junto.set(this.buffer, 0);
    junto.set(chegou, this.buffer.length);
    this.buffer = junto;

    for (;;) {
      if (this.buffer.length < 2) return;
      const cabecalho = lerTamanhoVariavel(this.buffer, 1);
      if (!cabecalho) return;
      const total = 1 + cabecalho.bytes + cabecalho.valor;
      if (this.buffer.length < total) return;

      const tipo = this.buffer[0] >> 4;
      const flags = this.buffer[0] & 0x0f;
      const corpo = this.buffer.subarray(1 + cabecalho.bytes, total);
      this.buffer = this.buffer.slice(total);
      this.tratar(tipo, flags, corpo);
    }
  }

  private tratar(tipo: number, flags: number, corpo: Uint8Array<ArrayBuffer>): void {
    switch (tipo) {
      case CONNACK: {
        // corpo[1] é o código de retorno; 0 = aceito.
        if (corpo.length < 2 || corpo[1] !== 0) {
          this.derrubar(`recusado pelo corretor (código ${corpo[1] ?? '?'})`);
          return;
        }
        this.pronto = true;
        const keepalive = this.opcoes.keepalive ?? 45;
        this.pulso = setInterval(() => this.enviar(montar(PINGREQ, 0, [])), keepalive * 1000 * 0.75);
        this.opcoes.aoConectar?.();
        break;
      }
      case PUBLISH: {
        const qos = (flags >> 1) & 0x03;
        if (corpo.length < 2) return;
        const tamTopico = (corpo[0] << 8) | corpo[1];
        if (corpo.length < 2 + tamTopico) return;
        const topico = new TextDecoder().decode(corpo.subarray(2, 2 + tamTopico));
        // Em QoS > 0 vem um identificador de pacote entre o tópico e a carga.
        // Não pedimos QoS alto, mas um corretor pode rebaixar em vez de negar.
        const inicioCarga = 2 + tamTopico + (qos > 0 ? 2 : 0);
        this.opcoes.aoMensagem?.(topico, corpo.slice(inicioCarga));
        break;
      }
      case SUBACK:
      case PINGRESP:
        break;
    }
  }

  assinar(topico: string): void {
    if (!this.pronto || this.assinados.has(topico)) return;
    this.assinados.add(topico);
    const id = this.proximoPacote++ & 0xffff;
    // Flag 0x02 é obrigatória no cabeçalho fixo do SUBSCRIBE.
    this.enviar(montar(SUBSCRIBE, 0x02, [id >> 8, id & 0xff, ...texto(topico), 0]));
  }

  publicar(topico: string, carga: Uint8Array<ArrayBuffer>): boolean {
    if (!this.pronto) return false;
    this.enviar(montar(PUBLISH, 0, [...texto(topico), ...carga]));
    return true;
  }

  encerrar(): void {
    this.encerrado = true;
    if (this.pronto) this.enviar(montar(DISCONNECT, 0, []));
    try {
      this.ws?.close();
    } catch {
      /* já estava caindo */
    }
    this.derrubar('encerrado');
  }
}

/** Exportado só para os testes conferirem a codificação byte a byte. */
export const _interno = { tamanhoVariavel, lerTamanhoVariavel, texto, montar };
