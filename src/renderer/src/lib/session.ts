import {
  CTRL_CHANNEL,
  FILE_CHANNEL,
  INPUT_CHANNEL,
  type CtrlMessage,
  type FileControl,
  type SignalPayload,
} from '../../../shared/protocol';
import { FileEngine, type ChunkSource, type ClipboardBatch } from './files';
import { Adaptador } from '../../../shared/adaptacao';
import { Vigilancia } from '../../../shared/vigilancia';
import type { Signaling } from './signaling';
import type { Quality } from '../../../shared/config';
import type { TipoCursor } from '../../../shared/protocol';
import type { BotaoMouse } from '../../../shared/botoes';
import { maiorQualidade, PERFIS_CAPTURA_SOFTWARE } from '../../../shared/qualidade-captura';
import { PERFIS_QUALIDADE, ALTURA_MAX_AUTO, escalaParaAltura } from '../../../shared/qualidade-video';
import type { Ponteiro } from '../../../shared/ponteiros';

/**
 * Uma sessão remota estabelecida, dos dois pontos de vista.
 *
 * O anfitrião é sempre quem faz a oferta SDP (é ele que tem o vídeo) e quem
 * cria os canais de dados; o visitante responde. Com os papéis fixos assim,
 * não precisamos da dança de "negociação perfeita" — não existe cenário em
 * que os dois lados ofereçam ao mesmo tempo.
 */

export type Role = 'anfitriao' | 'visitante';

export type { Quality };

export type LiveStats = {
  rtt: number;
  fps: number;
  kbps: number;
  width: number;
  height: number;
  /** Direto = P2P puro; retransmitido = passando por um servidor TURN. */
  transport: 'direto' | 'retransmitido' | '—';
  /**
   * Atraso da imagem em ms — o tempo entre o quadro sair de lá e aparecer aqui.
   *
   * Diferente do RTT: este inclui a espera no buffer de reprodução, que é onde
   * mora a maior parte do "delayzinho" percebido. É o número que importa para
   * quem está mexendo o mouse.
   */
  atraso: number;
  /** O que o ajuste automático está fazendo agora, em português. */
  ajuste: string;
  /**
   * O codec de vídeo em uso — H264, VP9, VP8, AV1. É o número que diz, num
   * relance, se a imagem está sendo codificada por hardware (H264 na esmagadora
   * maioria das GPUs) ou arrastando o processador em software. Fica na barra de
   * status justamente para diagnosticar lentidão sem adivinhação.
   */
  codec: string;
  /**
   * A imagem está sendo codificada por HARDWARE ou por SOFTWARE?
   *
   * É o número que decide a briga contra o atraso. Codificar a tela por software
   * é o que faz "digito e só aparece dois segundos depois"; por hardware, o
   * atraso some. Vem do `encoderImplementation`/`decoderImplementation` do
   * WebRTC — nomes como "MediaFoundation…"/"…Accelerator" são hardware; "libvpx",
   * "OpenH264" são software.
   */
  aceleracao: 'hardware' | 'software' | '';
};

export type SessionEvents = {
  stream: (stream: MediaStream) => void;
  stats: (stats: LiveStats) => void;
  /** Geometria e monitores do anfitrião, recebidos pelo visitante. */
  meta: (meta: Extract<CtrlMessage, { t: 'meta' }>) => void;
  /**
   * Onde o cursor do anfitrião está, em fração da tela.
   *
   * Chega uma vintena de vezes por segundo, e por isso não vira estado do
   * React: quem escuta move um elemento pelo estilo, sem redesenhar a árvore.
   */
  cursor: (ponto: { x: number; y: number; tipo?: TipoCursor }) => void;
  /**
   * "A SUA seta agora tem esta forma."
   *
   * Só no visitante: o anfitrião conta que forma o cursor assumiria onde a seta
   * deste visitante está, e a interface troca a forma do próprio cursor do
   * sistema — sem perder a cor que identifica cada um.
   */
  formaPropria: (tipo: TipoCursor) => void;
  /**
   * "A sua seta é esta cor, e este é o nome que vai escrito embaixo dela."
   *
   * Chega uma vez, logo depois de a sessão subir. É o que permite ao visitante
   * pintar o PRÓPRIO cursor do sistema: o primeiro que entrou fica vermelho, o
   * segundo azul, o terceiro verde.
   */
  cor: (cor: { indice: number; nome: string }) => void;
  /**
   * As setas dos OUTROS — os demais visitantes conectados ao mesmo anfitrião.
   *
   * Como `cursor`, chega dezenas de vezes por segundo e por isso não vira
   * estado do React: quem escuta move elementos pelo estilo.
   */
  ponteiros: (lista: Ponteiro[]) => void;
  installer: (result: { ok: boolean; canceled?: boolean; message: string }) => void;
  /** O que o outro lado respondeu ao pedido de Ctrl+Alt+Del. */
  sas: (result: { ok: boolean; motivo: string }) => void;
  transfers: () => void;
  closed: (reason: string) => void;
  ready: () => void;
  /**
   * A sessão está viva de verdade, ou só parece?
   *
   * `connectionState` do WebRTC diz "connected" muito depois de o caminho ter
   * morrido — foi exatamente esse otimismo que deixava a sessão congelada sem
   * ninguém perceber. Este evento vem da medição real: pulso respondido e
   * quadros avançando.
   */
  saude: (viva: boolean, motivo: string) => void;
};

/**
 * De quanto em quanto tempo o pulso é enviado pelo canal de controle.
 *
 * O protocolo já previa ping e pong, e o código respondia ao ping — mas nada
 * nunca ENVIAVA um. Na prática não havia keepalive nenhum, e era por isso que
 * uma sessão podia morrer sem que nada percebesse.
 */
const PULSO_MS = 3000;

/**
 * Traduz o nome do codificador/decodificador do WebRTC em "hardware" ou
 * "software".
 *
 * O WebRTC não expõe um sinalzinho limpo; expõe o NOME da implementação, e é
 * pelo nome que se sabe. "MediaFoundation…", "…Accelerator", "NvEnc", "D3D",
 * "Vaapi", "QuickSync", "ExternalEncoder/Decoder" são caminhos de hardware.
 * "libvpx", "OpenH264", "ffmpeg", "dav1d" são software. Na dúvida, devolve ''.
 */
function classificarAceleracao(impl: string): 'hardware' | 'software' | '' {
  const s = impl.toLowerCase();
  if (/mediafoundation|accelerat|nvenc|nvdec|d3d|vaapi|quicksync|external|hardware|vda|vea/.test(s)) return 'hardware';
  if (/libvpx|openh264|ffmpeg|dav1d|software|fallbackfromsw|internal/.test(s)) return 'software';
  return '';
}

export class Session {
  readonly role: Role;
  readonly peerId: string;

  private pc: RTCPeerConnection;
  private signaling: Signaling;
  private ctrl: RTCDataChannel | null = null;
  private fileChannel: RTCDataChannel | null = null;
  /** Só movimento de ponteiro; sem entrega garantida. Ver INPUT_CHANNEL. */
  private inputChannel: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private statsTimer: number | null = null;
  private lastBytes = 0;
  private lastStatsAt = 0;
  /** Última vez que despejei um resumo da sessão no arquivo de diagnóstico. */
  private ultimoDiag = 0;
  private unsubscribers: (() => void)[] = [];
  private disposed = false;
  private quality: Quality = 'auto';
  /** Só no visitante: por onde o vídeo entra, para regular o buffer. */
  private receptorVideo: RTCRtpReceiver | null = null;
  /** Só no anfitrião: quem decide a qualidade quando o preset é 'auto'. */
  private adaptador = new Adaptador();
  private ultimoAjuste = 0;
  /** Para calcular perda e taxa entre duas medidas. */
  private ultPacotes = { perdidos: 0, total: 0 };
  /**
   * Acumuladores do atraso, para medir o instante em vez da média da vida.
   *
   * `jitterBufferDelay` e `jitterBufferEmittedCount` do WebRTC são somas desde
   * o início da sessão. Dividir um pelo outro dá a média de TODA a sessão —
   * que fica presa aos primeiros segundos, quando o buffer ainda estava
   * cheio, e demora minutos para refletir uma melhora. A diferença entre duas
   * leituras dá o que está acontecendo agora, que é o que o usuário sente.
   */
  private ultEspera = { soma: 0, quadros: 0 };

