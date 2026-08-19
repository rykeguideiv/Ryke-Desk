import type { SignalPayload } from '../../../shared/protocol';
import { Malha, type Cofre, type EstadoPonto } from '../../../shared/malha';
import type { Soquete } from '../../../shared/mqtt';
import { SERVIDOR_PADRAO, servidorConfigurado } from '../../../shared/servidor-padrao';

/**
 * Como este computador encontra o outro.
 *
 * Antes havia um servidor: os dois lados se ligavam nele, ele apresentava um
 * ao outro e saía de cena. Funcionava, mas exigia alguém pagando uma máquina
 * na internet para o programa existir — e, se essa máquina caísse, ninguém
 * mais se conectava a ninguém.
 *
 * Hoje não há servidor. O encontro acontece numa malha de corretores públicos
 * de mensagens, usados todos ao mesmo tempo (ver `malha.ts`). O resto do
 * programa não precisa saber disso: esta classe entrega os mesmos eventos de
 * sempre, e a sessão de vídeo, teclado e arquivos continua indo direto de um
 * computador ao outro, sem passar por lugar nenhum.
 *
 * O nome antigo ficou de propósito. Quem lê `Signaling` no controlador
 * continua entendendo o papel da peça: o combinado inicial, e só ele.
 */

export type SignalingEvents = {
  status: (status: 'conectando' | 'online' | 'offline', detail?: string) => void;
  welcome: (payload: { id: string; token: string; iceServers: RTCIceServer[] }) => void;
  signal: (from: string, data: SignalPayload) => void;
  peerOffline: (peerId: string) => void;
  serverError: (reason: string, detail?: string) => void;
  /** A máquina por trás de um número mudou. Ver `malha.ts`. */
  identidadeMudou: (numero: string, esperada: string, recebida: string) => void;
  /** Outro computador respondeu pelo nosso número. Ver `malha.ts`. */
  numeroDuplicado: (numero: string) => void;
};

/**
 * O cofre da malha, ligado ao processo principal.
 *
 * A chave privada e o número moram no `ryke-config.json`, com a chave cifrada
 * pela DPAPI do Windows. A interface não guarda nada por conta própria.
 */
const cofreDoProcessoPrincipal: Cofre = {
  async ler() {
    const { id, token } = await window.ryke.identity.get();
    return { numero: id, chavePrivada: token };
  },
  async gravar(numero, chavePrivada) {
    await window.ryke.identity.save(numero, chavePrivada);
  },
  async lerPinos() {
    return window.ryke.identity.knownHosts();
  },
  async gravarPino(numero, impressao) {
    await window.ryke.identity.pin(numero, impressao);
  },
};

export class Signaling {
  private malha: Malha;
  private impressaoLocal: string | null = null;

  /**
   * `url` é um corretor próprio, opcional — quem não tiver passa vazio, que é
   * o caso normal. Ele entra *somando* aos corretores públicos, nunca no lugar
   * deles: quem aponta o seu não fica sem saída quando ele estiver fora do ar.
   */
  constructor(url: string, corretores: string[] | null, relays: string[] | null) {
    this.malha = new Malha({
      cofre: cofreDoProcessoPrincipal,
      // null = usa as listas embutidas, que é o uso normal.
      corretores: corretores ?? undefined,
      relays: relays ?? undefined,
      // O WebSocket do navegador cumpre o contrato de `Soquete`, mas o tipo do
      // DOM traz dezenas de sobrecargas de addEventListener que não casam
      // estruturalmente com a versão enxuta declarada em mqtt.ts.
      abrir: (endereco, subprotocolos) =>
        new WebSocket(endereco, subprotocolos) as unknown as Soquete,
    });
    const extra = url?.trim() || SERVIDOR_PADRAO;
    if (servidorConfigurado(extra)) this.malha.setUrl(extra);
    this.malha.on('welcome', ({ impressao }) => {
      this.impressaoLocal = impressao;
    });
  }

  /** Impressão digital deste computador, para conferência por telefone. */
  get impressao(): string | null {
    return this.impressaoLocal;
  }

  /** Sorteia um número novo, a pedido explícito do usuário. */
  async trocarNumero(): Promise<string> {
    return this.malha.trocarNumero();
  }

  /** Situação de cada ponto de encontro, para a tela de diagnóstico. */
  diagnostico(): EstadoPonto[] {
    return this.malha.diagnostico();
  }

  on<K extends keyof SignalingEvents>(event: K, fn: SignalingEvents[K]): () => void {
    return this.malha.on(event as never, fn as never);
  }

  get connected(): boolean {
    return this.malha.connected;
  }

  connect(): void {
    this.malha.connect();
  }

  setUrl(url: string): void {
    this.malha.setUrl(url);
  }

  send(to: string, data: SignalPayload): void {
    this.malha.send(to, data);
  }

  probe(to: string): void {
    this.malha.probe(to);
  }

  disconnect(): void {
    this.malha.disconnect();
  }
}
