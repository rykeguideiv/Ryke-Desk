/**
 * Processo principal do Ryke Desk.
 *
 * Responsabilidades: janela, captura de tela, injeção de teclado/mouse,
 * área de transferência, disco e o segredo da senha. Toda a parte de rede
 * (WebRTC e sinalização) vive no renderer, porque é lá que existe a pilha
 * WebRTC do Chromium — que é justamente o que nos dá NAT traversal,
 * criptografia e codificação de vídeo por hardware de graça.
 */
import { app, BrowserWindow, ipcMain, shell, clipboard, dialog, desktopCapturer, session, powerSaveBlocker, screen, Tray, Menu, nativeImage } from 'electron';
import { dirname, extname, join } from 'node:path';
import { release } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { appendFileSync, statSync, renameSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { isElevated, permitirArrastarArquivos } from './elevation';

import { Store } from './store';
import { Transfers } from './transfers';
import {
  ChallengeBook,
  Throttle,
  deriveVerifier,
  newSalt,
  proofFor,
  sessionKeyFor,
  macFor,
  macConfere,
  SCRYPT_PARAMS,
  type ScryptParams,
} from './auth';
import * as input from './entrada';
import { rodarComoAjudante, abrirCanoDoAjudante, fecharCanoDoAjudante, ajudanteConectado } from './ajudante';
import * as tecladoGlobal from './teclado-global';
import { definirPoliticaSas, enviarSas, estadoSas, dispararComoSistema } from './sas';
import { listDisplays, findDisplay, toPhysicalPoint, toFraction } from './screen';
import { ipLocal } from './network';
import { copiarArquivos, lerArquivosCopiados } from './clipboard-arquivos';
import type { Papel } from '../shared/config';
import { SERVIDOR_PADRAO } from '../shared/servidor-padrao';
import type { PerfilCapturaSoftware } from '../shared/qualidade-captura';
import type { Ponteiro, TipoCursor } from '../shared/ponteiros';
import type { BotaoMouse } from '../shared/botoes';
import {
  cursorAindaOndeDeixamos as aindaOndeDeixamos,
  esperaDevolucaoMs as calcularEsperaDevolucao,
  GRACA_INJECAO_MS,
} from '../shared/emprestimo-cursor';

// Lançado como SISTEMA por uma tarefa agendada, só para disparar o
// Ctrl+Alt+Del (ver `enviarSas` em sas.ts). Faz a única coisa que precisa e sai
// ANTES de qualquer inicialização — sem janela, sem GPU, sem trava de instância
// (esta cópia é efêmera e não disputa o número Ryke).
if (process.argv.includes('--sas')) {
  dispararComoSistema();
  process.exit(0);
}

/**
 * Lançado ELEVADO pela tarefa agendada, só para injetar mouse e teclado.
 *
 * É o "Modo administrador" novo. Antes, entrar em modo administrador reabria o
 * Ryke Desk INTEIRO elevado — e elevado o Chromium não consegue iniciar a
 * captura de tela, então a imagem despencava de 60 quadros para 1, a sessão
 * caía no reinício e ainda era preciso autorizar de novo. Três estragos para
 * resolver uma coisa só.
 *
 * A observação que desfaz o nó: só a INJEÇÃO precisa de privilégio; a captura
 * não. Então o aplicativo nunca mais eleva, e quem eleva é este ajudante — que
 * não desenha nada, não captura nada e não entra na malha. Ver `ajudante.ts`.
 *
 * Esta cópia não pega a trava de instância nem monta interface: as duas coisas
 * ficam guardadas por `EH_AJUDANTE` mais abaixo.
 */
const EH_AJUDANTE = process.argv.includes('--ajudante-entrada');
if (EH_AJUDANTE) {
  rodarComoAjudante(app.getPath('userData'));
}

// ─────────────────────────────────────────────────────────────────────
// A CAUSA RAIZ DA LENTIDÃO: JANELA OCULTA NA BANDEJA SENDO ESTRANGULADA.
//
// O Ryke Desk abre minimizado no ícone perto do relógio (foi pedido). Só que
// toda a pilha de vídeo — capturar a tela, codificar, enviar — vive no renderer
// dessa janela. E o Chromium, por padrão, PENALIZA janelas ocultas/ocluídas:
//   • estrangula timers e renderização (a captura passa a rodar em câmera lenta);
//   • marca a janela como "ocluída" e SUSPENDE a aceleração por GPU — jogando a
//     codificação do vídeo de volta no processador.
//
// É exatamente o quadro relatado: um PC com placa dedicada e driver atual, mas
// o vídeo "saindo pelo software, não pela placa", com atraso constante que não
// melhora ao baixar a qualidade. E é a REGRESSÃO desde a 1.0.5 — que abria a
// janela normalmente, sem nunca ficar oculta, e por isso não sofria disto.
//
// Os quatro ajustes abaixo desligam essa penalização. Com eles, a janela pode
// ficar escondida na bandeja o tempo todo que o vídeo continua saindo pela GPU,
// na velocidade cheia. É o coração do conserto de desempenho desta versão.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// disable-features aceita uma lista única (chamar de novo sobrescreve), então
// juntamos tudo aqui:
//   • CalculateNativeWinOcclusion — impede o Chromium de declarar a janela
//     oculta como "ocluída" e suspender GPU/pintura. É o par indispensável dos
//     switches acima para o host que roda na bandeja.
//   • WebRtcHideLocalIpsWithMdns — revela os IPs locais para o P2P DIRETO fechar
//     mais rápido, sem mascarar candidatos atrás de nomes mDNS.
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,WebRtcHideLocalIpsWithMdns',
);