  /** Vigilância da sessão — o que faltava para sessões longas não morrerem. */
  private pulso: number | null = null;
  private ultimoPong = 0;
  private ultimoQuadro = 0;
  /** Quadros que o outro lado diz ter mandado; `null` se ele não informa. */
  private quadrosDoOutro: number | null = null;
  /** Decide sozinha quando a sessão morreu e o que fazer. Ver `vigilancia.ts`. */
  private vigia = new Vigilancia();
  private recuperando = false;
  private viva = true;
  /** Registrado no dono da captura compartilhada; removido ao encerrar. */
  private consumidorTela: ConsumidorTela | null = null;

  engine: FileEngine | null = null;
  /** Vídeo recebido do anfitrião (só existe no lado visitante). */
  remoteStream: MediaStream | null = null;

  private listeners: { [K in keyof SessionEvents]: SessionEvents[K][] } = {
    stream: [], stats: [], meta: [], cursor: [], formaPropria: [], cor: [], ponteiros: [], installer: [], sas: [],
    transfers: [], closed: [], ready: [], saude: [],
  };

  constructor(role: Role, peerId: string, signaling: Signaling, iceServers: RTCIceServer[]) {
    this.role = role;
    this.peerId = peerId;
    this.signaling = signaling;

    this.pc = new RTCPeerConnection({
      iceServers,
      // Junta todo o tráfego numa única porta: menos furos de NAT para abrir,
      // conexão estabelecida mais rápido.
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 4,
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.signaling.send(this.peerId, { t: 'ice', candidate: event.candidate.toJSON() });
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'connected') {
        this.startStats();
        this.iniciarVigilancia();
        this.vigia.reiniciar(Date.now());
        this.recuperando = false;
        this.marcarSaude(true, 'conectado');
        this.emit('ready');
      } else if (state === 'failed') {
        this.close('não foi possível estabelecer o caminho entre os dois computadores');
      } else if (state === 'disconnected') {
        // 'disconnected' costuma ser passageiro (troca de rede, Wi-Fi
        // oscilando). Antes esperávamos 12 segundos e desistíamos; agora
        // tentamos refazer o caminho, que é o que resolve de verdade quando a
        // operadora troca o mapeamento no meio de uma sessão longa.
        this.conferirSaude();
      }
    };

    this.pc.ontrack = (event) => {
      if (!event.streams[0]) return;
      this.receptorVideo = event.receiver;
      this.ajustarBufferDeReproducao(0);
      // Guardado além de emitido: o vídeo chega durante a negociação, antes de
      // o componente do visualizador existir, e ele precisa poder buscá-lo.
      this.remoteStream = event.streams[0];
      this.emit('stream', event.streams[0]);
    };

    // O visitante recebe os canais criados pelo anfitrião.
    this.pc.ondatachannel = (event) => this.attachChannel(event.channel);
  }

  on<K extends keyof SessionEvents>(event: K, fn: SessionEvents[K]): () => void {
    this.listeners[event].push(fn);
    return () => {
      const list = this.listeners[event] as unknown[];
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  private emit<K extends keyof SessionEvents>(event: K, ...args: Parameters<SessionEvents[K]>): void {
    for (const fn of this.listeners[event]) (fn as (...a: unknown[]) => void)(...args);
  }

  // ───────────────────── estabelecimento ──────────────────────

  /** Anfitrião: captura a tela, cria os canais e envia a oferta. */
  async prepareAsHost(quality: Quality): Promise<void> {
    this.quality = quality;

    this.consumidorTela = {
      qualidade: quality,
      atualizar: (stream) => this.atualizarTelaCapturada(stream),
      falhar: (reason) => this.close(reason),
    };
    const stream = await pegarTela(this.consumidorTela);
    this.localStream = stream;
    // Aterrissa no arquivo de diagnóstico a informação que decide tudo: a
    // captura pegou o caminho rápido do Windows ou caiu na rota lenta? E, se
    // caiu, POR QUÊ? É o que eu leio do disco depois, sem depender de reproduzir.
    const trilha = stream.getVideoTracks()[0];
    const cfg = trilha?.getSettings();
    const rota = capturaEstaPorSoftware() ? 'SOFTWARE (rota lenta)' : 'hardware (getDisplayMedia)';
    window.ryke.diag.log(
      `[host] captura=${rota} qualidade=${quality} fonte=${cfg?.width ?? '?'}x${cfg?.height ?? '?'}@${Math.round(cfg?.frameRate ?? 0)}` +
        (capturaEstaPorSoftware() ? ` | motivo: ${motivoDaCapturaSoftware()}` : ''),
    );
    for (const track of stream.getTracks()) this.pc.addTrack(track, stream);
    this.preferirCodec();

    this.attachChannel(this.pc.createDataChannel(CTRL_CHANNEL, { ordered: true }));
    this.attachChannel(this.pc.createDataChannel(FILE_CHANNEL, { ordered: true }));
    // Sem ordem e sem retransmissão: posição de ponteiro velha não interessa a
    // ninguém, e esperar por ela era o que fazia o mouse andar aos solavancos.
    this.attachChannel(this.pc.createDataChannel(INPUT_CHANNEL, { ordered: false, maxRetransmits: 0 }));
  }

  /**
   * Faz o codificador preferir H.264.
   *
   * É a mudança que mais aproxima o Ryke Desk de um AnyDesk em ATRASO e em
   * imagem por bit. O padrão do Chromium para tela costuma ser VP8/VP9 em
   * SOFTWARE — e software encodando a tela é justamente o que enche a fila de
   * codificação e faz o "digito e só aparece dois segundos depois". O H.264 é
   * aceito por praticamente toda GPU de Windows para codificar POR HARDWARE:
   * sai do caminho do processador, o atraso despenca e a nitidez sobe.
   *
   * `setCodecPreferences` só REORDENA o que já foi oferecido, então é seguro: se
   * não houver H.264 numa máquina, ela simplesmente continua no próximo da fila
   * (VP9, VP8), sem quebrar a negociação. Mantemos a lista inteira — inclusive
   * rtx/red/ulpfec — só empurrando o H.264 para a frente.
   */
  private preferirCodec(): void {
    try {
      const cap = RTCRtpSender.getCapabilities('video');
      if (!cap?.codecs) return;
      const posicao = (mime: string): number => {
        switch (mime.toLowerCase()) {
          case 'video/h264':
            return 0;
          case 'video/vp9':
            return 1;
          case 'video/vp8':
            return 2;
          case 'video/av1':
            return 3;
          default:
            return 4; // rtx/red/ulpfec ficam depois dos codecs de vídeo reais
        }
      };
      const ordenados = [...cap.codecs].sort((a, b) => posicao(a.mimeType) - posicao(b.mimeType));
      const transceptor = this.pc.getTransceivers().find((t) => t.sender.track?.kind === 'video');
      transceptor?.setCodecPreferences(ordenados);
    } catch {
      /* navegador sem setCodecPreferences: segue no padrão, sem prejuízo */
    }
  }

  /** Envia a oferta somente depois que o visitante recebeu `accepted`. */
  async offerAsHost(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const sdp = this.pc.localDescription!.sdp;
    this.signaling.send(this.peerId, { t: 'offer', sdp, mac: await window.ryke.auth.sdpMac(this.peerId, sdp) });

    await this.applyQuality(this.quality);
  }

  /** Mantido como operação completa para chamadas que não precisam separar a preparação. */
  async startAsHost(quality: Quality): Promise<void> {
    await this.prepareAsHost(quality);
    await this.offerAsHost();
  }

  /** Ambos os lados: processa o que chega pela sinalização. */
  async handleSignal(data: SignalPayload): Promise<void> {
    switch (data.t) {
      case 'offer': {
        if (!(await this.sdpConfere(data.sdp, data.mac ?? null))) return;
        await this.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        this.remoteDescriptionSet = true;
        await this.drainCandidates();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        const sdp = this.pc.localDescription!.sdp;
        this.signaling.send(this.peerId, { t: 'answer', sdp, mac: await window.ryke.auth.sdpMac(this.peerId, sdp) });
        return;
      }
      case 'answer': {
        if (!(await this.sdpConfere(data.sdp, data.mac ?? null))) return;
        await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        this.remoteDescriptionSet = true;
        await this.drainCandidates();
        return;
      }
      case 'ice': {
        // Candidatos podem chegar antes da descrição remota; guardamos até lá.
        if (!this.remoteDescriptionSet) this.pendingCandidates.push(data.candidate);
        else await this.pc.addIceCandidate(data.candidate).catch(() => {});
        return;
      }
      case 'restart': {
        // Só o anfitrião faz oferta nesta sessão; o visitante pediu socorro
        // pela malha porque o caminho direto parou de servir.
        if (this.role === 'anfitriao') await this.refazerOferta();
        return;
      }
      case 'bye':
        this.close(data.reason ?? 'o outro computador encerrou a sessão');
        return;
    }
  }

  /**
   * Confere o carimbo do SDP antes de aceitá-lo.
   *
   * Um carimbo inválido significa que a descrição da sessão foi reescrita no
   * caminho — o cenário clássico de alguém no meio trocando as impressões
   * digitais DTLS para decifrar tela e teclado. Aí não há o que negociar: a
   * sessão morre na hora.
   */
  private async sdpConfere(sdp: string, mac: string | null): Promise<boolean> {
    const veredito = await window.ryke.auth.checkSdpMac(this.peerId, sdp, mac);
    if (veredito === 'invalido') {
      this.close('a identidade do outro computador não pôde ser verificada — conexão interrompida por segurança');
      return false;
    }
    // 'sem-chave' = acesso supervisionado, onde não existe senha para derivar
    // carimbo. Quem autorizou está na frente da tela.
    return true;
  }

  private async drainCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) await this.pc.addIceCandidate(candidate).catch(() => {});
  }

