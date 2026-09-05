/**
 * Injeção de teclado e mouse no Windows via SendInput (user32.dll).
 *
 * Usamos koffi (FFI com binários pré-compilados) em vez de um addon nativo:
 * não exige Visual Studio nem node-gyp na máquina de quem for compilar, e
 * SendInput é uma API estável desde o Windows 2000.
 *
 * Limites do que é possível sem um serviço com privilégio SYSTEM/UIAccess —
 * a interface avisa o usuário sobre eles:
 *   • Ctrl+Alt+Del não pode ser injetado (é a Secure Attention Sequence, o
 *     Windows reserva essa combinação ao hardware por design de segurança).
 *   • Janelas de UAC ficam no "desktop seguro": a tela congela e o teclado
 *     não chega até lá, a menos que o Ryke Desk rode como administrador.
 */
import koffi from 'koffi';
import { mudarBotao, type BotaoMouse } from '../shared/botoes';
import { lookupScan, VIRTUAL_KEYS, MODIFIER_CODES } from '../shared/keymap';
// Sem ciclo: o elevation.ts não importa este módulo.
import { isElevated } from './elevation';
import type { TipoCursor } from '../shared/protocol';

// ── tipos Win32 ───────────────────────────────────────────────────
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32',
  dy: 'int32',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
});

const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
});

const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
  uMsg: 'uint32',
  wParamL: 'uint16',
  wParamH: 'uint16',
});

const INPUT_UNION = koffi.union('INPUT_UNION', {
  mi: MOUSEINPUT,
  ki: KEYBDINPUT,
  hi: HARDWAREINPUT,
});

const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });

const user32 = koffi.load('user32.dll');
const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');

// Onde o cursor está agora. Usado para contar ao visitante a posição real do
// ponteiro desta máquina — inclusive quando quem o moveu foi a pessoa daqui.
// A struct precisa ser registrada no koffi para o nome "POINT" existir na
// assinatura abaixo; a constante em si não é usada em lugar nenhum.
koffi.struct('POINT', { x: 'long', y: 'long' });
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *p)');
// Quanto o Windows considera "dois cliques seguidos". Configurável pela pessoa
// no painel do mouse, por isso perguntamos em vez de fixar 500 ms.
const GetDoubleClickTime = user32.func('uint32 __stdcall GetDoubleClickTime()');

// ── forma do cursor (GetCursorInfo) ───────────────────────────────
//
// É o que permite ao ponteiro do acesso remoto virar viga de texto, seta de
// redimensionar ou mãozinha, em vez de ser sempre uma seta. Lemos a forma REAL
// do cursor do Windows — a que o próprio sistema está mostrando — e, para o que
// está só sob a seta virtual (sem o cursor real ali), consultamos a janela
// embaixo do ponto. Ver `cursorShape`/`cursorShapeAtPoint`.
const CURSORINFO = koffi.struct('CURSORINFO', {
  cbSize: 'uint32',
  flags: 'uint32',
  hCursor: 'uintptr',
  ptScreenPos: 'POINT',
});
const CURSORINFO_SIZE = koffi.sizeof(CURSORINFO);
// _Inout_: precisamos ENVIAR cbSize preenchido e LER de volta hCursor/flags.
const GetCursorInfo = user32.func('int __stdcall GetCursorInfo(_Inout_ CURSORINFO *pci)');
const LoadCursorW = user32.func('uintptr __stdcall LoadCursorW(uintptr hInstance, uintptr lpCursorName)');
const WindowFromPoint = user32.func('uintptr __stdcall WindowFromPoint(POINT Point)');

