/**
 * A sessão remota, do lado do celular — e só do lado do celular.
 *
 * O aplicativo Android é **exclusivamente visitante**: ele acessa um PC, e
 * nunca é acessado. Isso não é uma limitação temporária, é uma decisão de
 * escopo, e ela simplifica muita coisa: não há captura de tela, não há
 * injeção de teclado, não há senha para guardar, não há pedido de permissão
 * para aprovar. O celular só pede, recebe imagem e manda comandos.
 *
 * A consequência prática mais importante é de segurança: nada que chegue do
 * outro lado consegue mexer neste aparelho. O pior que um PC malicioso pode
 * fazer é mandar uma imagem ruim.
 *
 * O protocolo é o mesmo do PC, byte a byte (ver `src/shared/`), então um
 * celular conversa com um Ryke Desk de desktop sem nenhuma tradução no meio.
 */
import {
  CTRL_CHANNEL,
  FILE_CHANNEL,
  INPUT_CHANNEL,
  type CtrlMessage,
  type SignalPayload,
} from '../shared/protocol';
import type { Malha } from '../shared/malha';
import { carimbar, carimboConfere } from './auth';
import { Vigilancia } from '../shared/vigilancia';

export type Estatisticas = {
  rtt: number;
  fps: number;
  kbps: number;
  width: number;
  height: number;
  /** Atraso da imagem em ms — o que a mão sente, e não o ping. */
  atraso: number;
  transporte: 'direto' | 'retransmitido' | '—';
};

export type MetaAnfitriao = {
  width: number;
  height: number;
  hostName: string;
  displays: { id: number; label: string; primary: boolean }[];
  activeDisplay: number;
};

/** Pulso pelo canal de controle. Ver a explicação em `vigilancia.ts`. */
const PULSO_MS = 3000;

export type EventosSessao = {
  /**
   * O que o computador respondeu ao pedido de Ctrl+Alt+Del.
   *
   * Existe porque este pedido pode ser RECUSADO: ele depende de uma política
   * do Windows que vem desligada. Sem a resposta, o botão falharia calado —
   * que era exatamente o defeito.
   */
  sas: (r: { ok: boolean; motivo: string }) => void;
  stream: (stream: MediaStream) => void;
  /**
   * A sessão está viva de verdade, ou só parece?
   *
   * O WebRTC diz "connected" muito depois de o caminho ter morrido. Numa rede
   * móvel isso é ainda mais comum: trocar de Wi-Fi para dados, ou passar por
   * uma torre diferente, muda o caminho por baixo sem avisar ninguém.
   */
  saude: (viva: boolean, motivo: string) => void;
  stats: (stats: Estatisticas) => void;
  meta: (meta: MetaAnfitriao) => void;
  pronta: () => void;
  encerrada: (motivo: string) => void;
};

/**
 * Endereços de descoberta. Iguais aos do PC — se um lado usasse outra lista,
 * os dois poderiam nunca achar um caminho em comum.
 */
export const ICE_MOVEL: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'stun:stun.nextcloud.com:443' },
  { urls: 'stun:stun.sipgate.net:3478' },
];

export class Sessao {
  readonly peerId: string;
  private pc: RTCPeerConnection;
  private malha: Malha;
  private ctrl: RTCDataChannel | null = null;
  /** Só movimento de ponteiro; sem entrega garantida. Ver INPUT_CHANNEL. */
  private canalPonteiro: RTCDataChannel | null = null;
  private candidatosPendentes: RTCIceCandidateInit[] = [];
  private descricaoRemotaPronta = false;
  private relogio: number | null = null;
  private ultBytes = 0;
  private ultQuando = 0;
  private ultEspera = { soma: 0, quadros: 0 };
  private encerrada = false;
  private receptor: RTCRtpReceiver | null = null;

  /** Vigilância: o que impede a sessão de congelar em silêncio. */
  private vigia = new Vigilancia();
  private pulso: number | null = null;
  private ultimaMensagem = 0;
  private ultimoQuadro = 0;
  /** Quadros que o computador diz ter mandado; `null` se ele não informa. */
  private quadrosDoOutro: number | null = null;
  private recuperando = false;
  private viva = true;

