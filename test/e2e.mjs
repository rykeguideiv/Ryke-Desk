/**
 * Teste ponta a ponta real do Ryke Desk.
 *
 * Reproduz o cenário do projeto: dois computadores em cidades diferentes, sem
 * nenhum deles hospedando nada e SEM SERVIDOR ALGUM. Sobe dois corretores de
 * mensagens locais no lugar dos públicos — para o teste não depender de
 * serviço de terceiro estar no ar — e DUAS cópias do aplicativo, cada uma com
 * seu perfil e portanto com números Ryke distintos, conduzidas pela porta de
 * depuração do Chromium. Nenhuma linha de código de teste vive dentro do
 * aplicativo.
 *
 * São dois corretores, e não um, de propósito: é o mínimo para provar que a
 * mesma mensagem saindo por caminhos paralelos chega uma vez só.
 *
 * O roteiro é o do usuário final: responder às duas perguntas iniciais,
 * definir a senha no anfitrião, digitar número e senha no visitante, apertar
 * Conectar e conferir que a imagem chegou, que o teclado atravessa de verdade
 * (olhando o estado do Windows, não o que o app diz) e que um arquivo vai de
 * um lado ao outro byte a byte.
 *
 *   node test/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import koffi from 'koffi';
import { Aba, preencher, clicarTexto, clicarSeletor } from './cdp.mjs';
import { copiarArquivos } from '../src/main/clipboard-arquivos.ts';
import { iniciarCorretorLocal } from './corretor-local.mjs';

// Olhamos o estado real do Windows para provar que o teclado e o mouse do
// visitante mexeram mesmo na máquina do anfitrião — não basta o aplicativo
// dizer que enviou.
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const user32 = koffi.load('user32.dll');
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *p)');
const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)');
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vKey)');
// SM_CXSCREEN / SM_CYSCREEN: a tela principal em pixels físicos, que é a
// medida com que o anfitrião converte a posição do cursor em fração.
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');

// Área de transferência de arquivos: o teste põe um arquivo nela como faria um
// Ctrl+C no Explorador, e depois lê o que o outro lado deixou lá.
const OpenClipboard = user32.func('int __stdcall OpenClipboard(void *hWnd)');
const CloseClipboard = user32.func('int __stdcall CloseClipboard()');
const GetClipboardData = user32.func('void* __stdcall GetClipboardData(uint32 uFormat)');
const IsClipboardFormatAvailable = user32.func('int __stdcall IsClipboardFormatAvailable(uint32 f)');
const DragQueryFileW = koffi
  .load('shell32.dll')
  .func('uint32 __stdcall DragQueryFileW(void *hDrop, uint32 iFile, _Out_ char16_t *buf, uint32 cch)');
const CF_HDROP = 15;

/** O primeiro arquivo oferecido pela área de transferência, ou null. */
function arquivoNaAreaDeTransferencia() {
  if (!IsClipboardFormatAvailable(CF_HDROP)) return null;
  if (!OpenClipboard(null)) return null;
  try {
    const hDrop = GetClipboardData(CF_HDROP);
    if (!hDrop) return null;
    const buf = Buffer.alloc(520 * 2);
    const escritos = DragQueryFileW(hDrop, 0, buf, 520);
    return escritos > 0 ? buf.toString('ucs2', 0, escritos * 2) : null;
  } finally {
    CloseClipboard();
  }
}

function arquivosNaAreaDeTransferencia() {
  if (!IsClipboardFormatAvailable(CF_HDROP) || !OpenClipboard(null)) return [];
  try {
    const hDrop = GetClipboardData(CF_HDROP);
    if (!hDrop) return [];
    const quantidade = DragQueryFileW(hDrop, 0xffffffff, null, 0);
    const paths = [];
    for (let i = 0; i < quantidade; i++) {
      const tamanho = DragQueryFileW(hDrop, i, null, 0);
      const buf = Buffer.alloc((tamanho + 1) * 2);
      const escritos = DragQueryFileW(hDrop, i, buf, tamanho + 1);
      if (escritos) paths.push(buf.toString('ucs2', 0, escritos * 2));
    }
    return paths;
  } finally {
    CloseClipboard();
  }
}

