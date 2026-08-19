/**
 * Captura total do teclado enquanto se controla outro computador.
 *
 * O PROBLEMA
 *
 * Ctrl+Shift+Esc abria o Gerenciador de Tarefas DESTE computador, não do
 * remoto. E não é um descuido de programação: o Windows trata algumas
 * combinações antes de qualquer aplicativo ver. O navegador que desenha a tela
 * remota nunca recebe o evento, então não há o que reenviar — a tecla foi
 * consumida pelo sistema um andar abaixo.
 *
 * A lista é maior do que parece: Ctrl+Shift+Esc, Ctrl+Esc, a tecla Windows
 * sozinha, Win+E, Win+R, Win+D, Alt+Tab, Alt+Esc. Todas essas são exatamente
 * as que mais fazem falta em acesso remoto.
 *
 * A SOLUÇÃO
 *
 * Um gancho de teclado de baixo nível (`WH_KEYBOARD_LL`), que roda antes do
 * sistema decidir o que fazer com a tecla. Cada tecla é lida, mandada para o
 * outro computador e **engolida aqui** — devolvendo 1 em vez de repassar,
 * o Windows age como se ela nunca tivesse sido pressionada.
 *
 * O QUE CONTINUA IMPOSSÍVEL, E POR QUÊ
 *
 * Ctrl+Alt+Del não passa por aqui. É a "Secure Attention Sequence": o Windows
 * a entrega direto ao Winlogon, num caminho que nenhum programa comum alcança
 * — e isso é proposital, é o que garante que a tela de bloqueio seja mesmo do
 * Windows e não de um impostor. Por isso existe o botão na barra: ele injeta
 * a combinação do outro lado, que é onde ela precisa acontecer.
 *
 * CUIDADOS, PORQUE ISTO MEXE COM O TECLADO DA MÁQUINA INTEIRA
 *
 *   · Só fica instalado enquanto há sessão E a janela está em primeiro plano.
 *     Perdeu o foco, sai na hora — ninguém fica com o teclado sequestrado
 *     porque o Ryke Desk está aberto em segundo plano.
 *   · Teclas injetadas por programas (inclusive as nossas, quando esta mesma
 *     máquina também é anfitriã) são reconhecidas e deixadas passar, senão a
 *     sessão entraria em laço consigo mesma.
 *   · Qualquer erro aqui devolve a tecla ao sistema. Um defeito neste arquivo
 *     não pode deixar ninguém sem teclado.
 */
import koffi from 'koffi';
import { SCAN_CODES, MODIFIER_CODES } from '../shared/keymap';

const KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
  vkCode: 'uint32',
  scanCode: 'uint32',
  flags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
});

const ProcTeclado = koffi.proto('intptr __stdcall ProcTeclado(int nCode, uintptr wParam, void *lParam)');

const user32 = koffi.load('user32.dll');
const SetWindowsHookExW = user32.func(
  'void* __stdcall SetWindowsHookExW(int idHook, void *lpfn, void *hmod, uint32 dwThreadId)',
);
const UnhookWindowsHookEx = user32.func('int __stdcall UnhookWindowsHookEx(void *hhk)');
const CallNextHookEx = user32.func(
  'intptr __stdcall CallNextHookEx(void *hhk, int nCode, uintptr wParam, void *lParam)',
);

const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;
/** A tecla veio com o prefixo 0xE0 (as duplicadas: Ctrl direito, setas, etc). */
const LLKHF_EXTENDED = 0x01;
/** Foi injetada por software — nossa, ou de outro programa. */
const LLKHF_INJECTED = 0x10;

/**
 * Posição física da tecla → nome no padrão do navegador.
 *
 * O caminho inverso do que a injeção usa, e pela mesma razão: posição física
 * atravessa a diferença de layout. Quem pressiona a tecla ao lado do Enter num
 * ABNT2 quer aquela tecla do outro lado, não a letra que ela produziria aqui.
 */