// SEMPRE a melhor GPU para codificar a tela, e sem deixar a lista de bloqueio
// do Chromium barrar o codificador de hardware.
//
// force-high-performance-gpu: o Windows entrega a placa DEDICADA quando existe
// (NVIDIA/AMD, onde vivem NVENC/VCE); sem dedicada, a INTEGRADA do processador
// (Intel Quick Sync / AMD), que também codifica por hardware. Automático.
//
// ignore-gpu-blocklist: alguns pares placa+driver entram numa lista de bloqueio
// conservadora do Chromium que desliga o encode por hardware "por precaução".
// Numa ferramenta de acesso remoto isso é justamente o que não queremos — o
// resultado é o vídeo caindo no processador. Ignorar a lista devolve o NVENC.
app.commandLine.appendSwitch('force-high-performance-gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// ─────────────────────────────────────────────────────────────────────
// A CORREÇÃO DA LENTIDÃO DE VERDADE (descoberta pelo log de diagnóstico).
//
// O app roda como ADMINISTRADOR. E o Chromium, quando elevado, não consegue
// montar o sandbox do PROCESSO DE GPU e simplesmente DESLIGA a GPU inteira
// (`getGPUFeatureStatus` vira `encode=disabled_software`, `decode=disabled_software`).
// Com a GPU desligada, a captura de tela do Windows — que usa a Desktop
// Duplication API e depende de um dispositivo D3D da placa — NÃO INICIA, e
// devolve "NotReadableError: Could not start video source". Aí o app cai na rota
// reserva por canvas, que roda a ~1 quadro por segundo. Era ISSO a lentidão.
//
// `disable-gpu-sandbox` desliga APENAS o sandbox do processo de GPU (não o
// sandbox dos renderers). É o ajuste padrão para apps Electron elevados: deixa a
// GPU inicializar de novo, o que devolve o encode por hardware E faz a captura
// de tela voltar a funcionar em velocidade cheia. Num app que já roda como
// administrador, o sandbox da GPU não era a fronteira de segurança relevante.
app.commandLine.appendSwitch('disable-gpu-sandbox');

// Sob nenhuma hipótese desligamos a aceleração por hardware. Deixado explícito
// para ninguém reintroduzir um `disableHardwareAcceleration` "por estabilidade"
// e, com isso, jogar toda a codificação de volta no processador.

// Duas cópias abertas disputariam o mesmo número Ryke na malha.
// O ajudante é a exceção: ele não é uma cópia do programa, é um satélite sem
// janela e sem número Ryke. Pegar a trava faria ele MATAR o aplicativo que
// acabou de chamá-lo.
if (!EH_AJUDANTE && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/**
 * O Ryke Desk quer rodar elevado (ver elevation.ts). Se não estiver, e o
 * usuário não tiver pedido explicitamente para seguir sem admin, tentamos
 * relançar com UAC antes de qualquer inicialização.
 *
 * A variável RYKE_SEM_ELEVACAO é a válvula de escape: o relançamento a define
 * ao chamar a si mesmo caso o UAC seja recusado, para não cair num laço de
 * pedir elevação eternamente.
 */
// O aplicativo abre no nível normal do usuário. Elevar automaticamente
// fazia instaladores e antivírus tratarem cada abertura como uma operação
// de alto risco. Acesso à área de trabalho e a programas comuns não exige
// administrador; somente janelas que também estejam elevadas ficam protegidas
// pelo próprio Windows.

/**
 * Lista de corretores vinda do ambiente, para os testes.
 *
 * Vazia em uso normal — a malha usa os corretores públicos embutidos. Os
 * testes de ponta a ponta preenchem isto com corretores locais, para não
 * dependerem de serviços de terceiros estarem no ar: um teste que falha por
 * causa da internet alheia não diz nada sobre o nosso código.
 */
function listaDoAmbiente(nome: 'RYKE_CORRETORES' | 'RYKE_RELAYS'): string[] | null {
  const bruto = process.env[nome];
  // Ausente = usa a lista embutida. Definida (mesmo vazia) = substitui, o que
  // permite ao teste desligar uma família inteira.
  if (bruto === undefined) return null;
  return bruto
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^wss?:\/\/.+/i.test(s));
}

let store: Store;
let transfers: Transfers;
const challenges = new ChallengeBook();
const throttle = new Throttle();

/**
 * Chaves de sessão por número de peer, derivadas da senha na autenticação.
 *
 * Ficam só aqui: o renderer pede para carimbar ou conferir um SDP, nunca
 * recebe a chave. Assim nem um defeito na interface entregaria material
 * derivado da senha.
 */
const chavesDeSessao = new Map<string, Buffer>();

let mainWindow: BrowserWindow | null = null;
/** O ícone perto do relógio. Mantém o programa vivo mesmo com a janela fechada. */
let tray: Tray | null = null;
/**
 * Só uma saída de verdade fecha o programa; fechar a janela apenas o esconde
 * no ícone perto do relógio. Sem esta trava, o "Sair" do menu e a substituição
 * de arquivos pelo instalador não conseguiriam encerrar o processo.
 */
let encerrando = false;
/**
 * O atalho que abre o Ryke Desk junto com o Windows passa `--minimizado`.
 * Nesse caso a janela nasce escondida no ícone perto do relógio: o programa já
 * está na malha e pronto para receber acesso, sem roubar a tela de quem acabou
 * de ligar o computador.
 */
const iniciarMinimizado = process.argv.includes('--minimizado');
let captureDisplayId: number | null = null;
let ultimoPerfilCapturaSoftware: {
  mime: 'image/jpeg' | 'image/png';
  lossless: boolean;
  jpegQuality: number;
  width: number;
  height: number;
} | null = null;
let displayChangeTimer: NodeJS.Timeout | null = null;
let sleepBlocker: number | null = null;
/** O visitante quer o teclado inteiro? Só vale enquanto a janela tem foco. */
let querCapturarTeclado = false;

/**
 * Quantos visitantes estão controlando esta máquina agora.
 *
 * Vive no processo principal porque é ele quem tranca a senha enquanto houver
 * sessão: a interface, que é o outro lugar possível, está sob o comando de
 * quem se quer barrar.
 */
let visitantesConectados = 0;

/**
 * Instala ou remove o gancho de teclado, e leva o que ele pega até a interface.
 *
 * A entrega passa pelo renderer de propósito: quem sabe traduzir tecla em
 * mensagem da sessão é a mesma parte que já faz isso para o teclado comum, e
 * duplicar essa tradução no processo principal seria criar dois caminhos que
 * envelhecem separados.
 */
function ligarCapturaDeTeclado(on: boolean): boolean {
  return tecladoGlobal.capturar(on, (evento) => {
    mainWindow?.webContents.send('teclado:evento', evento);
  });
}

/**
 * Conta ao visitante onde o cursor DESTE computador está.
 *
 * Existe porque a seta que o visitante via era a que vem desenhada dentro do
 * vídeo, e ela chega com o atraso da imagem: mexer o mouse e ver a seta
 * responder meio segundo depois torna o trabalho fino insuportável. Agora o
 * visitante navega com o cursor do próprio Windows — instantâneo, porque é
 * local — e usa esta posição só para desenhar, por cima da imagem, a seta do
 * computador remoto com o nome dele embaixo.
 *
 * Vinte vezes por segundo é o suficiente para a marca acompanhar o movimento
 * sem custar nada: é uma linha de JSON, contra dezenas de milhares de pixels
 * que o vídeo já manda no mesmo intervalo. E só sai quando o ponto muda —
 * cursor parado não gera tráfego nenhum.
 */
const INTERVALO_CURSOR_MS = 50;
let relogioCursor: NodeJS.Timeout | null = null;
let ultimoCursor = '';

function comecarARelatarCursor(): void {
  if (relogioCursor !== null) return;
  ultimoCursor = '';
  relogioCursor = setInterval(() => {
    // (a) O cursor DESTE computador, para cada visitante desenhar a seta do
    // dono da máquina — a branca, sem cor, que não obedece a ninguém de fora.
    //
    // ENQUANTO O CURSOR ESTÁ EMPRESTADO, a posição real é a do VISITANTE — foi
    // fomos nós que o levamos até lá para poder clicar. Relatá-la fazia a seta
    // SALTAR para cima da seta colorida a cada clique e acompanhá-la em cada
    // rolagem: as duas setas viravam uma só, que é o defeito de "as setas se
    // misturam". Durante o empréstimo a seta branca fica onde o dono a deixou,
    // que é onde ela de fato pertence — o empréstimo é do cursor do Windows,
    // não da seta da pessoa.
    const emprestado = emprestimo && cursorAindaOndeDeixamos() ? emprestimo : null;
    const ponto = emprestado ? emprestado.volta : input.cursorPosition();
    const fracao = ponto ? toFraction(captureDisplayId, ponto.x, ponto.y) : null;
    // Fora da tela capturada (outro monitor): não há onde desenhar.
    if (fracao && ponto) {
      // A FORMA vai junto da posição: assim a seta do anfitrião que o visitante
      // desenha vira viga de texto, redimensionar ou mãozinha conforme o cursor
      // real de lá. Entra na marca para uma troca de forma sem mexer o cursor
      // (parado sobre um campo) também ser enviada.
      // Emprestado, a forma do cursor REAL é a do lugar onde o visitante está
      // clicando. A seta branca está desenhada noutro ponto: perguntamos a forma
      // de LÁ, senão o desenho mente sobre o que há sob ela.
      const tipo = emprestado ? input.cursorShapeAtPoint(ponto.x, ponto.y) : input.cursorShape();
      const marca = `${fracao.x.toFixed(4)},${fracao.y.toFixed(4)},${tipo}`;
      if (marca !== ultimoCursor) {
        ultimoCursor = marca;
        mainWindow?.webContents.send('cursor:posicao', { x: fracao.x, y: fracao.y, tipo });
      }
    }

    // (b) As setas virtuais dos visitantes, para a interface repassar a cada
    // um as dos OUTROS. Vinte vezes por segundo é o bastante: a própria seta
    // cada um desenha localmente, sem passar por aqui e sem atraso; estas são
    // as alheias, e para elas o olho não distingue 20 de 60.
    if (ponteiros.size > 0) mainWindow?.webContents.send('ponteiros:estado', ponteirosParaVisitantes());
  }, INTERVALO_CURSOR_MS);
}

function pararDeRelatarCursor(): void {
  if (relogioCursor === null) return;
  clearInterval(relogioCursor);
  relogioCursor = null;
}

// ── a área protegida do Windows (UAC) ─────────────────────────────
//
// O DEFEITO QUE ISTO CORRIGE: clicar em algo que pede administrador — um
// instalador, por exemplo — fazia a sessão CONGELAR E NÃO VOLTAR MAIS. O
// Windows troca para a área protegida, a captura para de entregar quadros e a
// entrada injetada não chega a lugar nenhum.
//
// Nada disso disparava recuperação, e por dois motivos que se somavam:
//   • a trilha de vídeo continua "viva", só que muda — então o evento `ended`,
//     que é quem manda recapturar, nunca acontecia;
//   • a vigilância da sessão via os DOIS lados parados e concluía, pela regra
//     dela e com razão, que era só uma "tela quieta".
//
// Então ninguém reerguia a captura, nem quando o UAC saía da frente. Perguntar
// ao Windows de quem é a área de entrada resolve os dois: dá para AVISAR quem
// está do outro lado, em vez de deixar a tela morta sem explicação, e dá para
// reerguer a captura no instante em que a área normal volta.
const INTERVALO_AREA_PROTEGIDA_MS = 500;
let relogioAreaProtegida: NodeJS.Timeout | null = null;
let areaProtegidaAntes = false;

function comecarAVigiarAreaProtegida(): void {
  if (relogioAreaProtegida !== null) return;
  areaProtegidaAntes = input.desktopSeguroAtivo();
  relogioAreaProtegida = setInterval(() => {
    const agora = input.desktopSeguroAtivo();
    if (agora === areaProtegidaAntes) return;
    areaProtegidaAntes = agora;
    registrarDiag(
      `[uac] área protegida ${agora ? 'ENTROU na frente' : 'saiu — reerguendo a captura'}`,
    );
    send('captura:areaProtegida', agora);
  }, INTERVALO_AREA_PROTEGIDA_MS);
}

function pararDeVigiarAreaProtegida(): void {
  if (relogioAreaProtegida === null) return;
  clearInterval(relogioAreaProtegida);
  relogioAreaProtegida = null;
  areaProtegidaAntes = false;
}

// ──────────────────────── as setas da sessão ──────────────────────
//
// O Windows tem UM ponteiro. Enquanto o movimento do visitante ia direto para
// o SendInput, esse ponteiro único era disputado: quem estava sentado aqui via
// a seta fugir da mão, e com dois visitantes eram três mãos num mouse só.
//
// Agora cada visitante tem uma seta VIRTUAL — desenho, e nada além disso. Ela
// mora na camada transparente logo abaixo, anda sozinha e não encosta no
// cursor do sistema. O cursor real continua sendo de quem está aqui; ele só é
// EMPRESTADO no instante de um clique, e devolvido ao lugar em seguida.

/** Uma seta virtual viva agora, em fração da tela capturada. */
type PonteiroVivo = { nome: string; cor: number; x: number; y: number };

const ponteiros = new Map<string, PonteiroVivo>();
let janelaSetas: BrowserWindow | null = null;
/**
 * Este Windows recusou esconder a camada da captura — não insista.
 *
 * Sem esta trava, cada visitante que entrasse tentaria abrir a camada de novo,
 * falharia do mesmo jeito e repetiria o aviso na tela. Um alerta é informação;
 * o mesmo alerta cinco vezes é ruído, e ruído a pessoa aprende a ignorar.
 */
let camadaRecusada = false;

function setasIndependentes(): boolean {
  // Ausente = ligado. Quem atualiza de uma versão antiga não tinha a chave
  // gravada, e nascer desligado devolveria justamente o defeito.
  return store?.getSettings().setasIndependentes !== false;
}

/**
 * A camada só existe onde o Windows sabe escondê-la da captura.
 *
 * `setContentProtection` usa `SetWindowDisplayAffinity`. A partir do Windows 10
 * 2004 (build 19041) existe WDA_EXCLUDEFROMCAPTURE, que torna a janela
 * invisível para quem grava a tela — exatamente o que queremos: as setas são
 * para quem está AQUI, e o visitante desenha as dele localmente, sem atraso.
 *
 * Nas versões anteriores só existe WDA_MONITOR, que não esconde: pinta de
 * PRETO na captura. Uma janela do tamanho da tela viraria um retângulo preto
 * cobrindo o vídeo inteiro. Diante disso, preferimos não abrir a camada: quem
 * está no anfitrião deixa de ver as setas dos visitantes, e todo o resto —
 * inclusive a independência dos ponteiros — continua funcionando.
 */
function podeEsconderDaCaptura(): boolean {
  const build = Number(release().split('.')[2] ?? 0);
  return process.platform === 'win32' && build >= 19041;
}

function abrirCamadaDeSetas(): void {
  if (janelaSetas && !janelaSetas.isDestroyed()) return;
  if (camadaRecusada) return;
  if (!podeEsconderDaCaptura()) return;

  const alvo = findDisplay(captureDisplayId);
  janelaSetas = new BrowserWindow({
    ...alvo.bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Nunca rouba o foco de nada. Uma janela sempre-no-topo que aceita foco
    // roubaria o clique do próprio programa que o visitante está tentando usar.
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    acceptFirstMouse: false,
    webPreferences: {
      preload: join(__dirname, '../preload/ponteiros.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // A camada redesenha a cada movimento do mouse do outro lado; em segundo
      // plano o Chromium estrangula os timers e ela andaria aos solavancos.
      backgroundThrottling: false,
    },
  });

  // O mouse atravessa: a camada desenha e mais nada. Sem isto ela engoliria
  // todo clique da máquina, que é o pior defeito possível numa janela que
  // cobre a tela inteira.
  janelaSetas.setIgnoreMouseEvents(true, { forward: false });
  janelaSetas.setAlwaysOnTop(true, 'screen-saver');
  janelaSetas.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Pedido também pelo caminho do Electron, por garantia. Quem decide se a
  // camada aparece, porém, é a conferência lá embaixo — este método não conta
  // se deu certo, e aqui "não deu certo" significa seta duplicada na tela de
  // todo mundo.
  janelaSetas.setContentProtection(true);

  janelaSetas.on('closed', () => {
    janelaSetas = null;
  });

  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) void janelaSetas.loadURL(url + '/ponteiros.html');
  else void janelaSetas.loadFile(join(__dirname, '../renderer/ponteiros.html'));

  janelaSetas.once('ready-to-show', () => {
    const janela = janelaSetas;
    if (!janela || janela.isDestroyed()) return;

    // showInactive, e não show: mostrar normalmente traria o foco para uma
    // janela vazia e tiraria o cursor de onde o usuário estava trabalhando.
    janela.showInactive();

    // A exclusão da captura é aplicada AGORA, com a janela já criada de fato
    // pelo Windows, e o resultado é conferido. Antes de existir handle nativo
    // o pedido cai no vazio, e era assim que a camada acabava dentro do vídeo.
    //
    // Se o Windows recusar, a camada NÃO fica. Perder as setas na tela de quem
    // está sendo acessado é ruim; deixá-las entrarem no vídeo é pior — vira uma
    // segunda seta vermelha atrás da de cada visitante, e o programa passa a
    // parecer quebrado justamente no recurso que ele tem de diferente.
    if (!input.excluirDaCaptura(janela.getNativeWindowHandle())) {
      // GRAVADO em arquivo, e não só no console: este erro é a explicação de "a
      // seta colorida não aparece na tela de quem está sendo acessado", e no
      // console ele morre junto com a janela — ninguém nunca o vê. Sem isto o
      // sintoma chega sem nenhuma pista do motivo.
      //
      // E NÃO desligamos mais a camada de vez: antes uma recusa única condenava
      // a sessão inteira a ficar sem setas, mesmo que a tentativa seguinte fosse
      // dar certo. Agora a próxima entrada de visitante tenta de novo.
      registrarDiag('[setas] o Windows recusou esconder a camada — sem setas nesta tentativa');
      fecharCamadaDeSetas();
      send('setas:indisponivel');
      return;
    }

    registrarDiag('[setas] camada de setas no ar');
    desenharSetas();
  });
}

/**
 * A lista para a CAMADA desta máquina: todo mundo, com quem está jogando
 * marcado como oculto.
 *
 * Marcado, e não removido. A camada usa esta lista para duas coisas — desenhar
 * as setas e montar a tarja de "este computador está sendo controlado" — e as
 * duas têm regras opostas: a seta de quem está no Modo Gamer não deve
 * aparecer, mas a pessoa continua controlando esta máquina e precisa continuar
 * na tarja. Remover aqui transformaria o Modo Gamer num botão de
 * invisibilidade, que é o oposto do que um programa de acesso remoto deve ter.
 */
function ponteirosDaCamada(): Ponteiro[] {
  return [...ponteiros.entries()].map(([id, p]) => ({
    id,
    nome: p.nome,
    cor: p.cor,
    x: p.x,
    y: p.y,
    oculta: emModoGamer.has(id),
    tipo: formaDoPonteiro(id, p.x, p.y),
  }));
}

/** Este visitante está com o cursor real na mão — arrastando ou clicando? */
function controlaCursorReal(peerId: string): boolean {
  return emprestimo?.dono === peerId || (botoesSegurados.get(peerId)?.size ?? 0) > 0;
}

/**
 * Que forma a seta deste visitante deve ter.
 *
 * Se ele está com o cursor real (arrasto/clique), a forma é a do cursor de
 * verdade — precisa: é aí que o "arrastar a borda" vira redimensionar dentro de
 * qualquer programa. Se só paira, perguntamos à janela sob o ponto, sem mover
 * nada. Ver `cursorShape`/`cursorShapeAtPoint`.
 */
function formaDoPonteiro(peerId: string, fx: number, fy: number): TipoCursor {
  if (controlaCursorReal(peerId)) return input.cursorShape();
  const fisico = toPhysicalPoint(captureDisplayId, fx, fy);
  return input.cursorShapeAtPoint(fisico.x, fisico.y);
}

/**
 * A lista para os OUTROS VISITANTES: só as setas que fazem sentido desenhar.
 *
 * Aqui filtrar é o certo. Um visitante não tem por que ver a seta parada de
 * quem entrou no Modo Gamer, e a tarja de aviso não é assunto dele — ela
 * existe para quem está sentado na máquina controlada.
 */
function ponteirosParaVisitantes(): Ponteiro[] {
  return ponteirosDaCamada().filter((p) => !p.oculta);
}

function fecharCamadaDeSetas(): void {
  if (!janelaSetas || janelaSetas.isDestroyed()) {
    janelaSetas = null;
    return;
  }
  janelaSetas.destroy();
  janelaSetas = null;
}

/** Reencaixa a camada no monitor que está sendo capturado agora. */
function reencaixarCamadaDeSetas(): void {
  if (!janelaSetas || janelaSetas.isDestroyed()) return;
  janelaSetas.setBounds(findDisplay(captureDisplayId).bounds);
}

function desenharSetas(): void {
  if (!janelaSetas || janelaSetas.isDestroyed()) return;
  const lista = ponteirosDaCamada();
  janelaSetas.webContents.send('ponteiros:desenhar', lista);
}

// ── o empréstimo do cursor real ──
//
// Mover a seta não move o cursor do Windows. Clicar precisa mover: não existe
// "clicar ali" sem o ponteiro estar ali — o Windows entrega o clique a quem
// estiver embaixo dele. Então pegamos o cursor emprestado pelo tempo do
// clique, guardamos onde ele estava e o devolvemos.
//
// Arrastar é a exceção que confirma a regra: enquanto o botão está apertado, o
// cursor fica com o visitante, porque um arrasto que larga o ponteiro no meio
// do caminho não arrasta nada.

/** Botões que cada visitante está segurando agora. */
const botoesSegurados = new Map<string, Set<number>>();
/** Para onde o cursor volta quando o clique acaba, e de quem é o empréstimo. */
let emprestimo: { dono: string; volta: { x: number; y: number } } | null = null;
/** O último ponto que NÓS injetamos — a régua para saber se alguém mexeu. */
let ultimoInjetado: { x: number; y: number } | null = null;
/** Quando injetamos aquele ponto. Ver `cursorAindaOndeDeixamos`. */
let ultimoInjetadoEm = 0;
let devolucaoAgendada: NodeJS.Timeout | null = null;

/**
 * O cursor ainda está onde NÓS o pusemos, ou a pessoa daqui pegou o mouse de
 * volta? A decisão — inclusive a carência que conserta o "branco preso no
 * vermelho" — mora em `shared/emprestimo-cursor`, onde o teste a cobre. Aqui
 * só colhemos o estado do Windows.
 */
function cursorAindaOndeDeixamos(): boolean {
  return aindaOndeDeixamos({
    ultimoInjetado,
    desdeAInjecaoMs: Date.now() - ultimoInjetadoEm,
    lerPosicao: () => input.cursorPosition(),
  });
}

/** A espera antes de devolver o cursor. Ver `shared/emprestimo-cursor`. */
function esperaDevolucaoMs(): number {
  return calcularEsperaDevolucao(input.doubleClickTime());
}

/**
 * Onde o cursor do DONO está — o ponto que o empréstimo promete devolver.
 *
 * Logo depois de uma DEVOLUÇÃO o GetCursorPos ainda pode responder o ponto
 * ANTIGO, que é justamente o do visitante. Guardar aquilo como "lugar do dono"
 * faria a seta branca migrar de vez para cima da colorida a cada par de cliques
 * seguidos — o mesmo defeito por outra porta. Dentro da carência vale o que nós
 * mesmos acabamos de injetar, que é onde o cursor está indo parar.
 */
function posicaoDeRepouso(): { x: number; y: number } | null {
  if (ultimoInjetado && Date.now() - ultimoInjetadoEm < GRACA_INJECAO_MS) return ultimoInjetado;
  return input.cursorPosition();
}

function moverCursorReal(ponto: { x: number; y: number }): void {
  input.moveMouseTo(ponto.x, ponto.y);
  ultimoInjetado = ponto;
  ultimoInjetadoEm = Date.now();
}

function pegarCursorEmprestado(peerId: string, ponto: { x: number; y: number }): void {
  if (devolucaoAgendada) {
    clearTimeout(devolucaoAgendada);
    devolucaoAgendada = null;
  }
  // Só o PRIMEIRO a pegar registra o ponto de volta. Se um segundo visitante
  // clicar no meio do clique do primeiro, o cursor ainda tem de voltar para
  // onde o dono da máquina o deixou — e não para onde o primeiro visitante
  // estava apontando.
  if (!emprestimo) emprestimo = { dono: peerId, volta: posicaoDeRepouso() ?? ponto };
  moverCursorReal(ponto);
}

function devolverCursor(peerId: string, agora: boolean): void {
  if (!emprestimo || emprestimo.dono !== peerId) return;
  if (!agora) {
    if (devolucaoAgendada) clearTimeout(devolucaoAgendada);
    devolucaoAgendada = setTimeout(() => {
      devolucaoAgendada = null;
      devolverCursor(peerId, true);
    }, esperaDevolucaoMs());
    return;
  }

  const { volta } = emprestimo;
  emprestimo = null;
  if (devolucaoAgendada) {
    clearTimeout(devolucaoAgendada);
    devolucaoAgendada = null;
  }

  // Se o cursor não está mais onde deixamos, quem o moveu foi a pessoa daqui —
  // com a mão dela, no mouse dela. Devolvê-lo ao ponto antigo arrancaria o
  // ponteiro da mão de quem está trabalhando, que é o defeito original.
  if (!cursorAindaOndeDeixamos()) return;
  moverCursorReal(volta);
}

function segurandoBotao(peerId: string): boolean {
  return (botoesSegurados.get(peerId)?.size ?? 0) > 0;
}

// ── o Modo Gamer, do lado do anfitrião ──

/** Quem está jogando agora. Enquanto estiver aqui, não desenhamos seta. */
const emModoGamer = new Set<string>();

/**
 * O centro da tela capturada, em pixels físicos — o poste ao qual o ponteiro
 * fica amarrado enquanto alguém joga.
 */
function centroDaTela(): { x: number; y: number } {
  return toPhysicalPoint(captureDisplayId, 0.5, 0.5);
}

/**
 * Devolve o ponteiro ao centro, sem o jogo perceber.
 *
 * Chamado depois de CADA rajada de movimento relativo. Parece exagero e não é:
 * é a diferença entre uma mira que gira 360° sem fim e uma que trava assim que
 * o ponteiro invisível encosta na borda do monitor. Como usa `warpCursor`
 * (SetCursorPos), o salto de volta não entra no Raw Input e o jogo não o
 * enxerga — ele só vê o deslocamento que mandamos de propósito.
 */
function recentralizarParaOJogo(): void {
  const centro = centroDaTela();
  input.warpCursor(centro.x, centro.y);
  ultimoInjetado = centro;
}

/** Anota onde a seta deste visitante está e repinta a camada. */
function registrarPonteiro(peerId: string, fx: number, fy: number): void {
  const atual = ponteiros.get(peerId);
  if (!atual) return;
  atual.x = Math.min(Math.max(fx, 0), 1);
  atual.y = Math.min(Math.max(fy, 0), 1);
  desenharSetas();
}

// ─────────────────────────── janela ───────────────────────────────

/**
 * Caminho do ícone do aplicativo, tanto instalado quanto rodando do build.
 *
 * Empacotado, `extraResources` copia os ícones para a pasta `resources`, ao
 * lado do executável — a pasta `build` do projeto não vai junto. Rodando do
 * código, eles ficam em `build/` na raiz.
 */
function iconePath(): string {
  const nome = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return app.isPackaged ? join(process.resourcesPath, nome) : join(app.getAppPath(), 'build', nome);
}

/** Traz a janela de volta do ícone perto do relógio para a frente. */
function mostrarJanela(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}


// ── o passe de retorno da troca de modo ──────────────────────────
//
// Trocar para o modo administrador REABRE o programa. Numa conexão
// supervisionada (sem senha salva), isso obrigava a pessoa daqui a autorizar
// tudo de novo — mesmo tendo sido ELA quem pediu a troca, segundos antes. Uma
// pergunta que não protege nada e só atrapalha: a resposta honesta a "posso
// deixar entrar?" já tinha sido dada.
//
// O que este passe NÃO é: uma porta aberta. Ele vale apenas para os números
// que JÁ ESTAVAM conectados no instante da troca, expira em dois minutos, e
// cada número o usa UMA vez só — depois disso é apagado. Fora dessa janela,
// tudo volta a passar pela autorização de sempre.
const PASSE_VALIDO_MS = 120_000;

function caminhoPasse(): string {
  return join(app.getPath('userData'), 'ryke-passe-retorno.json');
}

function salvarPasseDeRetorno(peers: string[]): void {
  if (peers.length === 0) return;
  try {
    writeFileSync(caminhoPasse(), JSON.stringify({ peers, expira: Date.now() + PASSE_VALIDO_MS }), 'utf8');
    registrarDiag(`[passe] guardado para ${peers.length} visitante(s), válido por ${PASSE_VALIDO_MS / 1000}s`);
  } catch (e) {
    registrarDiag(`[passe] não deu para guardar: ${String(e)}`);
  }
}

/** Vale para este número agora? Se valer, gasta o passe e devolve true. */
function consumirPasseDeRetorno(peerId: string): boolean {
  try {
    const dados = JSON.parse(readFileSync(caminhoPasse(), 'utf8')) as { peers?: unknown; expira?: unknown };
    const peers = Array.isArray(dados.peers) ? dados.peers.filter((p): p is string => typeof p === 'string') : [];
    const expira = typeof dados.expira === 'number' ? dados.expira : 0;
    if (Date.now() > expira || !peers.includes(peerId)) return false;
    const restantes = peers.filter((p) => p !== peerId);
    if (restantes.length === 0) rmSync(caminhoPasse(), { force: true });
    else writeFileSync(caminhoPasse(), JSON.stringify({ peers: restantes, expira }), 'utf8');
    registrarDiag(`[passe] usado por ${peerId} — entrou sem pedir autorização de novo`);
    return true;
  } catch {
    // Sem arquivo, ilegível ou vencido: segue o caminho normal, pedindo.
    return false;
  }
}
/**
 * Reabre o Ryke Desk no OUTRO nível de privilégio.
 *
 * O app roda SEM elevação de propósito — é a única forma de a captura de tela
 * funcionar (o Chromium não consegue capturar a tela quando elevado). Mas às
 * vezes é preciso admin no PC remoto (instalar um programa, mexer numa janela
 * que pede administrador). Este botão troca de modo sem prompt de UAC:
 *
 *   • para ADMIN: dispara a tarefa "RykeDesk-Admin" (RL HIGHEST), que sobe o app
 *     elevado SEM a janela de UAC — o que é essencial numa sessão remota, onde
 *     essa janela apareceria na área de trabalho segura, invisível para quem
 *     controla. (Enquanto elevado, a captura fica lenta — é o preço de ter admin,
 *     e por isso é um modo temporário, para a tarefa e volta.)
 *   • para NORMAL: relança pelo explorer.exe, que "des-eleva" e devolve a captura
 *     rápida.
 *
 * A nova cópia é subida pelo AGENDADOR DE TAREFAS (elevar) ou pelo EXPLORER
 * (normal) — nenhum dos dois é filho deste processo, então a nova cópia sobrevive
 * a este app morrer, aconteça o que acontecer com o lançador.
 */
/**
 * Dispara um programa e conta o que aconteceu no diagnóstico.
 *
 * Argumentos em VETOR, e nunca uma linha de comando montada à mão: é o que
 * conserta o "fecha e não reabre". A versão anterior montava um comando enorme
 * numa string e o entregava ao `cmd /c`. O Node envolve esse argumento em
 * aspas, e o cmd — que já tem as próprias regras para aspas dentro de aspas —
 * se perdia com as aspas dos caminhos, SAÍA COM CÓDIGO 0 e não executava nada.
 * Silenciosamente: nem o primeiro `echo` chegava a rodar, então nem no log
 * ficava rastro. Chamando o executável direto, o Node entrega os argumentos ao
 * Windows já separados e não existe string para o cmd interpretar errado.
 */
function lancar(programa: string, argumentos: string[], pronto: (ok: boolean) => void): void {
  let respondeu = false;
  const responder = (ok: boolean): void => {
    if (respondeu) return;
    respondeu = true;
    pronto(ok);
  };
  try {
    const filho = spawn(programa, argumentos, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let saida = '';
    filho.stdout?.on('data', (d) => (saida += String(d)));
    filho.stderr?.on('data', (d) => (saida += String(d)));
    filho.on('error', (e) => {
      registrarDiag(`[relanc] ${programa} não executou: ${String(e)}`);
      responder(false);
    });
    filho.on('exit', (codigo) => {
      const resumo = saida.trim().replace(/s+/g, ' ').slice(0, 200);
      registrarDiag(`[relanc] ${programa} saiu=${codigo}${resumo ? ` — ${resumo}` : ''}`);
      responder(codigo === 0);
    });
  } catch (e) {
    registrarDiag(`[relanc] falha ao lançar ${programa}: ${String(e)}`);
    responder(false);
  }
}

/**
 * Espera o ajudante conectar no cano, ou desiste.
 *
 * Ele sobe por um serviço do Windows, então leva um instante. Desistir depois
 * de um tempo importa: sem isso a interface diria "modo administrador ligado"
 * enquanto nada estaria escutando, e cada clique do visitante cairia no vazio
 * sem explicação nenhuma.
 */
function esperarAjudante(limiteMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const comecou = Date.now();
    const relogio = setInterval(() => {
      if (ajudanteConectado()) {
        clearInterval(relogio);
        resolve(true);
      } else if (Date.now() - comecou >= limiteMs) {
        clearInterval(relogio);
        resolve(false);
      }
    }, 100);
  });
}