// ── a janela sob o ponto exige administrador? ─────────────────────
//
// O DEFEITO QUE ISTO EXPLICA. Instalar um programa no computador remoto sem
// estar em modo administrador dava a impressão de que a sessão tinha travado:
// a janela do instalador é ELEVADA, o Windows descarta em silêncio a entrada
// que vem de um processo comum (é a UIPI), e o clique em "Concluir"
// simplesmente não acontece. Como o instalador cobre a tela e não fecha nunca,
// tudo parece congelado — quando na verdade só os cliques daquela janela estão
// sendo ignorados.
//
// Não dá para injetar ali sem privilégio, e não deveria mesmo dar. Mas dá para
// SABER e avisar, em vez de deixar a pessoa clicando no vazio.
//
// COMO SE DESCOBRE: o processo dono da janela é aberto e pedimos o token dele.
// Um processo de integridade mais baixa recebe "acesso negado" ao ler o token
// de um mais alto — e é essa recusa, e não uma comparação de números, que
// responde exatamente à pergunta que importa: "consigo mexer com esta janela?"
const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');
const GetWindowThreadProcessId = user32.func(
  'uint32 __stdcall GetWindowThreadProcessId(uintptr hWnd, _Out_ uint32 *lpdwProcessId)',
);
const OpenProcess = kernel32.func('uintptr __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)');
const CloseHandle = kernel32.func('int __stdcall CloseHandle(uintptr hObject)');
const OpenProcessTokenFn = advapi32.func(
  'int __stdcall OpenProcessToken(uintptr ProcessHandle, uint32 DesiredAccess, _Out_ uintptr *TokenHandle)',
);
const GetTokenInformationFn = advapi32.func(
  'int __stdcall GetTokenInformation(uintptr TokenHandle, int TokenInformationClass,' +
    ' _Out_ void *TokenInformation, uint32 TokenInformationLength, _Out_ uint32 *ReturnLength)',
);
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY_ACESSO = 0x0008;
/** TokenElevation — responde "este processo está elevado?" com um número. */
const TOKEN_ELEVATION = 20;

// ── a área protegida do Windows (UAC e tela bloqueada) ────────────
//
// Quando o UAC pergunta "deseja permitir?", o Windows TROCA de área de
// trabalho: a normal fica congelada atrás de uma área protegida, onde nenhum
// programa comum entra. Para o acesso remoto isso é um apagão total — a captura
// para de entregar quadros, o SendInput não chega a lugar nenhum, e do outro
// lado a sessão simplesmente congela sem explicação nenhuma.
//
// `OpenInputDesktop` é como se pergunta: ele falha justamente quando a área de
// entrada não é a nossa. É a diferença entre "a tela está parada porque ninguém
// mexeu" e "a tela está parada porque o Windows saiu de baixo de nós".
const OpenInputDesktop = user32.func(
  'uintptr __stdcall OpenInputDesktop(uint32 dwFlags, int fInherit, uint32 dwDesiredAccess)',
);
const CloseDesktop = user32.func('int __stdcall CloseDesktop(uintptr hDesktop)');
const DESKTOP_SWITCHDESKTOP = 0x0100;
const GetClassLongPtrW = user32.func('uintptr __stdcall GetClassLongPtrW(uintptr hWnd, int nIndex)');
const GCLP_HCURSOR = -12;
const CURSOR_SHOWING = 0x00000001;

/**
 * Os cursores de sistema, pelo identificador que o Windows usa (IDC_*), mapeados
 * para os nomes de forma que os dois lados entendem (iguais aos do CSS).
 *
 * O truque do `LoadCursorW(0, id)`: para os cursores padrão, o Windows devolve
 * sempre o MESMO handle compartilhado, então comparar o handle atual do cursor
 * com estes diz qual forma ele tem. Cursores próprios de um programa não batem
 * com nenhum e viram 'default' — o certo, porque não sabemos desenhá-los.
 */
const IDC_PARA_TIPO: Record<number, TipoCursor> = {
  32512: 'default', // IDC_ARROW
  32513: 'text', // IDC_IBEAM
  32514: 'wait', // IDC_WAIT
  32515: 'crosshair', // IDC_CROSS
  32516: 'default', // IDC_UPARROW
  32642: 'nwse-resize', // IDC_SIZENWSE
  32643: 'nesw-resize', // IDC_SIZENESW
  32644: 'ew-resize', // IDC_SIZEWE
  32645: 'ns-resize', // IDC_SIZENS
  32646: 'move', // IDC_SIZEALL
  32648: 'not-allowed', // IDC_NO
  32649: 'pointer', // IDC_HAND
  32650: 'progress', // IDC_APPSTARTING
  32651: 'help', // IDC_HELP
};

