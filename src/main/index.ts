/**
 * Processo principal do Ryke Desk.
 *
 * Responsabilidades: janela, captura de tela, injeção de teclado/mouse,
 * área de transferência, disco e o segredo da senha. Toda a parte de rede
 * (WebRTC e sinalização) vive no renderer, porque é lá que existe a pilha
 * WebRTC do Chromium — que é justamente o que nos dá NAT traversal,
 * criptografia e codificação de vídeo por hardware de graça.
 */
import { app, BrowserWindow, ipcMain, shell, clipboard, dialog, desktopCapturer, session, powerSaveBlocker, screen } from 'electron';
import { dirname, extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import * as input from './input';
import * as tecladoGlobal from './teclado-global';
import { listDisplays, findDisplay, toPhysicalPoint, toFraction } from './screen';
import { ipLocal } from './network';
import { copiarArquivos, lerArquivosCopiados } from './clipboard-arquivos';
import type { Papel } from '../shared/config';
import { SERVIDOR_PADRAO } from '../shared/servidor-padrao';
import type { PerfilCapturaSoftware } from '../shared/qualidade-captura';

// Duas cópias abertas disputariam o mesmo número Ryke na malha.
if (!app.requestSingleInstanceLock()) {
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
    const ponto = input.cursorPosition();
    if (!ponto) return;
    const fracao = toFraction(captureDisplayId, ponto.x, ponto.y);
    // Fora da tela capturada (outro monitor): não há onde desenhar.
    if (!fracao) return;
    const marca = `${fracao.x.toFixed(4)},${fracao.y.toFixed(4)}`;
    if (marca === ultimoCursor) return;
    ultimoCursor = marca;
    mainWindow?.webContents.send('cursor:posicao', fracao);
  }, INTERVALO_CURSOR_MS);
}

function pararDeRelatarCursor(): void {
  if (relogioCursor === null) return;
  clearInterval(relogioCursor);
  relogioCursor = null;
}

// ─────────────────────────── janela ───────────────────────────────

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
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
    // Rodando elevados, o Explorador (que é comum) não conseguiria nos enviar
    // arquivos arrastados. Esta exceção pontual devolve o recurso.
    if (mainWindow && isElevated()) permitirArrastarArquivos(mainWindow);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
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
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => {
    done(permission === 'media' || permission === 'display-capture');
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
    elevated: isElevated(),
    abi: input.verifyAbi(),
  }));

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
  ipcMain.on('input:move', (_e, fx: number, fy: number) => {
    const point = toPhysicalPoint(captureDisplayId, fx, fy);
    input.moveMouseTo(point.x, point.y);
  });

  ipcMain.on('input:button', (_e, button: 0 | 1 | 2, down: boolean, fx: number, fy: number) => {
    // Move antes de clicar: um pacote de movimento perdido não pode fazer o
    // clique cair no lugar errado.
    const point = toPhysicalPoint(captureDisplayId, fx, fy);
    input.moveMouseTo(point.x, point.y);
    input.mouseButton(button, down);
  });

  ipcMain.on('input:wheel', (_e, dx: number, dy: number) => input.mouseWheel(dx, dy));
  ipcMain.on('input:key', (_e, code: string, down: boolean) => input.key(code, down));
  ipcMain.on('input:combo', (_e, codes: string[]) => input.combo(codes));
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
  ipcMain.handle('files:read', async (_e, id: string, offset: number, length: number) => {
    const chunk = await transfers.readSlice(id, offset, length);
    // Buffer atravessa o IPC como Uint8Array; o renderer o entrega ao DataChannel.
    return new Uint8Array(chunk);
  });
  ipcMain.handle('files:closeSend', (_e, id: string) => transfers.closeSend(id));

  ipcMain.handle('files:begin', (_e, id: string, name: string, size: number) => transfers.begin(id, name, size));

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
    if (visitantesConectados > 0) comecarARelatarCursor();
    else pararDeRelatarCursor();
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
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  // Deixar um Ctrl preso ou o teclado bloqueado seria um desastre para o dono
  // do computador anfitrião.
  clipboardWatcher.stop();
  input.releaseAll();
  querCapturarTeclado = false;
  ligarCapturaDeTeclado(false);
  pararDeRelatarCursor();
  if (input.isLocalInputBlocked()) input.blockLocalInput(false);
  transfers?.closeAll();
  if (sleepBlocker !== null) powerSaveBlocker.stop(sleepBlocker);
});
