/**
 * Contrato entre os dois computadores de uma sessão Ryke Desk.
 *
 * Três canais distintos, cada um com um trabalho:
 *   - sinalização (WebSocket, via servidor) — só até o P2P subir
 *   - "ctrl"  (DataChannel confiável e ordenado)  — teclado, mouse, clipboard
 *   - "files" (DataChannel confiável e ordenado)  — blocos binários de arquivo
 *                                                   E o controle da transferência
 *
 * Sobre o último ponto: cada DataChannel é um fluxo SCTP separado, e a ordem
 * só vale dentro de um mesmo fluxo. Se o "terminei" fosse por "ctrl" enquanto
 * os bytes vão por "files", ele chegaria antes do último bloco e o arquivo
 * seria salvo truncado. Por isso o controle de arquivos anda junto dos bytes.
 *
 * Vocabulário fixo em todo o código:
 *   ANFITRIÃO (host)    = o PC que é controlado, o que tem a senha
 *   VISITANTE (viewer)  = o PC que digita o número e assume o controle
 */

export const CTRL_CHANNEL = 'ryke-ctrl';
export const FILE_CHANNEL = 'ryke-files';

/**
 * Canal do movimento do ponteiro — o único que NÃO é confiável nem ordenado.
 *
 * POR QUE UM CANAL SÓ PARA ISSO
 *
 * Movimento de mouse e posição de cursor saem umas sessenta vezes por segundo.
 * Enquanto andavam pelo "ctrl", herdavam dele a entrega garantida e em ordem —
 * e é exatamente essa garantia que produzia o atraso que se sentia na mão.
 *
 * Num canal ordenado, um pacote perdido segura TODOS os que vieram depois até
 * a retransmissão chegar. É o bloqueio de cabeça de fila: numa rede com 1% de
 * perda, a cada cem posições uma engasga o fluxo por um tempo de ida e volta
 * inteiro, e o ponteiro anda aos solavancos mesmo com banda de sobra.
 *
 * A garantia também não servia para nada aqui. Cada mensagem carrega a posição
 * ABSOLUTA, não um deslocamento: a seguinte já corrige a que se perdeu. Esperar
 * pela retransmissão de uma posição que ficou velha é esperar por uma
 * informação que ninguém mais quer.
 *
 * Então este canal entrega o que der, na ordem que chegar (`ordered: false`,
 * `maxRetransmits: 0`), e o "ctrl" continua confiável para o que realmente
 * depende disso: teclas, cliques, área de transferência, arquivos. Perder um
 * "soltar tecla" deixaria um Ctrl preso do outro lado; perder uma posição de
 * mouse não deixa nada.
 */
export const INPUT_CHANNEL = 'ryke-input';

/** Blocos de 16 KB: tamanho seguro para SCTP em qualquer implementação. */
export const FILE_CHUNK_SIZE = 16 * 1024;
/** Limite pedido no projeto. */
export const MAX_FILE_BYTES = 500 * 1024 * 1024;
/** Acima disto paramos de enfileirar e esperamos o buffer drenar. */
export const FILE_BUFFER_HIGH = 4 * 1024 * 1024;
export const FILE_BUFFER_LOW = 1 * 1024 * 1024;

// ─────────────────────────── Sinalização ───────────────────────────

/**
 * Como o visitante pretende entrar. São dois caminhos com propósitos opostos:
 *
 *   'senha'  — acesso NÃO SUPERVISIONADO. O visitante sabe a senha e entra
 *              mesmo sem ninguém na frente do outro computador.
 *   'pedido' — acesso SUPERVISIONADO. Sem senha nenhuma: uma pessoa precisa
 *              estar lá e clicar em "Permitir". É o modo do suporte remoto,
 *              em que quem pede ajuda autoriza na hora e vê tudo acontecer.
 */
export type ModoAcesso = 'senha' | 'pedido';

/** Envelope que o visitante manda primeiro: "quero entrar". */
export type SigKnock = { t: 'knock'; app: string; name: string; modo: ModoAcesso };

/**
 * Anfitrião avisando que a bola está com o usuário dele: alguém precisa
 * clicar em "Permitir" na tela de lá. Sem este aviso, o visitante ficaria
 * olhando para uma tela de "conectando" sem saber que depende de outra pessoa.
 */
export type SigWaiting = { t: 'aguardando'; hostName: string };

/**
 * Resposta do anfitrião com o material do desafio. `salt` é fixo por senha,
 * `nonce` é novo a cada tentativa — é o que impede replay.
 */
export type SigChallenge = {
  t: 'challenge';
  salt: string;
  nonce: string;
  scrypt: { N: number; r: number; p: number; keylen: number };
  hostName: string;
};

/** Prova do visitante: HMAC-SHA256(chave derivada da senha, nonce). */
export type SigProof = { t: 'proof'; proof: string };

/** Anfitrião aceitou; a partir daqui trocamos SDP/ICE. */
export type SigAccepted = { t: 'accepted' };

