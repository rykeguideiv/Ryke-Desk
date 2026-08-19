/**
 * Elevação a administrador no Windows.
 *
 * Por que o Ryke Desk precisa de admin:
 *   - injetar teclado/mouse em janelas de programas que rodam elevados
 *     (o Windows barra SendInput de um processo comum para um elevado — é a
 *     proteção UIPI);
 *   - bloquear o teclado/mouse físicos do anfitrião (BlockInput exige admin);
 *   - enxergar a tela de UAC e a área de trabalho segura.
 *
 * O instalador já grava o manifesto `requireAdministrator`, então o programa
 * instalado sempre abre elevado. Esta rotina cobre os outros casos (rodar
 * direto do build, um atalho sem o manifesto) relançando a si mesmo com o
 * pedido de elevação e encerrando a instância comum.
 */
import { spawnSync } from 'node:child_process';
import { app, type BrowserWindow } from 'electron';
import koffi from 'koffi';

/** Pergunta ao Windows se o processo atual já está elevado. */
export function isElevated(): boolean {
  if (process.platform !== 'win32') return true;
  // "net session" só funciona com privilégio de administrador; o código de
  // saída diz tudo, e escondemos qualquer texto.
  const r = spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' });
  return r.status === 0;
}

/**
 * Relança o aplicativo pedindo elevação (dispara o prompt do UAC) e devolve
 * true se conseguiu iniciar o novo processo — nesse caso o chamador deve
 * encerrar a instância atual.
 *
 * Se o usuário recusar o UAC, devolve false e seguimos sem elevação: o app
 * ainda abre e funciona no essencial; só perde os recursos que exigem admin.
 */
export function relaunchElevated(): boolean {
  if (process.platform !== 'win32') return false;

  const exe = process.execPath;
  // Em desenvolvimento, execPath é o electron.exe e os argumentos trazem o
  // caminho do app; preservamos tudo para o relançamento ser idêntico.
  const args = app.isPackaged ? [] : process.argv.slice(1);

  // PowerShell Start-Process -Verb RunAs é o caminho limpo para pedir UAC sem
  // depender de utilitários externos. -PassThru + exit garante que sabemos se
  // o processo elevado chegou a iniciar.
  const listaArgs = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  const comando = listaArgs
    ? `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList ${listaArgs} -Verb RunAs`
    : `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -Verb RunAs`;

  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', comando], {
    windowsHide: true,
    stdio: 'ignore',
  });

  // status 0 = o Start-Process disparou; UAC recusado retorna status != 0.
  return r.status === 0;
}

// ─────────────────── arrastar e soltar sob elevação ────────────────────

const user32 = koffi.load('user32.dll');
const ChangeWindowMessageFilterEx = user32.func(
  'int __stdcall ChangeWindowMessageFilterEx(void *hWnd, uint32 message, uint32 action, void *pChangeFilterStruct)',
);

const MSGFLT_ALLOW = 1;
const WM_DROPFILES = 0x0233;
const WM_COPYDATA = 0x004a;
/** Mensagem interna que acompanha o arrastar de arquivos; não tem nome público. */
const WM_COPYGLOBALDATA = 0x0049;

/**
 * Deixa o arrastar-e-soltar do Explorador funcionar numa janela elevada.
 *
 * O Windows tem uma proteção chamada UIPI: um processo de integridade baixa
 * (o Explorador, que roda como usuário comum) não pode enviar mensagens a um
 * processo de integridade alta (nós, elevados). O efeito prático é cruel —
 * arrastar um arquivo para a janela simplesmente não faz nada, sem erro nem
 * aviso.
 *
 * `ChangeWindowMessageFilterEx` é a API oficial para abrir exceções pontuais.
 * Liberamos só as três mensagens do protocolo de arrastar arquivos, e nada
 * mais: a proteção continua valendo para todo o resto.
 */
export function permitirArrastarArquivos(janela: BrowserWindow): boolean {
  if (process.platform !== 'win32') return true;
  try {
    const hwnd = janela.getNativeWindowHandle();
    let todasOk = true;
    for (const mensagem of [WM_DROPFILES, WM_COPYDATA, WM_COPYGLOBALDATA]) {
      const ok = ChangeWindowMessageFilterEx(hwnd, mensagem, MSGFLT_ALLOW, null);
      if (ok === 0) todasOk = false;
    }
    return todasOk;
  } catch (err) {
    console.warn('[elevação] não foi possível liberar o arrastar-soltar:', err);
    return false;
  }
}