/**
 * Liga ou desliga o MODO ADMINISTRADOR — e agora SEM reiniciar nada.
 *
 * O QUE MUDOU, E POR QUE
 *
 * Antes isto reabria o Ryke Desk inteiro elevado. Custava três coisas de uma
 * vez: a captura do Chromium não inicia em processo elevado (NotReadableError)
 * e a imagem caía de 60 quadros para 1; a sessão caía junto com o reinício; e
 * numa conexão sem senha salva era preciso autorizar tudo de novo.
 *
 * A observação que desfaz o nó: só a INJEÇÃO de mouse e teclado precisa de
 * privilégio — a captura não. Então o aplicativo nunca mais eleva, e quem eleva
 * é um ajudante que não desenha nem captura nada (ver `ajudante.ts`).
 *
 * O resultado é que ligar o modo administrador deixou de ter preço: a imagem
 * continua em 60 quadros, a conexão não cai e ninguém precisa autorizar de
 * novo, porque não há reinício nenhum.
 */
async function trocarModo(ligar: boolean): Promise<{ ok: boolean; mensagem: string }> {
  const pastaDados = app.getPath('userData');

  if (!ligar) {
    // Fechar o cano basta: o ajudante morre sozinho quando ele cai, e antes de
    // morrer solta o que estiver preso. Um processo elevado órfão injetando
    // teclado é exatamente o que não pode sobrar.
    fecharCanoDoAjudante(pastaDados);
    registrarDiag('[modo] administrador DESLIGADO — o ajudante foi dispensado');
    return { ok: true, mensagem: 'Modo administrador desligado.' };
  }

  if (ajudanteConectado()) {
    return { ok: true, mensagem: 'O modo administrador já estava ligado.' };
  }

  registrarDiag('[modo] ligando o administrador (ajudante elevado, sem reiniciar)');
  abrirCanoDoAjudante(pastaDados, registrarDiag);

  const windir = process.env.WINDIR ?? 'C:\\Windows';
  const disparou = await new Promise<boolean>((resolve) => {
    // A tarefa RL HIGHEST criada pelo instalador sobe o ajudante SEM UAC —
    // essencial numa sessão remota, onde o UAC apareceria na área protegida,
    // invisível para quem está controlando.
    lancar(join(windir, 'System32', 'schtasks.exe'), ['/Run', '/TN', 'RykeDesk-Entrada'], resolve);
  });

  if (!disparou) {
    fecharCanoDoAjudante(pastaDados);
    registrarDiag('[modo] a tarefa RykeDesk-Entrada não subiu');
    return {
      ok: false,
      mensagem:
        'Não consegui subir o ajudante de administrador. Se o Ryke Desk foi atualizado de uma versão antiga, reinstale para criar a tarefa que falta.',
    };
  }

  if (!(await esperarAjudante(8000))) {
    fecharCanoDoAjudante(pastaDados);
    registrarDiag('[modo] o ajudante subiu mas não conectou no cano');
    return { ok: false, mensagem: 'O ajudante não respondeu. O modo administrador continua desligado.' };
  }

  registrarDiag('[modo] administrador LIGADO — sessão intacta, captura segue por hardware');
  return { ok: true, mensagem: 'Modo administrador ligado. A imagem continua rápida e a conexão não caiu.' };
}

