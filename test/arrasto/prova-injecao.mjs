/**
 * Metade de baixo do caminho: o anfitrião consegue produzir um arrasto?
 *
 * Chama `src/main/input.ts` — o código de produção, não uma cópia — na mesma
 * ordem em que o `input:button`/`input:move` do processo principal chamam, e
 * pergunta à janela-alvo se ela viu um arrasto. Se passar aqui e falhar na
 * sessão real, o defeito está ACIMA: no visitante, no canal ou na ordem em que
 * as mensagens chegam.
 *
 *   node --import ./test/carregador-com-electron.mjs test/arrasto/prova-injecao.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import koffi from 'koffi';

const input = await import('../../src/main/input.ts');

const AQUI = dirname(fileURLToPath(import.meta.url));
const EXE = resolve(AQUI, 'alvo-arrasto.exe');
if (!existsSync(EXE)) {
  console.error('Falta alvo-arrasto.exe. Rode test/arrasto/compilar.cmd.');
  process.exit(2);
}

const user32 = koffi.load('user32.dll');
koffi.struct('RECT_P', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
koffi.struct('POINT_P', { x: 'long', y: 'long' });
const FindWindowA = user32.func('intptr __stdcall FindWindowA(const char *cls, const char *t)');
const GetClientRect = user32.func('int __stdcall GetClientRect(intptr h, _Out_ RECT_P *r)');
const ClientToScreen = user32.func('int __stdcall ClientToScreen(intptr h, _Inout_ POINT_P *p)');
const PostMessageA = user32.func('int __stdcall PostMessageA(intptr h, uint32 m, uintptr w, intptr l)');
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT_P *p)');
const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)');

const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? ' ok  ' : 'FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

const DIVISORIA = 350;
const DESTINO = 520;

const LOG = join(mkdtempSync(join(tmpdir(), 'ryke-inj-')), 'alvo.log');
const proc = spawn(EXE, [LOG], { stdio: 'ignore' });

const guardado = {};
GetCursorPos(guardado);

try {
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

  // A MESMA ordem do processo principal: leva o cursor, aperta, move enquanto
  // segura, solta.
  const p0 = tela(DIVISORIA);
  input.moveMouseTo(p0.x, p0.y);
  await dorme(60);
  input.mouseButton(0, true);
  await dorme(40);
  for (let i = 1; i <= 14; i++) {
    const p = tela(DIVISORIA + Math.round(((DESTINO - DIVISORIA) * i) / 14));
    input.moveMouseTo(p.x, p.y);
    await dorme(24);
  }
  await dorme(80);
  input.mouseButton(0, false);
  await dorme(300);

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
  check('a janela viu apertar e soltar', num('down') >= 1 && num('up') >= 1);
  check('a janela viu movimentos COM o botão apertado', num('moveComBotao') >= 5, `${num('moveComBotao')} de 14`);
  check(
    'a divisória foi de 350 para ~520',
    Math.abs(num('divisoria') - DESTINO) <= 25,
    `terminou em ${num('divisoria')}`
  );
} finally {
  try {
    input.releaseAll();
  } catch {
    /* nada preso é o caso normal */
  }
  SetCursorPos(guardado.x, guardado.y);
  try {
    proc.kill();
  } catch {
    /* já saiu pelo WM_CLOSE */
  }
}

console.log(`\n${falhas === 0 ? 'TUDO OK' : falhas + ' FALHA(S)'}\n`);
process.exit(falhas === 0 ? 0 : 1);
