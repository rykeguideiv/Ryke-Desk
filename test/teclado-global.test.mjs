/**
 * As teclas que o Windows come antes de qualquer aplicativo ver.
 *
 * O defeito relatado: Ctrl+Shift+Esc abria o Gerenciador de Tarefas do
 * computador de quem estava controlando, e não do computador controlado. O
 * mesmo vale para a tecla Windows, Ctrl+Esc e Alt+Tab — são tratadas pelo
 * sistema num andar abaixo do navegador, então não havia o que reenviar.
 *
 * POR QUE ESTE TESTE NÃO APERTA TECLAS
 *
 * Não dá. Toda tecla gerada por software chega ao gancho marcada como
 * injetada, e nós a deixamos passar de propósito: capturar a própria injeção
 * faria a sessão brigar consigo mesma quando as duas pontas rodam na mesma
 * máquina. Simular uma tecla "física" exigiria hardware.
 *
 * Por isso a decisão foi separada do FFI. O que se prova aqui é o miolo: dados
 * o código de varredura e as bandeiras que o Windows entrega, o que acontece
 * com a tecla. A instalação do gancho em si é conferida no teste de ponta a
 * ponta, que abre o programa de verdade.
 *
 *   node --import ./test/ts-resolve.mjs test/teclado-global.test.mjs
 */
import { capturando, capturar, interpretar } from '../src/main/teclado-global.ts';
import { SCAN_CODES } from '../src/shared/keymap.ts';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const EXTENDIDA = 0x01;
const INJETADA = 0x10;

/** Aperta uma tecla pela posição física, como o Windows a entrega. */
function apertar(pressionadas, code, wParam = WM_KEYDOWN, extra = 0) {
  const [scan, estendida] = SCAN_CODES[code];
  return interpretar(scan, (estendida ? EXTENDIDA : 0) | extra, wParam, pressionadas);
}

const teclasDe = (decisao) =>
  decisao.acao === 'engolir'
    ? decisao.eventos.filter((e) => e.tipo === 'tecla').map((e) => `${e.code}${e.pressionada ? '↓' : '↑'}`)
    : [];

console.log('\n── as combinações que o Windows reservava para si ──\n');

{
  const p = new Set();
  const ctrl = apertar(p, 'ControlLeft');
  const shift = apertar(p, 'ShiftLeft');
  const esc = apertar(p, 'Escape');
  check('Ctrl+Shift+Esc não acontece nesta máquina',
    [ctrl, shift, esc].every((d) => d.acao === 'engolir'));
  check('e a combinação inteira chega ao outro computador, sem minimizar aqui',
    teclasDe(esc).join('') === 'Escape↓' &&
      !esc.eventos.some((e) => e.tipo === 'acao' && e.qual === 'minimizar'),
    teclasDe(esc).join(''));
}

{
  const p = new Set();
  const d = apertar(p, 'MetaLeft');
  check('a tecla Windows sozinha não abre o menu Iniciar daqui', d.acao === 'engolir');
  check('ela vai para o outro lado', teclasDe(d).join('') === 'MetaLeft↓');
}

{
  const p = new Set();
  const alt = apertar(p, 'AltLeft', WM_SYSKEYDOWN);
  const tab = apertar(p, 'Tab', WM_SYSKEYDOWN);
  check('Alt+Tab não troca de janela nesta máquina',
    alt.acao === 'engolir' && tab.acao === 'engolir');
  check('e chega inteiro do outro lado',
    [...teclasDe(alt), ...teclasDe(tab)].join(' ') === 'AltLeft↓ Tab↓',
    [...teclasDe(alt), ...teclasDe(tab)].join(' '));
}

{
  const p = new Set();
  apertar(p, 'ControlLeft');
  const d = apertar(p, 'Escape');
  check('Ctrl+Esc (menu Iniciar) vai para o outro lado, não minimiza aqui',
    d.acao === 'engolir' && teclasDe(d).join('') === 'Escape↓');
}

console.log('\n── o que precisa continuar acontecendo aqui ──\n');

{
  // A saída de emergência. Com o teclado todo capturado, sem isto a pessoa
  // ficaria presa na tela cheia dependendo do mouse.
  const p = new Set();
  apertar(p, 'ControlLeft');
  apertar(p, 'AltLeft');
  apertar(p, 'ShiftLeft');
  const d = apertar(p, 'KeyX');
  check('Ctrl+Alt+Shift+X encerra a sessão em vez de virar tecla remota',
    d.acao === 'engolir' && d.eventos.some((e) => e.tipo === 'acao' && e.qual === 'sair'));
  check('e nenhum X vaza para o outro computador', teclasDe(d).length === 0);
  check('soltando antes tudo o que estava pressionado',
    d.eventos[0].tipo === 'soltar',
    'senão o Ctrl ficaria preso do outro lado para sempre');

  const q = new Set();
  apertar(q, 'ControlLeft');
  apertar(q, 'AltLeft');
  apertar(q, 'ShiftLeft');
  const f = apertar(q, 'KeyF');
  check('Ctrl+Alt+Shift+F alterna a tela cheia local',
    f.eventos.some((e) => e.tipo === 'acao' && e.qual === 'telaCheia'));

  // A saída do Modo Gamer (Ctrl+G) é tratada na interface, não no gancho,
  // porque depende de o modo estar ligado. Aqui só garantimos que o gancho NÃO
  // sequestra Ctrl+G — senão ele pararia de funcionar no computador remoto.
  const g = new Set();
  apertar(g, 'ControlLeft');
  const ctrlG = apertar(g, 'KeyG');
  check('Ctrl+G não vira ação local no gancho — segue como tecla normal',
    !ctrlG.eventos.some((e) => e.tipo === 'acao') && teclasDe(ctrlG).join('') === 'KeyG↓',
    teclasDe(ctrlG).join(''));
}

