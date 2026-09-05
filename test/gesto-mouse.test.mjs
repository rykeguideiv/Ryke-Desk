/**
 * O arrasto remontado a partir de mensagens fora de ordem.
 *
 * Cada caso aqui é uma coisa que a rede faz de verdade e que a mesa nunca faz:
 * o "apertar" atrasado, o "apertar" perdido, o "soltar" perdido, o movimento
 * que chega depois de já ter sido superado. Ver src/shared/gesto-mouse.ts.
 *
 *   node --import ./test/ts-resolve.mjs test/gesto-mouse.test.mjs
 */
import {
  bitDoBotao,
  mascaraDe,
  botoesDa,
  estaAtrasada,
  ajustarBotoes,
  movimentoPrecisaDeOrdem,
  BIT_ESQUERDO,
  BIT_MEIO,
  BIT_DIREITO,
  BIT_VOLTAR,
  BIT_AVANCAR,
} from '../src/shared/gesto-mouse.ts';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};
const igual = (rotulo, a, b) =>
  check(rotulo, JSON.stringify(a) === JSON.stringify(b), `obtido ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`);

console.log('\n== a máscara de botões ==\n');

check('esquerdo é o bit 1', bitDoBotao(0) === BIT_ESQUERDO && BIT_ESQUERDO === 1);
check('meio é o bit 2', bitDoBotao(1) === BIT_MEIO && BIT_MEIO === 2);
check('direito é o bit 4', bitDoBotao(2) === BIT_DIREITO && BIT_DIREITO === 4);
check('voltar é o bit 8', bitDoBotao(3) === BIT_VOLTAR && BIT_VOLTAR === 8);
check('avançar é o bit 16', bitDoBotao(4) === BIT_AVANCAR && BIT_AVANCAR === 16);
// Os laterais existem na máscara porque existem no produto: o usuário pediu
// voltar/avançar e eles arrastam como qualquer outro botão.
check('um botão que não existe não vira bit nenhum', bitDoBotao(7) === 0 && bitDoBotao(-1) === 0);

igual('nada apertado é máscara zero', mascaraDe([]), 0);
igual('esquerdo + direito', mascaraDe([0, 2]), 5);
igual('e a volta: 5 são o esquerdo e o direito', botoesDa(5), [0, 2]);
igual('todos os cinco cabem na máscara', botoesDa(mascaraDe([0, 1, 2, 3, 4])), [0, 1, 2, 3, 4]);
igual('repetir um botão não muda a máscara', mascaraDe([0, 0, 0]), 1);

console.log('\n== a mensagem que chegou atrasada ==\n');

check('a primeira mensagem nunca está atrasada', !estaAtrasada(0, -1));
check('uma mensagem mais nova passa', !estaAtrasada(10, 9));
check('a MESMA mensagem de novo é atrasada (duplicada pela rede)', estaAtrasada(9, 9));
check('uma mensagem mais velha é atrasada', estaAtrasada(3, 9));
// Sem contador: um Ryke Desk mais antigo do outro lado. Não pode parar de
// funcionar por causa disso — só perde a proteção contra o fora de ordem.
check('sem contador, nada é descartado', !estaAtrasada(undefined, 999));

console.log('\n== remontando o gesto ==\n');

igual('quando os dois concordam, não se faz nada', ajustarBotoes([0], BIT_ESQUERDO), {
  pressionar: [],
  soltar: [],
});
igual('nada apertado dos dois lados: nada a fazer', ajustarBotoes([], 0), { pressionar: [], soltar: [] });

// O CASO DO RELATO: "clico e arrasto e não acontece nada". O apertar se perdeu
// e o movimento chega dizendo que o esquerdo está apertado. Antes, o anfitrião
// descartava o movimento e o gesto sumia; agora ele aperta e o arrasto começa.
igual('o "apertar" que se perdeu é recuperado pelo movimento', ajustarBotoes([], BIT_ESQUERDO), {
  pressionar: [0],
  soltar: [],
});

// O oposto, e o mais perigoso: um botão preso na máquina de outra pessoa.
igual('o "soltar" que se perdeu é recuperado pelo movimento', ajustarBotoes([0], 0), {
  pressionar: [],
  soltar: [0],
});

igual('troca de botão no meio do caminho: solta um, aperta o outro', ajustarBotoes([0], BIT_DIREITO), {
  pressionar: [2],
  soltar: [0],
});
igual('dois botões ao mesmo tempo são recuperados juntos', ajustarBotoes([], BIT_ESQUERDO | BIT_DIREITO), {
  pressionar: [0, 2],
  soltar: [],
});
igual('o lateral também arrasta', ajustarBotoes([], BIT_VOLTAR), { pressionar: [3], soltar: [] });
igual(
  'com três apertados e a máscara dizendo um, os outros dois são soltos',
  ajustarBotoes([0, 1, 2], BIT_MEIO),
  { pressionar: [], soltar: [0, 2] },
);

console.log('\n== por qual canal o movimento viaja ==\n');

