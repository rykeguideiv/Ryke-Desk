/**
 * KeyboardEvent.code (posição física da tecla) → scan code do Windows (set 1).
 *
 * Por que scan code e não virtual-key: `event.code` descreve ONDE a tecla está
 * no teclado, não que letra ela produz. Injetando o scan code equivalente, o
 * Windows do outro lado aplica o layout DELE. Resultado: Ctrl+C é Ctrl+C em
 * qualquer layout, e teclas de ABNT2 (ç, ~, /, \) saem certas sem gambiarra.
 */

/** [scanCode, éEstendida] */
type Entry = readonly [number, boolean];

const N = false;
const E = true; // prefixo 0xE0

export const SCAN_CODES: Record<string, Entry> = {
  Escape: [0x01, N],

  Digit1: [0x02, N], Digit2: [0x03, N], Digit3: [0x04, N], Digit4: [0x05, N], Digit5: [0x06, N],
  Digit6: [0x07, N], Digit7: [0x08, N], Digit8: [0x09, N], Digit9: [0x0a, N], Digit0: [0x0b, N],

  Minus: [0x0c, N], Equal: [0x0d, N], Backspace: [0x0e, N], Tab: [0x0f, N],

  KeyQ: [0x10, N], KeyW: [0x11, N], KeyE: [0x12, N], KeyR: [0x13, N], KeyT: [0x14, N],
  KeyY: [0x15, N], KeyU: [0x16, N], KeyI: [0x17, N], KeyO: [0x18, N], KeyP: [0x19, N],

  BracketLeft: [0x1a, N], BracketRight: [0x1b, N], Enter: [0x1c, N], ControlLeft: [0x1d, N],

  KeyA: [0x1e, N], KeyS: [0x1f, N], KeyD: [0x20, N], KeyF: [0x21, N], KeyG: [0x22, N],
  KeyH: [0x23, N], KeyJ: [0x24, N], KeyK: [0x25, N], KeyL: [0x26, N],

  // Em ABNT2 esta é a tecla "Ç" — o layout do anfitrião resolve.
  Semicolon: [0x27, N],
  Quote: [0x28, N], Backquote: [0x29, N], ShiftLeft: [0x2a, N], Backslash: [0x2b, N],

  KeyZ: [0x2c, N], KeyX: [0x2d, N], KeyC: [0x2e, N], KeyV: [0x2f, N], KeyB: [0x30, N],
  KeyN: [0x31, N], KeyM: [0x32, N],

  Comma: [0x33, N], Period: [0x34, N], Slash: [0x35, N], ShiftRight: [0x36, N],

  NumpadMultiply: [0x37, N], AltLeft: [0x38, N], Space: [0x39, N], CapsLock: [0x3a, N],

  F1: [0x3b, N], F2: [0x3c, N], F3: [0x3d, N], F4: [0x3e, N], F5: [0x3f, N], F6: [0x40, N],
  F7: [0x41, N], F8: [0x42, N], F9: [0x43, N], F10: [0x44, N],

  NumLock: [0x45, N], ScrollLock: [0x46, N],

  Numpad7: [0x47, N], Numpad8: [0x48, N], Numpad9: [0x49, N], NumpadSubtract: [0x4a, N],
  Numpad4: [0x4b, N], Numpad5: [0x4c, N], Numpad6: [0x4d, N], NumpadAdd: [0x4e, N],
  Numpad1: [0x4f, N], Numpad2: [0x50, N], Numpad3: [0x51, N], Numpad0: [0x52, N],
  NumpadDecimal: [0x53, N],

  // Tecla extra dos teclados ISO/ABNT2, à direita do Shift esquerdo.
  IntlBackslash: [0x56, N],
  F11: [0x57, N], F12: [0x58, N],
  F13: [0x64, N], F14: [0x65, N], F15: [0x66, N], F16: [0x67, N], F17: [0x68, N],
  F18: [0x69, N], F19: [0x6a, N], F20: [0x6b, N], F21: [0x6c, N], F22: [0x6d, N],
  F23: [0x6e, N], F24: [0x76, N],

  // Barra do bloco alfanumérico do ABNT2 (a tecla "/ ? °").
  IntlRo: [0x73, N],
  IntlYen: [0x7d, N],
  NumpadComma: [0x7e, N],

  // ── estendidas (prefixo 0xE0) ──
  NumpadEnter: [0x1c, E], ControlRight: [0x1d, E], NumpadDivide: [0x35, E],
  PrintScreen: [0x37, E], AltRight: [0x38, E],
  Home: [0x47, E], ArrowUp: [0x48, E], PageUp: [0x49, E],
  ArrowLeft: [0x4b, E], ArrowRight: [0x4d, E],
  End: [0x4f, E], ArrowDown: [0x50, E], PageDown: [0x51, E],
  Insert: [0x52, E], Delete: [0x53, E],
  MetaLeft: [0x5b, E], MetaRight: [0x5c, E], ContextMenu: [0x5d, E],

  AudioVolumeMute: [0x20, E], AudioVolumeDown: [0x2e, E], AudioVolumeUp: [0x30, E],
  MediaPlayPause: [0x22, E], MediaStop: [0x24, E],
  MediaTrackNext: [0x19, E], MediaTrackPrevious: [0x10, E],
  BrowserBack: [0x6a, E], BrowserForward: [0x69, E], BrowserRefresh: [0x67, E],
};

