import {
  CORES_PONTEIRO,
  corDoPonteiro,
  proximaCorLivre,
  nomeCurto,
  svgDaSeta,
  cursorCssDaSeta,
  svgDoCursorSozinho,
  hotspotDaSeta,
  ehCursorPadrao,
} from '../src/shared/ponteiros.ts';

let falhas = 0;
const check = (rotulo, ok) => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}`);
  if (!ok) falhas++;
};

// ── a ordem prometida ──
check('o primeiro que conecta fica vermelho', corDoPonteiro(0).nome === 'vermelha');
check('o segundo fica azul', corDoPonteiro(1).nome === 'azul');
check('o terceiro fica verde', corDoPonteiro(2).nome === 'verde');
check('as cores dão a volta em vez de sumir', corDoPonteiro(CORES_PONTEIRO.length).nome === 'vermelha');
check('índice negativo não quebra', corDoPonteiro(-1).nome === CORES_PONTEIRO[CORES_PONTEIRO.length - 1].nome);
check(
  'nenhuma cor se repete dentro da paleta',
  new Set(CORES_PONTEIRO.map((c) => c.fill)).size === CORES_PONTEIRO.length,
);

// ── a fila de cores ──
check('ninguém conectado: a primeira cor é a 0', proximaCorLivre([]) === 0);
check('com o vermelho ocupado, o próximo é o azul', proximaCorLivre([0]) === 1);
check('com vermelho e azul ocupados, sobra o verde', proximaCorLivre([0, 1]) === 2);
// O caso que a fila existe para resolver: o primeiro sai, e quem entra depois
// herda a cor dele — a promessa é "o primeiro é vermelho", não "o quarto a
// entrar desde que o programa abriu".
check('a cor de quem saiu volta para a fila', proximaCorLivre([1, 2]) === 0);
check('a ordem em que se informa os ocupados não importa', proximaCorLivre([2, 0]) === 1);

// ── o nome sob a seta ──
check('nome curto passa intacto', nomeCurto('Notebook da Ana') === 'Notebook da Ana');
check('nome comprido é cortado', nomeCurto('Computador do Escritório Central').length === 18);
check('o corte termina em reticências', nomeCurto('Computador do Escritório Central').endsWith('…'));
check('espaços em volta somem', nomeCurto('  Ana  ') === 'Ana');

// ── o desenho ──
const svg = svgDaSeta(corDoPonteiro(1), 'Ana');
check('o SVG traz a cor pedida', svg.includes(corDoPonteiro(1).fill));
check('o SVG traz o nome embaixo da seta', svg.includes('>Ana<'));
check('o SVG é um documento único e fechado', svg.startsWith('<svg') && svg.endsWith('</svg>'));

// Um nome com < ou & viraria marcação quebrada dentro do SVG — e o cursor
// simplesmente não apareceria, sem erro nenhum para explicar o motivo.
const perigoso = svgDaSeta(corDoPonteiro(0), 'a<b&c');
check('caracteres de marcação no nome são escapados', perigoso.includes('a&lt;b&amp;c'));

// ── o cursor do CSS ──
const cursor = cursorCssDaSeta(corDoPonteiro(2), 'Ana');
check('o cursor é uma url() com o ponto quente e um padrão', /^url\(".+"\) 2 2, default$/.test(cursor));
check('o cursor não carrega aspas cruas que fechariam a url', !cursor.slice(5, -18).includes('"'));
// O Chromium ignora cursores acima de 128 px. Um nome longo demais no desenho
// não daria erro: o cursor voltaria a ser a setinha branca do sistema, e a
// pessoa perderia a cor que a identifica sem saber por quê.
const larguraMaxima = Number(/width="(\d+)"/.exec(svgDaSeta(corDoPonteiro(0), 'x'.repeat(80)))[1]);
check(`o desenho cabe no limite do Chromium (${larguraMaxima} px)`, larguraMaxima <= 128);

// ── a FORMA do cursor remoto (texto, redimensionar, mãozinha…) ──
//
// A seta remota agora vira a forma do cursor de lá. Sem desenho próprio, uma
// forma recai na seta comum — mas nunca deixa de produzir um SVG válido.
check('a seta comum é o padrão', ehCursorPadrao('default') && ehCursorPadrao(undefined));
check('uma forma de verdade não é a padrão', !ehCursorPadrao('text') && !ehCursorPadrao('ew-resize'));

// Cada forma conhecida gera um desenho fechado e com a cor pedida.
const cor = corDoPonteiro(0);
for (const tipo of ['default', 'text', 'pointer', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'move', 'crosshair', 'not-allowed', 'wait', 'progress', 'help']) {
  const desenho = svgDaSeta(cor, 'Ana', tipo);
  const soForma = svgDoCursorSozinho(cor, tipo);
  const h = hotspotDaSeta(tipo);
  check(`forma '${tipo}': SVG com nome é único e fechado`, desenho.startsWith('<svg') && desenho.endsWith('</svg>'));
  check(`forma '${tipo}': SVG só da forma é único e fechado`, soForma.startsWith('<svg') && soForma.endsWith('</svg>'));
  check(`forma '${tipo}': hotspot válido dentro do desenho`,
    Number.isFinite(h.x) && Number.isFinite(h.y) && h.x >= 0 && h.y >= 0 && h.x <= 24 && h.y <= 24);
}

// A viga de texto aponta pelo centro; a seta, pela ponta — hotspots diferentes.
check('a viga de texto e a seta têm hotspots diferentes',
  hotspotDaSeta('text').x !== hotspotDaSeta('default').x || hotspotDaSeta('text').y !== hotspotDaSeta('default').y);
check('a seta comum aponta pela ponta (2,2)',
  hotspotDaSeta('default').x === 2 && hotspotDaSeta('default').y === 2);

// A forma de redimensionar precisa levar a cor do visitante, não uma fixa.
const redimensionar = svgDaSeta(corDoPonteiro(1), 'Ana', 'ew-resize');
check('a forma de redimensionar usa a cor do visitante', redimensionar.includes(corDoPonteiro(1).fill));
check('e continua trazendo o nome embaixo', redimensionar.includes('>Ana<'));

console.log(falhas === 0 ? '\nSetas dos visitantes validadas.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