/** handle do cursor padrão -> tipo, montado uma vez. `null` se o FFI falhar. */
let tabelaCursores: Map<string, TipoCursor> | null = null;
function carregarTabelaCursores(): Map<string, TipoCursor> | null {
  if (tabelaCursores) return tabelaCursores;
  try {
    const tabela = new Map<string, TipoCursor>();
    for (const [idTexto, tipo] of Object.entries(IDC_PARA_TIPO)) {
      const h = LoadCursorW(0, Number(idTexto));
      if (h) tabela.set(String(h), tipo);
    }
    tabelaCursores = tabela;
    return tabela;
  } catch {
    return null;
  }
}

/**
 * A forma do cursor REAL do Windows agora — a que o sistema está desenhando.
 *
 * É a forma exata onde o cursor de fato está: durante um arrasto (o visitante
 * segurando o botão leva o cursor real junto) ou um clique, é este que dá o
 * redimensionar/texto certo, inclusive dentro de programas que decidem o cursor
 * na hora, como navegadores e editores.
 */
export function cursorShape(): TipoCursor {
  const tabela = carregarTabelaCursores();
  if (!tabela) return 'default';
  try {
    const info: { cbSize: number; flags: number; hCursor: number | bigint; ptScreenPos: { x: number; y: number } } = {
      cbSize: CURSORINFO_SIZE,
      flags: 0,
      hCursor: 0,
      ptScreenPos: { x: 0, y: 0 },
    };
    if (!GetCursorInfo(info)) return 'default';
    // Cursor escondido (vídeo em tela cheia, jogo): não há forma a anunciar.
    if (!(info.flags & CURSOR_SHOWING)) return 'default';
    return tabela.get(String(info.hCursor)) ?? 'default';
  } catch {
    return 'default';
  }
}

/**
 * A forma que o cursor teria num PONTO, sem mover o cursor real até lá.
 *
 * Serve para a seta virtual que só paira sobre a tela: pergunta à janela que
 * está embaixo do ponto qual é o cursor da CLASSE dela. Acerta os controles
 * nativos do Windows — campos de texto (viga), links, Explorer — sem incomodar
 * ninguém nem mover nada. Programas que desenham a interface por conta própria
 * (navegadores, apps em Electron) têm uma janela só e não revelam a forma
 * interna por aqui; para eles, a forma certa aparece no arrasto/clique, quando
 * o cursor real vai ao ponto e `cursorShape` assume.
 *
 * @param x,y pixels físicos da área de trabalho virtual.
 */
export function cursorShapeAtPoint(x: number, y: number): TipoCursor {
  const tabela = carregarTabelaCursores();
  if (!tabela) return 'default';
  try {
    const hwnd = WindowFromPoint({ x: Math.round(x), y: Math.round(y) });
    if (!hwnd) return 'default';
    const hcur = GetClassLongPtrW(hwnd, GCLP_HCURSOR);
    if (!hcur) return 'default';
    return tabela.get(String(hcur)) ?? 'default';
  } catch {
    return 'default';
  }
}

/**
 * A janela sob este ponto está acima do nosso alcance?
 *
 * `true` significa: por mais que injetemos, o Windows vai descartar. É o que
 * distingue "o clique não fez nada porque o programa ignorou" de "o clique nem
 * chegou lá" — e é a diferença entre a pessoa achar que a sessão travou e ela
 * saber que precisa do modo administrador.
 *
 * Na dúvida devolve `false`: um falso alarme faria o programa recusar cliques
 * legítimos, que é bem pior do que deixar um clique se perder.
 *
 * @param x,y pixels físicos da área de trabalho virtual.
 */