  // ──────────────────────── canais ────────────────────────────

  private attachChannel(channel: RTCDataChannel): void {
    if (channel.label === CTRL_CHANNEL) {
      this.ctrl = channel;
      channel.onmessage = (event) => void this.onCtrlMessage(event.data);
      channel.onopen = () => this.onCtrlOpen();
    } else if (channel.label === INPUT_CHANNEL) {
      // Mesmo tratamento das mensagens do "ctrl": o que muda é só a promessa
      // de entrega do transporte, não o que as mensagens significam.
      this.inputChannel = channel;
      channel.onmessage = (event) => void this.onCtrlMessage(event.data);
    } else if (channel.label === FILE_CHANNEL) {
      this.fileChannel = channel;
      channel.binaryType = 'arraybuffer';
      this.engine = new FileEngine(channel, () => this.emit('transfers'));
      // Binário = pedaço de arquivo; texto = controle da transferência. Os
      // dois pelo mesmo canal, e processados em fila, para que a ordem de
      // chegada seja também a ordem de tratamento.
      channel.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer || typeof event.data === 'string') {
          this.engine?.accept(event.data);
        }
      };
    }
  }

  private onCtrlOpen(): void {
    // Área de transferência espelhada nos dois sentidos — quando permitido.
    // Enquanto a sessão existe, TUDO o que se copia aqui atravessa para o
    // outro lado, então isto respeita a preferência do usuário.
    void window.ryke.settings.get().then((cfg) => {
      this.espelharClipboard = cfg.syncClipboard;
      if (!cfg.syncClipboard) return;
      this.unsubscribers.push(
        window.ryke.clipboard.onText((text) => this.sendCtrl({ t: 'clip', value: text })),
      );
      void window.ryke.clipboard.read().then((text) => {
        if (text) this.sendCtrl({ t: 'clip', value: text });
      });
    });

    if (this.role === 'anfitriao') void this.publishMeta();
  }

  /** Preferência local; também barra o que CHEGA, não só o que sai. */
  private espelharClipboard = true;

  sendCtrl(msg: CtrlMessage | FileControl): void {
    if (this.ctrl?.readyState === 'open') this.ctrl.send(JSON.stringify(msg));
  }

  /**
   * Manda pelo canal sem garantias, caindo no "ctrl" se ele não existir.
   *
   * A queda importa: um Ryke Desk mais antigo do outro lado não cria o canal
   * de ponteiro, e o movimento do mouse não pode simplesmente parar de
   * funcionar por causa disso — volta a andar pelo caminho confiável, como
   * antes, só sem o ganho.
   */
  private sendRapido(msg: CtrlMessage): void {
    if (this.inputChannel?.readyState === 'open') {
      this.inputChannel.send(JSON.stringify(msg));
      return;
    }
    this.sendCtrl(msg);
  }

  private async onCtrlMessage(raw: unknown): Promise<void> {
    if (typeof raw !== 'string') return;
    let msg: CtrlMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.t === 'clip') {
      // Desligado, também não deixamos a área de transferência local ser
      // sobrescrita pelo outro lado — a preferência vale nos dois sentidos.
      if (this.espelharClipboard) await window.ryke.clipboard.write(msg.value);
      return;
    }

    // Qualquer mensagem que chega é prova de vida do canal — não só o pong.
    this.ultimoPong = Date.now();
    if (msg.t === 'pong') {
      // Quantos quadros o outro lado já mandou. É o que impede a vigilância de
      // confundir uma tela quieta — que não gera quadro nenhum — com um
      // caminho de rede morto, e derrubar uma sessão perfeitamente viva.
      this.quadrosDoOutro = typeof msg.q === 'number' ? msg.q : null;
      return;
    }
    if (msg.t === 'ping') {
      this.sendCtrl({ t: 'pong', at: msg.at, q: this.ultimoQuadro });
      return;
    }

    if (this.role === 'visitante') {
      if (msg.t === 'meta') this.emit('meta', msg);
      if (msg.t === 'cursor') this.emit('cursor', { x: msg.x, y: msg.y, tipo: msg.tipo });
      if (msg.t === 'cursor-forma') this.emit('formaPropria', msg.tipo);
      if (msg.t === 'cor') this.emit('cor', { indice: msg.indice, nome: msg.nome });
      if (msg.t === 'ponteiros') this.emit('ponteiros', msg.lista);
      if (msg.t === 'sas-result') this.emit('sas', { ok: msg.ok, motivo: msg.motivo });
      if (msg.t === 'run-installer-result') {
        this.emit('installer', { ok: msg.ok, canceled: msg.canceled, message: msg.message });
      }
      return;
    }

    // Daqui para baixo: só o anfitrião, e só depois de a senha ter sido aceita.
    switch (msg.t) {
      case 'mm':
        // NÃO move o cursor do Windows daqui — move a seta virtual DESTE
        // visitante. Ver `input:move` no processo principal e o porquê inteiro
        // em shared/ponteiros.ts.
        window.ryke.input.move(this.peerId, msg.x, msg.y);
        break;
      case 'md':
      case 'mu':
        window.ryke.input.button(this.peerId, msg.b, msg.t === 'md', msg.x, msg.y);
        break;
      case 'mr':
        window.ryke.input.moveRel(this.peerId, msg.dx, msg.dy);
        break;
      case 'gamer':
        window.ryke.input.gamer(this.peerId, msg.on);
        break;
      case 'mrb':
        window.ryke.input.buttonRel(msg.b, msg.down);
        break;
      case 'wheel':
        window.ryke.input.wheel(this.peerId, msg.dx, msg.dy, msg.x, msg.y);
        break;
      case 'kd':
      case 'ku':
        window.ryke.input.key(msg.code, msg.t === 'kd');
        break;
      case 'combo':
        window.ryke.input.combo(msg.codes);
        break;
      case 'sas': {
        // Não é injeção de tecla: vai para a API SendSAS, e a resposta volta —
        // o pedido pode ser recusado pela política do Windows daqui.
        const r = await window.ryke.input.sas();
        this.sendCtrl({ t: 'sas-result', ok: r.ok, motivo: r.motivo });
        break;
      }
      case 'text':
        window.ryke.input.text(msg.value);
        break;
      case 'display':
        await window.ryke.screen.select(msg.id);
        // Trocar apenas o id fazia mouse e metadados mudarem, mas o vídeo
        // continuava preso na tela anterior. replaceTrack mantém o WebRTC e os
        // canais de teclado/arquivos vivos durante a troca real da captura.
        await recapturarTelaCompartilhada();
        break;
      case 'run-installer': {
        const result = await window.ryke.programas.instalar();
        this.sendCtrl({ t: 'run-installer-result', ...result });
        break;
      }
      case 'quality':
        await this.applyQuality(msg.preset);
        break;
      case 'block-input':
        await window.ryke.input.blockLocal(msg.on);
        break;
      case 'admin':
        // O visitante mandou o anfitrião trocar de modo. Reabre o processo do
        // anfitrião elevado (sem UAC, via tarefa) ou normal. A sessão cai; o
        // visitante reconecta. Ver CtrlAdmin no protocolo para o porquê.
        if (msg.ligar) await window.ryke.modo.elevar();
        else await window.ryke.modo.normal();
        break;
    }
  }

  /** Visitante: pede ao anfitrião para entrar/sair do modo administrador. */
  enviarModoAdmin(ligar: boolean): void {
    this.sendCtrl({ t: 'admin', ligar });
  }

  /** Anfitrião: informa ao visitante a geometria e a lista de monitores. */
  private async publishMeta(): Promise<void> {
    const [active, displays, info, gpu] = await Promise.all([
      window.ryke.screen.active(),
      window.ryke.screen.list(),
      window.ryke.app.info(),
      window.ryke.gpu.status().catch(() => null),
    ]);
    this.sendCtrl({
      t: 'meta',
      width: active.width,
      height: active.height,
      scaleFactor: active.scaleFactor,
      hostName: info.machineName,
      displays: displays.map((d) => ({ id: d.id, label: d.label, primary: d.primary })),
      activeDisplay: active.id,
      hostGpu: gpu ? { nome: gpu.nome, encode: gpu.encode, decode: gpu.decode } : undefined,
      hostCapturaSoftware: capturaEstaPorSoftware(),
      hostCapturaMotivo: motivoDaCapturaSoftware() || undefined,
      hostElevado: info.elevated,
    });
  }

  /** Substitui a fonte de vídeo sem renegociar nem derrubar a sessão. */
  private async atualizarTelaCapturada(stream: MediaStream): Promise<void> {
    if (this.disposed || this.role !== 'anfitriao') return;
    const video = stream.getVideoTracks()[0] ?? null;
    if (!video) throw new Error('a nova tela não forneceu uma faixa de vídeo');

    const videoSender = this.pc.getSenders().find((sender) => sender.track?.kind === 'video');
    if (!videoSender) throw new Error('a sessão não possui um transmissor de vídeo');
    await videoSender.replaceTrack(video);

    const audio = stream.getAudioTracks()[0] ?? null;
    const audioSender = this.pc.getSenders().find((sender) => sender.track?.kind === 'audio');
    if (audioSender) await audioSender.replaceTrack(audio);

    this.localStream = stream;
    await this.applyQuality(this.quality);
    await this.publishMeta();
  }

  // ─────────────────────── qualidade ──────────────────────────

  async applyQuality(preset: Quality): Promise<void> {
    this.quality = preset;
    if (this.role === 'visitante') {
      this.sendCtrl({ t: 'quality', preset });
      return;
    }

    // Na captura por software a fonte também precisa mudar. O laço que gera
    // quadros consulta este valor antes de cada imagem, sem reiniciar sessão.
    if (this.consumidorTela) this.consumidorTela.qualidade = preset;

    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender?.track) return;

    // E na captura normal, a fonte é o próprio Windows: pedir mais bits sem
    // pedir mais quadros deixaria "Alta" parecendo média para sempre, porque o
    // codificador só comprime o que foi fotografado. Reaplicar a restrição
    // muda a taxa da captura viva, sem derrubar a sessão nem renegociar.
    await sender.track
      .applyConstraints({ frameRate: { ideal: quadrosDaCaptura(), max: quadrosDaCaptura() } })
      .catch(() => {
        /* fonte que não aceita reconfiguração continua na taxa em que nasceu */
      });

    const profile = PERFIS_QUALIDADE[preset];
    // contentHint diz ao codificador se ele deve preservar nitidez de texto
    // ou suavidade de movimento — muda bastante o resultado em tela cheia.
    sender.track.contentHint = profile.hint;

    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.degradationPreference = profile.degradation;

    // A ESCALA AGORA MIRA UMA ALTURA, NÃO UM FATOR FIXO. É o conserto do
    // "baixar a qualidade não adianta": numa tela grande, encolher para 720p /
    // 1080p corta de verdade a área que o codificador comprime — menos
    // processador, fila mais curta, menos atraso — em vez de só apertar a banda
    // e borrar a imagem à toa. Lê a resolução VIVA da captura a cada chamada.
    const escala = escalaParaAltura(this.alturaDaFonte(), profile.alturaAlvo);

    if (preset === 'auto') {
      // Em 'auto' quem manda na taxa é o adaptador, que mede a rede a cada
      // dois segundos. Fixar um número aqui seria disputar o volante com ele:
      // este valor vale só até a primeira medida chegar. A altura já começa no
      // teto do automático; o adaptador só desce a partir daí.
      this.ultimoAjuste = 0;
      params.encodings[0].maxBitrate = profile.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = escala;
      delete params.encodings[0].maxFramerate;
    } else {
      // Escolha manual é ordem, não sugestão: fica exatamente como foi pedida.
      params.encodings[0].maxBitrate = profile.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = escala;
      if (profile.framerate) params.encodings[0].maxFramerate = profile.framerate;
      else delete params.encodings[0].maxFramerate;
    }
    await sender.setParameters(params).catch(() => {});
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  /**
   * Altura, em linhas, da tela que está sendo capturada agora.
   *
   * É a resolução real da fonte, lida da própria trilha de vídeo — é sobre ela
   * que o fator de escala mira uma altura-alvo. Sem trilha viva ainda, assume
   * 1080p: um palpite seguro que a primeira volta do ajuste já corrige.
   */
  private alturaDaFonte(): number {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    const altura = sender?.track?.getSettings().height;
    return typeof altura === 'number' && altura > 0 ? altura : 1080;
  }

  /**
   * Encurta a espera do vídeo antes de aparecer na tela.
   *
   * O navegador guarda quadros recebidos por um tempo para absorver variação
   * de rede e reproduzir tudo liso. Faz todo sentido para assistir a um vídeo,
   * e atrapalha aqui: numa área de trabalho remota, imagem lisa que chega
   * atrasada é pior do que imagem levemente irregular que chega junto com o
   * movimento do mouse.
   *
   * `jitterBufferTarget` é o campo padrão; `playoutDelayHint` é o antecessor
   * do Chromium. Escrevemos nos dois porque não custa nada e cobre versões
   * diferentes — e envolvemos em try, porque é recurso que pode não existir.
   */
  private ajustarBufferDeReproducao(segundos: number): void {
    const receptor = this.receptorVideo as
      | (RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number | null })
      | null;
    if (!receptor) return;
    try {
      receptor.jitterBufferTarget = Math.round(segundos * 1000); // em ms
    } catch {
      /* navegador sem suporte */
    }
    try {
      receptor.playoutDelayHint = segundos; // em segundos
    } catch {
      /* navegador sem suporte */
    }
  }

  /**
   * Ajuste automático da qualidade, no anfitrião.
   *
   * Só age no preset 'auto'. Quem escolheu "nítido" ou "fluido" à mão pediu
   * um comportamento específico, e mexer nisso seria desobedecer — a escolha
   * manual continua exatamente como era.
   */
  private ajustarQualidade(
    banca: number | null,
    rtt: number,
    perdidos: number,
    totalPacotes: number,
    limitacao: 'none' | 'bandwidth' | 'cpu' | 'other',
  ): string {
    if (this.quality !== 'auto') return '';

    // Perda é acumulada desde o início da sessão; o que interessa é o que
    // aconteceu desde a última medida.
    const novosPerdidos = Math.max(0, perdidos - this.ultPacotes.perdidos);
    const novosEnviados = Math.max(1, totalPacotes - this.ultPacotes.total);
    this.ultPacotes = { perdidos, total: totalPacotes };
    const perda = Math.min(1, novosPerdidos / novosEnviados);

    const decisao = this.adaptador.decidir({ bancaDisponivel: banca, rtt, perda, limitacao });

    // Aplicar a cada volta faria o codificador reiniciar à toa. Só mexemos
    // quando a mudança é grande o bastante para o olho notar.
    const mudouMuito = Math.abs(decisao.maxBitrate - this.ultimoAjuste) > this.ultimoAjuste * 0.12;
    if (mudouMuito || this.ultimoAjuste === 0) {
      this.ultimoAjuste = decisao.maxBitrate;
      void this.aplicarEncoding(decisao.maxBitrate, decisao.maxFramerate, decisao.scaleResolutionDownBy);
    }
    return decisao.motivo;
  }

  private async aplicarEncoding(maxBitrate: number, maxFramerate: number, escalaAdaptador: number): Promise<void> {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    params.encodings[0].maxFramerate = maxFramerate;
    // Dois motivos para encolher, e fica o MAIOR dos dois: o adaptador encolhe
    // por falta de BANDA; o teto de altura encolhe por CUSTO de codificação.
    // Assim o automático nunca codifica acima de 1440p (mesmo numa fibra que
    // aguentaria 4K, porque 4K aqui só rende atraso), e desce mais quando a
    // rede pedir.
    const escalaTeto = escalaParaAltura(this.alturaDaFonte(), ALTURA_MAX_AUTO);
    params.encodings[0].scaleResolutionDownBy = Math.max(escalaAdaptador, escalaTeto);
    await sender.setParameters(params).catch(() => {});
  }

  // ───────────────────── entrada do visitante ─────────────────

  // As duas mensagens de alta frequência, e as únicas que podem se perder sem
  // consequência: cada uma carrega a posição absoluta, então a próxima já
  // conserta o que a anterior não entregou.
  sendMouseMove(x: number, y: number): void {
    this.sendRapido({ t: 'mm', x, y });
  }
  /** Anfitrião: conta ao visitante onde o cursor daqui está — e que forma tem. */
  sendCursor(x: number, y: number, tipo?: TipoCursor): void {
    this.sendRapido({ t: 'cursor', x, y, tipo });
  }
  /**
   * Anfitrião: "a SUA seta, agora, tem esta forma."
   *
   * Confiável: uma troca de forma perdida deixaria o visitante com a viga de
   * texto (ou a mãozinha) presa depois de já ter saído de cima do campo.
   */
  sendCursorForma(tipo: TipoCursor): void {
    this.sendCtrl({ t: 'cursor-forma', tipo });
  }
  /**
   * Anfitrião: "você é o visitante de número N; a sua seta é esta cor".
   *
   * Confiável de propósito, ao contrário das posições: uma posição perdida é
   * corrigida pela seguinte, mas uma cor perdida deixaria o visitante pintando
   * a própria seta de vermelho para sempre — em cima da seta de outra pessoa.
   */
  sendCor(indice: number, nome: string): void {
    this.sendCtrl({ t: 'cor', indice, nome });
  }
  /** Anfitrião: onde estão as setas dos OUTROS visitantes. */
  sendPonteiros(lista: Ponteiro[]): void {
    this.sendRapido({ t: 'ponteiros', lista });
  }
  sendMouseButton(button: BotaoMouse, down: boolean, x: number, y: number): void {
    this.sendCtrl({ t: down ? 'md' : 'mu', b: button, x, y });
  }
  /** Modo Gamer: deslocamento relativo da mira (canal rápido, pode perder). */
  sendMouseRel(dx: number, dy: number): void {
    this.sendRapido({ t: 'mr', dx, dy });
  }
  /**
   * Modo Gamer ligado/desligado, para o anfitrião apagar a seta deste
   * visitante e prender o ponteiro real no centro da tela.
   *
   * Confiável: perder o "liguei" deixaria a mira travando na borda a partida
   * inteira, sem nada na tela explicando o motivo.
   */
  sendGamer(on: boolean): void {
    this.sendCtrl({ t: 'gamer', on });
  }
  /** Modo Gamer: clique sem reposicionar. Confiável — perder um tiro irrita. */
  sendMouseRelButton(button: BotaoMouse, down: boolean): void {
    this.sendCtrl({ t: 'mrb', b: button, down });
  }
  sendWheel(dx: number, dy: number, x: number, y: number): void {
    this.sendCtrl({ t: 'wheel', dx, dy, x, y });
  }
  sendKey(code: string, down: boolean, repeat = false): void {
    this.sendCtrl({ t: down ? 'kd' : 'ku', code, repeat });
  }
  sendCombo(codes: string[]): void {
    this.sendCtrl({ t: 'combo', codes });
  }
  /** Ctrl+Alt+Del: pedido separado, porque a resposta importa. Ver sas.ts. */
  sendSas(): void {
    this.sendCtrl({ t: 'sas' });
  }
  sendText(value: string): void {
    this.sendCtrl({ t: 'text', value });
  }
  selectDisplay(id: number): void {
    this.sendCtrl({ t: 'display', id });
  }
  runInstaller(): void {
    this.sendCtrl({ t: 'run-installer' });
  }
  setBlockLocalInput(on: boolean): void {
    this.sendCtrl({ t: 'block-input', on });
  }

  /**
   * Envia um arquivo.
   *
   * `daAreaDeTransferencia` faz o outro lado, ao terminar de gravar, colocá-lo
   * na área de transferência de lá — é o que permite copiar aqui e colar numa
   * pasta do computador remoto.
   */
  sendFile(source: ChunkSource, clipboard: ClipboardBatch | null = null): Promise<boolean> {
    if (!this.engine) {
      void source.close();
      return Promise.resolve(false);
    }
    return this.engine.enqueue(source, clipboard);
  }

  // ────────────────────── estatísticas ────────────────────────

  // ─────────────────────── vigilância da sessão ───────────────────────
  //
  // POR QUE ISTO EXISTE
  //
  // Uma sessão podia congelar depois de meia hora: a imagem parava, o teclado
  // e o mouse não chegavam mais, e ainda assim o WebRTC continuava dizendo
  // "connected". Do lado de quem usava, o sintoma era pior do que uma queda
  // limpa — a janela seguia aberta, o ponteiro remoto sumia (ele é desenhado
  // dentro do vídeo, que estava parado) e nada respondia.
  //
  // A causa raiz de sessões longas que morrem assim é quase sempre o caminho
  // entre os dois computadores mudando por baixo: a operadora troca o
  // mapeamento do NAT, o Wi-Fi muda de faixa, a rede corporativa reinicia um
  // equipamento. O `connectionState` demora muito a admitir isso, e às vezes
  // nunca admite.
  //
  // A resposta tem três partes: medir de verdade se está vivo (pulso e
  // quadros), refazer o caminho quando não estiver, e — se nem isso resolver —
  // dizer o que aconteceu em vez de deixar a tela congelada.

  private iniciarVigilancia(): void {
    if (this.pulso !== null) return;
    const agora = Date.now();
    this.ultimoPong = agora;
    this.vigia.reiniciar(agora);

    this.pulso = window.setInterval(() => {
      if (this.disposed) return;
      this.sendCtrl({ t: 'ping', at: Date.now() });
      this.conferirSaude();
    }, PULSO_MS);
  }

  /**
   * Pergunta à vigilância o que está acontecendo e obedece.
   *
   * Chamado tanto pelo pulso (a cada 3s) quanto pela coleta de estatísticas
   * (a cada 1s) — os dois trazem sinais diferentes, e a decisão é uma só.
   */
  private conferirSaude(): void {
    if (this.disposed) return;
    const decisao = this.vigia.avaliar({
      agora: Date.now(),
      ultimaMensagem: this.ultimoPong,
      quadros: this.ultimoQuadro,
      quadrosDoOutro: this.quadrosDoOutro,
      conexao: this.pc.connectionState,
    });

    this.marcarSaude(decisao.viva, decisao.motivo);
    if (decisao.acao === 'recuperar') void this.recuperar(decisao.motivo);
    if (decisao.acao === 'desistir') this.close(`não foi possível restabelecer a conexão — ${decisao.motivo}`);
  }

  private marcarSaude(viva: boolean, motivo: string): void {
    if (this.viva === viva) return;
    this.viva = viva;
    this.emit('saude', viva, motivo);
  }

  /** A sessão está respondendo agora? A interface usa para avisar o usuário. */
  get sessaoViva(): boolean {
    return this.viva;
  }

  /**
   * Refaz o caminho entre os dois computadores sem derrubar a sessão.
   *
   * Quem pede é sempre o visitante, e o pedido vai pela MALHA — não pelo canal
   * de dados, que a essa altura está morto junto com o caminho. A malha é uma
   * ligação separada, que continua de pé justamente porque não depende do
   * caminho direto.
   *
   * O anfitrião, ao receber o pedido, gera uma oferta nova com reinício de ICE:
   * na prática, os dois procuram um caminho do zero, mantendo a sessão, a
   * autenticação e a tela compartilhada como estavam.
   */
  private async recuperar(motivo: string): Promise<void> {
    if (this.disposed || this.recuperando) return;
    this.recuperando = true;
    void motivo;

    try {
      if (this.role === 'anfitriao') {
        await this.refazerOferta();
      } else {
        // Pede ao anfitrião, que é quem faz a oferta nesta sessão.
        this.signaling.send(this.peerId, { t: 'restart' });
      }
    } catch {
      /* a próxima volta do pulso tenta de novo */
    }

    // Solta a trava depois de um tempo: se a recuperação funcionou, o
    // `connected` já zerou o contador; se não, tentamos de novo.
    window.setTimeout(() => {
      this.recuperando = false;
    }, 8000);
  }

  private async refazerOferta(): Promise<void> {
    const oferta = await this.pc.createOffer({ iceRestart: true });
    await this.pc.setLocalDescription(oferta);
    const sdp = this.pc.localDescription!.sdp;
    this.signaling.send(this.peerId, {
      t: 'offer',
      sdp,
      mac: await window.ryke.auth.sdpMac(this.peerId, sdp),
    });
  }

  private startStats(): void {
    if (this.statsTimer !== null) return;
    this.statsTimer = window.setInterval(() => void this.collectStats(), 1000);
  }

  private async collectStats(): Promise<void> {
    if (this.disposed) return;
    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return;
    }

    const stats: LiveStats = {
      rtt: 0, fps: 0, kbps: 0, width: 0, height: 0, transport: '—', atraso: 0, ajuste: '', codec: '', aceleracao: '',
    };
    const now = performance.now();

    let banca: number | null = null;
    // Contagem de quadros do vídeo, para detectar imagem congelada.
    let quadrosDeVideo = 0;
    let jitterSegundos = 0;
    let perdidos = 0;
    let totalPacotes = 0;
    let limitacao: 'none' | 'bandwidth' | 'cpu' | 'other' = 'none';
    // Para resolver o codec: guardamos o id do codec do vídeo e o mapa id→nome,
    // porque as duas informações vêm em entradas separadas do getStats.
    let codecId = '';
    const nomesCodec = new Map<string, string>();

    report.forEach((entry) => {
      if (entry.type === 'codec' && typeof entry.mimeType === 'string') {
        // "video/H264" → "H264".
        nomesCodec.set(entry.id, entry.mimeType.replace(/^video\//i, ''));
      }
      if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
        if (typeof entry.codecId === 'string') codecId = entry.codecId;
        if (typeof entry.decoderImplementation === 'string') stats.aceleracao = classificarAceleracao(entry.decoderImplementation);
        quadrosDeVideo = entry.framesDecoded ?? 0;
        stats.fps = Math.round(entry.framesPerSecond ?? 0);
        stats.width = entry.frameWidth ?? 0;
        stats.height = entry.frameHeight ?? 0;
        const bytes = entry.bytesReceived ?? 0;
        if (this.lastStatsAt > 0 && bytes >= this.lastBytes) {
          const seconds = (now - this.lastStatsAt) / 1000;
          stats.kbps = Math.round(((bytes - this.lastBytes) * 8) / 1000 / Math.max(seconds, 0.001));
        }
        this.lastBytes = bytes;

        jitterSegundos = entry.jitter ?? 0;
        const somaEspera = entry.jitterBufferDelay ?? 0;
        const quadros = entry.jitterBufferEmittedCount ?? 0;
        const novosQuadros = quadros - this.ultEspera.quadros;
        const novaEspera = somaEspera - this.ultEspera.soma;
        if (novosQuadros > 0 && novaEspera >= 0) {
          stats.atraso = Math.round((novaEspera / novosQuadros) * 1000);
        }
        this.ultEspera = { soma: somaEspera, quadros };
      }
      if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
        if (typeof entry.codecId === 'string') codecId = entry.codecId;
        if (typeof entry.encoderImplementation === 'string') stats.aceleracao = classificarAceleracao(entry.encoderImplementation);
        quadrosDeVideo = entry.framesSent ?? 0;
        stats.fps = Math.round(entry.framesPerSecond ?? 0);
        stats.width = entry.frameWidth ?? 0;
        stats.height = entry.frameHeight ?? 0;
        const bytes = entry.bytesSent ?? 0;
        if (this.lastStatsAt > 0 && bytes >= this.lastBytes) {
          const seconds = (now - this.lastStatsAt) / 1000;
          stats.kbps = Math.round(((bytes - this.lastBytes) * 8) / 1000 / Math.max(seconds, 0.001));
        }
        this.lastBytes = bytes;
        const razao = entry.qualityLimitationReason;
        if (razao === 'bandwidth' || razao === 'cpu' || razao === 'other') limitacao = razao;
        totalPacotes = entry.packetsSent ?? 0;
      }
      if (entry.type === 'remote-inbound-rtp' && entry.kind === 'video') {
        // Quem sabe o que se perdeu é o outro lado; ele devolve pelo RTCP.
        perdidos = entry.packetsLost ?? 0;
      }
      if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated) {
        stats.rtt = Math.round((entry.currentRoundTripTime ?? 0) * 1000);
        if (typeof entry.availableOutgoingBitrate === 'number') banca = entry.availableOutgoingBitrate;
      }
      if (entry.type === 'local-candidate' && entry.candidateType === 'relay') {
        stats.transport = 'retransmitido';
      }
    });

    if (stats.transport === '—' && stats.rtt >= 0) stats.transport = 'direto';
    stats.codec = nomesCodec.get(codecId) ?? '';

    // Imagem parada com a conexão jurando estar viva é o retrato exato do
    // congelamento relatado. Quem decide o que fazer é a vigilância.
    this.ultimoQuadro = quadrosDeVideo;
    this.conferirSaude();

    if (this.role === 'visitante') {
      // O buffer de reprodução é o maior responsável pelo atraso percebido.
      // Zero seria ideal e é arriscado: numa rede trepidante, quadro que
      // chega fora de hora vira engasgo. Então o alvo acompanha a trepidação
      // medida — quase nada em rede boa, um respiro em rede ruim. O teto caiu
      // para 120 ms (era 200): numa área de trabalho remota, responder rápido
      // vale mais do que suavizar o último solavanco.
      this.ajustarBufferDeReproducao(Math.min(0.12, jitterSegundos * 2));
    }

    if (this.role === 'anfitriao') stats.ajuste = this.ajustarQualidade(banca, stats.rtt, perdidos, totalPacotes, limitacao);

    // Um resumo a cada ~5 s no arquivo de diagnóstico. No visitante é onde se
    // vê o essencial: caminho DIRETO ou retransmitido, atraso do buffer, codec,
    // e se o DECODE está por hardware. É a foto que, lida do disco depois,
    // aponta a causa da lentidão sem eu precisar reproduzir.
    if (now - this.ultimoDiag > 5000) {
      this.ultimoDiag = now;
      window.ryke.diag.log(
        `[${this.role === 'visitante' ? 'visitante' : 'host'}] ` +
          `transporte=${stats.transport} rtt=${stats.rtt}ms atrasoImg=${stats.atraso}ms ` +
          `fps=${stats.fps} mbps=${(stats.kbps / 1000).toFixed(1)} res=${stats.width}x${stats.height} ` +
          `codec=${stats.codec || '?'} aceleracao=${stats.aceleracao || '?'}`,
      );
    }

    this.lastStatsAt = now;
    this.emit('stats', stats);
  }

  // ──────────────────────── encerramento ──────────────────────

  close(reason: string, avisarOutro = true): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    if (this.pulso !== null) clearInterval(this.pulso);
    // A tela é compartilhada: quem sai devolve a sua parte, e ela só é
    // realmente desligada quando o último visitante vai embora.
    if (this.consumidorTela) {
      soltarTela(this.consumidorTela);
      this.consumidorTela = null;
      this.localStream = null;
    }
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];

    void this.engine?.dispose();

    // Solta modificadores presos: um Alt esquecido deixa o anfitrião
    // inutilizável depois que a janela fecha.
    if (this.role === 'anfitriao') {
      window.ryke.input.releaseAll();
      void window.ryke.input.blockLocal(false);
    }

    this.ctrl?.close();
    this.inputChannel?.close();
    this.fileChannel?.close();
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.pc.close();

    if (avisarOutro) this.signaling.send(this.peerId, { t: 'bye', reason });
    // A chave derivada da senha não sobrevive à sessão.
    void window.ryke.auth.forget(this.peerId);
    this.emit('closed', reason);
  }
}

