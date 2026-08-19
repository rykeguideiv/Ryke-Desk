/**
 * Verifica a ponte FFI com o Windows antes de confiar nela em produção.
 *
 * Todos os testes são inofensivos: o único SendInput real move o ponteiro
 * para a posição onde ele já está, então nada muda na tela do usuário.
 *
 *   node test/input-abi.mjs
 */
import koffi from 'koffi';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32', dy: 'int32', mouseData: 'uint32',
  dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32',
  time: 'uint32', dwExtraInfo: 'uintptr',
});
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
  uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16',
});
const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

const user32 = koffi.load('user32.dll');
const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *lpPoint)');

console.log(`\nkoffi ${koffi.version ?? ''} | node ${process.version} | ${process.arch}\n`);

// ── layout dos structs ──
check('sizeof(MOUSEINPUT) == 32', koffi.sizeof(MOUSEINPUT) === 32, `obtido ${koffi.sizeof(MOUSEINPUT)}`);
check('sizeof(KEYBDINPUT) == 24', koffi.sizeof(KEYBDINPUT) === 24, `obtido ${koffi.sizeof(KEYBDINPUT)}`);
check('sizeof(INPUT) == 40 (x64)', koffi.sizeof(INPUT) === 40, `obtido ${koffi.sizeof(INPUT)}`);

// ── métricas da área de trabalho virtual ──
const vs = {
  left: GetSystemMetrics(76), top: GetSystemMetrics(77),
  width: GetSystemMetrics(78), height: GetSystemMetrics(79),
};
check('área virtual tem dimensões plausíveis', vs.width >= 640 && vs.height >= 480, JSON.stringify(vs));

// ── leitura da posição do cursor ──
const pos = {};
const gotPos = GetCursorPos(pos);
check('GetCursorPos responde', gotPos !== 0, `x=${pos.x} y=${pos.y}`);
check('cursor dentro da área virtual',
  pos.x >= vs.left && pos.x < vs.left + vs.width && pos.y >= vs.top && pos.y < vs.top + vs.height);

// ── SendInput real, movendo para onde o cursor já está (invisível) ──
const nx = Math.round(((pos.x - vs.left) * 65535) / Math.max(1, vs.width - 1));
const ny = Math.round(((pos.y - vs.top) * 65535) / Math.max(1, vs.height - 1));

const inputs = [{
  type: 0, // INPUT_MOUSE
  u: { mi: { dx: nx, dy: ny, mouseData: 0, dwFlags: 0x0001 | 0x8000 | 0x4000, time: 0, dwExtraInfo: 0x52594b45 } },
}];
const buffer = Buffer.allocUnsafe(koffi.sizeof(INPUT) * inputs.length);
koffi.encode(buffer, koffi.array(INPUT, inputs.length), inputs);
const sent = SendInput(inputs.length, buffer, koffi.sizeof(INPUT));
check('SendInput aceitou o evento de mouse', sent === 1, `retorno ${sent}`);

// Confere que o ponteiro parou exatamente onde o esperávamos (±2 px de
// arredondamento da grade 0..65535). Isso prova que o mapeamento de
// coordenadas está correto, que é o erro mais comum nesse tipo de código.
const after = {};
GetCursorPos(after);
check('ponteiro no lugar previsto', Math.abs(after.x - pos.x) <= 2 && Math.abs(after.y - pos.y) <= 2,
  `antes ${pos.x},${pos.y} depois ${after.x},${after.y}`);

// ── codificação de um evento de teclado (sem disparar) ──
const keyInputs = [{ type: 1, u: { ki: { wVk: 0, wScan: 0x1e, dwFlags: 0x0008, time: 0, dwExtraInfo: 0 } } }];
const keyBuf = Buffer.allocUnsafe(koffi.sizeof(INPUT));
koffi.encode(keyBuf, koffi.array(INPUT, 1), keyInputs);
check('KEYBDINPUT codifica no offset certo da união',
  keyBuf.readUInt32LE(0) === 1 && keyBuf.readUInt16LE(8) === 0 && keyBuf.readUInt16LE(10) === 0x1e && keyBuf.readUInt32LE(12) === 0x0008,
  keyBuf.toString('hex'));

console.log(failures === 0 ? '\nPonte FFI validada.\n' : `\n${failures} falha(s).\n`);
process.exit(failures === 0 ? 0 : 1);