// A regra inteira: com botão apertado o movimento faz parte de um gesto, e um
// gesto precisa chegar em ordem. Solto, é só a seta passeando.
check('movimento com botão apertado exige ordem', movimentoPrecisaDeOrdem(BIT_ESQUERDO));
check('movimento com o lateral apertado também exige', movimentoPrecisaDeOrdem(BIT_AVANCAR));
check('movimento solto não exige ordem — vai pelo canal rápido', !movimentoPrecisaDeOrdem(0));

console.log('\n== um arrasto inteiro, mensagem por mensagem ==\n');

/**
 * Roda uma sequência de mensagens do jeito que o anfitrião roda, e devolve o
 * que aconteceu com os botões e com o cursor.
 */
function encenar(mensagens) {
  const segurados = new Set();
  let ultimo = -1;
  const injecoes = [];
  let cursor = null;

  for (const m of mensagens) {
    if (estaAtrasada(m.n, ultimo)) {
      injecoes.push(`descartada n=${m.n}`);
      continue;
    }
    ultimo = m.n;
    if (m.t === 'mm') {
      const { pressionar, soltar } = ajustarBotoes(segurados, m.b ?? 0);
      for (const b of pressionar) {
        segurados.add(b);
        injecoes.push(`aperta ${b}`);
      }
      for (const b of soltar) {
        segurados.delete(b);
        injecoes.push(`solta ${b}`);
      }
      if (segurados.size > 0) cursor = m.x;
    } else if (m.t === 'md') {
      segurados.add(m.b);
      cursor = m.x;
      injecoes.push(`aperta ${m.b}`);
    } else if (m.t === 'mu') {
      segurados.delete(m.b);
      injecoes.push(`solta ${m.b}`);
    }
  }
  return { cursor, presos: [...segurados], injecoes };
}

{
  const r = encenar([
    { t: 'md', b: 0, x: 100, n: 1 },
    { t: 'mm', x: 120, b: BIT_ESQUERDO, n: 2 },
    { t: 'mm', x: 160, b: BIT_ESQUERDO, n: 3 },
    { t: 'mu', b: 0, x: 160, n: 4 },
  ]);
  check('arrasto normal: o cursor chega ao fim', r.cursor === 160, `cursor=${r.cursor}`);
  igual('e nada fica preso', r.presos, []);
  igual('com um aperta e um solta, só', r.injecoes, ['aperta 0', 'solta 0']);
}

{
  // O apertar se perdeu de vez. É o relato do usuário.
  const r = encenar([
    { t: 'mm', x: 120, b: BIT_ESQUERDO, n: 2 },
    { t: 'mm', x: 160, b: BIT_ESQUERDO, n: 3 },
    { t: 'mu', b: 0, x: 160, n: 4 },
  ]);
  check('apertar perdido: o arrasto acontece mesmo assim', r.cursor === 160, `cursor=${r.cursor}`);
  igual('e nada fica preso no fim', r.presos, []);
  igual('o apertar foi reconstruído pelo primeiro movimento', r.injecoes, ['aperta 0', 'solta 0']);
}

{
  // O soltar se perdeu. O botão NÃO pode ficar preso.
  const r = encenar([
    { t: 'md', b: 0, x: 100, n: 1 },
    { t: 'mm', x: 160, b: BIT_ESQUERDO, n: 2 },
    { t: 'mm', x: 160, b: 0, n: 3 },
  ]);
  igual('soltar perdido: o movimento seguinte solta o botão', r.presos, []);
  igual('e a ordem foi aperta, solta', r.injecoes, ['aperta 0', 'solta 0']);
}

{
  // O apertar chega ATRASADO, depois de o movimento já ter reconstruído tudo.
  // Obedecê-lo seria inofensivo aqui, mas um "soltar" atrasado desfaria um
  // gesto novo — por isso o descarte vale para todas as mensagens.
  const r = encenar([
    { t: 'mm', x: 120, b: BIT_ESQUERDO, n: 2 },
    { t: 'md', b: 0, x: 100, n: 1 },
    { t: 'mm', x: 160, b: BIT_ESQUERDO, n: 3 },
    { t: 'mu', b: 0, x: 160, n: 4 },
  ]);
  check('o apertar atrasado é descartado', r.injecoes.includes('descartada n=1'));
  check('e o arrasto não volta para o ponto antigo', r.cursor === 160, `cursor=${r.cursor}`);
  igual('nada fica preso', r.presos, []);
}

{
  // Movimento antigo do canal rápido chegando depois de um mais novo.
  const r = encenar([
    { t: 'md', b: 0, x: 100, n: 1 },
    { t: 'mm', x: 200, b: BIT_ESQUERDO, n: 5 },
    { t: 'mm', x: 130, b: BIT_ESQUERDO, n: 3 },
    { t: 'mu', b: 0, x: 200, n: 6 },
  ]);
  check('o movimento atrasado não puxa o arrasto de volta', r.cursor === 200, `cursor=${r.cursor}`);
}

console.log(`\n${falhas === 0 ? 'TUDO OK' : `${falhas} FALHA(S)`}\n`);
process.exit(falhas === 0 ? 0 : 1);
