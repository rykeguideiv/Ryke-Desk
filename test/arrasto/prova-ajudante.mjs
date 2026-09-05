/**
 * O arrasto sobrevive ao caminho do MODO ADMINISTRADOR?
 *
 * Sem admin, o anfitrião injeta com as próprias mãos e o teste ponta a ponta
 * cobre isso. COM admin, cada movimento e cada clique viram uma linha de JSON
 * num cano nomeado até o ajudante elevado — outro processo, outra fila. Esse
 * caminho não era exercitado por teste nenhum, e é justamente onde o usuário
 * estava quando o arrasto parou de funcionar.
 *
 *   node --import ./test/carregador-com-electron.mjs test/arrasto/prova-ajudante.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import koffi from 'koffi';

// ANTES do import: o nome do cano é lido quando o módulo carrega. Um cano só
// para o teste, porque o Ryke Desk instalado pode estar rodando e sendo dono do
// cano de verdade — e o teste não tem o direito de fechá-lo.
const B = String.fromCharCode(92);
process.env.RYKE_CANO_ENTRADA = `${B}${B}.${B}pipe${B}ryke-teste-${process.pid}`;

const entrada = await import('../../src/main/entrada.ts');
const { abrirCanoDoAjudante, fecharCanoDoAjudante, ajudanteConectado } = await import('../../src/main/ajudante.ts');

const AQUI = dirname(fileURLToPath(import.meta.url));
const EXE = resolve(AQUI, 'alvo-arrasto.exe');
if (!existsSync(EXE)) {
  console.error('Falta alvo-arrasto.exe. Rode test/arrasto/compilar.cmd.');
  process.exit(2);
}

const user32 = koffi.load('user32.dll');
koffi.struct('RECT_A', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
koffi.struct('POINT_A', { x: 'long', y: 'long' });
const FindWindowA = user32.func('intptr __stdcall FindWindowA(const char *cls, const char *t)');
const GetClientRect = user32.func('int __stdcall GetClientRect(intptr h, _Out_ RECT_A *r)');
const ClientToScreen = user32.func('int __stdcall ClientToScreen(intptr h, _Inout_ POINT_A *p)');
const PostMessageA = user32.func('int __stdcall PostMessageA(intptr h, uint32 m, uintptr w, intptr l)');
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT_A *p)');
const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)');

const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? ' ok  ' : 'FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

const DIVISORIA = 350;
const DESTINO = 520;

const PASTA = mkdtempSync(join(tmpdir(), 'ryke-ajud-'));
const LOG = join(PASTA, 'alvo.log');

const guardado = {};
GetCursorPos(guardado);

let proc = null;
let filho = null;
try {
  // ── 1. o cano, e o ajudante do outro lado dele ──
  abrirCanoDoAjudante(PASTA, (l) => console.log('    ' + l));
  filho = spawn(process.execPath, ['--import', pathToFileURL(resolve(AQUI, '../carregador-com-electron.mjs')).href, resolve(AQUI, 'ajudante-de-mentira.mjs'), PASTA], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 80 && !ajudanteConectado(); i++) await dorme(50);
  check('o ajudante conectou no cano', ajudanteConectado());
  if (!ajudanteConectado()) process.exit(1);

  // ── 2. a janela-alvo ──
  proc = spawn(EXE, [LOG], { stdio: 'ignore' });
  let hwnd = 0;
  for (let i = 0; i < 60 && !hwnd; i++) {
    hwnd = FindWindowA('RykeAlvoArrasto', null);
    if (!hwnd) await dorme(100);
  }
  check('a janela-alvo abriu', hwnd !== 0);
  if (!hwnd) process.exit(1);

  await dorme(400);
  const rc = {};
  GetClientRect(hwnd, rc);
  const canto = { x: 0, y: 0 };
  ClientToScreen(hwnd, canto);
  const meioY = Math.round((rc.bottom - rc.top) / 2);
  const tela = (cx) => ({ x: canto.x + cx, y: canto.y + meioY });

  // ── 3. o arrasto, pela MESMA porta que o processo principal usa ──
  const p0 = tela(DIVISORIA);
  entrada.moveMouseTo(p0.x, p0.y);
  await dorme(60);
  entrada.mouseButton(0, true);
  await dorme(40);
  for (let i = 1; i <= 14; i++) {
    const p = tela(DIVISORIA + Math.round(((DESTINO - DIVISORIA) * i) / 14));
    entrada.moveMouseTo(p.x, p.y);
    await dorme(24);
  }
  await dorme(120);
  entrada.mouseButton(0, false);
  await dorme(400);

  PostMessageA(hwnd, 0x0010, 0, 0);
  let texto = '';
  for (let i = 0; i < 40; i++) {
    await dorme(100);
    texto = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
    if (texto.includes('FIM ')) break;
  }

  const linha = texto.split('\n').find((l) => l.startsWith('FIM ')) ?? '';
  const num = (c) => Number(new RegExp(`${c}=(-?\\d+)`).exec(linha)?.[1] ?? NaN);
  console.log('\n  registro: ' + (linha || '(vazio)') + '\n');
  check('a janela viu apertar e soltar', num('down') >= 1 && num('up') >= 1, `down=${num('down')} up=${num('up')}`);
  check('a janela viu movimentos COM o botão apertado', num('moveComBotao') >= 5, `${num('moveComBotao')} de 14`);
  check(
    'pelo ajudante, a divisória vai de 350 a ~520',
    Math.abs(num('divisoria') - DESTINO) <= 25,
    `terminou em ${num('divisoria')}`
  );
} finally {
  try {
    entrada.releaseAll();
  } catch {
    /* nada preso é o caso normal */
  }
  SetCursorPos(guardado.x, guardado.y);
  fecharCanoDoAjudante(PASTA);
  for (const p of [proc, filho]) {
    try {
      p?.kill();
    } catch {
      /* já saiu */
    }
  }
}

console.log(`\n${falhas === 0 ? 'TUDO OK' : falhas + ' FALHA(S)'}\n`);
process.exit(falhas === 0 ? 0 : 1);