const PORPOSICAO = new Map<number, string>();
for (const [code, entrada] of Object.entries(SCAN_CODES)) {
  const [scan, estendida] = entrada;
  PORPOSICAO.set((estendida ? 0x100 : 0) | scan, code);
}

export type EventoTeclado =
  | { tipo: 'tecla'; code: string; pressionada: boolean }
  /** Combinação reservada à interface do próprio Ryke Desk. */
  | { tipo: 'acao'; qual: 'sair' | 'telaCheia' | 'minimizar' | 'gamer' }
  /** O gancho saiu: solte no outro lado tudo o que ficou pressionado. */
  | { tipo: 'soltar' };

let gancho: unknown = null;
let ponteiroProc: ReturnType<typeof koffi.register> | null = null;
let entregar: ((evento: EventoTeclado) => void) | null = null;
const pressionadas = new Set<string>();
/** Esc puro minimiza? Desligado pelo Modo Gamer para o Esc chegar ao jogo. */
let escMinimizaLocal = true;

/** Liga/desliga o comportamento de "Esc minimiza" (ver interpretar). */
export function definirEscMinimiza(on: boolean): void {
  escMinimizaLocal = on;
}

const temAlgum = (pressionadas: Set<string>, ...codes: string[]): boolean =>
  codes.some((c) => pressionadas.has(c));

/**
 * As duas combinações que continuam sendo desta janela.
 *
 * Elas não podem ir para o outro lado: são a saída de emergência. Com o
 * teclado todo capturado, sem um atalho local a pessoa ficaria sem como sair
 * da tela cheia a não ser pelo mouse.
 *
 * O tratamento acontece aqui dentro, e não no navegador, justamente porque os
 * modificadores foram engolidos: para a janela, o Ctrl nunca chegou a ser
 * pressionado, e ela veria um "F" solto.
 */
function acaoLocal(code: string, pressionadas: Set<string>): 'sair' | 'telaCheia' | 'gamer' | null {
  if (
    !temAlgum(pressionadas, 'ControlLeft', 'ControlRight') ||
    !temAlgum(pressionadas, 'AltLeft', 'AltRight') ||
    !temAlgum(pressionadas, 'ShiftLeft', 'ShiftRight')
  ) {
    return null;
  }
  if (code === 'KeyX') return 'sair';
  if (code === 'KeyF') return 'telaCheia';
  // A saída de emergência do Modo Gamer: com o ponteiro travado no jogo, a
  // barra fica inalcançável, então precisa de um atalho que sempre funcione.
  if (code === 'KeyG') return 'gamer';
  return null;
}

export type Decisao =
  /** Devolve a tecla ao Windows: ela age nesta máquina, como sempre. */
  | { acao: 'passar' }
  /** A tecla não acontece aqui; estes eventos vão para o outro lado. */
  | { acao: 'engolir'; eventos: EventoTeclado[] };

/**
 * A decisão, separada do FFI para poder ser provada.
 *
 * Não dá para testar isto com teclas simuladas: toda tecla gerada por software
 * chega marcada como injetada, e nós a ignoramos de propósito — capturá-la
 * faria a sessão brigar com a própria injeção quando as duas pontas estão na
 * mesma máquina. Sem essa separação, o único teste possível seria uma pessoa
 * apertando teclas de verdade.
 *
 * Recebe o conjunto de teclas pressionadas e o atualiza: é ele que permite
 * reconhecer combinações, já que os modificadores foram engolidos e o Windows
 * não os tem mais como pressionados.
 */