export function janelaExigeAdmin(x: number, y: number): boolean {
  // Nós já somos elevados? Então alcançamos qualquer janela, e não há o que
  // recusar. (O ajudante elevado cobre este caso pelo outro lado.)
  if (isElevated()) return false;

  let processo: number | bigint = 0;
  let token: (number | bigint)[] = [0];
  try {
    const hwnd = WindowFromPoint({ x: Math.round(x), y: Math.round(y) });
    if (!hwnd) return false;

    const pid: number[] = [0];
    GetWindowThreadProcessId(hwnd, pid);
    if (!pid[0]) return false;

    processo = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0]);
    // Nem abrir o processo conseguimos: com certeza está fora do alcance.
    if (!processo) return true;

    token = [0];
    if (!OpenProcessTokenFn(processo, TOKEN_QUERY_ACESSO, token)) return true;

    // PERGUNTAMOS se o dono da janela está elevado, em vez de deduzir pela
    // recusa de alguma chamada.
    //
    // A primeira versão disto deduzia: supunha que um processo comum não
    // conseguiria LER o token de um elevado, e tratava a recusa como resposta.
    // A suposição era falsa — com PROCESS_QUERY_LIMITED_INFORMATION o Windows
    // deixa ler o token de um processo elevado sem reclamar. O teste contra uma
    // janela do Editor do Registro mostrou isso: "token lido", e a detecção
    // devolvia "pode clicar" justamente onde o clique não passa.
    const buf = Buffer.alloc(4);
    const usado: number[] = [0];
    if (!GetTokenInformationFn(token[0], TOKEN_ELEVATION, buf, 4, usado)) return false;
    return buf.readUInt32LE(0) !== 0;
  } catch {
    return false;
  } finally {
    try {
      if (token[0]) CloseHandle(token[0]);
      if (processo) CloseHandle(processo);
    } catch {
      /* fechar alça já fechada não é problema de ninguém */
    }
  }
}

/**
 * Move o cursor SEM que o jogo perceba.
 *
 * A diferença entre isto e `SendInput` é o que faz o Modo Gamer funcionar, e
 * ela não é óbvia:
 *
 *   • `SendInput` com MOUSEEVENTF_MOVE entra na fila de entrada como se fosse
 *     um mouse de verdade. Chega ao Raw Input, e portanto ao jogo, que vira a
 *     câmera. É assim que o movimento do visitante vira giro.
 *
 *   • `SetCursorPos` apenas REPOSICIONA o ponteiro. Não gera evento de
 *     dispositivo, não aparece no Raw Input, e o jogo não enxerga deslocamento
 *     nenhum — para ele, nada aconteceu.
 *
 * É essa cegueira que nos deixa recentralizar o ponteiro a cada quadro. Sem
 * recentralizar, o cursor caminha até a borda da tela e para ali; a partir daí
 * o Windows não tem mais para onde movê-lo, o deslocamento vira zero e a
 * câmera trava — que é exatamente o "precisa arrastar várias vezes para virar".
 * Recentralizando com SendInput em vez disto, o salto de volta ao centro seria
 * lido como movimento real e a mira giraria sozinha.
 */
const SetCursorPos = user32.func('int __stdcall SetCursorPos(int X, int Y)');

/**
 * Torna uma janela invisível para quem grava a tela.
 *
 * Chamamos esta função diretamente, em vez de usar o `setContentProtection` do
 * Electron, por um motivo prático: precisamos saber se ela FUNCIONOU. O método
 * do Electron não devolve nada, e uma falha silenciosa aqui tem consequência
 * visível — a camada de setas entra no vídeo, e cada visitante passa a ver a
 * própria seta duas vezes: a de verdade, instantânea, e o eco dela chegando
 * pela imagem com o atraso da rede. Duas setas vermelhas quase sobrepostas,
 * uma arrastando atrás da outra.
 *
 * WDA_EXCLUDEFROMCAPTURE existe a partir do Windows 10 2004 (build 19041).
 * Antes dele só havia WDA_MONITOR, que não esconde: pinta de preto na captura,
 * o que numa janela do tamanho da tela seria muito pior do que o problema.
 * Por isso não há caminho reserva — ou exclui de verdade, ou a camada não abre.
 */
const SetWindowDisplayAffinity = user32.func(
  'int __stdcall SetWindowDisplayAffinity(uintptr hWnd, uint32 dwAffinity)',
);
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;
const BlockInputNative = user32.func('int __stdcall BlockInput(int fBlockIt)');

const INPUT_SIZE = koffi.sizeof(INPUT);

// ── constantes ────────────────────────────────────────────────────
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
// Os laterais (polegar): um par só de sinalizadores para os dois, e QUAL deles
// foi vai no campo `mouseData` — daí eles não entrarem na tabela BUTTON_FLAGS.
const MOUSEEVENTF_XDOWN = 0x0080;
const MOUSEEVENTF_XUP = 0x0100;
/** O lateral de trás, que nos navegadores é "voltar". */
const XBUTTON1 = 0x0001;
/** O lateral da frente, que é "avançar". */
const XBUTTON2 = 0x0002;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;

