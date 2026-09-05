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

/**
 * Blocos de 64 KB.
 *
 * Eram 16 KB — o tamanho seguro para qualquer implementação de SCTP. Só que as
 * duas pontas de uma sessão Ryke Desk são sempre Chromium, que negocia até 256
 * KB por mensagem, e 16 KB significava QUATRO VEZES mais idas e voltas: cada
 * bloco custa uma leitura de disco por IPC, um `send` e um evento do outro
 * lado. Numa transferência de dezenas de gigabytes, esse custo fixo deixa de
 * ser detalhe e vira o gargalo — e o trabalho inútil de processar milhões de
 * blocos foi parte do que derrubava a sessão.
 */
export const FILE_CHUNK_SIZE = 64 * 1024;

/**
 * NÃO existe limite de tamanho. Isto é decisão, não esquecimento.
 *
 * Havia um teto de 500 MB, e ele era arbitrário: nada na arquitetura precisa
 * dele. Os bytes nunca passam inteiros pela memória — quem envia lê o arquivo
 * em pedaços e quem recebe grava direto em disco, num fluxo. O que protege o
 * disco de quem recebe não é um número escrito aqui, e sim duas conferências
 * reais, feitas em `transfers.ts`: o espaço livre precisa comportar o que foi
 * anunciado, e o remetente é cortado no instante em que passa de um byte do
 * que prometeu.
 *
 * O teto só conseguia uma coisa: recusar uma transferência legítima de 50 GB.
 */

/** Acima disto paramos de enfileirar e esperamos o buffer drenar. */
export const FILE_BUFFER_HIGH = 8 * 1024 * 1024;
export const FILE_BUFFER_LOW = 2 * 1024 * 1024;

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
  /**
   * Placa de vídeo do ANFITRIÃO e se ele codifica por hardware.
   *
   * Vai junto porque quem sente o atraso é o visitante, mas quem codifica a tela
   * é o anfitrião: é a placa DELE que decide se o vídeo sai por hardware (rápido)
   * ou por software (a causa mais comum de "digito e aparece dois segundos
   * depois"). Opcional para não quebrar quem estiver numa versão sem o campo.
   */
  hostGpu?: { nome: string; encode: boolean; decode: boolean };
  /**
   * O anfitrião está capturando a tela pela rota reserva por SOFTWARE (lenta)?
   *
   * Acontece quando o `getDisplayMedia` não sobe — driver de vídeo genérico
   * depois de formatar o Windows é o motivo campeão. É uma causa de atraso que
   * a placa habilitada não denuncia, por isso viaja separada.
   */
  hostCapturaSoftware?: boolean;
  /** Motivos técnicos reais de a captura ter caído na rota lenta (para diagnóstico honesto, sem palpite). */
  hostCapturaMotivo?: string;
  /** O anfitrião está em modo ADMINISTRADOR agora? (Para o botão do visitante refletir o estado.) */
  hostElevado?: boolean;
};

/**
 * Onde a seta DESTE visitante está, em fração da tela (0..1).
 *
 * Repare no que ela NÃO é: uma ordem para mover o cursor do Windows do outro
 * lado. Era isso que fazia, e era o defeito — a pessoa sentada no anfitrião
 * via o próprio ponteiro ser arrancado da mão, e dois visitantes brigavam pelo
 * único cursor que a máquina tem.
 *
 * Agora ela move um ponteiro VIRTUAL, que é desenho e mais nada: cada
 * visitante tem o seu, colorido e com o nome embaixo, e o cursor real do
 * anfitrião continua obedecendo só a quem está lá. O cursor real só é
 * emprestado no instante de um clique, e devolvido ao lugar em seguida.
 *
 * Enquanto o visitante estiver com um botão apertado — arrastando uma janela,
 * selecionando texto — o cursor real acompanha, porque um arrasto que solta o
 * ponteiro no meio do caminho não é um arrasto.
 */
export type CtrlMouseMove = { t: 'mm'; x: number; y: number };
/**
 * Qual botão, na numeração do DOM: 0 esquerdo · 1 meio · 2 direito ·
 * 3 voltar · 4 avançar (os dois laterais, do polegar).
 *
 * A lista está repetida aqui, e não importada de `botoes.ts`, porque este
 * arquivo é o CONTRATO DE REDE: ele não tem dependência nenhuma de propósito,
 * já que é copiado inteiro para o projeto do celular.
 */