export type SigDenied = {
  t: 'denied';
  reason:
    | 'senha-incorreta'
    | 'recusado'
    | 'ocupado'
    | 'bloqueado'
    | 'sem-senha'
    /** Ninguém clicou em "Permitir" a tempo do outro lado. */
    | 'sem-resposta'
    /** O anfitrião exige senha; pedir autorização não é aceito ali. */
    | 'exige-senha'
    /** O Windows do anfitrião não forneceu uma fonte de vídeo utilizável. */
    | 'falha-captura';
  /** Segundos de espera imposta após erros repetidos de senha. */
  retryAfter?: number;
  /** Diagnóstico técnico seguro, principalmente para falha de captura. */
  detail?: string;
};

/**
 * Oferta e resposta SDP, com um carimbo opcional.
 *
 * `mac` é HMAC(chave derivada da senha, sdp). O servidor de sinalização
 * repassa estas mensagens e, sem o carimbo, poderia trocar as impressões
 * digitais DTLS por uma sua e ficar no meio da conversa. Ele não conhece a
 * senha, então não consegue produzir o carimbo — e qualquer reescrita do SDP
 * é detectada do outro lado.
 *
 * Ausente no acesso supervisionado (sem senha não há segredo partilhado).
 */
export type SigOffer = { t: 'offer'; sdp: string; mac?: string | null };
export type SigAnswer = { t: 'answer'; sdp: string; mac?: string | null };
export type SigIce = { t: 'ice'; candidate: IceCandidate };
export type SigBye = { t: 'bye'; reason?: string };

/**
 * "O caminho morreu; refaça a negociação."
 *
 * Vai pela SINALIZAÇÃO, e não pelo canal de dados — de propósito. Quando o
 * caminho direto entre os dois computadores cai, o canal de dados cai junto e
 * não serve para pedir socorro. A malha de encontro, por outro lado, é uma
 * ligação independente que continua de pé, e é por ela que o visitante avisa
 * o anfitrião para começar de novo.
 *
 * Foi isto que faltou para as sessões longas: o caminho envelhecia, a imagem
 * congelava e nada tinha como pedir a renegociação.
 */
export type SigRestart = { t: 'restart' };

/**
 * Espelhos estruturais de RTCIceCandidateInit e RTCIceServer.
 *
 * Este arquivo é lido pelos três lados (processo principal, interface e
 * servidor), e só a interface tem os tipos do DOM disponíveis. Declará-los
 * aqui mantém o protocolo independente de ambiente sem perder a checagem.
 */
