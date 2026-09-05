/**
 * Prova que as assinaturas do win32.ts são válidas e que a leitura da área de
 * trabalho ativa funciona. Só chamadas de LEITURA — nada aqui cria processo.
 *
 *   node ryke-sistema/prova-win32.cjs
 */
const koffi = require('koffi');

const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');
const user32 = koffi.load('user32.dll');
const wtsapi32 = koffi.load('wtsapi32.dll');

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

// ── as estruturas ────────────────────────────────────────────────
const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *',
  dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
  dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32',
  dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16',
  lpReserved2: 'void *', hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
});
const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32',
});

// x64: 8 ponteiros + campos = 104 bytes. Se isto mudar, CreateProcessAsUser
// recebe lixo e falha de um jeito impossível de depurar.
const tam = koffi.sizeof(STARTUPINFOW);
check('STARTUPINFOW tem o tamanho do ABI x64', tam === 104, `${tam} bytes`);
check('PROCESS_INFORMATION idem', koffi.sizeof(PROCESS_INFORMATION) === 24, `${koffi.sizeof(PROCESS_INFORMATION)} bytes`);

// ── as funções: só declarar já valida a assinatura ───────────────
let declarou = true;
try {
  kernel32.func('int __stdcall CloseHandle(void *h)');
  kernel32.func('uint32 __stdcall GetLastError()');
  kernel32.func('uint32 __stdcall WTSGetActiveConsoleSessionId()');
  wtsapi32.func('int __stdcall WTSQueryUserToken(uint32 SessionId, _Out_ void **phToken)');
  advapi32.func('int __stdcall OpenProcessToken(void *ProcessHandle, uint32 DesiredAccess, _Out_ void **TokenHandle)');
  advapi32.func('int __stdcall DuplicateTokenEx(void *hExistingToken, uint32 dwDesiredAccess, void *lpTokenAttributes, int ImpersonationLevel, int TokenType, _Out_ void **phNewToken)');
  advapi32.func('int __stdcall SetTokenInformation(void *TokenHandle, int TokenInformationClass, void *TokenInformation, uint32 TokenInformationLength)');
  advapi32.func('int __stdcall CreateProcessAsUserW(void *hToken, const char16_t *lpApplicationName, char16_t *lpCommandLine, void *lpProcessAttributes, void *lpThreadAttributes, int bInheritHandles, uint32 dwCreationFlags, void *lpEnvironment, const char16_t *lpCurrentDirectory, STARTUPINFOW *lpStartupInfo, _Out_ PROCESS_INFORMATION *lpProcessInformation)');
} catch (e) {
  declarou = false;
  console.log('   erro ao declarar: ' + e.message);
}
check('todas as assinaturas são aceitas pelo koffi', declarou);

// ── leituras de verdade ──────────────────────────────────────────
const WTSGetActiveConsoleSessionId = kernel32.func('uint32 __stdcall WTSGetActiveConsoleSessionId()');
const sessao = WTSGetActiveConsoleSessionId();
check('a sessão do monitor foi lida', sessao !== 0xffffffff && Number.isInteger(sessao), `sessão ${sessao}`);

const OpenInputDesktop = user32.func('void * __stdcall OpenInputDesktop(uint32 dwFlags, int fInherit, uint32 dwDesiredAccess)');
const CloseDesktop = user32.func('int __stdcall CloseDesktop(void *hDesktop)');
const GetUserObjectInformationW = user32.func('int __stdcall GetUserObjectInformationW(void *hObj, int nIndex, _Out_ void *pvInfo, uint32 nLength, _Out_ uint32 *lpnLengthNeeded)');

const UOI_NAME = 2;
const DESKTOP_READOBJECTS = 0x0001;
const h = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
if (!h) {
  check('a área de trabalho ativa foi aberta', false, 'OpenInputDesktop devolveu nulo (área protegida na frente?)');
} else {
  const buf = Buffer.alloc(256);
  const usado = [0];
  const leu = GetUserObjectInformationW(h, UOI_NAME, buf, buf.length, usado);
  const bruto = buf.toString('ucs2');
  const fim = bruto.indexOf('\0');
  const nome = (fim >= 0 ? bruto.slice(0, fim) : bruto).trim();
  CloseDesktop(h);
  check('o NOME da área de trabalho ativa foi lido', !!leu && nome.length > 0, `"${nome}"`);
  // Sem UAC na tela agora, tem de ser a área normal.
  check('e é a área normal (nenhum UAC na frente agora)', nome.toLowerCase() === 'default', `"${nome}"`);
}

console.log(falhas === 0 ? '\nFundacao win32 validada.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