export type BotaoDoMouse = 0 | 1 | 2 | 3 | 4;
export type CtrlMouseButton = { t: 'md' | 'mu'; b: BotaoDoMouse; x: number; y: number };
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
export type CtrlMouseRelButton = { t: 'mrb'; b: BotaoDoMouse; down: boolean };

/**
 * "Entrei (ou saí) do Modo Gamer."
 *
 * O anfitrião precisa saber, e por dois motivos concretos:
 *
 *   1. A SETA SOME. Num jogo não existe ponteiro — existe mira, desenhada pelo
 *      próprio jogo no centro da tela. Continuar desenhando a seta virtual
 *      deste visitante seria pôr um cursor colorido em cima da mira, parado no
 *      último lugar em que ele estava antes de o modo ligar.
 *
 *   2. O PONTEIRO REAL VAI PARA O CENTRO E FICA LÁ. É o que impede a câmera de
 *      travar: um ponteiro encostado na borda da tela não tem mais para onde se
 *      mover, e o deslocamento que o jogo lê vira zero. Ver `warpCursor`.
 */
export type CtrlGamer = { t: 'gamer'; on: boolean };

/** `code` é o KeyboardEvent.code — posição física da tecla, não o caractere. */
export type CtrlKey = { t: 'kd' | 'ku'; code: string; repeat?: boolean };
/** Combinação disparada por botão da barra (Alt+Tab, Win+E, ...). */
export type CtrlCombo = { t: 'combo'; codes: string[] };

/**
 * Ctrl+Alt+Del — que NÃO é uma combinação como as outras.
 *
 * As demais viajam em `combo` e são injetadas com SendInput. Esta não pode:
 * o Windows intercepta a Secure Attention Sequence antes de qualquer processo
 * em modo usuário, e é essa reserva que garante que a tela de bloqueio seja
 * mesmo dele. Nenhum privilégio contorna isso — por isso a mensagem é
 * separada, e do outro lado ela vai para a API `SendSAS`, que é a porta
 * oficial. Ver src/main/sas.ts.
 */
export type CtrlSas = { t: 'sas' };
/** O que aconteceu com o pedido acima. Sem isto o botão falharia calado. */
export type CtrlSasResult = { t: 'sas-result'; ok: boolean; motivo: string };
/** Texto literal, usado para colar acentuação e emojis sem depender de layout. */
export type CtrlText = { t: 'text'; value: string };

/** Sincronização de área de transferência de texto, nos dois sentidos. */
export type CtrlClipboard = { t: 'clip'; value: string };

export type CtrlDisplay = { t: 'display'; id: number };
export type CtrlRunInstaller = { t: 'run-installer' };
export type CtrlRunInstallerResult = { t: 'run-installer-result'; ok: boolean; canceled?: boolean; message: string };
/**
 * O visitante pede ao anfitrião para trocar de modo.
 *
 * `ligar: true` reabre o anfitrião como ADMINISTRADOR (sem UAC, via tarefa
 * agendada) — necessário para instalar programas ou mexer em janelas de admin no
 * PC remoto. `ligar: false` volta ao modo normal. Trocar de modo REABRE o
 * processo do anfitrião: a sessão cai e é preciso reconectar. E, enquanto
 * elevado, a captura de tela do Windows não funciona por hardware (é a
 * incompatibilidade que motivou o modo normal), então a imagem fica lenta — por
 * isso é um modo temporário, para a tarefa e volta.
 */
export type CtrlAdmin = { t: 'admin'; ligar: boolean };

/**
 * "Este clique não chegou: a janela ali exige administrador."
 *
 * O anfitrião manda isto quando descobre que o ponto clicado pertence a uma
 * janela elevada e o modo administrador está desligado. Sem este aviso, o
 * clique some em silêncio — o Windows descarta a entrada de um processo comum
 * numa janela elevada — e a sessão PARECE travada. Foi exatamente o que
 * acontecia ao tentar clicar em "Concluir" num instalador: a janela cobre a
 * tela, não fecha nunca, e nada do que se clica funciona.
 *
 * A posição vem em fração da tela, como todo o resto, para o visitante
 * desenhar a marca no lugar exato onde ele clicou.
 */