/**
 * Teclas cujo scan code não é confiável — injetamos pelo virtual-key.
 * `Pause` tem sequência 0xE1 0x1D 0x45 que nem todo driver aceita.
 */
export const VIRTUAL_KEYS: Record<string, number> = {
  Pause: 0x13,
  NumpadEqual: 0x92,
  Lang1: 0x15,
  Lang2: 0x19,
};

export function lookupScan(code: string): Entry | undefined {
  return SCAN_CODES[code];
}

/** Toda tecla que o Ryke Desk sabe reproduzir do outro lado. */
export function isKnownKey(code: string): boolean {
  return code in SCAN_CODES || code in VIRTUAL_KEYS;
}

/** Modificadores — usados para soltar o que ficou preso ao sair da sessão. */
export const MODIFIER_CODES = [
  'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight',
] as const;

/** Combinações oferecidas na barra de ferramentas do visitante. */
/**
 * Ctrl+Alt+Del NÃO está nesta lista, e não é esquecimento.
 *
 * Tudo aqui é injetado com SendInput, e SendInput nunca produz a Secure
 * Attention Sequence — o Windows a intercepta antes de qualquer processo em
 * modo usuário. Enquanto ela esteve nesta lista, o botão existia, o clique
 * acontecia e nada chegava do outro lado. Agora ela tem caminho próprio
 * (a API SendSAS) e botão próprio na barra. Ver src/main/sas.ts.
 */
export const COMBOS: { label: string; hint: string; codes: string[] }[] = [
  { label: 'Alt+Tab', hint: 'Alternar janelas', codes: ['AltLeft', 'Tab'] },
  { label: 'Win', hint: 'Menu Iniciar', codes: ['MetaLeft'] },
  { label: 'Win+D', hint: 'Mostrar a área de trabalho', codes: ['MetaLeft', 'KeyD'] },
  { label: 'Win+E', hint: 'Abrir o Explorador de Arquivos', codes: ['MetaLeft', 'KeyE'] },
  { label: 'Alt+F4', hint: 'Fechar a janela ativa', codes: ['AltLeft', 'F4'] },
  { label: 'Ctrl+Shift+Esc', hint: 'Gerenciador de Tarefas', codes: ['ControlLeft', 'ShiftLeft', 'Escape'] },
  { label: 'PrtScn', hint: 'Capturar a tela', codes: ['PrintScreen'] },
  // Esc tem botao proprio porque a tecla, na janela da sessao, minimiza em vez
  // de atravessar: sem este caminho nao haveria como manda-lo ao outro lado.
  { label: 'Esc', hint: 'Cancelar / fechar caixa de dialogo', codes: ['Escape'] },
];