const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_SCANCODE = 0x0008;

const WHEEL_DELTA = 120;

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

/** Marca nossos eventos para podermos ignorá-los se algum dia usarmos hooks. */
const RYKE_SIGNATURE = 0x52594b45; // "RYKE"

// ── estado ────────────────────────────────────────────────────────

/** Teclas que mandamos pressionar e ainda não soltamos. */
const heldKeys = new Set<string>();
let inputBlocked = false;

/** Confere na inicialização que o layout dos structs bate com o ABI do Windows. */
export function verifyAbi(): { ok: boolean; inputSize: number } {
  // x64: 4 (type) + 4 (padding) + 32 (MOUSEINPUT, o maior membro) = 40 bytes.
  const expected = process.arch === 'x64' || process.arch === 'arm64' ? 40 : 28;
  return { ok: INPUT_SIZE === expected, inputSize: INPUT_SIZE };
}

export type VirtualScreen = { left: number; top: number; width: number; height: number };

export function getVirtualScreen(): VirtualScreen {
  return {
    left: GetSystemMetrics(SM_XVIRTUALSCREEN),
    top: GetSystemMetrics(SM_YVIRTUALSCREEN),
    width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
    height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
  };
}

function dispatch(inputs: unknown[]): number {
  if (inputs.length === 0) return 0;
  const buffer = Buffer.allocUnsafe(INPUT_SIZE * inputs.length);
  koffi.encode(buffer, koffi.array(INPUT, inputs.length), inputs);
  return SendInput(inputs.length, buffer, INPUT_SIZE);
}

function mouseInput(dwFlags: number, dx = 0, dy = 0, mouseData = 0): unknown {
  return {
    type: INPUT_MOUSE,
    u: { mi: { dx, dy, mouseData, dwFlags, time: 0, dwExtraInfo: RYKE_SIGNATURE } },
  };
}

function keyInput(wVk: number, wScan: number, dwFlags: number): unknown {
  return {
    type: INPUT_KEYBOARD,
    u: { ki: { wVk, wScan, dwFlags, time: 0, dwExtraInfo: RYKE_SIGNATURE } },
  };
}

// ── mouse ─────────────────────────────────────────────────────────

/**
 * Move o ponteiro para um pixel absoluto da área de trabalho virtual.
 *
 * SendInput em modo absoluto trabalha numa grade normalizada de 0..65535
 * que cobre todos os monitores (com MOUSEEVENTF_VIRTUALDESK). Convertemos o
 * pixel físico para essa grade — assim funciona com múltiplos monitores e
 * com escalas de DPI diferentes entre eles.
 */
export function moveMouseTo(physicalX: number, physicalY: number): void {
  const vs = getVirtualScreen();
  if (vs.width <= 0 || vs.height <= 0) return;

  const clampedX = Math.min(Math.max(physicalX, vs.left), vs.left + vs.width - 1);
  const clampedY = Math.min(Math.max(physicalY, vs.top), vs.top + vs.height - 1);

  const nx = Math.round(((clampedX - vs.left) * 65535) / Math.max(1, vs.width - 1));
  const ny = Math.round(((clampedY - vs.top) * 65535) / Math.max(1, vs.height - 1));

  dispatch([mouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny)]);
}

/**
 * Move o ponteiro por um DESLOCAMENTO, e não para um pixel — o Modo Gamer.
 *
 * Sem `MOUSEEVENTF_ABSOLUTE`, o Windows soma dx/dy à posição atual, do mesmo
 * jeito que um mouse físico faria. É isto que deixa a mira girar sem fim: não
 * há borda de tela para bater, porque não estamos apontando para lugar nenhum,
 * só empurrando. Os jogos que leem entrada relativa (a maioria dos de tiro)
 * enxergam este movimento e viram a câmera 360°.
 *
 * Aviso honesto: jogos com anticheat costumam recusar entrada injetada por
 * software — isto funciona nos que não bloqueiam, não há como contornar aquilo
 * sem um driver de dispositivo, e tentar seria justamente o que o anticheat
 * existe para impedir.
 */
export function moveMouseRelative(dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  dispatch([mouseInput(MOUSEEVENTF_MOVE, Math.round(dx), Math.round(dy))]);
}