/**
 * O ícone perto do relógio.
 *
 * É ele que sustenta o "sempre minimizado": ao abrir junto com o Windows, ou
 * ao fechar a janela, o programa continua vivo na malha e à disposição, sem
 * ocupar a tela. Um clique traz a janela de volta; "Sair" encerra de verdade.
 */
function criarTray(): void {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(iconePath());
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  } catch {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip('Ryke Desk');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir Ryke Desk', click: () => mostrarJanela() },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          encerrando = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => mostrarJanela());
  tray.on('double-click', () => mostrarJanela());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#0a0e1a',
    title: 'Ryke Desk',
    icon: iconePath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // A janela vive escondida na bandeja enquanto compartilha a tela. Sem isto,
      // o Chromium estrangula os timers do renderer quando a janela não está
      // visível — e é o renderer que captura, codifica e envia o vídeo. Desligar
      // o estrangulamento é o que mantém a sessão em velocidade cheia minimizada.
      backgroundThrottling: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    // Aberto junto com o Windows: nasce escondido no ícone perto do relógio.
    if (!iniciarMinimizado) mainWindow?.show();
    // Rodando elevados, o Explorador (que é comum) não conseguiria nos enviar
    // arquivos arrastados. Esta exceção pontual devolve o recurso.
    if (mainWindow && isElevated()) permitirArrastarArquivos(mainWindow);
  });

  /**
   * Fechar a janela apenas esconde no ícone perto do relógio — o programa
   * continua na malha, pronto para receber acesso. Só o "Sair" do menu (ou o
   * instalador substituindo os arquivos) encerra de verdade.
   */
  mainWindow.on('close', (evento) => {
    if (encerrando) return;
    evento.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  /**
   * A interface morreu. Recarrega, em vez de deixar o programa virar fantasma.
   *
   * Toda a rede do Ryke Desk — a malha de encontro, a presença do número, as
   * sessões — vive no renderer, porque é lá que existe a pilha WebRTC. Quando
   * ele morre, o processo principal continua de pé com uma janela em branco e o
   * computador simplesmente SOME da malha: quem tentar aquele número ouve
   * "ninguém respondeu", e nada na tela explica o motivo.
   *
   * Foi exatamente o que aconteceu numa transferência muito grande. A causa
   * daquela morte está corrigida (ver `notificarProgresso` em files.ts), mas a
   * lição vale para qualquer outra: um renderer que morre precisa voltar
   * sozinho. Recarregar devolve o número à malha em segundos, sem ninguém
   * precisar descobrir que o programa está aberto e inútil.
   *
   * `reason` fica no log porque a diferença entre 'crashed', 'oom' e
   * 'killed' é a diferença entre um defeito nosso, falta de memória e o
   * antivírus — e adivinhar qual dos três foi é o pior jeito de investigar.
   */
  mainWindow.webContents.on('render-process-gone', (_evento, detalhe) => {
    console.error(`[janela] a interface caiu (${detalhe.reason}, código ${detalhe.exitCode}) — recarregando`);
    // Solta o que ficou preso: teclas, bloqueio de entrada, arquivos abertos.
    // Sem isto, um Alt pressionado no instante da queda ficaria pressionado.
    input.releaseAll();
    if (input.isLocalInputBlocked()) input.blockLocalInput(false);
    void transfers?.closeAll();
    ponteiros.clear();
    botoesSegurados.clear();
    emprestimo = null;
    fecharCamadaDeSetas();
    visitantesConectados = 0;

    if (detalhe.reason === 'clean-exit' || detalhe.reason === 'killed') return;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });

  // Links externos abrem no navegador, nunca dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Captura total do teclado: só enquanto esta janela está em primeiro plano.
  // Sequestrar o teclado da máquina com o programa em segundo plano seria
  // inaceitável, e é o tipo de coisa que faz um antivírus ficar nervoso.
  mainWindow.on('focus', () => {
    if (querCapturarTeclado) ligarCapturaDeTeclado(true);
  });
  mainWindow.on('blur', () => ligarCapturaDeTeclado(false));

  const relayState = (): void => send('window:state', windowState());
  mainWindow.on('maximize', relayState);
  mainWindow.on('unmaximize', relayState);
  mainWindow.on('enter-full-screen', relayState);
  mainWindow.on('leave-full-screen', relayState);

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function windowState() {
  return {
    maximized: mainWindow?.isMaximized() ?? false,
    fullscreen: mainWindow?.isFullScreen() ?? false,
    // Minimizada também faz parte do estado: é para onde o Esc leva a sessão.
    minimizada: mainWindow?.isMinimized() ?? false,
  };
}

function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ─────────────────── captura de tela para o WebRTC ────────────────

/**
 * Atende o getDisplayMedia() do renderer sem abrir o seletor do sistema:
 * quem escolhe o monitor é o visitante, pela barra de ferramentas dele.
 */
function installCaptureHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const target = findDisplay(captureDisplayId);
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        const chosen = sources.find((s) => s.display_id === String(target.id)) ?? sources[0];
        if (!chosen) {
          callback({});
          return;
        }

        // Não force áudio quando o renderer pediu somente vídeo. Forçar
        // loopback aqui fazia a segunda tentativa falhar igual à primeira em
        // PCs cujo driver não oferece captura de som.
        callback(request.audioRequested ? { video: chosen, audio: 'loopback' } : { video: chosen });
      } catch (err) {
        console.error('[captura] não foi possível enumerar os monitores:', err);
        // O callback precisa ser respondido até no erro; do contrário a
        // promessa do renderer fica pendurada e nunca chega à rota reserva.
        callback({});
      }
    },
    { useSystemPicker: false },
  );

  // A captura é sempre iniciada por nós, nunca por conteúdo remoto.
  //
  // `pointerLock` entra na lista por causa do Modo Gamer: é ele que prende o
  // mouse na tela para a mira girar 360°. Sem liberar aqui, o pedido cairia no
  // "negado" e o modo não travaria o ponteiro — falhando em silêncio. Só a
  // NOSSA interface pede isso (nunca conteúdo remoto), então é seguro.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => {
    done(permission === 'media' || permission === 'display-capture' || permission === 'pointerLock');
  });
}