/**
 * A captura em vigor está na rota reserva por SOFTWARE (canvas + JPEG por
 * quadro)? Essa rota é muito mais lenta e é a causa provável de atraso num PC
 * onde o `getDisplayMedia` não sobe (driver de vídeo genérico depois de formatar
 * o Windows é o motivo campeão). O anfitrião manda este sinal no meta para o
 * visitante poder apontar a causa em vez de a gente adivinhar.
 */
let capturaPorSoftwareAtiva = false;
let motivoCapturaSoftware = '';
export function capturaEstaPorSoftware(): boolean {
  return capturaPorSoftwareAtiva;
}
/** Motivos técnicos reais que fizeram a captura cair na rota lenta (vazio se está no caminho rápido). */
export function motivoDaCapturaSoftware(): string {
  return capturaPorSoftwareAtiva ? motivoCapturaSoftware : '';
}

/**
 * Pede a tela ao processo principal. O seletor do Windows nunca aparece: o
 * monitor já foi decidido por quem está do outro lado.
 */
async function captureScreen(): Promise<MediaStream> {
  // A CAPTURA É O TETO DE TUDO O QUE VEM DEPOIS.
  //
  // Aqui estava o motivo de "Alta" nunca parecer o máximo. O perfil de alta
  // pede 60 quadros ao codificador, mas o codificador não inventa quadro: ele
  // só comprime o que a fonte entrega. E a fonte era pedida com `ideal: 30`
  // fixo, para toda e qualquer qualidade — então em Alta o Windows continuava
  // fotografando a tela 30 vezes por segundo e os outros 30 nunca existiram.
  // Subir a taxa de bits não resolvia, porque o que faltava não era banda.
  //
  // Agora a fonte acompanha o que foi pedido: 60 em Alta, 30 nas demais, que é
  // onde 60 só gastaria processador do anfitrião sem ninguém notar.
  const alvo = quadrosDaCaptura();
  // Duas formas de pedir a tela, da mais específica para a mais compatível. Se o
  // driver recusa a EXIGÊNCIA de uma taxa de quadros (alguns recusam `max:60`), a
  // segunda tentativa — sem restrição nenhuma — quase sempre passa. É o que evita
  // cair na rota lenta por causa de uma restrição que o Windows daquela máquina
  // não aceitou, em vez de por incapacidade real de capturar.
  const pedidosVideo: (MediaTrackConstraints | true)[] = [{ frameRate: { ideal: alvo, max: alvo } }, true];
  const erros: string[] = [];

  // Drivers de vídeo e o serviço de captura do Windows podem ainda estar
  // acordando quando a pessoa clica em Permitir. Repetimos as duas APIs em
  // vez de encerrar toda a sessão por uma falha transitória de milissegundos.
  for (const pausa of [0, 250, 750, 1500]) {
    if (pausa > 0) await esperar(pausa);

    for (const video of pedidosVideo) {
      try {
        // Vídeo primeiro: áudio em loopback não existe em vários drivers e não
        // pode impedir o acesso remoto, cuja parte essencial é a tela.
        const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
        if (!stream.getVideoTracks().some((track) => track.readyState === 'live')) {
          throw new Error('o Windows devolveu a fonte sem uma trilha de vídeo ativa');
        }
        capturaPorSoftwareAtiva = false; // caminho rápido (captura nativa do Windows)
        return stream;
      } catch (err) {
        erros.push(`tela ${pausa}ms ${video === true ? 'simples' : 'fps'}: ${mensagemDeErro(err)}`);
      }
    }

    // Compatibilidade para GPUs/sessões em que getDisplayMedia não inicia o
    // capturador. O processo principal escolhe o id nativo do monitor.
    try {
      const sourceId = await window.ryke.screen.captureSource();
      if (!sourceId) throw new Error('nenhum monitor foi encontrado pelo Windows');
      const compatibilidade = {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: alvo,
        },
      } as unknown as MediaTrackConstraints;
      const stream = await navigator.mediaDevices.getUserMedia({ video: compatibilidade, audio: false });
      if (!stream.getVideoTracks().some((track) => track.readyState === 'live')) {
        throw new Error('a fonte compatível não possui vídeo ativo');
      }
      capturaPorSoftwareAtiva = false; // ainda é captura nativa (desktopCapturer), não a rota lenta
      return stream;
    } catch (err) {
      erros.push(`compatibilidade ${pausa}ms: ${mensagemDeErro(err)}`);
    }
  }

  // Alguns PCs enumeram e fotografam a tela normalmente, mas o Chromium
  // recusa transformar essa fonte em MediaStream. Criamos então um fluxo de
  // canvas alimentado por JPEGs do processo principal. É uma rota de
  // compatibilidade mais leve em quadros, porém mantém o acesso plenamente
  // utilizável e independe das duas APIs que falharam acima.
  //
  // ATENÇÃO ao diagnosticar lentidão: esta rota é MUITO mais lenta que a
  // captura por hardware (uma foto inteira da tela por quadro). Se o programa
  // caiu aqui, é a causa provável do atraso — e o aviso abaixo é o que permite
  // descobrir isso sem adivinhação. getDisplayMedia falhar num Windows normal
  // costuma ser driver de vídeo desatualizado ou o serviço de captura parado.
  console.warn(
    '[captura] getDisplayMedia NÃO funcionou; caindo na rota reserva por SOFTWARE (lenta). ' +
      'Isto costuma ser a causa de lentidão. Motivos: ' + erros.join(' | '),
  );
  try {
    const stream = await captureScreenByFrames();
    capturaPorSoftwareAtiva = true; // rota reserva por SOFTWARE — a lenta
    motivoCapturaSoftware = erros.join(' | '); // por que os caminhos rápidos falharam
    return stream;
  } catch (err) {
    erros.push(`captura por software: ${mensagemDeErro(err)}`);
  }

  throw new Error(erros.join(' | '));
}