export type CtrlPrecisaAdmin = { t: 'precisaAdmin'; x: number; y: number };
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
/**
 * A FORMA que o ponteiro remoto assume, conforme o que há embaixo dele no
 * anfitrião — texto sobre um campo, redimensionar sobre uma borda, mãozinha
 * sobre um link. Os nomes são iguais aos valores de `cursor` do CSS de
 * propósito, para o visitante repassar direto ao próprio cursor do sistema.
 *
 * Mora aqui, e não junto do desenho das setas, porque é parte do contrato entre
 * os dois lados: o computador e o celular precisam concordar sobre estes nomes.
 */
export type TipoCursor =
  | 'default'
  | 'text'
  | 'pointer'
  | 'ew-resize'
  | 'ns-resize'
  | 'nesw-resize'
  | 'nwse-resize'
  | 'move'
  | 'wait'
  | 'progress'
  | 'crosshair'
  | 'not-allowed'
  | 'help';

export type CtrlCursor = { t: 'cursor'; x: number; y: number; tipo?: TipoCursor };

/**
 * "A SUA seta, neste instante, tem esta forma."
 *
 * Vai do anfitrião para cada visitante, e diz que forma o cursor assumiria no
 * ponto onde a seta daquele visitante está — texto sobre um campo, redimensionar
 * sobre a borda de uma janela, mãozinha sobre um link. O visitante usa isto para
 * trocar a forma do PRÓPRIO cursor do sistema (nítido e sem atraso), sem perder
 * a cor que o identifica. Só muda quando a forma muda.
 */
export type CtrlCursorForma = { t: 'cursor-forma'; tipo: TipoCursor };

/**
 * "Você é o visitante número N; a sua seta é esta cor."
 *
 * Vai uma vez, do anfitrião para cada visitante, assim que a sessão sobe. O
 * visitante usa o índice para pintar o PRÓPRIO cursor do sistema — o único
 * ponteiro que ele move de verdade — e para escrever o nome certo embaixo
 * dele. Sem esta mensagem cada visitante se pintaria de vermelho, e três
 * pessoas na mesma máquina veriam três setas vermelhas.
 *
 * `nome` é como o anfitrião vai anunciar este visitante aos outros: mandá-lo
 * de volta evita que cada lado invente um rótulo diferente para a mesma seta.
 */
export type CtrlCor = { t: 'cor'; indice: number; nome: string };

/**
 * Onde estão TODAS as setas da sessão, do ponto de vista do anfitrião.
 *
 * Vai do anfitrião para cada visitante pelo canal rápido, e a lista que cada
 * um recebe já vem sem a seta dele mesmo — a própria seta ele desenha com o
 * cursor do sistema, sem atraso nenhum, e vê-la chegar de volta pela rede
 * empilharia duas setas andando com um quadro de diferença.
 *
 * Substitui `cursor` quando os dois lados são novos; `cursor` continua sendo
 * enviado porque uma versão anterior do programa não entende esta mensagem e
 * ficaria sem enxergar a seta do anfitrião.
 */
export type CtrlPonteiros = {
  t: 'ponteiros';
  lista: { id: string; nome: string; cor: number; x: number; y: number; tipo?: TipoCursor }[];
};

export type CtrlMessage =
  | CtrlMeta
  | CtrlMouseMove
  | CtrlMouseButton
  | CtrlMouseRel
  | CtrlMouseRelButton
  | CtrlGamer
  | CtrlWheel
  | CtrlKey
  | CtrlCombo
  | CtrlSas
  | CtrlSasResult
  | CtrlText
  | CtrlClipboard
  | CtrlDisplay
  | CtrlRunInstaller
  | CtrlRunInstallerResult
  | CtrlAdmin
  | CtrlPrecisaAdmin
  | CtrlQuality
  | CtrlBlockInput
  | CtrlPing
  | CtrlPong
  | CtrlCursor
  | CtrlCursorForma
  | CtrlCor
  | CtrlPonteiros
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
  /**
   * Caminho do arquivo DENTRO da pasta que está sendo enviada.
   *
   * Só existe quando a origem é uma pasta: `Fotos/2026/praia.jpg`. É o que
   * permite ao outro lado recriar a árvore em vez de despejar quatrocentos
   * arquivos soltos na pasta de downloads.
   *
   * Vem do outro computador, portanto é texto hostil até prova em contrário:
   * quem o recebe quebra em segmentos, higieniza cada um e confere que o
   * resultado continua dentro da pasta de destino. Sem isso, um `..\..\` aqui
   * escreveria onde bem entendesse na máquina de quem recebe.
   */
  relPath?: string;
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