/**
 * Estender/duplicar a área de trabalho recria os monitores e seus ids. O
 * renderer recaptura a fonte; o pequeno atraso agrupa a rajada de eventos que
 * o Windows dispara durante uma única mudança.
 */
function installDisplayChangeHandler(): void {
  const changed = (): void => {
    if (displayChangeTimer) clearTimeout(displayChangeTimer);
    displayChangeTimer = setTimeout(() => {
      displayChangeTimer = null;
      captureDisplayId = findDisplay(captureDisplayId).id;
      reencaixarCamadaDeSetas();
      send('screen:changed');
    }, 700);
  };
  screen.on('display-added', changed);
  screen.on('display-removed', changed);
  screen.on('display-metrics-changed', changed);
}

/** Fonte nativa para a rota de compatibilidade usada quando getDisplayMedia falha. */
async function captureSourceId(): Promise<string | null> {
  const target = findDisplay(captureDisplayId);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  return (sources.find((source) => source.display_id === String(target.id)) ?? sources[0])?.id ?? null;
}

/**
 * Última rota de captura: um JPEG atual da tela, produzido no processo
 * principal. Não depende de getDisplayMedia/getUserMedia e por isso funciona
 * em instalações nas quais o Chromium recusa criar uma MediaStream desktop.
 */
async function captureSoftwareFrame(
  pedido?: Partial<PerfilCapturaSoftware>,
): Promise<{ bytes: Uint8Array; mime: 'image/jpeg' | 'image/png'; width: number; height: number }> {
  const target = findDisplay(captureDisplayId);
  const physical = screen.dipToScreenRect(null, target.bounds);
  // Limites defensivos: o renderer escolhe entre perfis conhecidos, mas o
  // processo principal nunca aceita dimensões/qualidade sem validar.
  const maxWidth = Math.min(3840, Math.max(640, Math.round(pedido?.maxWidth ?? 1920)));
  const maxHeight = Math.min(2160, Math.max(360, Math.round(pedido?.maxHeight ?? 1080)));
  const jpegQuality = Math.min(95, Math.max(45, Math.round(pedido?.jpegQuality ?? 80)));
  const lossless = pedido?.lossless === true;
  const escala = Math.min(1, maxWidth / Math.max(physical.width, 1), maxHeight / Math.max(physical.height, 1));
  const thumbnailSize = {
    width: Math.max(1, Math.round(physical.width * escala)),
    height: Math.max(1, Math.round(physical.height * escala)),
  };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize,
    fetchWindowIcons: false,
  });
  const chosen = sources.find((source) => source.display_id === String(target.id)) ?? sources[0];
  if (!chosen || chosen.thumbnail.isEmpty()) throw new Error('o Windows não devolveu imagem para nenhum monitor');
  const size = chosen.thumbnail.getSize();
  const mime = lossless ? 'image/png' : 'image/jpeg';
  ultimoPerfilCapturaSoftware = {
    mime,
    lossless,
    jpegQuality,
    width: size.width,
    height: size.height,
  };
  return {
    bytes: Uint8Array.from(lossless ? chosen.thumbnail.toPNG() : chosen.thumbnail.toJPEG(jpegQuality)),
    mime,
    width: size.width,
    height: size.height,
  };
}

/**
 * Trava o que a interface pode carregar e para onde pode falar.
 *
 * Só entra na versão empacotada: durante o desenvolvimento o servidor do Vite
 * injeta scripts em linha para recarregar a página, que esta política
 * bloquearia. `connect-src` precisa de ws:/wss: por causa da sinalização e de
 * blob:/data: por causa do vídeo e dos arquivos.
 */
function installCsp(): void {
  if (!app.isPackaged) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
            "script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +
            'img-src \'self\' data: blob:; ' +
            'media-src \'self\' blob: mediastream:; ' +
            'connect-src \'self\' ws: wss: blob: data:; ' +
            "font-src 'self'; " +
            "object-src 'none'; " +
            "base-uri 'none'; " +
            "form-action 'none'; " +
            "frame-ancestors 'none'",
        ],
      },
    });
  });
}

// ──────────────────── área de transferência ───────────────────────

/**
 * Observa a área de transferência local e avisa o renderer quando muda.
 * Polling é a única via: o Windows não expõe evento de clipboard ao Electron.
 * 700 ms é imperceptível ao colar e não pesa na CPU.
 */
class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null;
  private lastText = '';
  private lastFiles = '';

  start(): void {
    if (this.timer) return;
    this.lastText = clipboard.readText();
    this.lastFiles = assinaturaDeArquivos(readClipboardFiles());
    this.timer = setInterval(() => this.tick(), 700);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Evita eco: o que acabamos de escrever não deve voltar como novidade. */
  acknowledge(text: string): void {
    this.lastText = text;
  }

  /** O mesmo para arquivos — o que colamos aqui não é uma cópia nova. */
  acknowledgeFiles(paths: string[]): void {
    this.lastFiles = assinaturaDeArquivos(paths);
  }

  private tick(): void {
    // Arquivo tem prioridade sobre texto. Ao dar Ctrl+C no Explorer, o texto
    // costuma mudar para vazio no mesmo instante; espelhar esse vazio para a
    // outra ponta apagaria o CF_HDROP antes de ele ser detectado/enviado.
    const files = readClipboardFiles();
    const text = clipboard.readText();
    if (text !== this.lastText) {
      this.lastText = text;
      // Um clipboard gigante travaria o canal de controle; acima disso o
      // usuário deve usar a transferência de arquivos.
      if (files.length === 0 && text.length <= 256 * 1024) send('clipboard:text', text);
    }

    const assinatura = assinaturaDeArquivos(files);
    if (assinatura !== this.lastFiles) {
      this.lastFiles = assinatura;
      if (files.length > 0) send('clipboard:files', files);
    }
  }
}

/**
 * Lê o caminho do arquivo copiado com Ctrl+C no Explorador.
 * O Windows expõe isso no formato CF_HDROP; o Electron dá acesso ao
 * `FileNameW`, que traz o primeiro arquivo da seleção em UTF-16.
 */
function readClipboardFiles(): string[] {
  return lerArquivosCopiados();
}

const assinaturaDeArquivos = (paths: string[]): string => paths.join('\u0000');

const clipboardWatcher = new ClipboardWatcher();

// ───────────────────────────── IPC ────────────────────────────────