async function captureScreenByFrames(): Promise<MediaStream> {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('o mecanismo de desenho do Chromium não está disponível');

  const desenhar = async (): Promise<void> => {
    const perfil = perfilAtualDaCapturaSoftware();
    const frame = await window.ryke.screen.captureFrame(perfil);
    if (!frame.bytes || frame.bytes.byteLength === 0) throw new Error('o quadro da tela veio vazio');
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }
    const copia = new Uint8Array(frame.bytes);
    const bitmap = await createImageBitmap(new Blob([copia], { type: frame.mime }));
    try {
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    } finally {
      bitmap.close();
    }
  };

  // Só devolvemos a captura depois de provar que ao menos um quadro real
  // chegou. Assim o visitante nunca recebe uma sessão preta considerada boa.
  await desenhar();
  // O teto é alto; quem determina quantos quadros realmente entram é o laço
  // abaixo. Isso permite mudar Baixa/Média/Alta sem recriar a MediaStream.
  const stream = canvas.captureStream(quadrosDaCaptura());
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('o canvas não conseguiu produzir uma trilha de vídeo');

  let ativa = true;
  const parar = track.stop.bind(track);
  track.stop = () => {
    ativa = false;
    parar();
  };

  void (async () => {
    while (ativa && track.readyState === 'live') {
      await esperar(perfilAtualDaCapturaSoftware().intervalMs);
      if (!ativa || track.readyState !== 'live') break;
      try {
        await desenhar();
      } catch {
        // UAC/tela bloqueada pode esconder a fonte por alguns instantes. O
        // último quadro permanece e o laço continua tentando sem derrubar.
      }
    }
  })();

  return stream;
}