  /** Derivada da senha; ausente no acesso supervisionado. */
  private chaveSessao: Uint8Array | null;

  streamRemoto: MediaStream | null = null;

  private ouvintes: { [K in keyof EventosSessao]: EventosSessao[K][] } = {
    sas: [],
    stream: [], stats: [], meta: [], pronta: [], encerrada: [], saude: [],
  };

  constructor(peerId: string, malha: Malha, iceServers: RTCIceServer[], chaveSessao: Uint8Array | null) {
    this.peerId = peerId;
    this.malha = malha;
    this.chaveSessao = chaveSessao;

    this.pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 4,
    });

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) this.malha.send(this.peerId, { t: 'ice', candidate: ev.candidate.toJSON() });
    };

    this.pc.onconnectionstatechange = () => {
      const estado = this.pc.connectionState;
      if (estado === 'connected') {
        this.iniciarEstatisticas();
        this.iniciarVigilancia();
        this.vigia.reiniciar(Date.now());
        this.recuperando = false;
        this.marcarSaude(true, 'conectado');
        this.emitir('pronta');
      } else if (estado === 'failed') {
        this.encerrar('não foi possível abrir o caminho até o computador');
      } else if (estado === 'disconnected') {
        // Oscilação de rede móvel é comum: trocar de Wi-Fi para dados, ou
        // passar por outra torre, muda o caminho. Em vez de esperar e
        // desistir, pedimos ao computador para refazer a negociação.
        this.conferirSaude();
      }
    };

    this.pc.ontrack = (ev) => {
      if (!ev.streams[0]) return;
      this.receptor = ev.receiver;
      this.encurtarBuffer(0);
      this.streamRemoto = ev.streams[0];
      this.emitir('stream', ev.streams[0]);
    };

    // Quem cria os canais é o anfitrião; aqui só os recebemos.
    this.pc.ondatachannel = (ev) => this.ligarCanal(ev.channel);
  }

  on<K extends keyof EventosSessao>(evento: K, fn: EventosSessao[K]): () => void {
    this.ouvintes[evento].push(fn);
    return () => {
      const lista = this.ouvintes[evento] as unknown[];
      const i = lista.indexOf(fn);
      if (i >= 0) lista.splice(i, 1);
    };
  }

  private emitir<K extends keyof EventosSessao>(evento: K, ...args: Parameters<EventosSessao[K]>): void {
    for (const fn of this.ouvintes[evento]) (fn as (...a: unknown[]) => void)(...args);
  }

  // ───────────────────────── sinalização ─────────────────────────

  async tratarSinal(dados: SignalPayload): Promise<void> {
    switch (dados.t) {
      case 'offer': {
        if (!this.sdpConfere(dados.sdp, dados.mac ?? null)) return;
        await this.pc.setRemoteDescription({ type: 'offer', sdp: dados.sdp });
        this.descricaoRemotaPronta = true;
        await this.escoarCandidatos();
        const resposta = await this.pc.createAnswer();
        await this.pc.setLocalDescription(resposta);
        const sdp = this.pc.localDescription!.sdp;
        this.malha.send(this.peerId, {
          t: 'answer',
          sdp,
          mac: this.chaveSessao ? carimbar(this.chaveSessao, sdp) : null,
        });
        return;
      }
      case 'ice': {
        const candidato = dados.candidate as RTCIceCandidateInit;
        if (!this.descricaoRemotaPronta) {
          this.candidatosPendentes.push(candidato);
          return;
        }
        await this.pc.addIceCandidate(candidato).catch(() => {});
        return;
      }
      case 'bye':
        this.encerrar(dados.reason ?? 'o outro computador encerrou a sessão');
        return;
    }
  }

  /**
   * Confere o carimbo do SDP.
   *
   * Sem senha (acesso supervisionado) não há segredo partilhado, então não há
   * carimbo a conferir — a garantia ali vem de uma pessoa ter clicado em
   * "Permitir" na tela do PC. Com senha, um SDP sem carimbo ou com carimbo
   * errado significa que alguém no meio mexeu na negociação, e aí a sessão
   * morre em vez de continuar.
   */
  private sdpConfere(sdp: string, mac: string | null): boolean {
    if (!this.chaveSessao) return true;
    if (!mac || !carimboConfere(this.chaveSessao, sdp, mac)) {
      this.encerrar('a identidade do computador não pôde ser verificada — conexão interrompida por segurança');
      return false;
    }
    return true;
  }

  private async escoarCandidatos(): Promise<void> {
    const fila = this.candidatosPendentes;
    this.candidatosPendentes = [];
    for (const c of fila) await this.pc.addIceCandidate(c).catch(() => {});
  }

  // ───────────────────────── canal de controle ─────────────────────────

  private ligarCanal(canal: RTCDataChannel): void {
    if (canal.label === CTRL_CHANNEL) {
      this.ctrl = canal;
      canal.onmessage = (ev) => this.aoReceberCtrl(ev.data);
    } else if (canal.label === INPUT_CHANNEL) {
      // Mesmas mensagens do "ctrl"; o que muda é a promessa de entrega do
      // transporte. Precisa ser aceito mesmo que o celular não leia nada dele:
      // ignorar o canal faria as mensagens que o computador manda por aqui
      // (a posição do cursor de lá) sumirem sem deixar rastro.
      this.canalPonteiro = canal;
      canal.onmessage = (ev) => this.aoReceberCtrl(ev.data);
    } else if (canal.label === FILE_CHANNEL) {
      // O celular não envia nem recebe arquivos nesta versão. O canal é aceito
      // e ignorado: recusá-lo derrubaria a negociação inteira, e o anfitrião
      // não tem como saber de antemão que do outro lado tem um telefone.
      canal.onmessage = () => {};
    }
  }

  private aoReceberCtrl(dados: unknown): void {
    // Qualquer mensagem que chega é prova de vida do canal.
    this.ultimaMensagem = Date.now();
    if (typeof dados !== 'string') return;
    let msg: CtrlMessage;
    try {
      msg = JSON.parse(dados);
    } catch {
      return;
    }
    if (msg.t === 'pong') {
      // Quantos quadros o computador já mandou. Sem este número, uma tela
      // parada — que não gera quadro nenhum — era lida como conexão morta, e a
      // sessão se fechava sozinha depois de alguns segundos de silêncio.
      this.quadrosDoOutro = typeof msg.q === 'number' ? msg.q : null;
      return;
    }
    if (msg.t === 'ping') {
      this.enviarCtrl({ t: 'pong', at: msg.at, q: this.ultimoQuadro });
      return;
    }
    if (msg.t === 'sas-result') {
      this.emitir('sas', { ok: msg.ok, motivo: msg.motivo });
      return;
    }
    if (msg.t === 'meta') {
      this.emitir('meta', {
        width: msg.width,
        height: msg.height,
        hostName: msg.hostName,
        displays: msg.displays,
        activeDisplay: msg.activeDisplay,
      });
    }
  }

  private enviarCtrl(msg: CtrlMessage): void {
    if (this.ctrl?.readyState !== 'open') return;
    try {
      this.ctrl.send(JSON.stringify(msg));
    } catch {
      /* canal caindo */
    }
  }

  /**
   * Manda pelo canal sem garantias, caindo no "ctrl" se ele não existir.
   *
   * A queda importa: um Ryke Desk anterior à 1.0.16 não cria o canal de
   * ponteiro, e arrastar o dedo não pode simplesmente parar de funcionar por
   * causa disso — volta ao caminho confiável, como antes, só sem o ganho.
   */
  private enviarRapido(msg: CtrlMessage): void {
    if (this.canalPonteiro?.readyState === 'open') {
      try {
        this.canalPonteiro.send(JSON.stringify(msg));
        return;
      } catch {
        /* canal caindo: tenta pelo confiável */
      }
    }
    this.enviarCtrl(msg);
  }

  // ───────────────────── comandos do visitante ─────────────────────

  // A única mensagem que pode se perder sem consequência: carrega a posição
  // absoluta, então a seguinte já corrige o que a anterior não entregou.
  moverMouse(x: number, y: number): void {
    this.enviarRapido({ t: 'mm', x, y });
  }
  botaoMouse(botao: 0 | 1 | 2, pressionado: boolean, x: number, y: number): void {
    this.enviarCtrl({ t: pressionado ? 'md' : 'mu', b: botao, x, y });
  }
  rolar(dx: number, dy: number, x: number, y: number): void {
    this.enviarCtrl({ t: 'wheel', dx, dy, x, y });
  }
  tecla(code: string, pressionada: boolean): void {
    this.enviarCtrl({ t: pressionada ? 'kd' : 'ku', code });
  }
  combinacao(codes: string[]): void {
    this.enviarCtrl({ t: 'combo', codes });
  }

  /**
   * Ctrl+Alt+Del — que não é uma combinação como as outras.
   *
   * As demais são injetadas com SendInput no computador. Esta não pode ser: o
   * Windows intercepta a Secure Attention Sequence antes de qualquer programa,
   * e é essa reserva que garante que a tela de bloqueio seja mesmo dele. Do
   * outro lado, este pedido vai para a API oficial (SendSAS).
   */
  sas(): void {
    this.enviarCtrl({ t: 'sas' });
  }
  /** Texto literal: é assim que acentos e emojis chegam sem depender de layout. */
  texto(valor: string): void {
    this.enviarCtrl({ t: 'text', value: valor });
  }
  escolherMonitor(id: number): void {
    this.enviarCtrl({ t: 'display', id });
  }
  qualidade(preset: 'auto' | 'baixa' | 'media' | 'alta'): void {
    this.enviarCtrl({ t: 'quality', preset });
  }

  // ───────────────────────── medições ─────────────────────────

  /**
   * Encurta a espera do vídeo antes de aparecer na tela.
   *
   * O navegador guarda quadros para reproduzir liso — ótimo para assistir a um
   * vídeo, ruim aqui: imagem lisa que chega atrasada é pior do que imagem
   * levemente irregular que chega junto com o toque do dedo.
   */
  private encurtarBuffer(segundos: number): void {
    const r = this.receptor as
      | (RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number | null })
      | null;
    if (!r) return;
    try {
      r.jitterBufferTarget = Math.round(segundos * 1000);
    } catch {
      /* WebView sem suporte */
    }
    try {
      r.playoutDelayHint = segundos;
    } catch {
      /* WebView sem suporte */
    }
  }

  /**
   * Vigilância da sessão.
   *
   * Mesma política do computador (`vigilancia.ts`), e por bom motivo: o
   * congelamento silencioso não é um defeito de plataforma, é o caminho
   * envelhecendo. No celular acontece até mais, porque a rede muda embaixo do
   * aparelho o tempo todo.
   */
  private iniciarVigilancia(): void {
    if (this.pulso !== null) return;
    this.ultimaMensagem = Date.now();
    this.pulso = window.setInterval(() => {
      if (this.encerrada) return;
      this.enviarCtrl({ t: 'ping', at: Date.now() });
      this.conferirSaude();
    }, PULSO_MS);
  }

  private conferirSaude(): void {
    if (this.encerrada) return;
    const decisao = this.vigia.avaliar({
      agora: Date.now(),
      ultimaMensagem: this.ultimaMensagem,
      quadros: this.ultimoQuadro,
      quadrosDoOutro: this.quadrosDoOutro,
      conexao: this.pc.connectionState,
    });
    this.marcarSaude(decisao.viva, decisao.motivo);
    if (decisao.acao === 'recuperar') this.pedirRenegociacao();
    if (decisao.acao === 'desistir') this.encerrar(`não foi possível restabelecer — ${decisao.motivo}`);
  }

  private marcarSaude(viva: boolean, motivo: string): void {
    if (this.viva === viva) return;
    this.viva = viva;
    this.emitir('saude', viva, motivo);
  }

  /** A sessão está respondendo agora? A interface usa para avisar. */
  get sessaoViva(): boolean {
    return this.viva;
  }

  /**
   * Pede ao computador para refazer o caminho.
   *
   * O pedido vai pela MALHA, e não pelo canal de dados: quando o caminho
   * direto morre, o canal morre junto e não serve para pedir socorro. A malha
   * é uma ligação separada, que continua de pé.
   */
  private pedirRenegociacao(): void {
    if (this.recuperando) return;
    this.recuperando = true;
    this.malha.send(this.peerId, { t: 'restart' });
    window.setTimeout(() => {
      this.recuperando = false;
    }, 8000);
  }

  private iniciarEstatisticas(): void {
    if (this.relogio !== null) return;
    this.relogio = window.setInterval(() => void this.coletar(), 1000);
  }

  private async coletar(): Promise<void> {
    if (this.encerrada) return;
    let relatorio: RTCStatsReport;
    try {
      relatorio = await this.pc.getStats();
    } catch {
      return;
    }

    const s: Estatisticas = { rtt: 0, fps: 0, kbps: 0, width: 0, height: 0, atraso: 0, transporte: '—' };
    const agora = performance.now();
    let trepidacao = 0;

    relatorio.forEach((e) => {
      if (e.type === 'inbound-rtp' && e.kind === 'video') {
        this.ultimoQuadro = e.framesDecoded ?? 0;
        s.fps = Math.round(e.framesPerSecond ?? 0);
        s.width = e.frameWidth ?? 0;
        s.height = e.frameHeight ?? 0;
        const bytes = e.bytesReceived ?? 0;
        if (this.ultQuando > 0 && bytes >= this.ultBytes) {
          const segundos = (agora - this.ultQuando) / 1000;
          s.kbps = Math.round(((bytes - this.ultBytes) * 8) / 1000 / Math.max(segundos, 0.001));
        }
        this.ultBytes = bytes;

        trepidacao = e.jitter ?? 0;
        // Diferença entre duas leituras, e não a média da sessão inteira: o
        // acumulado ficaria preso aos primeiros segundos e demoraria minutos
        // para refletir uma melhora.
        const soma = e.jitterBufferDelay ?? 0;
        const quadros = e.jitterBufferEmittedCount ?? 0;
        const novosQuadros = quadros - this.ultEspera.quadros;
        const novaEspera = soma - this.ultEspera.soma;
        if (novosQuadros > 0 && novaEspera >= 0) s.atraso = Math.round((novaEspera / novosQuadros) * 1000);
        this.ultEspera = { soma, quadros };
      }
      if (e.type === 'candidate-pair' && e.state === 'succeeded' && e.nominated) {
        s.rtt = Math.round((e.currentRoundTripTime ?? 0) * 1000);
      }
      if (e.type === 'local-candidate' && e.candidateType === 'relay') s.transporte = 'retransmitido';
    });

    if (s.transporte === '—') s.transporte = 'direto';
    this.conferirSaude();
    // Buffer proporcional à trepidação: quase nada em rede boa, um respiro em
    // rede móvel instável, onde zerar produziria engasgo em vez de fluidez.
    this.encurtarBuffer(Math.min(0.25, trepidacao * 2.5));
    this.ultQuando = agora;
    this.emitir('stats', s);
  }

  encerrar(motivo: string): void {
    if (this.encerrada) return;
    this.encerrada = true;
    if (this.relogio !== null) {
      clearInterval(this.relogio);
      this.relogio = null;
    }
    if (this.pulso !== null) {
      clearInterval(this.pulso);
      this.pulso = null;
    }
    try {
      this.malha.send(this.peerId, { t: 'bye', reason: motivo });
    } catch {
      /* já sem caminho */
    }
    try {
      this.pc.close();
    } catch {
      /* já fechado */
    }
    this.emitir('encerrada', motivo);
  }
}
