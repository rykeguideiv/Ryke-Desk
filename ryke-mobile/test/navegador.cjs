/**
 * Casca mínima para rodar o pacote do aplicativo fora do Android.
 *
 * O APK é uma WebView do Chromium em volta dos arquivos de `dist/`. Aqui esses
 * mesmos arquivos são servidos e abertos numa janela do Chromium — o mesmo
 * motor, o mesmo código, a mesma pilha WebRTC. O que muda é só a moldura.
 *
 * Servimos por http://127.0.0.1 e não por file://, e isso não é detalhe: o
 * WebCrypto — que a malha usa para cifrar cada envelope — só existe em
 * contexto seguro. `file://` não é considerado seguro; `localhost` é. No
 * Android, o Capacitor resolve o mesmo problema servindo por https://.
 *
 *   electron test/navegador.cjs <pasta-dist> <porta-http>
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { join, extname, normalize } = require('node:path');

const RAIZ = process.argv[2];
const PORTA = Number(process.argv[3] || 4173);

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  try {
    const caminho = decodeURIComponent((req.url || '/').split('?')[0]);
    // normalize + startsWith: sem isso, "../.." serviria qualquer arquivo do
    // disco. Servidor de teste também não pode ser um buraco.
    const alvo = normalize(join(RAIZ, caminho === '/' ? 'index.html' : caminho));
    if (!alvo.startsWith(normalize(RAIZ))) {
      res.writeHead(403).end();
      return;
    }
    const corpo = await readFile(alvo);
    res.writeHead(200, { 'Content-Type': TIPOS[extname(alvo)] || 'application/octet-stream' });
    res.end(corpo);
  } catch {
    res.writeHead(404).end();
  }
}).listen(PORTA, '127.0.0.1');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(() => {
  const janela = new BrowserWindow({
    // Proporção de celular: o mesmo espaço que a interface terá no aparelho,
    // para os alvos de toque serem exercitados no tamanho real.
    width: 412,
    height: 915,
    show: true,
    // Sempre à frente e sem estrangulamento: a janela do PC anfitrião fica
    // maximizada e cobre esta, e o Chromium suspende os quadros de animação de
    // janelas encobertas. O joystick vive de quadros de animação — encoberto,
    // ele parava e só entregava o movimento quando a janela reaparecia. Num
    // celular de verdade o aplicativo em uso está sempre visível.
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });

  /**
   * Esta janela não recebe mouse de verdade — e isso é o que a torna um celular.
   *
   * As duas pontas do teste rodam na mesma máquina. O anfitrião move o cursor
   * do Windows obedecendo ao que o "celular" manda, e esse cursor passa por
   * cima desta janela: o toque que saiu daqui volta como evento de ponteiro
   * real, é interpretado como um novo toque, e manda outro comando. O
   * resultado é um laço que arrasta o cursor sozinho pela tela.
   *
   * Um telefone de verdade nunca vê o mouse do PC. Ignorar o mouse aqui não
   * afrouxa o teste: é o que faz esta casca se parecer com o aparelho.
   */
  janela.setIgnoreMouseEvents(true);

  janela.loadURL(`http://127.0.0.1:${PORTA}/`);
});

app.on('window-all-closed', () => app.quit());
