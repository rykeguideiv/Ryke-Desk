/**
 * A prova da captura nativa: ela abre, entrega quadros, e a que velocidade?
 *
 * Nao e um teste de unidade — e uma MEDIDA. A pergunta que este projeto existe
 * para responder e "da 60 quadros?", e essa pergunta so tem resposta com um
 * relogio e uma tela mudando de verdade.
 *
 *   node ryke-sistema/nativo/prova.cjs
 *
 * Enquanto ele roda, mexa uma janela na tela. Uma tela parada NAO produz
 * quadros — e isso esta certo, e nao falha.
 */
'use strict';

const { Tela, disponivel, porQueNaoCarregou } = require('./index.js');

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

if (!disponivel()) {
  console.log('\n A captura nativa nao carregou:\n');
  console.log(String(porQueNaoCarregou().message).split('\n').map((l) => '   ' + l).join('\n'));
  process.exit(1);
}
check('o modulo nativo carregou', true);

const tela = new Tela(0);
let info;
try {
  info = tela.abrir();
} catch (e) {
  check('abrir o duplicador do monitor 0', false, e.message);
  process.exit(1);
}
check('abrir o duplicador do monitor 0', true, `${info.largura}x${info.altura}`);
check('a resolucao faz sentido', info.largura >= 640 && info.altura >= 480);

// ── a medida ──
const SEGUNDOS = 5;
console.log(`\n   Medindo por ${SEGUNDOS}s. MEXA UMA JANELA na tela agora.\n`);

const inicio = Date.now();
let quadros = 0;
let vazios = 0;
let bytes = 0;
let ultimo = null;

while (Date.now() - inicio < SEGUNDOS * 1000) {
  const q = tela.proximo(16);
  if (!q) {
    vazios++;
    continue;
  }
  quadros++;
  bytes += q.dados.length;
  ultimo = q;
}
const decorrido = (Date.now() - inicio) / 1000;
const fps = quadros / decorrido;

tela.fechar();

console.log(`   quadros: ${quadros}   sem novidade: ${vazios}   recriacoes: ${tela.recriacoes}`);
console.log(`   taxa: ${fps.toFixed(1)} quadros/s`);
console.log(`   volume: ${(bytes / 1024 / 1024 / decorrido).toFixed(1)} MB/s tirados da GPU\n`);

check('a captura entregou algum quadro', quadros > 0,
  quadros === 0 ? 'a tela ficou parada? mexa uma janela durante a medida' : `${quadros} quadros`);

if (ultimo) {
  const esperado = ultimo.largura * ultimo.altura * 4;
  check('o quadro tem o tamanho exato de BGRA', ultimo.dados.length === esperado,
    `${ultimo.dados.length} bytes para ${ultimo.largura}x${ultimo.altura}`);
  // Uma imagem inteira zerada e o sintoma classico de captura que "funciona"
  // mas devolve tela preta — precisa falhar aqui, e nao no olho do usuario.
  const algumPixel = ultimo.dados.some((b) => b !== 0);
  check('o quadro nao veio todo preto', algumPixel);
}

// 60 quadros exige a tela mudando o tempo todo; num teste manual isso raramente
// acontece. Entao o piso aqui e baixo de proposito: o que se afirma e que o
// caminho FUNCIONA, nao que a maquina estava ocupada durante a medida.
if (quadros > 0) {
  console.log(
    fps >= 50
      ? '\n   60 quadros ao alcance: a captura acompanhou a tela.\n'
      : `\n   ${fps.toFixed(1)} q/s medidos. Se a tela estava quase parada, isto e o esperado —\n` +
        '   a Desktop Duplication so entrega quadro quando algo muda.\n',
  );
}

console.log(falhas === 0 ? 'Captura nativa validada.\n' : `${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
