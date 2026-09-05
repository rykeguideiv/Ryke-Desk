/**
 * As chamadas do Windows que só o SISTEMA pode fazer.
 *
 * Este é o coração da arquitetura nova, e também a única parte dela que é
 * genuinamente difícil. Tudo aqui existe para responder a uma pergunta: como
 * um processo que roda como SISTEMA, na sessão 0 (sem tela nenhuma), cria um
 * outro processo DENTRO da sessão de quem está usando o computador — e na área
 * de trabalho certa, inclusive na área protegida do UAC.
 *
 * Nada disto precisa de COM nem de Direct3D: são funções C simples de
 * `kernel32`, `advapi32`, `user32` e `wtsapi32`, então `koffi` dá conta. Foi o
 * que tornou esta arquitetura possível sem um módulo nativo em C++ — e é por
 * isso que ela é o caminho escolhido, e não a captura por API do Windows, que
 * exigiria compilar C++ de verdade.
 */
import koffi from 'koffi';

// ── as bibliotecas ────────────────────────────────────────────────
const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');
const user32 = koffi.load('user32.dll');
const wtsapi32 = koffi.load('wtsapi32.dll');

// ── estruturas ────────────────────────────────────────────────────
//
// STARTUPINFOW carrega o campo que dá nome a tudo isto: `lpDesktop`. É ele que
// decide em QUE área de trabalho o processo nasce — e um processo do Windows
// não pode trocar de área depois de criado, o que é a razão de existir o
// supervisor.
const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'void *',
  lpDesktop: 'void *',
  lpTitle: 'void *',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: 'void *',
  hStdInput: 'void *',
  hStdOutput: 'void *',
  hStdError: 'void *',
});

const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: 'void *',
  hThread: 'void *',
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
});

// ── funções ───────────────────────────────────────────────────────
const CloseHandle = kernel32.func('int __stdcall CloseHandle(void *h)');
const GetLastError = kernel32.func('uint32 __stdcall GetLastError()');

/** Qual sessão está no monitor físico agora. 0xFFFFFFFF = nenhuma. */
const WTSGetActiveConsoleSessionId = kernel32.func('uint32 __stdcall WTSGetActiveConsoleSessionId()');

/**
 * O token de quem está usando aquela sessão.
 *
 * Exige o privilégio SE_TCB_NAME, que na prática significa "só o SISTEMA". É
 * por aqui que o supervisor descobre em qual sessão precisa entrar.
 */
const WTSQueryUserToken = wtsapi32.func('int __stdcall WTSQueryUserToken(uint32 SessionId, _Out_ void **phToken)');

const OpenProcessToken = advapi32.func(
  'int __stdcall OpenProcessToken(void *ProcessHandle, uint32 DesiredAccess, _Out_ void **TokenHandle)',
);
const DuplicateTokenEx = advapi32.func(
  'int __stdcall DuplicateTokenEx(void *hExistingToken, uint32 dwDesiredAccess, void *lpTokenAttributes,' +
    ' int ImpersonationLevel, int TokenType, _Out_ void **phNewToken)',
);
const SetTokenInformation = advapi32.func(
  'int __stdcall SetTokenInformation(void *TokenHandle, int TokenInformationClass,' +
    ' void *TokenInformation, uint32 TokenInformationLength)',
);
const CreateProcessAsUserW = advapi32.func(
  'int __stdcall CreateProcessAsUserW(void *hToken, const char16_t *lpApplicationName, char16_t *lpCommandLine,' +
    ' void *lpProcessAttributes, void *lpThreadAttributes, int bInheritHandles, uint32 dwCreationFlags,' +
    ' void *lpEnvironment, const char16_t *lpCurrentDirectory, STARTUPINFOW *lpStartupInfo,' +
    ' _Out_ PROCESS_INFORMATION *lpProcessInformation)',
);

const OpenInputDesktop = user32.func(
  'void * __stdcall OpenInputDesktop(uint32 dwFlags, int fInherit, uint32 dwDesiredAccess)',
);
const CloseDesktop = user32.func('int __stdcall CloseDesktop(void *hDesktop)');
const GetUserObjectInformationW = user32.func(
  'int __stdcall GetUserObjectInformationW(void *hObj, int nIndex, _Out_ void *pvInfo,' +
    ' uint32 nLength, _Out_ uint32 *lpnLengthNeeded)',
);

// ── constantes ────────────────────────────────────────────────────
export const TOKEN_DUPLICATE = 0x0002;
export const TOKEN_QUERY = 0x0008;
export const TOKEN_ASSIGN_PRIMARY = 0x0001;
export const TOKEN_ADJUST_DEFAULT = 0x0080;
export const TOKEN_ADJUST_SESSIONID = 0x0100;
export const TOKEN_ALL_NEEDED =
  TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID;

/** SecurityImpersonation — suficiente para depois virar token primário. */
export const SecurityImpersonation = 2;
/** TokenPrimary — o tipo que `CreateProcessAsUser` exige. */
export const TokenPrimary = 1;
/** TokenSessionId, a classe que move o token para outra sessão. */
export const TokenSessionId = 12;

export const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
export const CREATE_NEW_CONSOLE = 0x00000010;
export const CREATE_NO_WINDOW = 0x08000000;

/** UOI_NAME — o nome da área de trabalho ("Default", "Winlogon"…). */
const UOI_NAME = 2;
const DESKTOP_READOBJECTS = 0x0001;

/** As duas áreas de trabalho que importam aqui. */
export const AREA_NORMAL = 'winsta0\\Default';
export const AREA_PROTEGIDA = 'winsta0\\Winlogon';

// ── o que o resto do projeto usa ──────────────────────────────────

export function ultimoErro(): number {
  return GetLastError();
}