export type IceCandidate = {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type SignalPayload =
  | SigRestart
  | SigKnock
  | SigChallenge
  | SigProof
  | SigWaiting
  | SigAccepted
  | SigDenied
  | SigOffer
  | SigAnswer
  | SigIce
  | SigBye;

/** Mensagens que o servidor de sinalização entende (cliente → servidor). */
export type ToServer =
  | { t: 'hello'; token: string | null }
  | { t: 'probe'; to: string }
  | { t: 'signal'; to: string; data: SignalPayload }
  | { t: 'bye'; to: string; reason?: string };

/** Mensagens do servidor (servidor → cliente). */
export type FromServer =
  | { t: 'welcome'; id: string; token: string; iceServers: IceServer[] }
  | { t: 'probe-result'; to: string; online: boolean }
  | { t: 'signal'; from: string; data: SignalPayload }
  | { t: 'peer-offline'; to: string }
  | { t: 'error'; reason: string; detail?: string };

// ─────────────────────── Canal de controle ────────────────────────

/** Geometria da tela do anfitrião, para o visitante mapear coordenadas. */
export type CtrlMeta = {
  t: 'meta';
  width: number;
  height: number;
  scaleFactor: number;
  hostName: string;
  displays: { id: number; label: string; primary: boolean }[];
  activeDisplay: number;
};

/** Posição do ponteiro em fração da tela (0..1), independente de resolução. */
export type CtrlMouseMove = { t: 'mm'; x: number; y: number };
export type CtrlMouseButton = { t: 'md' | 'mu'; b: 0 | 1 | 2; x: number; y: number };
export type CtrlWheel = { t: 'wheel'; dx: number; dy: number; x: number; y: number };

/**
 * Movimento RELATIVO do ponteiro — o coração do Modo Gamer.
 *
 * A mensagem `mm` manda a POSIÇÃO absoluta: ótima para trabalhar, inútil para
 * jogar. Num jogo de tiro, virar a mira 360° é empurrar o mouse sem parar; com
 * posição absoluta o cursor bate na borda da tela e a câmera trava ali. Este
 * evento manda o DESLOCAMENTO (dx, dy) desde o último quadro, que o anfitrião
 * injeta em modo relativo — sem borda, girando à vontade. Em pixels do
 * anfitrião. Ver INPUT_CHANNEL: também vai pelo canal rápido, sem garantia.
 */
export type CtrlMouseRel = { t: 'mr'; dx: number; dy: number };
/**
 * Clique no Modo Gamer: aperta ou solta sem reposicionar.
 *
 * Com o ponteiro travado (pointer lock), não existe "onde clicar" — o jogo usa
 * a posição atual da mira. Reaproveitar `md`/`mu`, que carregam coordenada,
 * faria o anfitrião teleportar o cursor antes de cada tiro.
 */
export type CtrlMouseRelButton = { t: 'mrb'; b: 0 | 1 | 2; down: boolean };

/** `code` é o KeyboardEvent.code — posição física da tecla, não o caractere. */
export type CtrlKey = { t: 'kd' | 'ku'; code: string; repeat?: boolean };
/** Combinação disparada por botão da barra (Ctrl+Alt+Del, Alt+Tab, ...). */
export type CtrlCombo = { t: 'combo'; codes: string[] };
/** Texto literal, usado para colar acentuação e emojis sem depender de layout. */
export type CtrlText = { t: 'text'; value: string };

/** Sincronização de área de transferência de texto, nos dois sentidos. */
export type CtrlClipboard = { t: 'clip'; value: string };

export type CtrlDisplay = { t: 'display'; id: number };
export type CtrlRunInstaller = { t: 'run-installer' };
export type CtrlRunInstallerResult = { t: 'run-installer-result'; ok: boolean; canceled?: boolean; message: string };
export type CtrlQuality = { t: 'quality'; preset: 'auto' | 'baixa' | 'media' | 'alta' };
export type CtrlBlockInput = { t: 'block-input'; on: boolean };
export type CtrlPing = { t: 'ping'; at: number };
/**
 * `q` = quantos quadros de vídeo este lado já mandou.
 *
 * Serve para distinguir "a imagem travou" de "não há nada de novo para
 * mandar" — uma tela parada não produz quadro nenhum, e sem este número a
 * vigilância confundia uma pessoa lendo um texto com um caminho de rede morto.
 * Opcional de propósito: uma versão anterior do programa não manda, e a outra
 * ponta precisa continuar conversando com ela.
 */
export type CtrlPong = { t: 'pong'; at: number; q?: number };

/**
 * Onde o cursor do ANFITRIÃO está de verdade, em fração da tela (0..1).
 *
 * Vai do anfitrião para o visitante, umas vinte vezes por segundo e só quando
 * muda. Serve para o visitante desenhar a seta do computador remoto no lugar
 * certo — com o nome da máquina embaixo — enquanto continua usando o próprio
 * cursor do sistema para navegar, que é o único que responde sem atraso.
 *
 * Repare que a posição não é adivinhada a partir do que o visitante mandou: é
 * lida do Windows do outro lado. Assim, quando a pessoa que está lá mexe no
 * mouse dela, a seta marcada se mexe junto, e o visitante vê isso acontecer.
 */
export type CtrlCursor = { t: 'cursor'; x: number; y: number };

export type CtrlMessage =
  | CtrlMeta
  | CtrlMouseMove
  | CtrlMouseButton
  | CtrlMouseRel
  | CtrlMouseRelButton
  | CtrlWheel
  | CtrlKey
  | CtrlCombo
  | CtrlText
  | CtrlClipboard
  | CtrlDisplay
  | CtrlRunInstaller
  | CtrlRunInstallerResult
  | CtrlQuality
  | CtrlBlockInput
  | CtrlPing
  | CtrlPong
  | CtrlCursor
  | FileControl;

// ────────────────────── Transferência de arquivos ──────────────────
//
// O controle viaja no canal "ctrl" (JSON) e os bytes no canal "files"
// (binário puro, em sequência). Um envio por vez em cada sentido, então o
// receptor sempre sabe a qual arquivo o bloco atual pertence.

/** Oferta: "tenho este arquivo, aceita?" */
export type FileOffer = {
  t: 'file-offer';
  id: string;
  name: string;
  size: number;
  /** true quando veio de um Ctrl+C de arquivo no explorador. */
  fromClipboard?: boolean;
  /** Grupo de uma seleção múltipla copiada no Explorer. */
  clipboardBatch?: string;
  clipboardIndex?: number;
  clipboardTotal?: number;
};
export type FileAccept = { t: 'file-accept'; id: string };
export type FileReject = { t: 'file-reject'; id: string; reason: string };
/** Emitida pelo remetente logo antes do primeiro bloco binário. */
export type FileStart = { t: 'file-start'; id: string };
export type FileDone = { t: 'file-done'; id: string; sha256?: string };
export type FileAbort = { t: 'file-abort'; id: string; reason: string };
/** Confirmação do receptor com o caminho onde o arquivo foi salvo. */
export type FileSaved = { t: 'file-saved'; id: string; path: string };

export type FileControl =
  | FileOffer
  | FileAccept
  | FileReject
  | FileStart
  | FileDone
  | FileAbort
  | FileSaved;

// ───────────────────────────── Auxiliares ─────────────────────────

/**
 * Aceita "481 922 730 155", "481-922-730-155" ou "481922730155".
 *
 * Números de nove dígitos (das primeiras versões) são recusados de propósito:
 * o endereço na malha mudou junto com o tamanho, então um número antigo não
 * alcançaria ninguém — e falhar na digitação, dizendo o motivo, é melhor do
 * que discar para o vazio.
 */
export function normalizeId(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  return digits.length === 12 ? digits : null;
}

/** 481922730155 → "481 922 730 155" */
export function formatId(id: string): string {
  return id.replace(/(\d{3})(?=\d)/g, '$1 ');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