const VK_LSHIFT = 0xa0;
const teclaPressionada = (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0;
const posicaoDoCursor = () => {
  const p = {};
  GetCursorPos(p);
  return p;
};

const SENHA = 'melancia-42-azul';
const RAIZ = resolve(import.meta.dirname, '..');
const ELECTRON = join(RAIZ, 'node_modules', 'electron', 'dist', 'electron.exe');

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const descartaveis = [];
const processos = [];

// O cliente do protocolo de depuracao e os auxiliares de interface vivem
// em cdp.mjs, compartilhados com os demais testes.
// ──────────────────────────── orquestração ───────────────────────────────

/**
 * Corretores locais que fazem o papel dos públicos.
 *
 * Em produção a malha usa corretores MQTT abertos na internet. Aqui eles são
 * substituídos por dois locais, via RYKE_CORRETORES: o teste precisa falhar
 * por causa do nosso código, nunca porque um serviço de cortesia de terceiro
 * saiu do ar.
 */
let corretores = [];

/**
 * Usar os corretores públicos de verdade, em vez dos locais.
 *
 * O padrão é local, porque um teste que falha por causa da internet alheia
 * não diz nada sobre o nosso código. Mas essa escolha esconde a única
 * pergunta que decide se o produto funciona na casa do usuário — o app
 * empacotado atravessa mesmo a internet pública? Com RYKE_E2E_INTERNET=1 o
 * roteiro é idêntico, só que sem rede de proteção.
 */
const PELA_INTERNET = process.env.RYKE_E2E_INTERNET === '1';

function lancarAplicativo(nome, portaDebug, perfil, downloadDir) {
  const ambiente = { ...process.env };
  // A porta de depuração precisa de um Electron de verdade, não do modo Node.
  delete ambiente.ELECTRON_RUN_AS_NODE;
  // O teste automatizado não pode disparar UAC: seguimos sem elevação.
  ambiente.RYKE_SEM_ELEVACAO = '1';
  // Aponta a malha para os corretores do teste. Repare no que NÃO está aqui:
  // nenhum endereço de servidor. É assim que o instalador sai de fábrica.
  // Pela internet, nem isto: o app usa exatamente o que vem embutido.
  if (!PELA_INTERNET) {
    ambiente.RYKE_CORRETORES = corretores.map((c) => c.url).join(',');
    // Definida e vazia = desliga a família inteira. Sem isto o teste abriria
    // relays reais da internet e deixaria de ser hermético.
    ambiente.RYKE_RELAYS = '';
  }
  writeFileSync(
    join(perfil, 'ryke-config.json'),
    // Mantemos deliberadamente o valor legado desligado: versões antigas
    // gravavam esta preferência. Ele não pode mais transformar uma senha
    // correta em pedido supervisionado.
    JSON.stringify({ version: 1, settings: { serverUrl: '', downloadDir, autoAccept: false } }),
  );

  const proc = spawn(
    ELECTRON,
    [
      RAIZ,
      `--remote-debugging-port=${portaDebug}`,
      `--user-data-dir=${perfil}`,
      '--remote-allow-origins=*',
    ],
    { env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stderr.on('data', (d) => {
    const texto = d.toString();
    if (/Error|error|FALHA/.test(texto) && !/DevTools|Autofill|GPU|gpu_|dxdiag|Vulkan|servidor/.test(texto)) {
      console.log(`    [${nome}] ${texto.trim().split('\n')[0]}`);
    }
  });
  processos.push(proc);
  return proc;
}

async function principal() {
  // ── a malha: dois corretores independentes, nenhum servidor ──
  if (PELA_INTERNET) {
    console.log('  >> usando os corretores PUBLICOS embutidos no aplicativo');
  } else {
    corretores = [await iniciarCorretorLocal(), await iniciarCorretorLocal()];
    check('a malha de encontro está de pé', corretores.every((c) => c.url.startsWith('ws://')));
  }

  const perfilA = mkdtempSync(join(tmpdir(), 'ryke-anfitriao-'));
  const perfilB = mkdtempSync(join(tmpdir(), 'ryke-visitante-'));
  const recebidosAnfitriao = mkdtempSync(join(tmpdir(), 'ryke-recebe-a-'));
  const recebidosVisitante = mkdtempSync(join(tmpdir(), 'ryke-recebe-b-'));
  descartaveis.push(perfilA, perfilB, recebidosAnfitriao, recebidosVisitante);

  console.log('\nsubindo os dois computadores (sem servidor nenhum)…\n');
  lancarAplicativo('anfitriao', 9333, perfilA, recebidosAnfitriao);
  lancarAplicativo('visitante', 9334, perfilB, recebidosVisitante);

  const anfitriao = await Aba.abrir('anfitriao', 9333);
  const visitante = await Aba.abrir('visitante', 9334);
  await anfitriao.pronta();
  await visitante.pronta();

  // ── 1a. abre direto na tela principal ──
  //
  // Havia aqui duas perguntas obrigatórias — "este PC vai receber?" e "você vai
  // conectar?". Elas faziam sentido quando um dos lados hospedava um servidor;
  // sem servidor os dois papéis são a mesma coisa, e perguntar só atrasava.
  const abriuDireto = await anfitriao.esperar(`!!document.querySelector('.home')`, 20_000);
  check('o programa abre direto na tela principal, sem perguntas', abriuDireto === true);

  const semPerguntas = await anfitriao.avaliar(
    `!document.querySelector('.welcome') && !document.querySelector('.welcome-card')`,
  );
  check('a tela das duas perguntas não existe mais', semPerguntas === true);

  const semAvisoDeRedeLocal = await anfitriao.avaliar(
    `!document.body.textContent.includes('rede local') && !document.body.textContent.includes('mesma rede')`,
  );
  check('não há mais aviso de "modo rede local"', semAvisoDeRedeLocal === true);

  check('visitante também abre direto', (await visitante.esperar(`!!document.querySelector('.home')`, 20_000)) === true);

  // ── 1b. os dois recebem número ──
  const idAnfitriao = await anfitriao.esperar(
    `(() => { const e = document.querySelector('.my-id-value:not(.pending)'); return e ? e.textContent.replace(/\\D/g,'') : null; })()`,
  );
  const idVisitante = await visitante.esperar(
    `(() => { const e = document.querySelector('.my-id-value:not(.pending)'); return e ? e.textContent.replace(/\\D/g,'') : null; })()`,
  );

  check('anfitrião recebeu um número de 12 dígitos', /^\d{12}$/.test(idAnfitriao ?? ''), idAnfitriao ?? 'nenhum');
  check('visitante recebeu um número de 12 dígitos', /^\d{12}$/.test(idVisitante ?? ''), idVisitante ?? 'nenhum');
  check('os dois números são diferentes', idAnfitriao !== idVisitante);
  if (!idAnfitriao || !idVisitante) throw new Error('sem números, o resto do teste não faz sentido');

  // Os números foram sorteados pelas próprias máquinas — não há cartório para
  // distribuí-los. O que prova que os dois estão na MESMA malha é o tráfego
  // que passou pelos corretores.
  if (!PELA_INTERNET) {
    const trafego = corretores.reduce((soma, c) => soma + c.entregues, 0);
    check('os dois se anunciaram pelos corretores', trafego > 0, `${trafego} mensagens repassadas`);
    check('os dois corretores foram usados', corretores.every((c) => c.clientes >= 2),
      corretores.map((c) => `${c.clientes} clientes`).join(', '));
  }

  const semServidor = await anfitriao.avaliar(
    `(async () => (await window.ryke.role.status()).serverUrl === '')()`,
  );
  check('nenhum dos dois tem servidor configurado', semServidor === true);

  // O diagnóstico existe para que uma falha de conexão deixe de ser
  // adivinhação; se ele mesmo estiver mudo, não serve para nada.
  await anfitriao.avaliar(clicarTexto('Ajustes'));
  const pontos = await anfitriao.esperar(
    `(() => { const l = document.querySelectorAll('.ponto'); return l.length ? [...l].filter(p => p.classList.contains('on')).length : null; })()`,
    15_000,
  );
  check('a tela mostra os pontos de encontro alcançados', typeof pontos === 'number' && pontos >= 1,
    `${pontos} conectado(s)`);
  await anfitriao.avaliar(
    `(() => { const b = [...document.querySelectorAll('.overlay .btn')].find(x => /fechar|concluído|ok/i.test(x.textContent)); if (b) b.click(); else document.querySelector('.overlay')?.click(); return true; })()`,
  );
  await anfitriao.esperar(`!document.querySelector('.overlay')`, 8000);

  // ── 1c. o botão de conectar nunca fica mudo ──
  //
  // Regressão real: com o número digitado, o botão ficava apagado sem dizer
  // por quê — ou faltava dígito, ou este PC ainda não tinha entrado na malha.
  // Quem estava do outro lado não tinha como descobrir qual dos dois era.

  await visitante.avaliar(preencher('#peer-id', idAnfitriao.slice(0, 5)));
  const parcial = await visitante.avaliar(
    `(() => { const e = document.querySelector('.impedimento'); return e ? e.textContent.trim() : null; })()`,
  );
  check('número incompleto explica quantos dígitos faltam',
    typeof parcial === 'string' && /Faltam \d+/.test(parcial), parcial ?? 'nada na tela');

  await visitante.avaliar(preencher('#peer-id', idAnfitriao));
  const liberado = await visitante.esperar(
    `(() => { const b = [...document.querySelectorAll('.btn.primary.block')].find(x => /Pedir acesso|Conectar/.test(x.textContent)); return b ? !b.disabled : null; })()`,
    15_000,
  );
  check('com o número completo, o botão fica disponível', liberado === true);

  const semImpedimento = await visitante.avaliar(
    `!document.querySelector('.impedimento')`,
  );
  check('e não sobra nenhum impedimento na tela', semImpedimento === true);

  // ── 1d. favoritos: doze dígitos ninguém decora ──
  //
  // Antes, tanto o botão de favorito quanto a caixinha de guardar senha só
  // apareciam depois de a pessoa já ter digitado o número inteiro ou a senha.
  // O resultado prático foi que os dois recursos passaram despercebidos: quem
  // nunca chegou àquele ponto nunca soube que existiam.

  await visitante.avaliar(preencher('#peer-id', ''));
  const conviteVisivel = await visitante.avaliar(
    `(() => { const b = [...document.querySelectorAll('.link-acao')].find(x => /favoritos/i.test(x.textContent));
       return b ? { visivel: true, desligado: b.disabled } : { visivel: false }; })()`,
  );
  check('o botão de salvar favorito está à vista desde o começo',
    conviteVisivel.visivel === true && conviteVisivel.desligado === true,
    'visível e desligado, com o número ainda vazio');

  const caixinhaVisivel = await visitante.avaliar(
    `(() => { const c = document.querySelector('.caixinha');
       return c ? c.textContent.includes('Guardar a senha') : false; })()`,
  );
  check('e a caixinha de guardar a senha também', caixinhaVisivel === true);

  const caixinhaExplica = await visitante.avaliar(
    `(() => { const s = document.querySelector('.caixinha small'); return s ? s.textContent.trim() : ''; })()`,
  );
  check('dizendo o que falta para poder usá-la',
    /Digite a senha/i.test(String(caixinhaExplica)), String(caixinhaExplica).slice(0, 60));

  await visitante.avaliar(preencher('#peer-id', idAnfitriao));
  await visitante.avaliar(clicarTexto('Salvar nos favoritos'));
  await visitante.esperar(`!!document.querySelector('#fav-nome')`, 8000);
  await visitante.avaliar(preencher('#fav-nome', 'PC do Ceara'));
  await visitante.avaliar(
    `(() => { const b = document.querySelector('.salvar-favorito .input-with-action button'); b.click(); return true; })()`,
  );

  // O ATALHO. Favoritos e recentes saíram de dentro do cartão — cresciam sem
  // limite e obrigavam a rolar a tela inicial. O que ficou à vista é uma linha
  // de até quatro atalhos, de altura fixa; o resto mora no painel.
  const salvo = await visitante.esperar(
    `(() => { const e = document.querySelector('.atalho-nome'); return e ? e.textContent : null; })()`,
    8000,
  );
  check('favorito salvo aparece como atalho, com o nome escolhido', salvo === 'PC do Ceara', salvo ?? 'nenhum');

  // O PAINEL. É onde a lista inteira vive agora, com o número ao lado do nome
  // — e não escondido num `title`, que quem vai ditar o número por telefone
  // não descobre que existe.
  await visitante.avaliar(clicarTexto('Computadores salvos e recentes'));
  const noPainel = await visitante.esperar(
    `(() => {
       const linha = document.querySelector('.painel-lista .pc-linha');
       if (!linha) return null;
       const nome = linha.querySelector('.pc-nome');
       const num = linha.querySelector('.pc-numero');
       return { nome: nome ? nome.textContent : null, num: num ? num.textContent.replace(/[^0-9]/g, '') : null };
     })()`,
    8000,
  );
  check('o painel lista o computador salvo', noPainel && noPainel.nome === 'PC do Ceara',
    noPainel ? String(noPainel.nome) : 'painel vazio');
  check('e mostra o número junto do nome', noPainel && noPainel.num === idAnfitriao,
    noPainel ? String(noPainel.num) : 'nenhum');

  // As três abas existem e contam o que têm. Sem isso o painel seria uma lista
  // só, e "quais eu guardei", "para onde eu fui" e "quem veio até mim" são
  // perguntas diferentes.
  const abas = await visitante.avaliar(
    `[...document.querySelectorAll('.painel-aba')].map(b => b.textContent.trim())`,
  );
  check('o painel tem as três listas separadas', Array.isArray(abas) && abas.length === 3, String(abas));

  await visitante.avaliar(clicarTexto('Fechar'));
  await visitante.esperar(`!document.querySelector('.painel-pcs')`, 8000);

  // Salvar de novo o mesmo número renomeia, e não duplica: duas linhas com o
  // mesmo número seriam um convite ao engano na hora de escolher.
  await visitante.avaliar(preencher('#peer-id', idAnfitriao));
  await visitante.avaliar(clicarTexto('Renomear'));
  await visitante.esperar(`!!document.querySelector('#fav-nome')`, 8000);
  await visitante.avaliar(preencher('#fav-nome', 'Servidor da loja'));
  await visitante.avaliar(
    `(() => { document.querySelector('.salvar-favorito .input-with-action button').click(); return true; })()`,
  );
  const renomeado = await visitante.esperar(
    `(() => { const l = document.querySelectorAll('.atalho-nome'); return l.length === 1 ? l[0].textContent : 'duplicou:' + l.length; })()`,
    8000,
  );
  check('renomear não duplica o favorito', renomeado === 'Servidor da loja', String(renomeado));

  // Sobrevive a fechar e reabrir? Favorito guardado em memória não serve.
  const persistido = await visitante.avaliar(
    `(async () => { const l = await window.ryke.favorites.list(); return l.length === 1 && l[0].nome === 'Servidor da loja' && l[0].numero === '${idAnfitriao}'; })()`,
  );
  check('o favorito está gravado no disco, não só na tela', persistido === true);

  // Informar uma senha quando o anfitrião ainda não definiu nenhuma jamais
  // pode virar pedido supervisionado. Ou autentica, ou falha claramente.
  await visitante.avaliar(preencher('#peer-id', idAnfitriao));
  await visitante.avaliar(preencher('#peer-password', 'senha-que-nao-existe'));
  await visitante.avaliar(clicarTexto('Conectar'));
  const avisouSenhaNaoDefinida = await visitante.esperar(
    `[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('não definiu uma senha'))`,
    20_000,
  );
  check('tentativa com senha não vira pedido se o anfitrião não definiu senha', avisouSenhaNaoDefinida === true);
  const naoPediuAprovacao = await anfitriao.avaliar(
    `![...document.querySelectorAll('.modal')].some(m => m.textContent.includes('Pedido de acesso'))`,
  );
  check('e nenhuma janela de aprovação aparece no anfitrião', naoPediuAprovacao === true);
  await dorme(500);

  // ══════════════ ACESSO SUPERVISIONADO (sem senha) ══════════════
  //
  // Neste ponto o anfitrião ainda não tem senha nenhuma. O visitante digita
  // só o número: a decisão tem de cair no colo de quem está no outro lado.

  // ── 2. pedido recusado ──
  await visitante.avaliar(preencher('#peer-id', idAnfitriao));
  await visitante.avaliar(preencher('#peer-password', ''));
  await visitante.avaliar(clicarTexto('Pedir acesso'));

  const avisouEspera = await visitante.esperar(
    `(() => { const e = document.querySelector('.dialing-phase'); return !!e && e.textContent.includes('permitir'); })()`,
    20_000,
  );
  check('visitante é avisado de que depende de alguém autorizar', avisouEspera === true);

  const pedidoNaTela = await anfitriao.esperar(
    `(() => { const m = document.querySelector('.modal'); return !!m && m.textContent.includes('Pedido de acesso'); })()`,
    20_000,
  );
  check('pedido aparece na tela do anfitrião', pedidoNaTela === true);

  const alertaSemSenha = await anfitriao.avaliar(
    `(() => { const a = document.querySelector('.aviso-forte'); return !!a && a.textContent.includes('sem senha'); })()`,
  );
  check('anfitrião é avisado de que o pedido chegou sem senha', alertaSemSenha === true);

  await anfitriao.avaliar(clicarTexto('Recusar'));
  const recusaChegou = await visitante.esperar(
    `[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('recusou'))`,
    20_000,
  );
  check('recusa do anfitrião chega ao visitante', recusaChegou === true);
  check('nenhum vídeo após recusa', (await visitante.avaliar(`!document.querySelector('video')`)) === true);

  await dorme(800);

  // ── 3. pedido autorizado ──
  // Alguns drivers recusam a primeira chamada de captura logo depois do
  // clique. Simulamos a falha nas duas APIs para provar que o anfitrião tenta
  // de novo em vez de aceitar e encerrar a sessão imediatamente.
  await anfitriao.avaliar(
    `(() => {
      const media = navigator.mediaDevices;
      const display = media.getDisplayMedia.bind(media);
      const user = media.getUserMedia.bind(media);
      // Alto o bastante para as duas APIs continuarem recusando durante todas
      // as tentativas: a sessão só abrirá se a rota de quadros por software
      // realmente estiver funcionando.
      window.__rykeCaptureTest = { display: 100, user: 100 };
      Object.defineProperty(media, 'getDisplayMedia', { configurable: true, value: (...args) => {
        if (window.__rykeCaptureTest.display-- > 0) return Promise.reject(new DOMException('falha simulada', 'NotReadableError'));
        return display(...args);
      }});
      Object.defineProperty(media, 'getUserMedia', { configurable: true, value: (...args) => {
        if (window.__rykeCaptureTest.user-- > 0) return Promise.reject(new DOMException('falha simulada', 'NotReadableError'));
        return user(...args);
      }});
      return true;
    })()`,
  );
  await visitante.avaliar(preencher('#peer-id', idAnfitriao));
  await visitante.avaliar(preencher('#peer-password', ''));
  await visitante.avaliar(clicarTexto('Pedir acesso'));
  await anfitriao.esperar(`!!document.querySelector('.modal')`, 20_000);
  await anfitriao.avaliar(clicarTexto('Permitir acesso'));

  const videoSupervisionado = await visitante.esperar(
    `(() => { const v = document.querySelector('video'); return !!(v && v.videoWidth > 0 && !v.paused); })()`,
    60_000,
  );
  check('autorização abre a sessão, sem senha nenhuma', videoSupervisionado === true);
  check('a captura por software abre a sessão mesmo com as duas APIs de mídia bloqueadas',
    (await anfitriao.avaliar(`window.__rykeCaptureTest.display <= 97 && window.__rykeCaptureTest.user <= 97`)) === true);
  // O restante da suíte volta a exercitar a rota rápida normal.
  await anfitriao.avaliar(`(() => { window.__rykeCaptureTest.display = 0; window.__rykeCaptureTest.user = 0; return true; })()`);

  // Encerra para deixar o anfitrião livre para o teste com senha.
  await visitante.avaliar(clicarTexto('Encerrar'));
  await visitante.esperar(`!document.querySelector('video')`, 20_000);
  await anfitriao.esperar(`!document.body.textContent.includes('Em sessão com')`, 20_000);
  await dorme(1200);

  // ══════════════ ACESSO NÃO SUPERVISIONADO (com senha) ══════════════

  // ── 4. senha no anfitrião ──
  await anfitriao.avaliar(clicarTexto('Com senha'));
  await dorme(400);
  await anfitriao.avaliar(preencher('#nova-senha', SENHA));
  await anfitriao.avaliar(preencher('#repetir-senha', SENHA));
  // Por seletor: "Salvar" também aparece no botão de favoritos da tela de
  // trás, e clicar pelo texto pegava aquele em vez deste.
  await anfitriao.avaliar(clicarSeletor('.modal-actions .btn.primary'));
  const senhaDefinida = await anfitriao.esperar(
    `[...document.querySelectorAll('button')].some(b => b.textContent.includes('definida'))`,
  );
  check('senha gravada no anfitrião', senhaDefinida === true);

  // ── 5. tentativa com a senha errada deve ser barrada ──
  await visitante.avaliar(preencher('#peer-id', idAnfitriao));
  await visitante.avaliar(preencher('#peer-password', 'senha-completamente-errada'));
  await visitante.avaliar(clicarTexto('Conectar'));
  const recusou = await visitante.esperar(
    `[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Senha incorreta'))`,
    20_000,
  );
  check('senha errada é recusada', recusou === true);
  check('nenhum vídeo aparece após senha errada', (await visitante.avaliar(`!document.querySelector('video')`)) === true);

  await dorme(800);

  // ── 6. conexão com a senha correta, sem ninguém aprovar nada ──
  await visitante.avaliar(preencher('#peer-id', idAnfitriao));
  await visitante.avaliar(preencher('#peer-password', SENHA));
  await visitante.avaliar(clicarTexto('Conectar'));

  check(
    'com senha, nenhum pedido de autorização aparece no anfitrião',
    (await anfitriao.avaliar(`!document.querySelector('.modal')`)) === true,
  );

  const temVideo = await visitante.esperar(
    `(() => { const v = document.querySelector('video'); return !!(v && v.videoWidth > 0 && !v.paused); })()`,
    60_000,
  );
  check('a tela do anfitrião chegou ao visitante', temVideo === true);

  if (temVideo === true) {
    const dim = await visitante.avaliar(
      `(() => { const v = document.querySelector('video'); return v.videoWidth + 'x' + v.videoHeight; })()`,
    );
    check('resolução recebida é plausível', /^\d{3,5}x\d{3,5}$/.test(dim), dim);

    // A imagem precisa estar mudando, não congelada num quadro só.
    const quadros1 = await visitante.avaliar(`document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames`);
    await dorme(2500);
    const quadros2 = await visitante.avaliar(`document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames`);
    check('o vídeo está correndo, não parado', quadros2 > quadros1, `${quadros1} → ${quadros2} quadros`);

    // ── 5. canal de controle e estatísticas ──
    const stats = await visitante.esperar(
      `(() => { const e = document.querySelector('.tool-stats'); return e ? e.textContent : null; })()`,
      20_000,
    );
    check('barra mostra as estatísticas da sessão', typeof stats === 'string' && stats.length > 0, String(stats).trim());

    // O seletor fica sempre no topo, inclusive com uma única tela: assim ele
    // aparece automaticamente se o anfitrião conectar outra durante a sessão.
    await visitante.avaliar(clicarTexto('Telas'));
    const telasNoMenu = await visitante.esperar(
      `(() => { const m = document.querySelector('.tool-menu .menu');
        return m ? [...m.querySelectorAll('.menu-item')].map(x => x.textContent.trim()) : null; })()`,
      10_000,
    );
    check('a barra superior tem o botão Telas', Array.isArray(telasNoMenu) && telasNoMenu.length >= 1);
    check('o menu identifica a tela disponível',
      Array.isArray(telasNoMenu) && telasNoMenu.some((nome) => nome.includes('Tela 1')),
      JSON.stringify(telasNoMenu));

    // Selecionar até a tela atual força a mesma rota usada para Tela 2/3/4:
    // nova captura + replaceTrack, sem refazer a conexão.
    const antesDaTroca = await visitante.avaliar(
      `document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames`,
    );
    // A área protegida do UAC esconde temporariamente todas as fontes. Dez
    // recusas seguidas reproduzem esse intervalo; a conexão precisa ficar de
    // pé e recuperar a imagem quando o desktop normal voltar.
    await anfitriao.avaliar(
      `(() => { window.__rykeCaptureTest.display = 5; window.__rykeCaptureTest.user = 5; return true; })()`,
    );
    await visitante.avaliar(clicarSeletor('.tool-menu .menu .menu-item.active'));
    await dorme(10_000);
    const depoisDaTroca = await visitante.avaliar(
      `document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames`,
    );
    check('captura temporariamente bloqueada não encerra a conexão e volta sozinha',
      depoisDaTroca > antesDaTroca && (await visitante.avaliar(`!!document.querySelector('video')`)) === true,
      `${antesDaTroca} → ${depoisDaTroca} quadros`);

    // Mantemos a rota reserva até o teste dos botões de qualidade: é nela que
    // Baixa/Média/Alta antes mudavam só o rótulo, sem mudar a imagem.
    const botaoInstalar = await visitante.avaliar(
      `[...document.querySelectorAll('.toolbar .tool')].some(b => b.textContent.trim() === 'Instalar')`,
    );
    check('a barra oferece iniciar instaladores no remoto como administrador', botaoInstalar === true);

    // ── captura total do teclado ──
    //
    // Sem ela, Ctrl+Shift+Esc abria o Gerenciador de Tarefas de quem estava
    // controlando, e não do computador controlado — o Windows consome essas
    // combinações antes de qualquer aplicativo enxergar.
    const rotuloTeclas = await visitante.esperar(
      `(() => { const b = [...document.querySelectorAll('.tool')].find(x => /^Teclas:/.test(x.textContent.trim()));
         return b ? b.textContent.trim() : null; })()`,
      10_000,
    );
    check('a barra diz para onde as teclas estão indo', rotuloTeclas === 'Teclas: todas lá',
      String(rotuloTeclas));

    // Ícone sozinho não explica nada, e estes dois botões mexem em coisa séria:
    // um tranca o teclado de quem está do outro lado, o outro tira os atalhos
    // deste computador.
    const dicas = await visitante.avaliar(
      `[...document.querySelectorAll('.tool[data-dica]')].map(b => b.getAttribute('data-dica').length)`,
    );
    check('os botões da barra explicam o que fazem ao passar o mouse',
      Array.isArray(dicas) && dicas.length >= 3 && dicas.every((n) => n > 40),
      `${Array.isArray(dicas) ? dicas.length : 0} botões com explicação`);

    // ── a barra não pode roubar o alto da tela remota ──
    //
    // Ela abria com o cursor a menos de 70px do topo. Só que 70px do alto de um
    // computador é onde ficam as guias do navegador, a barra de título de toda
    // janela e o menu de todo programa: ir clicar numa guia do Chrome do outro
    // lado fazia a barra saltar na frente e receber o clique.
    // O cursor DE VERDADE é movido junto com o evento: ao abrir, a barra muda
    // o que está sob o ponteiro, e o Chromium dispara em seguida um evento com
    // a posição real do mouse. Se os dois discordarem, a barra abre e fecha no
    // mesmo instante — e o teste acusa um defeito que não existe.
    const centroX = await visitante.avaliar(
      `(() => { const r = document.querySelector('video').getBoundingClientRect();
         return Math.round(r.left + r.width / 2); })()`,
    );
    const moverPara = (y) => `(() => {
         const v = document.querySelector('video');
         v.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse',
           isPrimary: true, bubbles: true, cancelable: true,
           clientX: ${centroX}, clientY: ${y}, screenY: ${y} }));
         return true;
       })()`;
    const barraEscondida = `(() => { const b = document.querySelector('.toolbar');
         return b ? b.className.includes('hidden') : null; })()`;
    const irAte = async (y) => {
      SetCursorPos(centroX, y);
      await dorme(150);
      await visitante.avaliar(moverPara(y));
      await dorme(200);
    };

    await irAte(400);
    check('a barra some quando o cursor está no meio da tela',
      (await visitante.avaliar(barraEscondida)) === true);

    // O cenário do usuário: mirar uma guia do navegador remoto, a poucos
    // pixels do alto, sem que a barra apareça na frente.
    for (const y of [12, 28, 45, 60]) await irAte(y);
    check('passar pelas guias do navegador remoto NÃO abre a barra',
      (await visitante.avaliar(barraEscondida)) === true,
      'testado a 12, 28, 45 e 60 pixels do topo');

    await irAte(0);
    check('encostar no topo abre a barra', (await visitante.avaliar(barraEscondida)) === false);

    // E depois de aberta, descer até os botões dela não pode fazê-la fugir.
    await irAte(30);
    check('e ela continua aberta enquanto o cursor está na área dela',
      (await visitante.avaliar(barraEscondida)) === false);

    await irAte(400);
    check('sair da área dela fecha de novo', (await visitante.avaliar(barraEscondida)) === true);

    const cadeado = await visitante.avaliar(
      `(() => { const b = [...document.querySelectorAll('.tool')].find(x => /Travar lá|Travado/.test(x.textContent));
         return b ? b.getAttribute('data-dica') : null; })()`,
    );
    check('o cadeado diz que trava o teclado físico do outro computador',
      typeof cadeado === 'string' && /f[íi]sic/i.test(cadeado), String(cadeado).slice(0, 60));

    const direto = await visitante.avaliar(
      `(() => { const e = document.querySelector('.tool-stats'); return e && e.textContent.includes('direto'); })()`,
    );
    // ── qualidade automática e atraso ──
  //
  // O buffer de reprodução do navegador é o maior responsável pelo atraso
  // sentido: ele guarda quadros para reproduzir liso, o que faz sentido para
  // assistir a um vídeo e atrapalha quando se está mexendo o mouse.

  const atrasoImagem = await visitante.esperar(
    `(() => { const m = document.body.textContent.match(/([0-9]+) ms img/); return m ? Number(m[1]) : null; })()`,
    20_000,
  );
  check('a barra mostra o atraso real da imagem', typeof atrasoImagem === 'number',
    atrasoImagem === null ? 'não apareceu' : `${atrasoImagem} ms`);
  check('e o atraso está baixo numa rede boa', typeof atrasoImagem === 'number' && atrasoImagem < 300,
    `${atrasoImagem} ms`);

  // Nada de espiar objetos internos do aplicativo: o que prova que o buffer
  // foi encurtado é o próprio atraso medido ficar baixo. Sem o ajuste, o
  // navegador acumula tipicamente mais de 100 ms só de espera.

  // Duas leituras seguidas: o atraso instantâneo precisa se manter baixo, e
  // não só ter passado baixo por acaso numa amostra.
  //
  // A segunda leitura ESPERA em vez de fotografar. O atraso instantâneo é
  // calculado sobre os quadros emitidos desde a medida anterior, e uma tela
  // parada não emite quadro nenhum — o número simplesmente some da barra até
  // algo se mexer do outro lado. Fotografar num instante qualquer testava, na
  // prática, se por acaso havia movimento na tela do anfitrião naquele
  // segundo, o que não é o que esta verificação existe para provar. Isso
  // ficou visível quando o mouse do visitante deixou de arrastar o cursor do
  // anfitrião: sumiu a fonte acidental de movimento que mantinha a medida viva.
  await new Promise((r) => setTimeout(r, 2500));
  const atrasoDepois = await visitante.esperar(
    `(() => { const m = document.body.textContent.match(/([0-9]+) ms img/); return m ? Number(m[1]) : null; })()`,
    20_000,
  );
  check('e continua baixo na medida seguinte', typeof atrasoDepois === 'number' && atrasoDepois < 300,
    `${atrasoDepois} ms`);

  // ── escolha de qualidade, com a trava de segurança do "Alta" ──
  //
  // "Alta" é a única opção que pode piorar a sessão: numa rede que não
  // sustenta, ela enche a fila e a imagem passa a chegar segundos atrasada —
  // e aí o usuário não consegue nem clicar para desfazer. Por isso ela
  // pergunta e se desfaz sozinha, como o Windows faz ao trocar a resolução.

  // Clicar NUNCA pode acontecer dentro de `esperar`: ele repete a expressão
  // até dar certo, e um clique repetido abre e fecha o menu alternadamente —
  // o estado final vira sorteio. Clique é ação única; espera é só leitura.
  const abrirMenuImagem = async () => {
    await visitante.avaliar(
      `(() => { const b = [...document.querySelectorAll('.tool')].find(x => /Imagem/.test(x.textContent)); if (b) b.click(); return !!b; })()`,
    );
    return visitante.esperar(`document.querySelectorAll('.menu-item').length > 0`, 8000);
  };
  const escolherQualidade = (nome) =>
    visitante.avaliar(
      `(() => { const b = [...document.querySelectorAll('.menu-item')].find(x => x.textContent.startsWith('${nome}')); if (b) b.click(); return !!b; })()`,
    );
  const qualidadeAtiva = () =>
    visitante.avaliar(
      `(() => { const a = document.querySelector('.menu-item.active'); return a ? a.childNodes[0].textContent.trim() : null; })()`,
    );

  await abrirMenuImagem();
  const opcoes = await visitante.avaliar(
    `[...document.querySelectorAll('.menu-item')].map(x => x.childNodes[0].textContent.trim()).join(',')`,
  );
  check('as quatro qualidades estão na tela',
    typeof opcoes === 'string' && ['Automática', 'Alta', 'Média', 'Baixa'].every((q) => opcoes.includes(q)),
    String(opcoes));

  check('a automática vem selecionada por padrão', (await qualidadeAtiva()) === 'Automática',
    String(await qualidadeAtiva()));

  check('clique em Baixa registrado', (await escolherQualidade('Baixa')) === true);
  await dorme(2500);
  const fonteBaixa = await anfitriao.avaliar(`window.ryke.screen.captureStatus()`);
  const semAviso = await visitante.avaliar(`!document.querySelector('.confirma-qualidade')`);
  check('escolher Baixa não pede confirmação', semAviso === true);

  await abrirMenuImagem();
  check('Baixa ficou selecionada', (await qualidadeAtiva()) === 'Baixa', String(await qualidadeAtiva()));

  // Agora a alta: é a única que pergunta antes de ficar.
  check('clique em Alta registrado', (await escolherQualidade('Alta')) === true);
  const contagem = await visitante.esperar(
    `(() => { const e = document.querySelector('.confirma-qualidade b'); return e ? Number(e.textContent.replace(/[^0-9]/g,'')) : null; })()`,
    8000,
  );
  check('escolher Alta pede confirmação com contagem', typeof contagem === 'number' && contagem > 0,
    `${contagem}s`);

  await dorme(3000);
  const fonteAlta = await anfitriao.avaliar(`window.ryke.screen.captureStatus()`);
  check('Alta muda de fato a fonte reserva para imagem sem perdas',
    fonteBaixa?.mime === 'image/jpeg' && fonteAlta?.mime === 'image/png' && fonteAlta?.lossless === true,
    `${fonteBaixa?.mime ?? 'nenhuma'} → ${fonteAlta?.mime ?? 'nenhuma'}`);
  const contagemDepois = await visitante.avaliar(
    `(() => { const e = document.querySelector('.confirma-qualidade b'); return e ? Number(e.textContent.replace(/[^0-9]/g,'')) : null; })()`,
  );
  check('a contagem regressiva anda sozinha', typeof contagemDepois === 'number' && contagemDepois < contagem,
    `${contagem}s → ${contagemDepois}s`);

  await visitante.avaliar(
    `(() => { const b = [...document.querySelectorAll('.confirma-qualidade .btn')].find(x => /manter/i.test(x.textContent)); if (b) b.click(); return !!b; })()`,
  );
  const sumiu = await visitante.esperar(`!document.querySelector('.confirma-qualidade')`, 8000);
  check('clicar em OK faz o aviso sumir', sumiu === true);

  await abrirMenuImagem();
  check('e a qualidade alta permanece', (await qualidadeAtiva()) === 'Alta', String(await qualidadeAtiva()));

  // ── a trava de verdade: ninguém confirma, e ela se desfaz sozinha ──
  //
  // Este é o caso que a proteção existe para cobrir. Se a rede não sustenta a
  // qualidade alta, a imagem passa a chegar tão atrasada que o usuário não
  // consegue clicar em nada — nem para desfazer. Ele precisa poder apenas
  // esperar. Vale os 20 segundos que este trecho leva.

  await escolherQualidade('Média');
  await dorme(600);
  await abrirMenuImagem();
  check('voltou para Média antes do teste da reversão', (await qualidadeAtiva()) === 'Média',
    String(await qualidadeAtiva()));

  await escolherQualidade('Alta');
  await visitante.esperar(`!!document.querySelector('.confirma-qualidade')`, 8000);

  const revertida = await visitante.esperar(`!document.querySelector('.confirma-qualidade')`, 26_000);
  check('sem confirmação, o aviso some sozinho no fim do prazo', revertida === true);

  await abrirMenuImagem();
  const depoisDaReversao = await qualidadeAtiva();
  check('e a qualidade volta ao que era antes, sem o usuário fazer nada',
    depoisDaReversao === 'Média', String(depoisDaReversao));

  // Volta para automática, que é o padrão do produto.
  await escolherQualidade('Automática');
  await dorme(600);

  // Volta à captura nativa para o restante da suíte também continuar cobrindo
  // o caminho de alto desempenho.
  await anfitriao.avaliar(
    `(() => { window.__rykeCaptureTest.display = 0; window.__rykeCaptureTest.user = 0; return true; })()`,
  );
  await visitante.avaliar(clicarTexto('Telas'));
  await visitante.avaliar(clicarSeletor('.tool-menu .menu .menu-item.active'));
  await dorme(3500);

  check('caminho estabelecido é direto (P2P, sem retransmissão)', direto === true);

    // ── 6. área de transferência atravessa a sessão ──
    const marca = `ryke-clipboard-${randomBytes(4).toString('hex')}`;
    await anfitriao.avaliar(`window.ryke.clipboard.write(${JSON.stringify(marca)})`);
    const clipboardChegou = await visitante.esperar(
      `window.ryke.clipboard.read().then(t => t === ${JSON.stringify(marca)})`,
      15_000,
    );
    check('texto copiado no anfitrião aparece no visitante', clipboardChegou === true);

    // ── 7. a seta do visitante NÃO rouba o cursor do anfitrião ──
    //
    // Este é o contrato que mudou, e é o coração do recurso: mexer o mouse do
    // visitante move a SETA VIRTUAL dele, não o ponteiro do Windows do outro
    // lado. O ponteiro real continua de quem está sentado lá — é isso que
    // permite duas pessoas trabalharem na mesma tela ao mesmo tempo.
    //
    // Só o clique é exceção, e é uma exceção física: o Windows entrega o
    // clique a quem estiver embaixo do ponteiro. Então o cursor é pego
    // emprestado pelo instante do clique e devolvido em seguida.
    const cursorOriginal = posicaoDoCursor();
    // Resolução física real do monitor capturado, direto do anfitrião: é
    // contra ela que a fração enviada deve ser convertida.
    const telaAnfitriao = await anfitriao.avaliar('window.ryke.screen.active()');

    /** Dispara um evento de ponteiro de verdade sobre o vídeo do visitante. */
    async function eventoNoVideo(tipo, fx, fy, extra = '') {
      await visitante.avaliar(`(() => {
        const v = document.querySelector('video');
        const r = v.getBoundingClientRect();
        const escala = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        const largura = v.videoWidth * escala, altura = v.videoHeight * escala;
        const ox = r.left + (r.width - largura) / 2, oy = r.top + (r.height - altura) / 2;
        v.dispatchEvent(new PointerEvent('${tipo}', {
          clientX: ox + ${fx} * largura, clientY: oy + ${fy} * altura,
          bubbles: true, pointerId: 1, isPrimary: true${extra},
        }));
        return true;
      })()`);
    }

    // O canto é o lugar seguro para estacionar: é o ponto em que qualquer
    // realimentação se aquieta, porque a fração ali é zero.
    const ESTACIONA = { x: 1, y: 1 };
    const perto = (p, x, y, folga = 4) => Math.abs(p.x - x) <= folga && Math.abs(p.y - y) <= folga;

    /**
     * Tem gente mexendo no mouse desta máquina agora?
     *
     * Esta seção mede onde o ponteiro do Windows está, e o Windows tem um
     * ponteiro só — o mesmo que a pessoa sentada aqui usa. Se alguém encostar
     * no mouse durante a medição, o teste acusa um defeito que não existe, e
     * pior: acusa exatamente o comportamento que o programa tem DE PROPÓSITO,
     * que é devolver o ponteiro a quem está com a mão nele.
     *
     * Então perguntamos antes: estaciona o cursor e observa se ele anda
     * sozinho, sem nenhum evento sintético em jogo. Se andar, a medição não
     * vale — e dizer isso é honesto, enquanto marcar falha seria mentira.
     */
    async function mouseHumanoAtivo() {
      SetCursorPos(ESTACIONA.x, ESTACIONA.y);
      await dorme(120);
      for (let i = 0; i < 8; i++) {
        await dorme(50);
        if (!perto(posicaoDoCursor(), ESTACIONA.x, ESTACIONA.y, 2)) return true;
      }
      return false;
    }

    if (await mouseHumanoAtivo()) {
      console.log('  --   ponteiro: pulado, o mouse desta máquina está sendo usado agora');
      console.log('       (esta seção mede o cursor do Windows, que é o mesmo que a sua mão move)');
    } else {

    async function aSetaNaoPuxaOCursor(fx, fy) {
      SetCursorPos(ESTACIONA.x, ESTACIONA.y);
      await dorme(320);
      // Várias vezes, e não uma: o envio é agrupado por quadro, e queremos
      // provar que nem uma rajada inteira de movimento move o cursor de lá.
      for (let i = 0; i < 5; i++) {
        await eventoNoVideo('pointermove', fx, fy);
        await dorme(90);
      }
      await dorme(500);
      const onde = posicaoDoCursor();
      check(
        `mover a seta para ${fx}/${fy} NÃO mexe no cursor do anfitrião`,
        perto(onde, ESTACIONA.x, ESTACIONA.y),
        `cursor em ${onde.x},${onde.y} — deveria ter ficado em ${ESTACIONA.x},${ESTACIONA.y}`,
      );
    }

    await aSetaNaoPuxaOCursor(0.25, 0.75);
    await aSetaNaoPuxaOCursor(0.8, 0.2);

    /**
     * O clique: pega emprestado, clica, devolve.
     *
     * A amostragem do "chegou lá" é rápida de propósito. Este teste roda as
     * duas pontas na MESMA tela, então o SendInput do anfitrião joga o
     * ponteiro físico em cima da janela do visitante — e, com o botão
     * apertado, aquilo vira um arrasto de verdade que continua mexendo o
     * cursor. Na prática isso não existe (são dois computadores, e a interface
     * impede conectar-se ao próprio número); aqui basta flagrar o instante em
     * que o ponteiro passou pelo alvo.
     */
    async function oCliqueEmprestaEDevolve(fx, fy) {
      const alvoX = Math.round(fx * (telaAnfitriao.width - 1));
      const alvoY = Math.round(fy * (telaAnfitriao.height - 1));

      let emprestou = false;
      let ultima = posicaoDoCursor();

      for (let tentativa = 0; tentativa < 6 && !emprestou; tentativa++) {
        SetCursorPos(ESTACIONA.x, ESTACIONA.y);
        await dorme(320);

        await eventoNoVideo('pointerdown', fx, fy, ', button: 0, buttons: 1');
        for (let i = 0; i < 60 && !emprestou; i++) {
          ultima = posicaoDoCursor();
          if (perto(ultima, alvoX, alvoY)) emprestou = true;
          else await dorme(12);
        }
        await eventoNoVideo('pointerup', fx, fy, ', button: 0, buttons: 0');
        await dorme(200);
      }

      check(
        `clicar em ${fx}/${fy} leva o cursor do anfitrião até lá`,
        emprestou,
        `esperado ~${alvoX},${alvoY} · obtido ${ultima.x},${ultima.y}`,
      );

      // E devolve. Sem isto o "empréstimo" seria só o comportamento antigo com
      // outro nome: o cursor ficaria onde o visitante clicou por último, longe
      // de onde o dono da máquina o tinha deixado.
      let voltou = false;
      for (let i = 0; i < 60 && !voltou; i++) {
        if (perto(posicaoDoCursor(), ESTACIONA.x, ESTACIONA.y, 6)) voltou = true;
        else await dorme(25);
      }
      const fim = posicaoDoCursor();
      check(
        'e devolve o cursor para onde ele estava antes do clique',
        voltou,
        `cursor em ${fim.x},${fim.y} — deveria ter voltado para ${ESTACIONA.x},${ESTACIONA.y}`,
      );
    }

    await oCliqueEmprestaEDevolve(0.25, 0.75);

    SetCursorPos(cursorOriginal.x, cursorOriginal.y);

    }

    // ── 8. o teclado do visitante pressiona a tecla real no anfitrião ──
    //
    // Shift é a cobaia ideal: sozinha não produz nada nem dispara atalho, e o
    // Windows expõe o estado físico dela para conferirmos.
    check('Shift começa solto no anfitrião', !teclaPressionada(VK_LSHIFT));

    /** Repete o evento até o Windows do anfitrião refletir o estado esperado. */
    async function mandarTecla(tipo, esperadoPressionada, prazoMs = 6000) {
      const limite = Date.now() + prazoMs;
      let estado = teclaPressionada(VK_LSHIFT);
      while (Date.now() < limite && estado !== esperadoPressionada) {
        await visitante.avaliar(
          `window.dispatchEvent(new KeyboardEvent('${tipo}', { code: 'ShiftLeft', key: 'Shift', bubbles: true })), true`,
        );
        await dorme(300);
        estado = teclaPressionada(VK_LSHIFT);
      }
      return estado;
    }

    check('Shift pressionado no visitante desce a tecla no anfitrião', (await mandarTecla('keydown', true)) === true);
    check('soltar no visitante solta a tecla no anfitrião', (await mandarTecla('keyup', false)) === false);

    // ── 9. transferência de arquivo, pelo mesmo caminho de um arrastar-soltar ──
    //
    // O conteúdo é gerado dentro da própria página (uma sequência previsível)
    // para não ter que empurrar 3 MB pelo protocolo de depuração; aqui fora
    // recalculamos a mesma sequência para conferir byte a byte o que chegou.
    const TAMANHO = 3 * 1024 * 1024;
    const NOME_ARQUIVO = `teste-ryke-${randomBytes(3).toString('hex')}.bin`;

    const soltou = await visitante.avaliar(`(() => {
      const tamanho = ${TAMANHO};
      const bytes = new Uint8Array(tamanho);
      for (let i = 0; i < tamanho; i++) bytes[i] = (i * 31 + 7) & 0xff;
      const arquivo = new File([bytes], ${JSON.stringify(NOME_ARQUIVO)});
      const dt = new DataTransfer();
      dt.items.add(arquivo);
      const alvo = document.querySelector('.viewer');
      alvo.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return arquivo.size;
    })()`);
    check('arquivo solto sobre a janela do visitante', soltou === TAMANHO, `${soltou} bytes`);

    const concluiu = await visitante.esperar(
      `[...document.querySelectorAll('.transfer-meta')].some(e => e.textContent.includes('Concluído'))`,
      90_000,
    );
    check('visitante marca a transferência como concluída', concluiu === true);

    // A prova final está no disco do anfitrião, não na interface.
    const recebido = join(recebidosAnfitriao, NOME_ARQUIVO);
    check('arquivo existe na pasta de recebidos do anfitrião', existsSync(recebido), recebido);

    if (existsSync(recebido)) {
      const dados = readFileSync(recebido);
      const esperado = Buffer.alloc(TAMANHO);
      for (let i = 0; i < TAMANHO; i++) esperado[i] = (i * 31 + 7) & 0xff;
      check('arquivo tem o tamanho certo', dados.length === TAMANHO, `${dados.length} de ${TAMANHO}`);
      check('conteúdo chegou byte a byte idêntico', dados.equals(esperado));
    }

    // ── 9b. copiar aqui, colar numa pasta de lá ──
    //
    // O defeito: o arquivo atravessava e ia parar na pasta de recebidos, mas o
    // Ctrl+V numa pasta do computador remoto não fazia nada — a área de
    // transferência de lá continuava vazia. Aqui o teste faz o percurso
    // inteiro: põe um arquivo na área de transferência do Windows (como um
    // Ctrl+C no Explorador), deixa o envio automático agir e confere que a
    // área de transferência do outro lado passou a oferecer o arquivo gravado.
    const NOME_COLA = `cola-ryke-${randomBytes(3).toString('hex')}.txt`;
    const origemCola = join(recebidosVisitante, NOME_COLA);
    writeFileSync(origemCola, 'conteudo de teste para colagem\n');

    // Copiamos várias vezes de propósito. Os dois computadores do teste são o
    // mesmo, e portanto dividem UMA área de transferência: o espelhamento de
    // texto entre eles reescreve a área e apaga o arquivo que acabou de ser
    // copiado. Em uso real são máquinas distintas e isso não acontece.
    copiarArquivos([origemCola]);

    const chegouCola = join(recebidosAnfitriao, NOME_COLA);
    let esperas = 0;
    while (!existsSync(chegouCola) && esperas < 60) {
      await dorme(500);
      esperas++;
    }
    check('copiar um arquivo aqui dispara o envio automaticamente', existsSync(chegouCola));
    check('o arquivo copiado chega ao outro computador', existsSync(chegouCola), chegouCola);

    // A prova é a área de transferência do Windows: é dela que o Explorador
    // tira o arquivo ao colar.
    let naArea = null;
    for (let i = 0; i < 20 && naArea !== chegouCola; i++) {
      await dorme(500);
      naArea = arquivoNaAreaDeTransferencia();
    }
    check('e passa a ser colável lá — a área de transferência aponta para ele',
      naArea === chegouCola, String(naArea));

    // A seleção inteira precisa sobreviver: publicar cada arquivo ao terminar
    // faria o segundo apagar o primeiro no clipboard remoto.
    const nomesLote = [`lote-a-${randomBytes(2).toString('hex')}.txt`, `lote-b-${randomBytes(2).toString('hex')}.txt`];
    const origensLote = nomesLote.map((nome, i) => {
      const path = join(recebidosVisitante, nome);
      writeFileSync(path, `arquivo ${i + 1} do lote\n`);
      return path;
    });
    copiarArquivos(origensLote);
    const destinosLote = nomesLote.map((nome) => join(recebidosAnfitriao, nome));
    let loteRemoto = [];
    for (let i = 0; i < 60; i++) {
      await dorme(500);
      loteRemoto = arquivosNaAreaDeTransferencia();
      if (destinosLote.every((path, index) => loteRemoto[index] === path)) break;
    }
    check('dois arquivos selecionados chegam ao computador remoto', destinosLote.every(existsSync), destinosLote.join(', '));
    check('e os dois ficam juntos para um único Ctrl+V',
      destinosLote.every((path, index) => loteRemoto[index] === path), JSON.stringify(loteRemoto));
  }

  // ══════════ RESILIÊNCIA: a sessão precisa sobreviver ao tempo ══════════
  //
  // Defeito relatado em uso real: depois de mais de meia hora a sessão
  // congelava — imagem parada, teclado e mouse mortos — e o WebRTC continuava
  // dizendo "connected". O ponteiro sumia junto, porque ele é desenhado dentro
  // do vídeo, que estava parado.
  //
  // A POLÍTICA que decide "isto morreu, refaça o caminho" é exercitada contra
  // relógio simulado em test/vigilancia.test.mjs, inclusive o cenário de meia
  // hora. Aqui conferimos o que só a sessão real mostra: que a imagem continua
  // chegando de forma sustentada, e que a interface tem como avisar.

  const amostras = [];
  for (let i = 0; i < 6; i++) {
    amostras.push(
      await visitante.avaliar(
        `(() => { const v = document.querySelector('video'); return v ? v.getVideoPlaybackQuality().totalVideoFrames : 0; })()`,
      ),
    );
    await dorme(2000);
  }
  const sempreSubindo = amostras.every((n, i) => i === 0 || n > amostras[i - 1]);
  check('a imagem continua chegando de forma sustentada', sempreSubindo,
    amostras.join(' → '));

  const semAvisoDeQueda = await visitante.avaliar(`!document.querySelector('.reconectando')`);
  check('sem aviso de reconexão numa rede saudável', semAvisoDeQueda === true);

  // O ponteiro do visitante fica escondido sobre o vídeo, para não competir
  // com o cursor remoto. Se a sessão adoecer ele PRECISA voltar — foi essa
  // combinação, imagem congelada e cursor invisível, que dava a impressão de
  // aplicativo travado.
  const regraDoCursor = await visitante.avaliar(
    `[...document.styleSheets].some((f) => {
       try { return [...f.cssRules].some((r) => r.selectorText === '.viewer.instavel video'); }
       catch { return false; }
     })`,
  );
  check('há regra devolvendo o cursor quando a sessão adoece', regraDoCursor === true);

  // ══════════ DOIS VISITANTES NO MESMO COMPUTADOR, AO MESMO TEMPO ══════════
  //
  // Antes o segundo levava "ocupado". Isso nunca foi limite técnico: a captura
  // de tela é compartilhada entre as sessões e cada visitante tem a própria
  // conexão, com a própria taxa de bits. O que existia era só uma recusa.

  const perfilC = mkdtempSync(join(tmpdir(), 'ryke-visitante2-'));
  const recebidosC = mkdtempSync(join(tmpdir(), 'ryke-recebe-c-'));
  descartaveis.push(perfilC, recebidosC);
  lancarAplicativo('visitante2', 9335, perfilC, recebidosC);

  const visitante2 = await Aba.abrir('visitante2', 9335);
  await visitante2.pronta();
  await visitante2.esperar(`!!document.querySelector('.home')`, 25_000);

  const idVisitante2 = await visitante2.esperar(
    `(() => { const e = document.querySelector('.my-id-value:not(.pending)'); return e ? e.textContent.replace(/[^0-9]/g,'') : null; })()`,
    60_000,
  );
  check('o segundo visitante entrou na malha', /^[0-9]{12}$/.test(idVisitante2 ?? ''), idVisitante2 ?? 'nenhum');

  await visitante2.avaliar(preencher('#peer-id', idAnfitriao));
  await visitante2.avaliar(preencher('#peer-password', SENHA));
  await visitante2.avaliar(clicarTexto('Conectar'));

  const segundoConectou = await visitante2.esperar(`!!document.querySelector('.viewer video')`, 60_000);
  check('o segundo visitante entra sem levar "ocupado"', segundoConectou === true);

  const primeiroSegueVivo = await visitante.avaliar(`!!document.querySelector('.viewer video')`);
  check('e o primeiro continua na sessão dele', primeiroSegueVivo === true);

  // As duas imagens precisam estar correndo ao mesmo tempo, e não uma
  // congelada enquanto a outra anda.
  const antes1 = await visitante.avaliar(
    `(() => { const v = document.querySelector('video'); return v ? v.getVideoPlaybackQuality().totalVideoFrames : 0; })()`,
  );
  const antes2 = await visitante2.avaliar(
    `(() => { const v = document.querySelector('video'); return v ? v.getVideoPlaybackQuality().totalVideoFrames : 0; })()`,
  );
  await dorme(3000);
  const depois1 = await visitante.avaliar(
    `(() => { const v = document.querySelector('video'); return v ? v.getVideoPlaybackQuality().totalVideoFrames : 0; })()`,
  );
  const depois2 = await visitante2.avaliar(
    `(() => { const v = document.querySelector('video'); return v ? v.getVideoPlaybackQuality().totalVideoFrames : 0; })()`,
  );
  check('as duas sessões recebem imagem ao mesmo tempo', depois1 > antes1 && depois2 > antes2,
    `visitante ${antes1}→${depois1} · visitante2 ${antes2}→${depois2}`);

  // Um sair não pode derrubar o outro — nem levar junto a captura de tela,
  // que agora é compartilhada.
  await visitante2.avaliar(clicarTexto('Encerrar'));
  await visitante2.esperar(`!document.querySelector('video')`, 20_000);
  await dorme(2500);

  const sobreviveu = await visitante.avaliar(
    `(() => { const v = document.querySelector('video'); return v ? v.getVideoPlaybackQuality().totalVideoFrames : 0; })()`,
  );
  check('quando um sai, o outro segue recebendo imagem', sobreviveu > depois1,
    `${depois1} → ${sobreviveu} quadros`);

  visitante2.fechar();

  // ── 7b. a seta do computador remoto, marcada e sem atraso ──
  //
  // O cursor que o visitante usa para navegar passou a ser o do próprio
  // Windows dele — instantâneo. A seta que vem desenhada dentro do vídeo chega
  // com o atraso da imagem, e era a única que existia. Agora o anfitrião conta
  // pelo canal de controle onde o cursor dele está, e o visitante desenha ali
  // uma seta vermelho-claro com o nome da máquina embaixo.
  const telaW = GetSystemMetrics(0);
  const telaH = GetSystemMetrics(1);

  const lerMarca = `(() => {
       const m = document.querySelector('.seta-remota');
       const v = document.querySelector('video');
       if (!m || !v || !v.videoWidth) return null;
       const r = v.getBoundingClientRect();
       const escala = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
       const larg = v.videoWidth * escala, alt = v.videoHeight * escala;
       const esq = r.left + (r.width - larg) / 2, topo = r.top + (r.height - alt) / 2;
       const p = document.querySelector('.viewer').getBoundingClientRect();
       const t = /translate\\(([-0-9.]+)px, ?([-0-9.]+)px\\)/.exec(m.style.transform);
       if (!t) return null;
       return { fx: (Number(t[1]) + p.left - esq) / larg,
                fy: (Number(t[2]) + p.top - topo) / alt,
                nome: m.querySelector('span').textContent };
     })()`;

  // O cursor precisa estar parado entre as duas leituras: as duas pontas
  // rodam na mesma máquina, e o ponteiro que o anfitrião move pode passar por
  // cima da janela do visitante e ser lido como movimento novo.
  let marca = null;
  let cursorEstavel = null;
  for (let tentativa = 0; tentativa < 6 && !cursorEstavel; tentativa++) {
    SetCursorPos(Math.round(telaW * 0.72), Math.round(telaH * 0.31));
    await dorme(700);
    const antes = posicaoDoCursor();
    marca = await visitante.avaliar(lerMarca);
    const depois = posicaoDoCursor();
    if (antes.x === depois.x && antes.y === depois.y) cursorEstavel = depois;
  }

  check('o visitante recebe a posição real do cursor do anfitrião', marca !== null);
  if (marca && cursorEstavel) {
    const esperadoX = cursorEstavel.x / (telaW - 1);
    const esperadoY = cursorEstavel.y / (telaH - 1);
    const erro = Math.hypot(marca.fx - esperadoX, marca.fy - esperadoY);
    check('e desenha a seta remota onde o cursor está de verdade', erro < 0.02,
      `esperado ${esperadoX.toFixed(3)},${esperadoY.toFixed(3)} · marca ${marca.fx.toFixed(3)},${marca.fy.toFixed(3)}`);
    check('com o nome do computador embaixo dela',
      typeof marca.nome === 'string' && marca.nome.trim().length > 0, String(marca.nome));
  }

  const cursorLocalVisivel = await visitante.avaliar(
    `getComputedStyle(document.querySelector('video')).cursor !== 'none'`,
  );
  check('e o cursor do próprio visitante continua visível sobre a imagem',
    cursorLocalVisivel === true, 'é ele que responde sem atraso');

  // ── 7c. a senha do anfitrião fica trancada durante a sessão ──
  //
  // Quem controla a máquina de longe enxerga esta tela e comanda o teclado:
  // sem a trava, poderia abrir o Ryke Desk de lá e trocar a senha por uma
  // dele, transformando uma sessão autorizada em acesso permanente.
  const senhaTravadaNaTela = await anfitriao.esperar(
    `[...document.querySelectorAll('button')].some(b => b.textContent.includes('Senha trancada durante a conexão') && b.disabled)`,
    10_000,
  );
  check('com alguém conectado, o anfitrião não abre a tela de senha', senhaTravadaNaTela === true);

  // E a trava de verdade não está na interface — que é justamente o que fica
  // sob o comando de quem se quer barrar — e sim no processo principal.
  const recusouTroca = await anfitriao.avaliar(
    `window.ryke.password.set('senha-do-invasor-999').then(() => 'aceitou').catch((e) => String(e.message || e))`,
  );
  check('e o processo principal recusa a troca mesmo sem passar pela tela',
    typeof recusouTroca === 'string' && /conex[aã]o remota ativa/i.test(recusouTroca),
    String(recusouTroca).slice(0, 70));

  // ── 7d. Esc em tela cheia devolve a janela ──
  // Pelo botão da barra, e não chamando a janela direto: é o clique que põe a
  // interface em modo tela cheia, e é esse estado que o Esc consulta.
  await visitante.avaliar(
    `(() => { const b = [...document.querySelectorAll('.tool')]
         .find(x => /Tela cheia/.test(x.getAttribute('data-dica') || ''));
       if (!b) return 'nao achou'; b.click(); return 'ok'; })()`,
  );
  const entrouTelaCheia = await visitante.esperar(
    `window.ryke.window.state().then(s => s.fullscreen === true)`,
    8000,
  );
  check('a sessão entra em tela cheia', entrouTelaCheia === true);

  await visitante.avaliar(
    `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true })); return true; })()`,
  );
  const saiuTelaCheia = await visitante.esperar(
    `window.ryke.window.state().then(s => s.fullscreen === false)`,
    8000,
  );
  check('Esc tira a sessão da tela cheia', saiuTelaCheia === true);

  const minimizou = await visitante.esperar(
    `window.ryke.window.state().then(s => s.minimizada === true)`,
    8000,
  );
  check('e minimiza a janela, sem encerrar a conexão', minimizou === true);

  const sessaoContinua = await visitante.avaliar(`!!document.querySelector('video')`);
  check('a sessão continua aberta atrás da janela minimizada', sessaoContinua === true);

  // O botão não ocupa a imagem. Ele aparece junto com a barra somente quando
  // o ponteiro encosta no topo.
  await visitante.avaliar(`(() => { window.ryke.window.chamarAtencao(); return true; })()`);
  await dorme(500);
  const ocultoAntesDoTopo = await visitante.avaliar(
    `document.querySelector('.toolbar')?.classList.contains('hidden') === true`,
  );
  check('o botão de minimizar começa escondido com a barra', ocultoAntesDoTopo === true);
  await visitante.avaliar(
    `(() => { const v = document.querySelector('video');
       v.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 0, bubbles: true }));
       return true; })()`,
  );
  const abriuNoTopo = await visitante.esperar(
    `document.querySelector('.toolbar')?.classList.contains('hidden') === false`,
    5000,
  );
  check('encostar o ponteiro no topo revela a barra', abriuNoTopo === true);
  const botaoMinimizar = await visitante.avaliar(
    `(() => { const b = document.querySelector('[aria-label="Minimizar o Ryke Desk"]'); if (!b) return false; b.click(); return true; })()`,
  );
  check('a barra revelada contém o botão de minimizar', botaoMinimizar === true);
  const minimizouPeloBotao = await visitante.esperar(
    `window.ryke.window.state().then(s => s.minimizada === true)`,
    8000,
  );
  check('o botão do topo minimiza toda a janela', minimizouPeloBotao === true);

  // E fora da sessão o Esc faz a mesma coisa — "não importa a tela".
  await anfitriao.avaliar(
    `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true })); return true; })()`,
  );
  const minimizouNaInicial = await anfitriao.esperar(
    `window.ryke.window.state().then(s => s.minimizada === true)`,
    8000,
  );
  check('Esc minimiza também na tela inicial', minimizouNaInicial === true);
  await anfitriao.avaliar(`(() => { window.ryke.window.chamarAtencao(); return true; })()`);
  await dorme(600);

  // Devolve a janela para o resto do teste poder trabalhar.
  await visitante.avaliar(`(() => { window.ryke.window.chamarAtencao(); return true; })()`);
  await dorme(600);

  // ── 8. encerramento limpo ──
  await visitante.avaliar(clicarTexto('Encerrar'));
  const voltou = await visitante.esperar(`!document.querySelector('video') && !!document.querySelector('.home')`, 15_000);
  check('visitante volta à tela inicial ao encerrar', voltou === true);

  const anfitriaoLivre = await anfitriao.esperar(`!document.body.textContent.includes('Em sessão com')`, 15_000);
  check('anfitrião sai do estado "em sessão"', anfitriaoLivre === true);

  anfitriao.fechar();
  visitante.fechar();
}

principal()
  .catch((err) => {
    console.error('\n  ERRO:', err.message);
    falhas++;
  })
  .finally(async () => {
    for (const proc of processos) proc.kill();
    await dorme(600);
    for (const corretor of corretores) await corretor.parar();
    for (const caminho of descartaveis) rmSync(caminho, { recursive: true, force: true });
    console.log(falhas === 0 ? '\nSessão remota validada de ponta a ponta.\n' : `\n${falhas} falha(s).\n`);
    process.exit(falhas === 0 ? 0 : 1);
  });