/**
 * Apertar e soltar de cada botão que tem par próprio no Windows.
 *
 * Um mapa, e não uma lista: com os laterais no tipo, uma lista de três posições
 * indexada por `BotaoMouse` deixaria de bater — e é o que o compilador acusa.
 * Os laterais ficam em `BOTOES_LATERAIS`, logo abaixo, porque no Windows eles
 * seguem por outro caminho.
 */
const BUTTON_FLAGS: Partial<Record<BotaoMouse, readonly [number, number]>> = {
  0: [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
  1: [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP],
  2: [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
};
const heldButtons = new Set<BotaoMouse>();

/**
 * Qual lateral é qual, no jeito do Windows.
 *
 * Os três primeiros botões têm cada um o seu par de sinalizadores; os laterais
 * dividem um par só (XDOWN/XUP) e se distinguem pelo `mouseData`. Por isso eles
 * moram neste mapa, e não na tabela acima.
 */
const BOTOES_LATERAIS: Partial<Record<BotaoMouse, number>> = { 3: XBUTTON1, 4: XBUTTON2 };

/**
 * @param button 0 esquerdo, 1 meio, 2 direito, 3 voltar, 4 avançar — a ordem do DOM.
 */
export function mouseButton(button: BotaoMouse, down: boolean): void {
  const lateral = BOTOES_LATERAIS[button];
  if (lateral !== undefined) {
    if (!mudarBotao(heldButtons, button, down)) return;
    dispatch([mouseInput(down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP, 0, 0, lateral)]);
    return;
  }
  const pair = BUTTON_FLAGS[button];
  if (!pair) return;
  if (!mudarBotao(heldButtons, button, down)) return;
  dispatch([mouseInput(down ? pair[0] : pair[1])]);
}

/** @param deltaY positivo rola para cima, seguindo a convenção do Windows */
export function mouseWheel(deltaX: number, deltaY: number): void {
  const events: unknown[] = [];
  if (deltaY) events.push(mouseInput(MOUSEEVENTF_WHEEL, 0, 0, Math.round(deltaY * WHEEL_DELTA)));
  if (deltaX) events.push(mouseInput(MOUSEEVENTF_HWHEEL, 0, 0, Math.round(deltaX * WHEEL_DELTA)));
  dispatch(events);
}

// ── teclado ───────────────────────────────────────────────────────

function keyEvents(code: string, down: boolean): unknown[] {
  const scan = lookupScan(code);
  if (scan) {
    const [scanCode, extended] = scan;
    let flags = KEYEVENTF_SCANCODE;
    if (extended) flags |= KEYEVENTF_EXTENDEDKEY;
    if (!down) flags |= KEYEVENTF_KEYUP;
    return [keyInput(0, scanCode, flags)];
  }

  const vk = VIRTUAL_KEYS[code];
  if (vk !== undefined) return [keyInput(vk, 0, down ? 0 : KEYEVENTF_KEYUP)];

  return [];
}

export function key(code: string, down: boolean): void {
  const events = keyEvents(code, down);
  if (events.length === 0) return;
  dispatch(events);
  if (down) heldKeys.add(code);
  else heldKeys.delete(code);
}

/**
 * Dispara uma combinação: pressiona na ordem recebida e solta na ordem
 * inversa, que é como um humano digita Ctrl+Shift+Esc.
 */
export function combo(codes: string[]): void {
  const events: unknown[] = [];
  for (const code of codes) events.push(...keyEvents(code, true));
  for (const code of [...codes].reverse()) events.push(...keyEvents(code, false));
  dispatch(events);
}

/**
 * Digita texto literal usando KEYEVENTF_UNICODE — não depende do layout do
 * teclado do anfitrião. É o caminho usado ao colar acentos e emojis.
 */
export function typeText(text: string): void {
  const events: unknown[] = [];
  for (const char of text) {
    // Fora do BMP (emoji) o Windows exige os dois surrogates separados.
    for (let i = 0; i < char.length; i++) {
      const unit = char.charCodeAt(i);
      events.push(keyInput(0, unit, KEYEVENTF_UNICODE));
      events.push(keyInput(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    // Lotes grandes podem estourar a fila de entrada; despachamos em blocos.
    if (events.length >= 200) {
      dispatch(events.splice(0, events.length));
    }
  }
  dispatch(events);
}

/**
 * Solta tudo que ficou pressionado. Chamado ao encerrar a sessão e quando o
 * visitante perde o foco da janela — sem isso um Alt preso deixa o anfitrião
 * inutilizável depois que a conexão cai.
 */
export function releaseAll(): void {
  const events: unknown[] = [];
  for (const code of heldKeys) events.push(...keyEvents(code, false));
  // Rede sempre pode ter perdido um "keyup" de modificador: solta todos por garantia.
  for (const code of MODIFIER_CODES) {
    if (!heldKeys.has(code)) events.push(...keyEvents(code, false));
  }
  heldKeys.clear();
  dispatch(events);

  // Só solta botões realmente pressionados por esta sessão. Enviar RIGHTUP
  // sem um RIGHTDOWN anterior era o que abria o menu de contexto ao conectar
  // ou desconectar.
  for (const button of [...heldButtons]) mouseButton(button, false);
}

/**
 * Impede que o teclado/mouse físicos do anfitrião interfiram na sessão.
 * Exige processo elevado; devolve false quando não foi permitido.
 */
/**
 * O Windows está mostrando a área protegida (UAC ou tela bloqueada)?
 *
 * Enquanto isto for verdade, a captura não entrega quadro nenhum e a entrada
 * injetada não chega a lugar nenhum — a sessão está viva, mas cega e muda.
 * Saber disso é o que permite avisar quem está do outro lado, em vez de deixar
 * a tela congelada sem explicação, e reerguer a captura quando a área normal
 * voltar (ela não volta sozinha).
 */
export function desktopSeguroAtivo(): boolean {
  try {
    const h = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
    // Sem alça = a área de entrada não é a nossa: o UAC (ou o bloqueio de tela)
    // está na frente.
    if (!h) return true;
    CloseDesktop(h);
    return false;
  } catch {
    // Na dúvida, dizemos que está tudo normal: um falso "está bloqueado"
    // dispararia recapturas à toa.
    return false;
  }
}

/** Posição atual do cursor, em pixels físicos da área de trabalho virtual. */
export function cursorPosition(): { x: number; y: number } | null {
  const p: { x?: number; y?: number } = {};
  if (!GetCursorPos(p)) return null;
  if (typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  return { x: p.x, y: p.y };
}

/**
 * O intervalo, em milissegundos, dentro do qual o Windows chama dois cliques
 * de duplo clique. Padrão 500 ms, mas a pessoa pode ter afrouxado no painel do
 * mouse — e é justamente quem afrouxou que ficaria sem duplo clique se
 * chutássemos o número.
 */
export function doubleClickTime(): number {
  try {
    const ms = GetDoubleClickTime();
    return typeof ms === 'number' && ms > 0 ? ms : 500;
  } catch {
    return 500;
  }
}

/**
 * Reposiciona o ponteiro sem gerar evento de entrada. Ver `SetCursorPos`.
 *
 * Coordenadas em pixels físicos da área de trabalho virtual, como em
 * `moveMouseTo` — e ao contrário desta, invisível para quem lê Raw Input.
 */
export function warpCursor(x: number, y: number): boolean {
  return SetCursorPos(Math.round(x), Math.round(y)) !== 0;
}

/**
 * Esconde a janela da captura de tela. Devolve false se o Windows recusou.
 *
 * @param handle o que `BrowserWindow.getNativeWindowHandle()` devolve — um
 *   Buffer com o HWND lá dentro, e não o HWND em si. Ler o ponteiro do buffer
 *   é obrigatório: passar o Buffer direto entregaria à API o endereço do
 *   buffer, que não é janela nenhuma, e a chamada falharia sem explicar por quê.
 */
export function excluirDaCaptura(handle: Buffer): boolean {
  if (handle.length < 4) return false;
  // HWND tem o tamanho de um ponteiro: 8 bytes no x64, 4 no x86.
  const hwnd = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
  if (!hwnd) return false;
  return SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) !== 0;
}

export function blockLocalInput(on: boolean): boolean {
  const result = BlockInputNative(on ? 1 : 0);
  if (result !== 0) inputBlocked = on;
  return result !== 0;
}

export function isLocalInputBlocked(): boolean {
  return inputBlocked;
}

export function heldKeyCount(): number {
  return heldKeys.size;
}
