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

const BUTTON_FLAGS = [
  [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
  [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP],
  [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
] as const;
const heldButtons = new Set<BotaoMouse>();

/** @param button 0 = esquerdo, 1 = meio, 2 = direito (mesma ordem do DOM) */
export function mouseButton(button: 0 | 1 | 2, down: boolean): void {
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
/** Posição atual do cursor, em pixels físicos da área de trabalho virtual. */
export function cursorPosition(): { x: number; y: number } | null {
  const p: { x?: number; y?: number } = {};
  if (!GetCursorPos(p)) return null;
  if (typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  return { x: p.x, y: p.y };
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