export function interpretar(
  scanCode: number,
  flags: number,
  wParam: number,
  pressionadas: Set<string>,
  escMinimiza = true,
): Decisao {
  // Tecla injetada por software não pode ser capturada: quando esta mesma
  // máquina é anfitriã de outra sessão, engolir a própria injeção faria a
  // sessão brigar consigo mesma.
  if ((flags & LLKHF_INJECTED) !== 0) return { acao: 'passar' };

  const desceu = wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN;
  const subiu = wParam === WM_KEYUP || wParam === WM_SYSKEYUP;
  if (!desceu && !subiu) return { acao: 'passar' };

  const chave = ((flags & LLKHF_EXTENDED) !== 0 ? 0x100 : 0) | (scanCode & 0xff);
  const code = PORPOSICAO.get(chave);
  // Tecla que não sabemos nomear (multimídia, teclas de fabricante): devolve
  // ao sistema em vez de sumir com ela.
  if (!code) return { acao: 'passar' };

  if (desceu) {
    // Esc sozinho pertence à janela local e minimiza a sessão. Combinado com
    // um modificador (Ctrl+Shift+Esc, Alt+Esc, Ctrl+Esc...) é um atalho de
    // verdade — vai para o outro lado, que é exatamente para isso que este
    // gancho existe (ver o topo do arquivo).
    //
    // O Modo Gamer desliga essa regra (escMinimiza = false): num jogo, Esc é
    // "abrir o menu", não "sair da tela". Aí ele segue para o outro lado como
    // qualquer outra tecla, em vez de minimizar.
    if (escMinimiza && code === 'Escape' && !temAlgum(pressionadas, ...MODIFIER_CODES)) {
      pressionadas.clear();
      return { acao: 'engolir', eventos: [{ tipo: 'soltar' }, { tipo: 'acao', qual: 'minimizar' }] };
    }
    const acao = acaoLocal(code, pressionadas);
    if (acao) {
      pressionadas.clear();
      return { acao: 'engolir', eventos: [{ tipo: 'soltar' }, { tipo: 'acao', qual: acao }] };
    }
    pressionadas.add(code);
  } else {
    pressionadas.delete(code);
  }

  return { acao: 'engolir', eventos: [{ tipo: 'tecla', code, pressionada: desceu }] };
}

const proc = (nCode: number, wParam: number, lParam: unknown): number => {
  try {
    if (nCode !== 0 || !entregar) return CallNextHookEx(null, nCode, wParam, lParam) as number;

    const info = koffi.decode(lParam, KBDLLHOOKSTRUCT) as { scanCode: number; flags: number };
    const decisao = interpretar(info.scanCode, info.flags, wParam, pressionadas, escMinimizaLocal);
    if (decisao.acao === 'passar') return CallNextHookEx(null, nCode, wParam, lParam) as number;

    for (const evento of decisao.eventos) entregar(evento);
    return 1;
  } catch {
    // Nunca deixar o teclado da máquina refém de um erro nosso.
    return 0;
  }
};

/** O gancho está instalado agora? */
export function capturando(): boolean {
  return gancho !== null;
}

/**
 * Liga ou desliga a captura.
 *
 * Devolve se conseguiu. Instalar pode falhar — por política de grupo, por
 * outro programa de acesso remoto no mesmo aparelho — e nesse caso o visitante
 * continua funcionando pelo caminho normal do navegador, só sem as
 * combinações que o Windows reserva.
 */
export function capturar(on: boolean, aoReceber?: (evento: EventoTeclado) => void): boolean {
  if (on) {
    entregar = aoReceber ?? entregar;
    if (gancho) return true;
    try {
      ponteiroProc = koffi.register(proc, koffi.pointer(ProcTeclado));
      gancho = SetWindowsHookExW(WH_KEYBOARD_LL, ponteiroProc, null, 0);
      if (!gancho) {
        koffi.unregister(ponteiroProc);
        ponteiroProc = null;
        return false;
      }
      return true;
    } catch {
      gancho = null;
      ponteiroProc = null;
      return false;
    }
  }

  if (!gancho) return true;
  try {
    UnhookWindowsHookEx(gancho);
  } catch {
    /* já removido pelo sistema */
  }
  gancho = null;
  if (ponteiroProc) {
    try {
      koffi.unregister(ponteiroProc);
    } catch {
      /* já liberado */
    }
    ponteiroProc = null;
  }
  // Solta do outro lado o que ficou pressionado: sair com o Alt preso lá
  // deixaria o computador remoto com o comportamento todo errado.
  if (pressionadas.size > 0 && entregar) entregar({ tipo: 'soltar' });
  pressionadas.clear();
  return true;
}