console.log('\n── Modo Gamer: o Esc deixa de minimizar ──\n');

{
  // Com escMinimiza = false, o Esc puro vira tecla comum e segue para o jogo,
  // em vez de minimizar a sessão. É o que o botão "Desativar Esc" liga.
  const p = new Set();
  const esc = interpretar(SCAN_CODES.Escape[0], 0, WM_KEYDOWN, p, false);
  check('Esc sozinho, com "Desativar Esc", vai para o outro lado',
    esc.acao === 'engolir' && teclasDe(esc).join('') === 'Escape↓' &&
      !esc.eventos.some((e) => e.tipo === 'acao'),
    teclasDe(esc).join(''));

  // E o padrão (escMinimiza = true) continua minimizando, como sempre.
  const q = new Set();
  const escPadrao = interpretar(SCAN_CODES.Escape[0], 0, WM_KEYDOWN, q, true);
  check('e sem "Desativar Esc" ele minimiza como antes',
    escPadrao.eventos.some((e) => e.tipo === 'acao' && e.qual === 'minimizar'));
}

{
  const p = new Set();
  const d = apertar(p, 'KeyA', WM_KEYDOWN, INJETADA);
  check('tecla injetada por software passa direto', d.acao === 'passar',
    'é o que impede a sessão de brigar com a própria injeção');
}

{
  // 0x56 não está no mapa (tecla de fabricante, multimídia): sumir com ela
  // deixaria o dono do computador sem entender por que a tecla morreu.
  const d = interpretar(0x7f, 0, WM_KEYDOWN, new Set());
  check('tecla desconhecida é devolvida ao sistema', d.acao === 'passar');
}

{
  const d = interpretar(0x1e, 0, 0x0200 /* WM_MOUSEMOVE, não é tecla */, new Set());
  check('mensagem que não é tecla passa sem ser tocada', d.acao === 'passar');
}

console.log('\n── a posição física da tecla, e não a letra ──\n');

{
  const p = new Set();
  const enter = interpretar(0x1c, 0, WM_KEYDOWN, p);
  const numpad = interpretar(0x1c, EXTENDIDA, WM_KEYDOWN, p);
  check('Enter e Enter do teclado numérico não se confundem',
    teclasDe(enter).join('') === 'Enter↓' && teclasDe(numpad).join('') === 'NumpadEnter↓',
    `${teclasDe(enter)} / ${teclasDe(numpad)}`);
}

{
  // O mapa de ida (nome → posição) e o de volta (posição → nome) precisam
  // cobrir as mesmas teclas: uma colisão faria uma tecla virar outra.
  const vistos = new Map();
  const colisoes = [];
  for (const [code, [scan, estendida]] of Object.entries(SCAN_CODES)) {
    const chave = (estendida ? 0x100 : 0) | scan;
    if (vistos.has(chave)) colisoes.push(`${vistos.get(chave)} × ${code}`);
    vistos.set(chave, code);
  }
  check('nenhuma posição física responde por duas teclas', colisoes.length === 0, colisoes.join(', '));

  const naoVoltam = [];
  for (const [code, [scan, estendida]] of Object.entries(SCAN_CODES)) {
    const d = interpretar(scan, estendida ? EXTENDIDA : 0, WM_KEYDOWN, new Set());
    if (code === 'Escape') {
      if (!d.eventos?.some((e) => e.tipo === 'acao' && e.qual === 'minimizar')) naoVoltam.push(code);
    } else if (teclasDe(d).join('') !== `${code}↓`) naoVoltam.push(code);
  }
  check('todas as teclas voltam com o mesmo nome, salvo Esc que minimiza',
    naoVoltam.length === 0, `${Object.keys(SCAN_CODES).length} teclas conferidas`);
}

console.log('\n── soltar as teclas ──\n');

{
  const p = new Set();
  apertar(p, 'ControlLeft');
  apertar(p, 'KeyC');
  check('o conjunto acompanha o que está pressionado', p.has('ControlLeft') && p.has('KeyC'));
  const solta = apertar(p, 'KeyC', WM_KEYUP);
  check('soltar manda o levantar da tecla', teclasDe(solta).join('') === 'KeyC↑');
  check('e sai do conjunto', !p.has('KeyC') && p.has('ControlLeft'));
}

console.log('\n── o gancho de verdade, no Windows ──\n');

{
  // A parte que só o sistema pode responder: se as assinaturas do FFI estiverem
  // erradas, isto devolve nulo ou derruba o processo. Instala e remove na
  // mesma respiração — um gancho de baixo nível vivo num processo sem laço de
  // mensagens deixaria o teclado da máquina lento enquanto durasse.
  const instalou = capturar(true, () => {});
  const estava = capturando();
  const removeu = capturar(false);
  check('o gancho de teclado instala no Windows', instalou === true);
  check('e fica registrado enquanto está de pé', estava === true);
  check('e sai limpo', removeu === true && capturando() === false);
}

console.log(falhas === 0 ? '\nCaptura de teclado validada.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