const esperar = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

function mensagemDeErro(err: unknown): string {
  if (err instanceof DOMException) return `${err.name}: ${err.message || 'sem detalhes'}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Uma captura de tela, muitos visitantes.
 *
 * Agora que várias pessoas podem acessar o mesmo computador ao mesmo tempo,
 * capturar a tela uma vez por sessão seria desperdício grosseiro: cada captura
 * é um caminho separado de vídeo saindo do sistema, e três visitantes
 * custariam três vezes o processador do anfitrião — sem nenhum ganho, já que a
 * tela é exatamente a mesma.
 *
 * Capturamos uma vez e ligamos as mesmas trilhas em todas as sessões. Cada
 * visitante ainda tem a própria conexão e a própria taxa de bits, porque quem
 * decide isso é o remetente de cada conexão, e não a origem da imagem.
 */
let telaCompartilhada: MediaStream | null = null;
type ConsumidorTela = {
  qualidade: Quality;
  atualizar: (stream: MediaStream) => Promise<void>;
  falhar: (reason: string) => void;
};
const consumidoresTela = new Set<ConsumidorTela>();
let filaDeRecaptura: Promise<void> = Promise.resolve();
let observandoMonitores = false;
let relogioDeRecaptura: number | null = null;

function qualidadeCompartilhada(): Quality {
  return maiorQualidade([...consumidoresTela].map((consumidor) => consumidor.qualidade));
}

function perfilAtualDaCapturaSoftware() {
  return PERFIS_CAPTURA_SOFTWARE[qualidadeCompartilhada()];
}

/**
 * Quantos quadros por segundo pedir ao Windows.
 *
 * Uma captura serve a todos os visitantes, então vale a maior qualidade que
 * alguém pediu — capturar a 30 porque um deles está em "baixa" cortaria pela
 * metade a imagem de quem escolheu "alta" na mesma máquina.
 */
/**
 * A que taxa PEDIMOS a tela ao Windows.
 *
 * Este é o teto de tudo: o adaptador pode baixar os quadros quando a rede
 * aperta, mas nunca inventar quadros que a fonte não entregou. Pedir 30 no modo
 * automático — o padrão — condenava toda sessão a 30, mesmo numa rede direta de
 * 11 ms com a GPU codificando por hardware e a banda sobrando.
 *
 * Agora automático e alta pedem 60, e quem decide o que cabe é o adaptador,
 * medindo a rede de verdade. Média e baixa continuam em 30 de propósito: são
 * escolhas explícitas de economia, e nelas o perfil já pede 30 no codificador.
 */
function quadrosDaCaptura(): number {
  const q = qualidadeCompartilhada();
  return q === 'alta' || q === 'auto' ? 60 : 30;
}

let observandoAreaProtegida = false;

/**
 * Reergue a captura quando a área protegida do Windows (o UAC) sai da frente.
 *
 * O DEFEITO: clicar em algo que pede administrador congelava a sessão PARA
 * SEMPRE. O Windows troca de área de trabalho, a captura para de entregar
 * quadros — mas a trilha continua "viva", então o evento `ended`, que é quem
 * manda recapturar, nunca dispara. E a vigilância da sessão via os dois lados
 * parados e concluía, com razão pelas regras dela, que era só uma tela quieta.
 * Ninguém reerguia nada, nem depois que o UAC saía.
 *
 * O processo principal pergunta ao Windows de quem é a área de entrada e avisa
 * aqui. Ao voltar ao normal, trocamos a fonte por uma nova — é isso que faz a
 * imagem voltar em vez de ficar parada até alguém reconectar na mão.
 */
function observarAreaProtegida(): void {
  if (observandoAreaProtegida) return;
  observandoAreaProtegida = true;
  window.ryke.captura.onAreaProtegida((ativa) => {
    if (ativa || consumidoresTela.size === 0) return;
    void recapturarTelaCompartilhada();
  });
}

function observarMonitores(): void {
  if (observandoMonitores) return;
  observandoMonitores = true;
  window.ryke.screen.onChanged(() => {
    if (consumidoresTela.size > 0) void recapturarTelaCompartilhada();
  });
}

function vigiarFimDaCaptura(stream: MediaStream): void {
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    // Ao trocar de tela, a fonte antiga é encerrada depois que a nova já virou
    // a atual. Só recuperamos se foi a fonte realmente ativa que terminou.
    if (telaCompartilhada !== stream || consumidoresTela.size === 0) return;
    for (const track of stream.getTracks()) {
      if (track.readyState === 'live') track.stop();
    }
    telaCompartilhada = null;
    void recapturarTelaCompartilhada();
  });
}

async function pegarTela(consumidor: ConsumidorTela): Promise<MediaStream> {
  observarMonitores();
  observarAreaProtegida();
  consumidoresTela.add(consumidor);
  if (!telaCompartilhada) {
    try {
      telaCompartilhada = await captureScreen();
      vigiarFimDaCaptura(telaCompartilhada);
    } catch (err) {
      consumidoresTela.delete(consumidor);
      throw err;
    }
  }
  return telaCompartilhada;
}

function soltarTela(consumidor: ConsumidorTela): void {
  consumidoresTela.delete(consumidor);
  if (consumidoresTela.size === 0) {
    if (relogioDeRecaptura !== null) {
      window.clearTimeout(relogioDeRecaptura);
      relogioDeRecaptura = null;
    }
    if (!telaCompartilhada) return;
    const antiga = telaCompartilhada;
    telaCompartilhada = null;
    for (const t of antiga.getTracks()) t.stop();
  }
}

async function executarRecaptura(): Promise<void> {
  if (consumidoresTela.size === 0) return;

  // Durante Estender/Duplicar ou enquanto o UAC mostra a área protegida, o
  // Windows pode esconder todas as fontes de vídeo. Isso é temporário e não
  // significa que a conexão WebRTC morreu. Tentamos novamente até a área de
  // trabalho normal voltar, mantendo teclado, arquivos e sessão de pé.
  try {
    const nova = await captureScreen();
    const antiga = telaCompartilhada;
    telaCompartilhada = nova;
    vigiarFimDaCaptura(nova);

    const consumidores = [...consumidoresTela];
    const resultados = await Promise.allSettled(
      consumidores.map((consumidor) => consumidor.atualizar(nova)),
    );
    resultados.forEach((resultado, index) => {
      if (resultado.status === 'rejected') {
        consumidores[index]?.falhar('não foi possível trocar a tela capturada');
      }
    });

    if (antiga && antiga !== nova) {
      for (const track of antiga.getTracks()) track.stop();
    }
  } catch {
    agendarRecaptura();
  }
}

function agendarRecaptura(): void {
  if (relogioDeRecaptura !== null || consumidoresTela.size === 0) return;
  relogioDeRecaptura = window.setTimeout(() => {
    relogioDeRecaptura = null;
    if (consumidoresTela.size > 0) void recapturarTelaCompartilhada();
  }, 1500);
}

/** Serializa trocas vindas do menu e da configuração de vídeo do Windows. */
function recapturarTelaCompartilhada(): Promise<void> {
  const tarefa = filaDeRecaptura.then(() => executarRecaptura());
  filaDeRecaptura = tarefa.catch(() => {});
  return tarefa;
}