function registerIpc(): void {
  // ── identidade e preferências ──
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    machineName: process.env.COMPUTERNAME ?? 'PC',
    configPath: store.path,
    // "elevated" aqui quer dizer MODO ADMINISTRADOR LIGADO, e não "este
    // processo está elevado" — os dois deixaram de ser a mesma coisa. O
    // aplicativo nunca mais eleva; quem eleva é o ajudante. É o estado deste
    // que o botão da interface reflete.
    elevated: ajudanteConectado(),
    // O processo em si. Deveria ser sempre falso: se aparecer verdadeiro,
    // alguém abriu o Ryke Desk como administrador na mão — e aí a captura cai
    // para 1 quadro por segundo. Vale saber, para o diagnóstico não mentir.
    processoElevado: isElevated(),
    abi: input.verifyAbi(),
  }));

  // Placa de vídeo em uso e se o vídeo está por hardware. É a resposta, sem
  // adivinhação, para "está usando a GPU mesmo?" — e o anfitrião a manda junto
  // do meta, para o visitante ver a placa da máquina que ESTÁ CODIFICANDO.
  ipcMain.handle('gpu:status', () => statusGpu());

  // O renderer despeja aqui os fatos da sessão (rota de captura, rede) para o
  // arquivo de diagnóstico. É como a causa da lentidão vira algo legível no
  // disco depois, em vez de sumir no console de um app empacotado.
  ipcMain.on('diag:log', (_e, linha: string) => registrarDiag(String(linha).slice(0, 2000)));
  // Mostrar o arquivo no Explorador, em vez de abri-lo: assim a pessoa pode
  // anexá-lo direto, que é o caminho que funciona quando a área de
  // transferência não coopera.
  ipcMain.handle('diag:abrir', () => shell.showItemInFolder(caminhoDiag()));

  // Trocar entre modo normal (rápido) e administrador (para instalar/mexer em
  // janelas de admin no PC remoto). Ver `trocarModo`.
  ipcMain.handle('modo:elevar', () => trocarModo(true));
  ipcMain.handle('modo:normal', () => trocarModo(false));

  ipcMain.handle('identity:get', () => store.getIdentity());
  ipcMain.handle('identity:save', (_e, id: string, token: string) => {
    store.saveIdentity(id, token);
  });

  // ── favoritos ──
  ipcMain.handle('favorites:list', () => store.getFavoritos());
  ipcMain.handle('favorites:save', (_e, numero: string, nome: string) => store.saveFavorito(numero, nome));
  ipcMain.handle('favorites:remove', (_e, numero: string) => store.removeFavorito(numero));
  ipcMain.handle('favorites:touch', (_e, numero: string) => {
    store.touchFavorito(numero);
  });

  // ── senhas guardadas de outros computadores ──
  //
  // A senha em si NUNCA é devolvida em lista; a interface só pergunta "tem
  // senha guardada para este número?" e, na hora de conectar, pede aquela
  // específica. Assim um defeito na interface não vaza a lista inteira.
  ipcMain.handle('senhas:lista', () => store.listSavedPasswords());
  ipcMain.handle('senhas:ler', (_e, numero: string) => store.getSavedPassword(numero));
  ipcMain.handle('senhas:salvar', (_e, numero: string, senha: string) => {
    store.saveSavedPassword(numero, senha);
  });
  ipcMain.handle('senhas:esquecer', (_e, numero: string) => {
    store.forgetSavedPassword(numero);
    return { ok: true };
  });

  // ── impressões digitais fixadas ──
  ipcMain.handle('identity:knownHosts', () => store.getKnownHosts());
  ipcMain.handle('identity:pin', (_e, numero: string, impressao: string) => {
    store.saveKnownHost(numero, impressao);
  });
  ipcMain.handle('identity:unpin', (_e, numero: string) => {
    store.forgetKnownHost(numero);
    return { ok: true };
  });

  // ── papel do computador ──
  //
  /**
   * Aplica a resposta das duas perguntas iniciais.
   *
   * Não há servidor para ligar nem para procurar: os dois lados se encontram
   * na malha pública, e isso independe do papel. A escolha é só de intenção —
   * serve para a interface saber o que destacar. Por isso aqui não há mais
   * nada a fazer além de guardar a resposta.
   */
  ipcMain.handle('role:apply', (_e, papel: Papel) => {
    store.saveSettings({ papel });
    return { ok: true, papel, serverUrl: store.getSettings().serverUrl, configurado: true };
  });

  ipcMain.handle('role:status', () => {
    const cfg = store.getSettings();
    return {
      papel: cfg.papel,
      ip: ipLocal(),
      /** Corretor próprio, opcional. Vazio é o caso normal. */
      serverUrl: cfg.serverUrl,
      servidorPadrao: SERVIDOR_PADRAO,
      /** A malha pública não precisa de configuração; nunca falta endereço. */
      configurado: true,
      corretores: listaDoAmbiente('RYKE_CORRETORES'),
      relays: listaDoAmbiente('RYKE_RELAYS'),
    };
  });

  // Volta para a tela das duas perguntas.
  ipcMain.handle('role:reset', () => {
    store.saveSettings({ papel: null });
    return { ok: true };
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:save', (_e, patch) => {
    const next = store.saveSettings(patch);
    transfers.setDownloadDir(next.downloadDir);
    return next;
  });

  ipcMain.handle('settings:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Pasta para os arquivos recebidos',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── senha ──
  ipcMain.handle('password:status', () => ({ defined: store.hasPassword(), travada: visitantesConectados > 0 }));

  /**
   * Trocar ou remover a senha desta máquina.
   *
   * COM ALGUÉM CONECTADO, NÃO.
   *
   * Quem está controlando este computador de longe enxerga a tela e comanda o
   * teclado e o mouse — ou seja, pode abrir este mesmo programa aqui dentro e
   * digitar a senha que quiser. Feito isso, passaria a entrar quando bem
   * entendesse, e o dono da máquina só descobriria quando a própria senha
   * parasse de funcionar. Uma sessão autorizada uma vez viraria acesso
   * permanente, concedido por quem não tem esse direito.
   *
   * A trava é aqui no processo principal, e não só na interface: a interface
   * está justamente sob o controle de quem se quer barrar.
   *
   * O dono continua podendo trocar a senha quando quiser — basta encerrar a
   * sessão antes, o que é uma decisão que só quem está na máquina consegue
   * tomar com segurança.
   */
  ipcMain.handle('password:set', (_e, password: string | null) => {
    if (visitantesConectados > 0) {
      throw new Error(
        'Há uma conexão remota ativa neste computador. Encerre a sessão antes de mexer na senha — ' +
          'quem está conectado veria e poderia trocar a senha por outra.',
      );
    }
    if (password === null || password === '') {
      store.clearPassword();
      return { defined: false };
    }
    if (password.length < 6) throw new Error('a senha precisa de pelo menos 6 caracteres');
    const salt = newSalt();
    store.savePassword(salt, deriveVerifier(password, salt));
    return { defined: true };
  });

  // Lado anfitrião: emite o desafio para quem bateu à porta.
  ipcMain.handle('auth:challenge', (_e, peerId: string) => {
    const locked = throttle.lockedFor(peerId);
    if (locked > 0) return { locked };

    const material = store.getPasswordMaterial();
    if (!material) return { noPassword: true };

    return { challenge: challenges.issue(peerId, material.salt) };
  });

  // Lado anfitrião: confere a prova. O verificador nunca sai daqui.
  ipcMain.handle('auth:verify', (_e, peerId: string, nonce: string, proof: string) => {
    const locked = throttle.lockedFor(peerId);
    if (locked > 0) return { ok: false, locked };

    const material = store.getPasswordMaterial();
    if (!material) return { ok: false, reason: 'sem-senha' };

    const result = challenges.redeem(peerId, nonce, proof, material.verifier);
    if (result === 'ok') {
      throttle.succeed(peerId);
      // A partir daqui os dois lados compartilham uma chave que o servidor
      // não tem; é com ela que o SDP é carimbado.
      chavesDeSessao.set(peerId, sessionKeyFor(material.verifier, Buffer.from(nonce, 'hex')));
      return { ok: true };
    }
    const wait = throttle.fail(peerId);
    return { ok: false, reason: result, locked: wait };
  });

  // Lado visitante: transforma a senha digitada na prova a enviar.
  ipcMain.handle('auth:prove', (_e, peerId: string, password: string, salt: string, nonce: string, params: ScryptParams) => {
    const safeParams: ScryptParams = {
      // Nunca aceitamos parâmetros arbitrários de outra máquina: um "N"
      // absurdo enviado por um anfitrião malicioso travaria este PC.
      N: Math.min(Math.max(params?.N ?? SCRYPT_PARAMS.N, 1024), 1 << 20),
      r: Math.min(Math.max(params?.r ?? SCRYPT_PARAMS.r, 1), 32),
      p: Math.min(Math.max(params?.p ?? SCRYPT_PARAMS.p, 1), 16),
      keylen: 32,
    };
    const verifier = deriveVerifier(password, Buffer.from(salt, 'hex'), safeParams);
    const nonceBuf = Buffer.from(nonce, 'hex');
    chavesDeSessao.set(peerId, sessionKeyFor(verifier, nonceBuf));
    return proofFor(verifier, nonceBuf);
  });

  /**
   * Carimba o SDP com a chave derivada da senha, se houver.
   *
   * Devolve null no modo supervisionado (sem senha, sem segredo partilhado) —
   * e nesse caso a sessão segue sem essa proteção, o que é aceitável porque
   * uma pessoa autorizou o acesso olhando para a tela.
   */
  ipcMain.handle('auth:sdpMac', (_e, peerId: string, sdp: string) => {
    const chave = chavesDeSessao.get(peerId);
    return chave ? macFor(chave, sdp) : null;
  });

  /**
   * Confere o carimbo do SDP recebido.
   * @returns 'ok' | 'invalido' | 'sem-chave' (sem-chave = modo supervisionado)
   */
  ipcMain.handle('auth:checkSdpMac', (_e, peerId: string, sdp: string, mac: string | null) => {
    const chave = chavesDeSessao.get(peerId);
    if (!chave) return 'sem-chave';
    // Há chave dos dois lados: a ausência de carimbo é justamente o que um
    // intermediário produziria ao reescrever o SDP.
    if (!mac) return 'invalido';
    return macConfere(chave, sdp, mac) ? 'ok' : 'invalido';
  });

  ipcMain.handle('auth:forget', (_e, peerId: string) => {
    chavesDeSessao.delete(peerId);
  });

  // ── monitores ──
  ipcMain.handle('screen:list', () => listDisplays());
  ipcMain.handle('screen:select', (_e, id: number) => {
    captureDisplayId = findDisplay(id).id;
  });
  ipcMain.handle('screen:active', () => {
    const display = findDisplay(captureDisplayId);
    const physical = screen.dipToScreenRect(null, display.bounds);
    return { id: display.id, width: physical.width, height: physical.height, scaleFactor: display.scaleFactor };
  });
  ipcMain.handle('screen:captureSource', () => captureSourceId());
  ipcMain.handle('screen:captureFrame', (_e, perfil?: Partial<PerfilCapturaSoftware>) => captureSoftwareFrame(perfil));
  ipcMain.handle('screen:captureStatus', () => ultimoPerfilCapturaSoftware);

  // ── iniciar instalador pelo processo já elevado ──
  // Abrir um setup pelo Explorer comum dispara o UAC na área de trabalho
  // segura, que uma conexão remota não deve tentar burlar. Aqui o usuário
  // escolhe o arquivo conscientemente e ele nasce como filho do Ryke elevado,
  // sem interromper a captura para pedir uma segunda elevação.
  ipcMain.handle('programas:instalar', async () => {
    if (!mainWindow || !isElevated()) {
      return { ok: false, message: 'O Ryke Desk não está executando como administrador.' };
    }
    const escolha = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecionar instalador para executar como administrador',
      buttonLabel: 'Instalar',
      properties: ['openFile'],
      filters: [
        { name: 'Instaladores', extensions: ['exe', 'msi'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
    });
    if (escolha.canceled || !escolha.filePaths[0]) return { ok: false, canceled: true, message: 'Cancelado.' };

    const arquivo = escolha.filePaths[0];
    const comando = extname(arquivo).toLowerCase() === '.msi' ? 'msiexec.exe' : arquivo;
    const argumentos = comando === 'msiexec.exe' ? ['/i', arquivo] : [];
    try {
      const filho = spawn(comando, argumentos, {
        cwd: dirname(arquivo),
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
      });
      await new Promise<void>((resolve, reject) => {
        filho.once('spawn', resolve);
        filho.once('error', reject);
      });
      filho.unref();
      return { ok: true, message: 'Instalador iniciado como administrador.' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── injeção de entrada (só o anfitrião chama) ──

  /**
   * O visitante mexeu o mouse.
   *
   * Com as setas independentes — o padrão —, isto move a seta VIRTUAL dele e
   * mais nada: o cursor do Windows daqui fica onde estava, na mão de quem está
   * sentado nesta cadeira. A exceção é o arrasto: enquanto o visitante segura
   * um botão, o cursor real vai junto, porque soltar o ponteiro no meio de um
   * arrasto não arrasta coisa nenhuma.
   */
  ipcMain.on('input:move', (_e, peerId: string, fx: number, fy: number) => {
    const point = toPhysicalPoint(captureDisplayId, fx, fy);
    if (!setasIndependentes()) {
      input.moveMouseTo(point.x, point.y);
      return;
    }
    registrarPonteiro(peerId, fx, fy);
    if (segurandoBotao(peerId)) moverCursorReal(point);
  });

/**
   * Avisa o visitante de que o clique dele não chegou — e por quê.
   *
   * Com limite de um aviso por segundo e meio: quem clica num botão que não
   * responde clica de novo, e de novo, e encher a tela dele de marcas seria
   * trocar um problema por outro.
   */
  const ultimoAvisoAdmin = new Map<string, number>();
  const avisarPrecisaAdmin = (peerId: string, fx: number, fy: number): void => {
    const agora = Date.now();
    if (agora - (ultimoAvisoAdmin.get(peerId) ?? 0) < 1500) return;
    ultimoAvisoAdmin.set(peerId, agora);
    registrarDiag('[entrada] clique recusado: a janela sob o ponto exige administrador');
    send('entrada:precisaAdmin', { peerId, x: fx, y: fy });
  };

  /**
   * Clique: o único momento em que o cursor real é emprestado.
   *
   * O Windows entrega o clique a quem estiver EMBAIXO do ponteiro — não existe
   * clicar num lugar sem estar nele. Então levamos o cursor até a seta virtual,
   * clicamos, e no soltar do último botão ele volta para onde estava.
   */
  ipcMain.on('input:button', (_e, peerId: string, button: BotaoMouse, down: boolean, fx: number, fy: number) => {
    // Move antes de clicar: um pacote de movimento perdido não pode fazer o
    // clique cair no lugar errado.
    const point = toPhysicalPoint(captureDisplayId, fx, fy);

    // A JANELA ALI ACEITA A NOSSA ENTRADA?
    //
    // Se ela for elevada e nós não, o Windows descarta o clique em silêncio — e
    // a sessão parece travada, porque a janela não responde e não sai da
    // frente. Era o que acontecia ao clicar em "Concluir" num instalador. Em
    // vez de injetar no vazio, avisamos e não mexemos no cursor: puxá-lo para
    // dentro de uma janela onde não podemos clicar só piora a confusão.
    if (down && !ajudanteConectado() && input.janelaExigeAdmin(point.x, point.y)) {
      avisarPrecisaAdmin(peerId, fx, fy);
      return;
    }
    if (!setasIndependentes()) {
      input.moveMouseTo(point.x, point.y);
      input.mouseButton(button, down);
      return;
    }

    registrarPonteiro(peerId, fx, fy);
    let segurados = botoesSegurados.get(peerId);
    if (!segurados) {
      segurados = new Set();
      botoesSegurados.set(peerId, segurados);
    }

    if (down) {
      segurados.add(button);
      pegarCursorEmprestado(peerId, point);
      input.mouseButton(button, true);
      return;
    }

    // Soltar primeiro, devolver depois: devolver antes faria o "soltar" cair
    // no ponto de origem, e um arrasto terminaria onde começou.
    input.mouseButton(button, false);
    segurados.delete(button);
    // A devolução é AGENDADA, e não imediata — é isto que faz o duplo clique
    // funcionar. Devolvendo na hora, o cursor voltava para o dono entre o
    // primeiro e o segundo clique e era trazido de novo: o Windows via um
    // movimento no meio do par e entregava dois cliques soltos, nunca um duplo
    // (e a seta ainda piscava de um lado para o outro). Como o segundo apertar
    // cancela a devolução pendente, o par inteiro acontece parado no mesmo
    // ponto, que é o que o Windows exige para reconhecer o duplo clique.
    if (segurados.size === 0) devolverCursor(peerId, false);
  });

  /**
   * O visitante entrou ou saiu do Modo Gamer.
   *
   * Entrar faz duas coisas: apaga a seta virtual dele (num jogo quem desenha a
   * mira é o jogo) e prende o ponteiro real no centro da tela, que é o que
   * permite girar sem fim. Sair devolve a seta.
   */
  ipcMain.on('input:gamer', (_e, peerId: string, on: boolean) => {
    if (on) {
      emModoGamer.add(peerId);
      recentralizarParaOJogo();
    } else {
      emModoGamer.delete(peerId);
    }
    desenharSetas();
  });

  // Modo Gamer: deslocamento relativo (mira 360°) e clique sem reposicionar.
  // Fica de fora do empréstimo de propósito: ali o ponteiro do visitante está
  // preso e o jogo lê deslocamento, não posição — não há seta para desenhar.
  ipcMain.on('input:moveRel', (_e, peerId: string, dx: number, dy: number) => {
    input.moveMouseRelative(dx, dy);
    // E, logo depois, de volta ao centro — invisível para o jogo. Sem isto o
    // ponteiro caminha até a borda e a câmera para de girar ali.
    if (emModoGamer.has(peerId)) recentralizarParaOJogo();
  });
  ipcMain.on('input:buttonRel', (_e, button: BotaoMouse, down: boolean) => input.mouseButton(button, down));

  /**
   * A roda também precisa do cursor: o Windows rola a janela que está embaixo
   * dele. A devolução é agendada, e não imediata, porque rolar é uma rajada de
   * tiques — devolver entre um e outro faria o cursor tremer de ida e volta.
   */
  ipcMain.on('input:wheel', (_e, peerId: string, dx: number, dy: number, fx: number, fy: number) => {
    if (!setasIndependentes()) {
      input.mouseWheel(dx, dy);
      return;
    }
    registrarPonteiro(peerId, fx, fy);
    pegarCursorEmprestado(peerId, toPhysicalPoint(captureDisplayId, fx, fy));
    input.mouseWheel(dx, dy);
    if (!segurandoBotao(peerId)) devolverCursor(peerId, false);
  });
  ipcMain.handle('passe:consumir', (_e, peerId: string) => consumirPasseDeRetorno(peerId));

  ipcMain.on('input:key', (_e, code: string, down: boolean) => input.key(code, down));
  ipcMain.on('input:combo', (_e, codes: string[]) => input.combo(codes));

  /**
   * Ctrl+Alt+Del. Fora do caminho das outras teclas de propósito — ver sas.ts.
   *
   * `handle`, e não `on`, porque este é o único atalho cujo resultado precisa
   * voltar: ele depende de uma política do Windows que pode estar desligada, e
   * o defeito que isto corrige era justamente o botão não fazer nem dizer nada.
   */
  ipcMain.handle('input:sas', () => {
    if (!store.getSettings().permitirSasRemoto) {
      return {
        ok: false,
        motivo:
          'O outro computador ainda não liberou o Ctrl+Alt+Del remoto. Lá, em Ajustes, ligue "Permitir Ctrl+Alt+Del remoto".',
      };
    }
    return enviarSas();
  });

  /** Estado da política, para os Ajustes mostrarem a verdade e não a intenção. */
  ipcMain.handle('sas:estado', () => estadoSas());

  /**
   * Liga/desliga a política do Windows junto com a preferência.
   *
   * As duas andam juntas porque separá-las produziria a pior das situações: a
   * caixinha marcada nos Ajustes e o Windows recusando na hora do aperto, sem
   * ninguém entender por quê.
   */
  ipcMain.handle('sas:permitir', (_e, ligar: boolean) => {
    const r = definirPoliticaSas(ligar);
    // Só grava a preferência se o Windows aceitou de fato.
    if (r.ok) store.saveSettings({ permitirSasRemoto: ligar });
    return r;
  });
  ipcMain.on('input:text', (_e, text: string) => input.typeText(text));
  ipcMain.on('input:release', () => input.releaseAll());

  ipcMain.handle('input:block', (_e, on: boolean) => input.blockLocalInput(on));

  // ── área de transferência ──
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text);
    clipboardWatcher.acknowledge(text);
  });
  ipcMain.handle('clipboard:files', () => readClipboardFiles());

  // ── arquivos ──
  ipcMain.handle('files:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Escolha o arquivo para enviar',
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return transfers.openForSend(result.filePaths[0]);
  });

  ipcMain.handle('files:open', (_e, path: string) => transfers.openForSend(path));

  /**
   * Escolher uma PASTA para enviar.
   *
   * Devolve a lista de arquivos já com o caminho relativo de cada um, e não a
   * pasta em si: o protocolo transporta arquivos, e é o caminho relativo que
   * permite ao outro lado remontar a árvore. Uma pasta com dez mil arquivos
   * devolve dez mil linhas — a varredura acontece aqui, no processo que tem
   * disco, e não na interface.
   */
  ipcMain.handle('files:pickFolder', async () => {
    const escolha = await dialog.showOpenDialog(mainWindow!, {
      title: 'Escolha a pasta para enviar',
      buttonLabel: 'Enviar pasta',
      properties: ['openDirectory'],
    });
    if (escolha.canceled || !escolha.filePaths[0]) return null;
    return transfers.listarPasta(escolha.filePaths[0]);
  });

  /** A mesma varredura, para uma pasta que veio arrastada para a janela. */
  ipcMain.handle('files:listFolder', (_e, path: string) => transfers.listarPasta(path));

  /** É pasta ou arquivo? O que foi arrastado precisa ser tratado diferente. */
  ipcMain.handle('files:isFolder', async (_e, path: string) => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  });
  ipcMain.handle('files:read', async (_e, id: string, offset: number, length: number) => {
    const chunk = await transfers.readSlice(id, offset, length);
    // Buffer atravessa o IPC como Uint8Array; o renderer o entrega ao DataChannel.
    return new Uint8Array(chunk);
  });
  ipcMain.handle('files:closeSend', (_e, id: string) => transfers.closeSend(id));

  ipcMain.handle('files:begin', (_e, id: string, name: string, size: number, relPath?: string) =>
    transfers.begin(id, name, size, relPath),
  );

  /**
   * Põe o arquivo recém-recebido na área de transferência desta máquina.
   *
   * É o que faltava para "copiar aqui e colar lá" funcionar de verdade: o
   * arquivo já atravessava e ia parar na pasta de downloads, mas o Ctrl+V do
   * outro lado não fazia nada, porque a área de transferência de lá continuava
   * vazia.
   */
  ipcMain.handle('clipboard:copiarArquivos', (_e, caminhos: string[]) => {
    const ok = copiarArquivos(caminhos);
    // Sem isto, o vigia veria o arquivo que nós mesmos acabamos de colocar e
    // ofereceria mandá-lo de volta para quem o enviou.
    if (ok) clipboardWatcher.acknowledgeFiles(caminhos);
    return ok;
  });
  ipcMain.handle('files:write', (_e, id: string, chunk: Uint8Array) => transfers.write(id, Buffer.from(chunk)));
  ipcMain.handle('files:finish', (_e, id: string) => transfers.finish(id));
  ipcMain.handle('files:abort', (_e, id: string, reason: string) => transfers.abort(id, reason));
  ipcMain.handle('files:reveal', (_e, path: string) => shell.showItemInFolder(path));
  ipcMain.handle('files:newId', () => randomUUID());

  // ── janela ──
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());
  ipcMain.on('window:fullscreen', (_e, on: boolean) => mainWindow?.setFullScreen(on));

  /**
   * Traz a janela para a frente quando chega um pedido de acesso.
   *
   * Sem isto o aviso pode nascer minimizado ou atrás de outras janelas, o
   * prazo se esgota e o pedido é recusado sem ninguém ter visto nada. O
   * "sempre visível" dura poucos segundos de propósito: é para chamar a
   * atenção, não para atrapalhar quem está trabalhando.
   */
  ipcMain.on('window:attention', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.flashFrame(true);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(false);
        mainWindow.flashFrame(false);
      }
    }, 4000);
  });
  ipcMain.handle('window:state', () => windowState());

  /**
   * Modo visitante: a janela cresce para caber a tela remota e passamos a
   * capturar todos os atalhos antes do Chromium — sem isso, Ctrl+W fecharia
   * a janela local em vez de fechar a aba do outro computador.
   */
  /**
   * O visitante pede a captura total do teclado.
   *
   * Sem ela, Ctrl+Shift+Esc abre o Gerenciador de Tarefas DESTE computador, e
   * a tecla Windows abre o menu Iniciar daqui — porque o sistema consome essas
   * combinações antes de qualquer aplicativo enxergar.
   */
  ipcMain.handle('teclado:capturar', (_e, on: boolean) => {
    querCapturarTeclado = on;
    // Sem foco não instala: a captura acompanha a janela, não a vontade.
    if (on && mainWindow?.isFocused() === false) return true;
    return ligarCapturaDeTeclado(on);
  });

  // Modo Gamer: enquanto ligado, o Esc puro deixa de minimizar e vai ao jogo.
  ipcMain.on('teclado:escMinimiza', (_e, on: boolean) => tecladoGlobal.definirEscMinimiza(on));

  /**
   * "Janela": tira a sessão da tela cheia e a devolve a um retângulo.
   *
   * O visualizador nasce maximizado, e essa era a única forma que ele tinha —
   * quem quisesse olhar a tela remota ao lado de um documento daqui não tinha
   * para onde ir. Este botão o encolhe para METADE do monitor, centralizado.
   *
   * Metade, e não um tamanho decorado: é grande o bastante para a tela remota
   * continuar legível e pequeno o bastante para sobrar espaço de cada lado.
   * Daí em diante quem manda no tamanho é o usuário — a janela é
   * redimensionável, e basta arrastar qualquer borda ou canto.
   */
  ipcMain.on('window:janela', () => {
    if (!mainWindow) return;

    // ALTERNA. Só encolher fazia do botão um caminho de mão única: uma vez em
    // janela, apertá-lo de novo repetia o mesmo encolhimento e a sessão nunca
    // voltava a ocupar a tela. Quem já está solto quer o contrário.
    if (!mainWindow.isFullScreen() && !mainWindow.isMaximized()) {
      mainWindow.maximize();
      send('window:state', windowState());
      return;
    }

    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    if (mainWindow.isMaximized()) mainWindow.unmaximize();

    // A área de TRABALHO, não a do monitor: encaixar sobre a barra de tarefas
    // esconderia justamente a borda de baixo, que é uma das alças de arrasto.
    const area = screen.getDisplayNearestPoint(mainWindow.getBounds()).workArea;
    const largura = Math.max(mainWindow.getMinimumSize()[0], Math.round(area.width / 2));
    const altura = Math.max(mainWindow.getMinimumSize()[1], Math.round(area.height / 2));
    mainWindow.setBounds({
      x: Math.round(area.x + (area.width - largura) / 2),
      y: Math.round(area.y + (area.height - altura) / 2),
      width: largura,
      height: altura,
    });
    // Uma janela que voltou de tela cheia sem poder ser redimensionada seria
    // uma armadilha: o usuário veria as bordas e elas não responderiam.
    mainWindow.setResizable(true);
    send('window:state', windowState());
  });

  ipcMain.on('window:viewer', (_e, on: boolean) => {
    if (!mainWindow) return;
    mainWindow.setMenuBarVisibility(false);
    if (on) {
      mainWindow.maximize();
      mainWindow.webContents.setIgnoreMenuShortcuts(true);
    } else {
      mainWindow.setFullScreen(false);
      mainWindow.unmaximize();
      mainWindow.webContents.setIgnoreMenuShortcuts(false);
    }
  });

  /**
   * Quantos visitantes estão conectados a esta máquina.
   *
   * Informado pela interface a cada abertura e fechamento de sessão. Serve
   * para trancar a senha enquanto alguém estiver no comando daqui.
   */
  ipcMain.on('sessao:visitantes', (_e, quantos: number) => {
    visitantesConectados = Math.max(0, Math.floor(quantos));
    send('senha:travada', visitantesConectados > 0);
    if (visitantesConectados > 0) {
      comecarARelatarCursor();
      comecarAVigiarAreaProtegida();
    } else {
      pararDeRelatarCursor();
      pararDeVigiarAreaProtegida();
      // Sem ninguém conectado não há seta para desenhar, e uma janela sempre
      // no topo cobrindo a tela inteira não é coisa que se deixe aberta "por
      // via das dúvidas".
      ponteiros.clear();
      botoesSegurados.clear();
      emModoGamer.clear();
      emprestimo = null;
      fecharCamadaDeSetas();
    }
  });

  // ── as setas dos visitantes ──

  /**
   * Um visitante entrou: reserve a seta dele, com a cor e o nome que a
   * interface já escolheu, e abra a camada se ela ainda não estiver de pé.
   */
  ipcMain.on('ponteiros:entrar', (_e, peerId: string, nome: string, cor: number) => {
    const anterior = ponteiros.get(peerId);
    ponteiros.set(peerId, { nome, cor, x: anterior?.x ?? 0.5, y: anterior?.y ?? 0.5 });
    if (setasIndependentes()) abrirCamadaDeSetas();
    desenharSetas();
  });

  ipcMain.on('ponteiros:sair', (_e, peerId: string) => {
    ponteiros.delete(peerId);
    botoesSegurados.delete(peerId);
    emModoGamer.delete(peerId);
    // Quem sai segurando um botão deixaria o cursor emprestado para sempre.
    if (emprestimo?.dono === peerId) devolverCursor(peerId, true);
    if (ponteiros.size === 0) fecharCamadaDeSetas();
    else desenharSetas();
  });

  // ── sessão ativa: impede a tela de apagar no meio de um atendimento ──
  ipcMain.on('session:active', (_e, active: boolean) => {
    if (active && sleepBlocker === null) {
      sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
    } else if (!active && sleepBlocker !== null) {
      powerSaveBlocker.stop(sleepBlocker);
      sleepBlocker = null;
    }
    if (!active) {
      input.releaseAll();
      if (input.isLocalInputBlocked()) input.blockLocalInput(false);
      transfers.closeAll();
    }
  });
}

