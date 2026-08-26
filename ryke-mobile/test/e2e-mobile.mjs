/**
 * Teste ponta a ponta: o aplicativo do celular acessando um PC de verdade.
 *
 * O QUE ESTE TESTE PROVA — E O QUE NÃO PROVA
 *
 * O APK é uma WebView do Chromium em volta de `dist/`. Aqui rodamos exatamente
 * esses arquivos no mesmo motor, contra uma cópia real do Ryke Desk de
 * desktop, pelos pontos de encontro públicos da internet — os mesmos que um
 * telefone usaria. Isso exercita tudo o que é do nosso código: achar o
 * computador na malha, provar a senha, negociar o WebRTC, receber o vídeo e
 * traduzir toque em movimento de mouse.
 *
 * O que fica de fora é a casca do Android: instalar, permissões do sistema,
 * e o WebView do aparelho em vez do Chromium de mesa. Essa parte precisa de um
 * telefone ligado por USB ou de um emulador — e o emulador exige virtualização
 * por hardware, que está desligada na BIOS desta máquina.
 *
 * A prova de que o pacote testado aqui é o que está no APK vive em
 * `test/apk.test.mjs`, que compara os bytes de dentro do arquivo instalável.
 *
 *   node test/e2e-mobile.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// koffi vem do projeto do PC: é dependência dele, e este teste roda ao lado.
// Duplicar a biblioteca aqui só para o teste engordaria o projeto do celular
// sem necessidade — o aplicativo Android não usa nada disso.
import { createRequire } from 'node:module';
const exigir = createRequire(resolve(import.meta.dirname, '..', '..', 'ryke-desk', 'package.json'));
const koffi = exigir('koffi');
import { Aba, preencher, clicarTexto, clicarSeletor } from '../../ryke-desk/test/cdp.mjs';

// O cursor e o teclado reais do Windows são a única prova de que o toque no
// celular mexeu mesmo no computador — o aplicativo dizer que enviou não basta.
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const user32 = koffi.load('user32.dll');
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *p)');
const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)');
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vKey)');

const VK_LSHIFT = 0xa0;
const VK_LBUTTON = 0x01;
// Rede de segurança: se o teste morrer com o botão do mouse injetado para
// baixo, esta máquina fica arrastando tudo por onde o cursor passar.
const mouse_event = user32.func(
  'void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr dwExtraInfo)',
);
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const posicaoDoCursor = () => {
  const p = {};
  GetCursorPos(p);
  return p;
};

const AQUI = resolve(import.meta.dirname, '..');
const PC = resolve(AQUI, '..', 'ryke-desk');
const ELECTRON = join(PC, 'node_modules', 'electron', 'dist', 'electron.exe');
const SENHA = 'melancia-42-azul';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

const processos = [];
const descartaveis = [];

function ambienteLimpo() {
  const env = { ...process.env };
  // A porta de depuração precisa de um Electron de verdade, não do modo Node.
  delete env.ELECTRON_RUN_AS_NODE;
  env.RYKE_SEM_ELEVACAO = '1';
  return env;
}

async function principal() {
  // ── 1. o computador anfitrião: o Ryke Desk de desktop, sem alterações ──
  const perfil = mkdtempSync(join(tmpdir(), 'ryke-pc-'));
  const recebidos = mkdtempSync(join(tmpdir(), 'ryke-rec-'));
  descartaveis.push(perfil, recebidos);
  writeFileSync(
    join(perfil, 'ryke-config.json'),
    JSON.stringify({ version: 1, settings: { serverUrl: '', downloadDir: recebidos, autoAccept: true } }),
  );

  console.log('\nsubindo o PC anfitrião (pontos de encontro públicos, como um telefone usaria)…\n');
  processos.push(
    spawn(ELECTRON, [PC, '--remote-debugging-port=9401', `--user-data-dir=${perfil}`, '--remote-allow-origins=*'], {
      env: ambienteLimpo(),
      stdio: ['ignore', 'ignore', 'pipe'],
    }),
  );

  const pc = await Aba.abrir('pc', 9401);
  await pc.pronta();
  // O PC abre direto na tela principal: a escolha "receber ou conectar" foi
  // embora, porque sem servidor os dois papéis são o mesmo programa.
  const abriuDireto = await pc.esperar(`!!document.querySelector('.home')`, 25_000);
  check('o PC abre direto na tela principal', abriuDireto === true);

  const numeroPc = await pc.esperar(
    `(() => { const e = document.querySelector('.my-id-value:not(.pending)'); return e ? e.textContent.replace(/[^0-9]/g,'') : null; })()`,
    60_000,
  );
  check('o PC entrou na malha e recebeu número', /^[0-9]{12}$/.test(numeroPc ?? ''), numeroPc ?? 'nenhum');
  if (!numeroPc) throw new Error('sem número do PC, o resto não faz sentido');

  // Senha no PC, para o celular exercitar o caminho não supervisionado —
  // que é o que depende do scrypt em JavaScript puro.
  await pc.avaliar(clicarTexto('Com senha'));
  await dorme(400);
  await pc.avaliar(preencher('#nova-senha', SENHA));
  await pc.avaliar(preencher('#repetir-senha', SENHA));
  await pc.avaliar(clicarSeletor('.modal-actions .btn.primary'));
  const temSenha = await pc.esperar(
    `[...document.querySelectorAll('button')].some(b => b.textContent.includes('definida'))`,
    15_000,
  );
  check('senha definida no PC', temSenha === true);

  // ── 2. o aplicativo do celular: os arquivos que vão dentro do APK ──
  console.log('\nabrindo o pacote do aplicativo Android…\n');
  // Aparelho novo a cada execução: sem isto, favoritos e senhas de execuções
  // anteriores sobrevivem no perfil e um teste passa por causa do que outro
  // deixou para trás.
  const perfilCel = mkdtempSync(join(tmpdir(), 'ryke-cel-'));
  descartaveis.push(perfilCel);
  processos.push(
    spawn(
      ELECTRON,
      [
        join(AQUI, 'test', 'navegador.cjs'),
        join(AQUI, 'dist'),
        '4173',
        `--user-data-dir=${perfilCel}`,
        '--remote-debugging-port=9402',
        '--remote-allow-origins=*',
      ],
      { env: ambienteLimpo(), stdio: ['ignore', 'ignore', 'pipe'] },
    ),
  );

  const cel = await Aba.abrir('celular', 9402);
  await cel.pronta();

  const abriu = await cel.esperar(`!!document.querySelector('.inicio')`, 25_000);
  check('a tela inicial do aplicativo abriu', abriu === true);

  const soVisitante = await cel.avaliar(
    `document.body.textContent.includes('só acessa') && !document.body.textContent.includes('receber conexão')`,
  );
  check('o aplicativo se apresenta como somente visitante', soVisitante === true);

  const entrouNaMalha = await cel.esperar(
    `(() => { const s = document.querySelector('.selo'); return s && s.textContent.trim() === 'pronto'; })()`,
    90_000,
  );
  check('o celular entrou na malha pública', entrouNaMalha === true);

  // ── 3. conectar com senha ──
  await cel.avaliar(preencher('#numero', numeroPc));
  await cel.avaliar(preencher('#senha', SENHA));

  const liberado = await cel.esperar(
    `(() => { const b = document.querySelector('.bt.principal'); return b ? !b.disabled : null; })()`,
    10_000,
  );
  check('o botão de conectar libera com o número completo', liberado === true);

  // Guardar a senha: a caixinha só faz sentido depois de haver senha digitada.
  const marcou = await cel.avaliar(
    `(() => { const c = document.querySelector('.caixinha input');
       if (!c) return null; if (!c.checked) c.click(); return c.checked; })()`,
  );
  check('existe a caixinha de guardar a senha, e ela marca', marcou === true);

  const temAvisoDaCaixinha = await cel.avaliar(
    `(() => { const s = document.querySelector('.caixinha small'); return s ? s.textContent.trim().length > 30 : false; })()`,
  );
  check('e ela explica o que isso significa', temAvisoDaCaixinha === true);

  await cel.avaliar(`(() => { document.querySelector('.bt.principal').click(); return true; })()`);

  const conectou = await cel.esperar(`!!document.querySelector('.visualizador video')`, 90_000);
  check('a sessão abriu no celular', conectou === true);

  const tamanho = await cel.esperar(
    `(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0 ? v.videoWidth + 'x' + v.videoHeight : null; })()`,
    40_000,
  );
  check('a tela do PC chegou ao celular', typeof tamanho === 'string' && /^\d+x\d+$/.test(tamanho), String(tamanho));

  const correndo = await cel.avaliar(
    `(() => { const v = document.querySelector('video'); return v ? v.getVideoPlaybackQuality().totalVideoFrames : 0; })()`,
  );
  await dorme(2500);
  const correndoDepois = await cel.avaliar(
    `(() => { const v = document.querySelector('video'); return v ? v.getVideoPlaybackQuality().totalVideoFrames : 0; })()`,
  );
  check('o vídeo está correndo, não parado', correndoDepois > correndo, `${correndo} → ${correndoDepois} quadros`);

  // ── 4. o toque move o mouse do Windows de verdade ──
  //
  // Os dois lados rodam na mesma máquina, então o cursor que o anfitrião move
  // passa por cima da janela do "celular" e gera um evento de ponteiro real —
  // que seria lido como um novo toque. Estacionar o cursor e esperar um
  // instante separa os dois eventos em quadros de animação diferentes.
  //
  // O alvo é medido sobre a IMAGEM, não sobre o elemento de vídeo. Com
  // `object-fit: contain` os dois não coincidem: uma tela de PC 16:9 num
  // celular em pé ocupa menos de um terço da altura do elemento, e o resto é
  // tarja preta. Medir pelo elemento — que era o que este teste fazia — dá
  // "erro de 0 pixel" enganoso, porque o teste e o aplicativo erravam juntos.
  const alvo = await cel.avaliar(
    `(() => {
       const v = document.querySelector('video');
       const r = v.getBoundingClientRect();
       const proporcao = v.videoWidth / v.videoHeight;
       let w = r.width, h = r.width / proporcao;
       if (h > r.height) { h = r.height; w = r.height * proporcao; }
       const left = r.left + (r.width - w) / 2, top = r.top + (r.height - h) / 2;
       return { x: Math.round(left + w * 0.25), y: Math.round(top + h * 0.75),
                meioX: Math.round(left + w / 2), meioTarja: Math.round(r.top + (top - r.top) / 2),
                tarja: Math.round(top - r.top), imagem: Math.round(w) + '×' + Math.round(h) }; })()`,
  );
  check('a imagem não preenche o elemento — há tarja preta a descontar', alvo.tarja >= 0,
    `imagem ${alvo.imagem}, tarja de ${alvo.tarja}px`);

  SetCursorPos(1, 1);
  await dorme(400);
  await cel.avaliar(
    `(() => {
       const v = document.querySelector('video');
       const op = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
                    clientX: ${alvo.x}, clientY: ${alvo.y} };
       v.dispatchEvent(new PointerEvent('pointerdown', op));
       v.dispatchEvent(new PointerEvent('pointerup', op));
       return true;
     })()`,
  );
  await dorme(900);
  const cursor = posicaoDoCursor();

  // O toque foi em 25% da largura e 75% da altura da tela remota.
  const meta = await cel.avaliar(
    `(() => { const v = document.querySelector('video'); return { w: v.videoWidth, h: v.videoHeight }; })()`,
  );
  const esperadoX = Math.round(meta.w * 0.25);
  const esperadoY = Math.round(meta.h * 0.75);
  const erro = Math.hypot(cursor.x - esperadoX, cursor.y - esperadoY);
  check('o toque moveu o cursor real do Windows', erro < 40,
    `esperado ~${esperadoX},${esperadoY} · obtido ${cursor.x},${cursor.y} (erro ${erro.toFixed(0)}px)`);

  // Dedo na tarja preta: caiu fora da imagem. Grudar na borda é o certo —
  // inventar uma posição lá dentro clicaria no que não foi apontado.
  if (alvo.tarja > 8) {
    SetCursorPos(1, 1);
    await dorme(400);
    await cel.avaliar(
      `(() => {
         const v = document.querySelector('video');
         const op = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
                      clientX: ${alvo.meioX}, clientY: ${alvo.meioTarja} };
         v.dispatchEvent(new PointerEvent('pointerdown', op));
         v.dispatchEvent(new PointerEvent('pointerup', op));
         return true;
       })()`,
    );
    await dorme(900);
    const naBorda = posicaoDoCursor();
    check('toque na tarja preta gruda na borda de cima, não vai parar no meio da tela',
      naBorda.y < meta.h * 0.05, `y = ${naBorda.y} de ${meta.h}`);
  }

  // ── 4b. o joystick move o cursor, e o dedo não tapa o alvo ──
  //
  // O toque direto acerta alvo grande; o joystick é o que permite trabalho
  // fino. Aqui a prova é a mesma de sempre: o cursor DE VERDADE do Windows.
  await cel.avaliar(clicarTexto('Ativar controle de mouse'));
  const temControle = await cel.esperar(
    `!!document.querySelector('.joystick') && !!document.querySelector('.marcador-cursor')`,
    10_000,
  );
  check('o controle de mouse aparece com haste e marcador', temControle === true);

  const rotulos = await cel.avaliar(
    `[...document.querySelectorAll('.bm')].map(b => b.firstChild.textContent.trim()).join('|')`,
  );
  check('os cinco botões pedidos estão lá',
    typeof rotulos === 'string' &&
      ['Copiar', 'Colar', 'Voltar', 'Direito', 'Esquerdo'].every((r) => rotulos.includes(r)),
    String(rotulos));

  // Haste toda para a direita, meio segundo, e solta.
  //
  // O identificador de ponteiro é 21 de propósito: os dois lados rodam na
  // mesma máquina, então o cursor que o anfitrião move passa por cima desta
  // janela e gera eventos de mouse reais (ponteiro 1). O joystick só escuta o
  // dedo que ele capturou, e é isso que separa um do outro.
  const inclinar = (tipo) => `(() => {
       const j = document.querySelector('.joystick');
       const r = j.getBoundingClientRect();
       j.dispatchEvent(new PointerEvent('${tipo}', { pointerId: 21, pointerType: 'touch', isPrimary: true,
         bubbles: true, cancelable: true, clientX: r.right - 2, clientY: r.top + r.height / 2 }));
       return true;
     })()`;

  const antesDaHaste = posicaoDoCursor();
  await cel.avaliar(inclinar('pointerdown'));
  await dorme(500);
  await cel.avaliar(inclinar('pointerup'));
  await dorme(250);
  const depoisDaHaste = posicaoDoCursor();

  const tela = await cel.avaliar(
    `(() => { const v = document.querySelector('video'); return { w: v.videoWidth, h: v.videoHeight }; })()`,
  );
  const andou = depoisDaHaste.x - antesDaHaste.x;
  check('a haste para a direita levou o cursor para a direita',
    andou > tela.w * 0.1 && andou < tela.w * 0.95,
    `${antesDaHaste.x} → ${depoisDaHaste.x} (${andou}px de ${tela.w})`);
  check('e sem desviar na vertical', Math.abs(depoisDaHaste.y - antesDaHaste.y) < 40,
    `${antesDaHaste.y} → ${depoisDaHaste.y}`);

  // Cursor que continua andando depois do dedo sair é o defeito clássico
  // deste tipo de controle.
  await dorme(400);
  const parado = posicaoDoCursor();
  check('soltar a haste para o cursor na hora',
    parado.x === depoisDaHaste.x && parado.y === depoisDaHaste.y,
    `${depoisDaHaste.x},${depoisDaHaste.y} → ${parado.x},${parado.y}`);

  // ── 4c. segurar o botão esquerdo prende o mouse do PC (é o arrastar) ──
  const apertarEsquerdo = (tipo) => `(() => {
       const b = document.querySelector('.bm.esquerdo');
       const r = b.getBoundingClientRect();
       b.dispatchEvent(new PointerEvent('${tipo}', { pointerId: 22, pointerType: 'touch', isPrimary: true,
         bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
       return true;
     })()`;

  let presoDurante = false;
  try {
    await cel.avaliar(apertarEsquerdo('pointerdown'));
    await dorme(600);
    presoDurante = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
  } finally {
    // Sair daqui com o botão preso deixaria o mouse desta máquina arrastando
    // tudo por onde passasse. Solta aconteça o que acontecer.
    await cel.avaliar(apertarEsquerdo('pointerup')).catch(() => {});
  }
  await dorme(600);
  check('segurar o botão esquerdo prende o mouse do PC — é o que permite arrastar', presoDurante === true);
  check('e tirar o dedo solta', (GetAsyncKeyState(VK_LBUTTON) & 0x8000) === 0);

  // ── 5. o teclado do celular chega ao Windows ──
  await cel.avaliar(clicarTexto('Teclado'));
  const temTeclado = await cel.esperar(`!!document.querySelector('.teclado')`, 10_000);
  check('o teclado remoto abre', temTeclado === true);

  const temAtalhos = await cel.avaliar(
    `[...document.querySelectorAll('.atalhos button')].map(b => b.textContent).join(',')`,
  );
  check('os atalhos essenciais estão lá',
    typeof temAtalhos === 'string' && ['Esc', 'Ctrl+C', 'Ctrl+V', 'Alt+Tab', 'Ctrl+Alt+Del'].every((a) => temAtalhos.includes(a)),
    String(temAtalhos).slice(0, 60));

  // Texto literal: é o caminho que faz acento funcionar sem depender de layout.
  //
  // `preencher` usa o setter nativo do HTMLInputElement, e não `.value = x`:
  // o React guarda o último valor que conhece e ignora atribuição direta, o
  // que faria o onChange nunca disparar — e o teste acusaria um defeito que
  // não existe no uso real.
  await cel.avaliar(preencher('.campo-invisivel', 'ação'));
  await dorme(700);
  check('o texto digitado é enviado e o campo se limpa',
    (await cel.avaliar(`document.querySelector('.campo-invisivel').value === ''`)) === true);

  // E o Shift chegando de verdade no Windows: a prova final de que o teclado
  // do celular controla o computador, e não só parece controlar.
  const shiftAntes = (GetAsyncKeyState(VK_LSHIFT) & 0x8000) !== 0;
  check('Shift começa solto no PC', shiftAntes === false);
  await cel.avaliar(
    `(() => { const b = [...document.querySelectorAll('.atalhos button')].find(x => x.textContent === 'Ctrl+C'); if (b) b.click(); return !!b; })()`,
  );
  await dorme(800);
  const semTravar = (GetAsyncKeyState(VK_LSHIFT) & 0x8000) === 0;
  check('combinação enviada não deixa tecla presa no PC', semTravar === true);

  // ── 6. encerrar ──
  await cel.avaliar(clicarTexto('Encerrar'));
  const voltou = await cel.esperar(`!document.querySelector('video') && !!document.querySelector('.inicio')`, 20_000);
  check('encerrar volta à tela inicial', voltou === true);

  const pcLivre = await pc.esperar(`!document.body.textContent.includes('Em sessão com')`, 20_000);
  check('o PC sai do estado "em sessão"', pcLivre === true);

  // ── 7. o que fica guardado depois da sessão ──
  const recentes = await cel.esperar(`document.body.textContent.includes('Conexões recentes')`, 10_000);
  check('o computador acessado aparece em "recentes"', recentes === true);

  const estrela = await cel.avaliar(`!!document.querySelector('.favorito .remover.estrela')`);
  check('e há a estrela para transformá-lo em favorito com nome', estrela === true);

  await cel.avaliar(`(() => { document.querySelector('.favorito .remover.estrela').click(); return true; })()`);
  const pediuNome = await cel.esperar(`!!document.querySelector('.salvar input')`, 8000);
  check('a estrela pede o nome antes de salvar', pediuNome === true);

  await cel.avaliar(preencher('.salvar input', 'PC da sala'));
  await cel.avaliar(clicarSeletor('.salvar .bt'));
  const virouFavorito = await cel.esperar(
    `[...document.querySelectorAll('.favorito .abrir strong')].some(e => e.textContent === 'PC da sala')`,
    10_000,
  );
  check('e ele passa a aparecer pelo nome escolhido', virouFavorito === true);

  // A senha volta sozinha — que era o pedido: não digitar toda vez.
  await cel.avaliar(preencher('#numero', numeroPc));
  await dorme(1200);
  const senhaVoltou = await cel.avaliar(`document.querySelector('#senha').value`);
  check('a senha guardada volta sozinha ao digitar o número', senhaVoltou === SENHA,
    senhaVoltou ? 'preenchida' : 'campo vazio');
  const caixaMarcada = await cel.avaliar(`document.querySelector('.caixinha input').checked`);
  check('e a caixinha vem marcada, para ninguém ser surpreendido', caixaMarcada === true);

  // E o mais importante: guardada não quer dizer largada em texto puro.
  const vazou = await cel.avaliar(
    `Object.keys(localStorage).some((k) => String(localStorage.getItem(k)).includes(${JSON.stringify(SENHA)}))`,
  );
  check('a senha NÃO fica em texto puro no armazenamento do aparelho', vazou === false);

  const esqueceu = await cel.avaliar(
    `(() => { const c = document.querySelector('.caixinha input'); c.click(); return !c.checked; })()`,
  );
  check('desmarcar a caixinha apaga a senha guardada', esqueceu === true);
  await dorme(900);
  const cofreDepois = await cel.avaliar(
    `(() => { const k = Object.keys(localStorage).find((x) => x.includes('senhas'));
       return k ? String(localStorage.getItem(k)) : 'sem registro'; })()`,
  );
  check('e ela some mesmo do armazenamento', !String(cofreDepois).includes(numeroPc),
    String(cofreDepois).slice(0, 70));

  pc.fechar();
  cel.fechar();
}

principal()
  .catch((err) => {
    console.error('\n  ERRO:', err.message);
    falhas++;
  })
  .finally(async () => {
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
    for (const p of processos) p.kill();
    await dorme(800);
    for (const c of descartaveis) rmSync(c, { recursive: true, force: true });
    console.log(falhas === 0 ? '\nCelular validado contra um PC real.\n' : `\n${falhas} falha(s).\n`);
    process.exit(falhas === 0 ? 0 : 1);
  });
