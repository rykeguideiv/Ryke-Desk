/**
 * Segundo caminho da malha: relays Nostr, na porta 443.
 *
 * POR QUE ISTO EXISTE
 *
 * Os corretores MQTT públicos atendem em portas incomuns — 8084, 8884, 8081.
 * Rede doméstica não liga para isso, mas rede de empresa costuma liberar só
 * 80 e 443 e barrar o resto. Num escritório assim o programa não conectava, e
 * de um jeito especialmente ruim: ficava online, porque os dois lados até
 * entravam na malha, mas em corretores diferentes — e dois computadores em
 * corretores sem interseção nunca se enxergam.
 *
 * Relays Nostr resolvem isso porque falam WebSocket seguro na 443, a mesma
 * porta de qualquer site. Para o firewall, é tráfego HTTPS.
 *
 * POR QUE NOSTR, E NÃO OUTRA COISA
 *
 * Precisava de algo público, sem cadastro, com vários operadores
 * independentes e feito para publicar e assinar mensagens. Nostr é
 * exatamente isso, e tem um recurso sob medida: eventos EFÊMEROS (faixa
 * 20000–29999), que o relay repassa a quem está ouvindo e não guarda. É o
 * que queremos — o combinado inicial de uma conexão não é para ficar
 * arquivado em lugar nenhum.
 *
 * O QUE O RELAY VÊ
 *
 * O mesmo que o corretor MQTT vê: uma etiqueta opaca e bytes cifrados que
 * ele não sabe ler. A chave Nostr criada aqui é descartável, vale só para
 * esta execução e não identifica o usuário — quem identifica a máquina é a
 * chave ECDSA de `encontro.ts`, que vai dentro do envelope.
 *
 * Referência: NIP-01 (protocolo base) e NIP-16 (eventos efêmeros).
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { AbrirSoquete, Soquete } from './mqtt';

/**
 * Faixa efêmera: o relay entrega a quem está ouvindo naquele instante e
 * descarta. Nada do Ryke Desk fica gravado em relay nenhum.
 */
const KIND_RYKE = 20777;

/** Aceitamos eventos com até este atraso; o resto é repetição tardia. */
const JANELA_SEGUNDOS = 120;

export type OpcoesNostr = {
  url: string;
  abrir: AbrirSoquete;
  aoConectar?: () => void;
  aoMensagem?: (topico: string, carga: Uint8Array<ArrayBuffer>) => void;
  aoFechar?: (motivo: string) => void;
};

function paraBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function deBase64(texto: string): Uint8Array<ArrayBuffer> {
  const bin = atob(texto);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A etiqueta do evento.
 *
 * Os tópicos são `ryke/v1/<32 hexas>`; as barras não servem como etiqueta
 * Nostr, então fica só a parte que identifica — que já é o resumo opaco do
 * número, e portanto não revela nada.
 */
function etiquetaDe(topico: string): string {
  return topico.replace(/^ryke\/v1\//, '');
}

export class ClienteNostr {
  private opcoes: OpcoesNostr;
  private ws: Soquete | null = null;
  private pronto = false;
  private encerrado = false;
  private assinados = new Set<string>();
  private priv: Uint8Array;
  private pub: string;
  private sub = 0;

  constructor(opcoes: OpcoesNostr) {
    this.opcoes = opcoes;
    // Chave descartável, só para o transporte. Trocada a cada execução de
    // propósito: uma chave fixa deixaria os relays correlacionarem sessões.
    this.priv = new Uint8Array(32);
    globalThis.crypto.getRandomValues(this.priv);
    this.pub = bytesToHex(schnorr.getPublicKey(this.priv));
  }

  get conectado(): boolean {
    return this.pronto;
  }

  get nome(): string {
    return this.opcoes.url.replace(/^wss?:\/\//, '');
  }

  conectar(): void {
    this.encerrado = false;
    let ws: Soquete;
    try {
      ws = this.opcoes.abrir(this.opcoes.url, []);
    } catch (err) {
      this.opcoes.aoFechar?.(`não abriu: ${String(err)}`);
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.pronto = true;
      const antes = [...this.assinados];
      this.assinados.clear();
      for (const t of antes) this.assinar(t);
      this.opcoes.aoConectar?.();
    });

    ws.addEventListener('message', (ev) => this.receber(ev.data));
    ws.addEventListener('close', () => this.derrubar('conexão fechada'));
    ws.addEventListener('error', () => this.derrubar('erro de rede'));
  }

  private derrubar(motivo: string): void {
    const estavaVivo = this.ws !== null;
    this.ws = null;
    this.pronto = false;
    if (estavaVivo && !this.encerrado) this.opcoes.aoFechar?.(motivo);
  }

  private enviar(quadro: unknown): void {
    try {
      (this.ws as unknown as { send(d: string): void } | null)?.send(JSON.stringify(quadro));
    } catch {
      this.derrubar('falha ao escrever');
    }
  }

  private receber(dados: unknown): void {
    let texto: string;
    if (typeof dados === 'string') texto = dados;
    else if (dados instanceof ArrayBuffer) texto = new TextDecoder().decode(dados);
    else if (ArrayBuffer.isView(dados)) {
      const v = dados as ArrayBufferView;
      texto = new TextDecoder().decode(new Uint8Array(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength));
    } else return;

    let quadro: unknown[];
    try {
      quadro = JSON.parse(texto);
    } catch {
      return;
    }
    if (!Array.isArray(quadro)) return;

    if (quadro[0] === 'EVENT') {
      const ev = quadro[2] as { content?: string; tags?: string[][]; created_at?: number } | undefined;
      if (!ev?.content || !Array.isArray(ev.tags)) return;
      // Relays podem entregar coisa velha; o envelope também confere o
      // horário, mas cortar aqui evita trabalho de decifragem à toa.
      const idade = Math.abs(Math.floor(Date.now() / 1000) - (ev.created_at ?? 0));
      if (idade > JANELA_SEGUNDOS) return;
      const etiqueta = ev.tags.find((t) => t[0] === 't')?.[1];
      if (!etiqueta) return;
      try {
        this.opcoes.aoMensagem?.(`ryke/v1/${etiqueta}`, deBase64(ev.content));
      } catch {
        /* conteúdo que não é nosso */
      }
      return;
    }

    // Alguns relays exigem autenticação ou recusam a faixa; nesse caso a
    // assinatura é encerrada e este relay simplesmente não serve.
    if (quadro[0] === 'CLOSED') this.derrubar(`assinatura recusada: ${String(quadro[2] ?? '')}`);
  }

  assinar(topico: string): void {
    if (!this.pronto || this.assinados.has(topico)) return;
    this.assinados.add(topico);
    this.enviar([
      'REQ',
      `r${this.sub++}`,
      { kinds: [KIND_RYKE], '#t': [etiquetaDe(topico)], since: Math.floor(Date.now() / 1000) - 10 },
    ]);
  }

  publicar(topico: string, carga: Uint8Array<ArrayBuffer>): boolean {
    if (!this.pronto) return false;
    const evento: Record<string, unknown> = {
      pubkey: this.pub,
      created_at: Math.floor(Date.now() / 1000),
      kind: KIND_RYKE,
      tags: [['t', etiquetaDe(topico)]],
      content: paraBase64(carga),
    };
    // A identificação do evento é o SHA-256 da forma canônica definida na
    // NIP-01 — array posicional, sem nomes de campo.
    const serial = JSON.stringify([
      0,
      evento.pubkey,
      evento.created_at,
      evento.kind,
      evento.tags,
      evento.content,
    ]);
    const id = sha256(new TextEncoder().encode(serial));
    evento.id = bytesToHex(id);
    evento.sig = bytesToHex(schnorr.sign(id, this.priv));
    this.enviar(['EVENT', evento]);
    return true;
  }

  encerrar(): void {
    this.encerrado = true;
    try {
      this.ws?.close();
    } catch {
      /* já estava caindo */
    }
    this.derrubar('encerrado');
  }
}