// ─────────────────────────── ciclo de vida ────────────────────────

app.on('second-instance', () => {
  // Abrir de novo (atalho, menu Iniciar) traz a janela de volta do ícone.
  mostrarJanela();
});

app.whenReady().then(async () => {
  // O ajudante só ouve o cano: nada de janela, bandeja, malha ou captura.
  if (EH_AJUDANTE) return;

  store = new Store();
  transfers = new Transfers(store.getSettings().downloadDir);

  const abi = input.verifyAbi();
  if (!abi.ok) {
    console.error(`[input] layout de INPUT inesperado (${abi.inputSize} bytes) — injeção desativada`);
  }

  installCsp();
  installCaptureHandler();
  installDisplayChangeHandler();
  registerIpc();
  clipboardWatcher.start();

  createWindow();
  criarTray();
  registrarStatusGpu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * Nome legível da placa a partir da linha crua do ANGLE.
 *
 * O `glRenderer` vem como "ANGLE (NVIDIA, NVIDIA GeForce GTX 960 Direct3D11
 * vs_5_0 ps_5_0, D3D11)". Ninguém quer ler isso na barra: extraímos só o miolo
 * — "NVIDIA GeForce GTX 960".
 */
function nomeAmigavelGpu(glRenderer: string | undefined): string {
  if (!glRenderer) return 'GPU desconhecida';
  const m = /ANGLE \([^,]+,\s*(.+?)\s+(?:Direct3D|OpenGL|Vulkan|D3D)/i.exec(glRenderer);
  const bruto = m ? m[1] : glRenderer;
  return bruto
    .replace(/\bDirect3D\d+\b/gi, '')
    .replace(/\bvs_\d+_\d+\b|\bps_\d+_\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || 'GPU desconhecida';
}

/**
 * Registro em ARQUIVO do diagnóstico da sessão.
 *
 * O console de um app empacotado (aberto sem terminal) se perde. Mas a causa da
 * lentidão precisa aterrissar em algum lugar legível DEPOIS do fato — este
 * arquivo é esse lugar. Grava a rota de captura (hardware x a rota lenta) com o
 * motivo real, o estado da GPU e um resumo da rede. É o que transforma "está
 * lento" em "getDisplayMedia falhou por tal motivo", sem depender de reproduzir
 * na minha máquina. Fica em: %APPDATA%/ryke-desk/ryke-diagnostico.log
 */
function caminhoDiag(): string {
  return join(app.getPath('userData'), 'ryke-diagnostico.log');
}
function registrarDiag(linha: string): void {
  try {
    const arquivo = caminhoDiag();
    // Um teto simples para o arquivo não crescer sem fim numa máquina que fica
    // sempre ligada: ao passar de 512 KB, vira .old e recomeça.
    try {
      if (statSync(arquivo).size > 512 * 1024) renameSync(arquivo, arquivo + '.old');
    } catch {
      /* ainda não existe */
    }
    appendFileSync(arquivo, `${new Date().toISOString()} ${linha}\n`, 'utf8');
  } catch {
    /* diagnóstico nunca pode derrubar o app */
  }
}

export type StatusGpu = { nome: string; encode: boolean; decode: boolean; brutoEncode: string; brutoDecode: string };

// A placa não troca no meio da sessão; guardamos o primeiro bom resultado para
// não repetir o getGPUInfo, que não é barato. Só cacheamos quando o nome já
// veio de verdade — nos primeiros segundos o processo de GPU ainda sobe e tudo
// aparece desligado/desconhecido, e cachear isso seria mentir para a barra.
let gpuCache: StatusGpu | null = null;
async function statusGpu(): Promise<StatusGpu> {
  if (gpuCache) return gpuCache;
  try {
    const status = app.getGPUFeatureStatus();
    const brutoEncode = String(status.video_encode ?? '');
    const brutoDecode = String(status.video_decode ?? '');
    // Qualquer 'enabled…' (enabled, enabled_readback, enabled_force) é por
    // hardware; 'disabled_software'/'unavailable_software'/'disabled…' significam
    // que o processador está fazendo o serviço. Usamos o prefixo para não gritar
    // "software" à toa numa variação de estado que ainda é a placa.
    const encode = brutoEncode.startsWith('enabled');
    const decode = brutoDecode.startsWith('enabled');
    let nome = 'GPU desconhecida';
    try {
      const info = (await app.getGPUInfo('complete')) as { auxAttributes?: { glRenderer?: string } };
      nome = nomeAmigavelGpu(info.auxAttributes?.glRenderer);
    } catch {
      /* getGPUInfo pode não existir em algum ambiente */
    }
    const resultado: StatusGpu = { nome, encode, decode, brutoEncode, brutoDecode };
    // Só cacheamos um resultado DEFINITIVAMENTE bom (nome real + encode por
    // hardware). Nos primeiros segundos o subsistema de encode da GPU ainda
    // sobe e pode reportar 'disabled' por um instante; cachear isso deixaria o
    // selo preso em "SW" para o resto da sessão, mesmo já estando por hardware.
    // Enquanto não for bom, relemos a cada chamada (barato e raro).
    if (nome !== 'GPU desconhecida' && encode) gpuCache = resultado;
    return resultado;
  } catch {
    return { nome: 'GPU desconhecida', encode: false, decode: false, brutoEncode: '', brutoDecode: '' };
  }
}

/**
 * Anota no log qual placa entrou e se o vídeo está mesmo por hardware.
 *
 * É a confirmação, sem adivinhação, do "reconhecimento automático": diz a placa
 * ativa (a dedicada, ou a integrada quando não há dedicada) e se o codificador
 * de hardware está ligado. Se um dia aparecer `video_encode = disabled`, o
 * culpado é driver de vídeo ou a placa na lista de bloqueio do Chromium — e
 * este log é o primeiro lugar onde isso fica visível.
 */
function registrarStatusGpu(): void {
  // Um respiro para o processo de GPU subir; antes dele, tudo aparece desligado.
  setTimeout(() => {
    void statusGpu().then((g) => {
      const linha = `[gpu] placa=${g.nome} | encode=${g.brutoEncode} decode=${g.brutoDecode} | elevado=${isElevated()}`;
      console.log(linha);
      registrarDiag(linha);
    });
  }, 3000);
}

// A janela agora só se esconde no ícone perto do relógio, então este evento
// praticamente não dispara em uso normal. Fica como rede de segurança: se a
// última janela realmente sumir e já estamos encerrando, o programa fecha.
app.on('window-all-closed', () => {
  if (encerrando) app.quit();
});

app.on('before-quit', () => {
  encerrando = true;
  // Quem está conectado agora não precisará ser autorizado de novo se o
  // programa voltar em seguida — numa atualização, por exemplo. Vale dois
  // minutos e é gasto na primeira usada. Ver o passe de retorno.
  salvarPasseDeRetorno([...ponteiros.keys()]);
  tray?.destroy();
  tray = null;
  // Deixar um Ctrl preso ou o teclado bloqueado seria um desastre para o dono
  // do computador anfitrião.
  clipboardWatcher.stop();
  input.releaseAll();
  querCapturarTeclado = false;
  ligarCapturaDeTeclado(false);
  pararDeRelatarCursor();
  fecharCamadaDeSetas();
  if (input.isLocalInputBlocked()) input.blockLocalInput(false);
  transfers?.closeAll();
  if (sleepBlocker !== null) powerSaveBlocker.stop(sleepBlocker);
});