export function fecharAlca(h: unknown): void {
  try {
    if (h) CloseHandle(h);
  } catch {
    /* fechar uma alça já fechada não é problema de ninguém */
  }
}

/**
 * A sessão que está no monitor agora.
 *
 * `null` quando não há nenhuma — acontece de verdade, entre o desligar de um
 * usuário e o login do próximo, e tratar isso como erro encheria o log de
 * ruído numa máquina que está apenas ociosa.
 */
export function sessaoAtiva(): number | null {
  const id = WTSGetActiveConsoleSessionId();
  return id === 0xffffffff ? null : id;
}

/**
 * O NOME da área de trabalho que está na frente agora.
 *
 * É este nome que distingue o dia a dia (`Default`) do momento em que o UAC
 * assume a tela (`Winlogon`) — a troca que o supervisor precisa enxergar para
 * recriar o agente do lado certo.
 *
 * Devolve `null` quando não dá para abrir a área de entrada. Para um processo
 * comum isso acontece o tempo todo (é justamente o sinal de área protegida que
 * o aplicativo já usa hoje); para o SISTEMA, quase nunca.
 */
export function nomeDaAreaAtiva(): string | null {
  let hDesk: unknown = null;
  try {
    hDesk = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
    if (!hDesk) return null;
    const buffer = Buffer.alloc(256);
    const usado: number[] = [0];
    if (!GetUserObjectInformationW(hDesk, UOI_NAME, buffer, buffer.length, usado)) return null;
    // UTF-16 terminado em zero.
    const bruto = buffer.toString('ucs2');
    const fim = bruto.indexOf('\0');
    return (fim >= 0 ? bruto.slice(0, fim) : bruto).trim() || null;
  } catch {
    return null;
  } finally {
    if (hDesk) {
      try {
        CloseDesktop(hDesk);
      } catch {
        /* idem */
      }
    }
  }
}

/** O nome bate com a área protegida do UAC? A comparação ignora maiúsculas. */
export function ehAreaProtegida(nome: string | null): boolean {
  return (nome ?? '').toLowerCase() === 'winlogon';
}

export type Criacao = { ok: true; pid: number } | { ok: false; erro: string };

/**
 * Cria um processo COMO SISTEMA, dentro da sessão de quem está no computador e
 * na área de trabalho indicada.
 *
 * É a operação que a arquitetura inteira existe para poder fazer, e o encadeado
 * abaixo é a receita oficial da Microsoft para ela:
 *
 *   1. pegar o token do próprio processo (que é o do SISTEMA);
 *   2. DUPLICAR esse token — um token em uso não pode ser modificado;
 *   3. mover a cópia para a sessão do usuário (`TokenSessionId`), que é o passo
 *      que exige SE_TCB_NAME e o motivo de nada disto funcionar sem ser SISTEMA;
 *   4. criar o processo com essa cópia, apontando `lpDesktop` para a área certa.
 *
 * O processo resultante é SISTEMA e enxerga a área de trabalho pedida — que é
 * exatamente o que falta hoje para ver e clicar no diálogo do UAC.
 */
export function criarComoSistemaNaSessao(
  executavel: string,
  linhaDeComando: string,
  sessao: number,
  area: string,
): Criacao {
  let meuToken: unknown = null;
  let copia: unknown = null;
  try {
    const saidaToken: unknown[] = [null];
    if (!OpenProcessToken(-1, TOKEN_ALL_NEEDED, saidaToken)) {
      return { ok: false, erro: `não consegui abrir o próprio token (erro ${ultimoErro()})` };
    }
    meuToken = saidaToken[0];

    const saidaCopia: unknown[] = [null];
    if (!DuplicateTokenEx(meuToken, TOKEN_ALL_NEEDED, null, SecurityImpersonation, TokenPrimary, saidaCopia)) {
      return { ok: false, erro: `não consegui duplicar o token (erro ${ultimoErro()})` };
    }
    copia = saidaCopia[0];

    // Mover o token para a sessão de quem está no monitor. Sem SE_TCB_NAME
    // isto falha — e é o teste mais honesto de "estou mesmo rodando como
    // SISTEMA?" que existe neste projeto.
    const idSessao = Buffer.alloc(4);
    idSessao.writeUInt32LE(sessao, 0);
    if (!SetTokenInformation(copia, TokenSessionId, idSessao, 4)) {
      return { ok: false, erro: `não consegui mover o token para a sessão ${sessao} (erro ${ultimoErro()})` };
    }

    const si: Record<string, unknown> = {
      cb: koffi.sizeof(STARTUPINFOW),
      lpReserved: null,
      lpDesktop: Buffer.from(`${area}\0`, 'ucs2'),
      lpTitle: null,
      dwX: 0,
      dwY: 0,
      dwXSize: 0,
      dwYSize: 0,
      dwXCountChars: 0,
      dwYCountChars: 0,
      dwFillAttribute: 0,
      dwFlags: 0,
      wShowWindow: 0,
      cbReserved2: 0,
      lpReserved2: null,
      hStdInput: null,
      hStdOutput: null,
      hStdError: null,
    };
    const pi: Record<string, unknown> = {};

    const criou = CreateProcessAsUserW(
      copia,
      executavel,
      linhaDeComando,
      null,
      null,
      0,
      CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
      null,
      null,
      si,
      pi,
    );
    if (!criou) return { ok: false, erro: `CreateProcessAsUser falhou (erro ${ultimoErro()})` };

    fecharAlca(pi.hProcess);
    fecharAlca(pi.hThread);
    return { ok: true, pid: Number(pi.dwProcessId ?? 0) };
  } catch (e) {
    return { ok: false, erro: String(e) };
  } finally {
    fecharAlca(copia);
    fecharAlca(meuToken);
  }
}
