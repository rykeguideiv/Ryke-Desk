/**
 * O empréstimo do cursor — os dois defeitos que este módulo existe para impedir.
 *
 * 1. "O ponteiro branco fica pulando para onde o vermelho vai." O cursor real
 *    era levado até a seta do visitante para clicar e NÃO voltava: ficava
 *    plantado em cima dela. A causa era a pergunta "o cursor ainda está onde eu
 *    o pus?" ser feita cedo demais — o SendInput leva alguns milissegundos para
 *    aparecer no GetCursorPos, então o Windows respondia a posição ANTIGA, o
 *    programa concluía "a pessoa daqui mexeu no mouse" e desistia de devolver.
 *
 * 2. O duplo clique não funcionava: devolvendo o cursor entre o primeiro e o
 *    segundo clique, o Windows via um movimento no meio do par e entregava dois
 *    cliques soltos.
 */
import {
  cursorAindaOndeDeixamos,
  esperaDevolucaoMs,
  TOLERANCIA_CURSOR_PX,
  GRACA_INJECAO_MS,
  ESPERA_MINIMA_MS,
} from '../src/shared/emprestimo-cursor.ts';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

const PUS_AQUI = { x: 800, y: 400 };
/** Onde o dono da máquina tinha deixado o cursor antes do empréstimo. */
const ANTIGA = { x: 100, y: 100 };

// ── O DEFEITO Nº 1: a leitura atrasada não pode desfazer o empréstimo ──
//
// É exatamente o quadro de um duplo clique: injetamos o movimento e, poucos
// milissegundos depois, o Windows ainda responde a posição ANTIGA.
check(
  'leitura atrasada dentro da carência NÃO quebra o empréstimo (o bug do branco preso no vermelho)',
  cursorAindaOndeDeixamos({
    ultimoInjetado: PUS_AQUI,
    desdeAInjecaoMs: 5,
    lerPosicao: () => ANTIGA,
  }) === true,
);

// E, dentro da carência, nem chegamos a perguntar: a resposta seria ignorada e
// perguntar custa uma chamada ao sistema a cada 50 ms.
let perguntou = false;
cursorAindaOndeDeixamos({
  ultimoInjetado: PUS_AQUI,
  desdeAInjecaoMs: 5,
  lerPosicao: () => {
    perguntou = true;
    return ANTIGA;
  },
});
check('dentro da carência nem lemos a posição', perguntou === false);

check(
  'a carência vale até o limite, não além dele',
  cursorAindaOndeDeixamos({
    ultimoInjetado: PUS_AQUI,
    desdeAInjecaoMs: GRACA_INJECAO_MS - 1,
    lerPosicao: () => ANTIGA,
  }) === true,
);

// ── Passada a carência, a leitura vale — e é ela que protege a pessoa daqui ──
check(
  'passada a carência, cursor parado onde o pusemos: empréstimo mantido',
  cursorAindaOndeDeixamos({
    ultimoInjetado: PUS_AQUI,
    desdeAInjecaoMs: GRACA_INJECAO_MS + 50,
    lerPosicao: () => ({ ...PUS_AQUI }),
  }) === true,
);

// O caso que o empréstimo existe para respeitar: a pessoa sentada na máquina
// pegou o mouse de volta. Devolver o cursor agora arrancaria o ponteiro da mão
// dela no meio do trabalho.
check(
  'passada a carência, a pessoa daqui mexeu o mouse: empréstimo desfeito',
  cursorAindaOndeDeixamos({
    ultimoInjetado: PUS_AQUI,
    desdeAInjecaoMs: GRACA_INJECAO_MS + 50,
    lerPosicao: () => ({ x: PUS_AQUI.x + 300, y: PUS_AQUI.y }),
  }) === false,
);

// ── A tolerância: um pixel de arredondamento não é "a pessoa mexeu o mouse" ──
check(
  `desvio de ${TOLERANCIA_CURSOR_PX}px ainda conta como parado`,
  cursorAindaOndeDeixamos({
    ultimoInjetado: PUS_AQUI,
    desdeAInjecaoMs: 999,
    lerPosicao: () => ({ x: PUS_AQUI.x + TOLERANCIA_CURSOR_PX, y: PUS_AQUI.y + TOLERANCIA_CURSOR_PX }),
  }) === true,
);
check(
  `desvio de ${TOLERANCIA_CURSOR_PX + 1}px já é a mão de alguém`,
  cursorAindaOndeDeixamos({
    ultimoInjetado: PUS_AQUI,
    desdeAInjecaoMs: 999,
    lerPosicao: () => ({ x: PUS_AQUI.x + TOLERANCIA_CURSOR_PX + 1, y: PUS_AQUI.y }),
  }) === false,
);

// ── Os casos de borda, onde o seguro é não abandonar o cursor ──
//
// Sem leitura confiável, devolver o cursor depois é reversível; deixá-lo preso
// na seta do visitante não é. Na dúvida, mantemos o empréstimo.
check(
  'leitura falhou: mantém o empréstimo em vez de abandonar o cursor',
  cursorAindaOndeDeixamos({
    ultimoInjetado: PUS_AQUI,
    desdeAInjecaoMs: 999,
    lerPosicao: () => null,
  }) === true,
);
check(
  'nunca injetamos nada: não há empréstimo para manter',
  cursorAindaOndeDeixamos({
    ultimoInjetado: null,
    desdeAInjecaoMs: 999,
    lerPosicao: () => ({ ...PUS_AQUI }),
  }) === false,
);

// ── O DEFEITO Nº 2: a espera precisa cobrir o duplo clique inteiro ──
check(
  'a espera cobre o duplo clique padrão do Windows (500 ms)',
  esperaDevolucaoMs(500) > 500,
  `${esperaDevolucaoMs(500)} ms`,
);
// Quem afrouxou o duplo clique no painel do mouse seria exatamente quem
// ficaria sem ele, se a espera fosse um número fixo.
check(
  'a espera acompanha um duplo clique lento, em vez de um número fixo',
  esperaDevolucaoMs(900) > 900,
  `${esperaDevolucaoMs(900)} ms`,
);
// O piso existe para a ROLAGEM: devolver o cursor entre um tique e o outro
// faria o ponteiro tremer de ida e volta no meio do scroll.
check(
  'um duplo clique curtíssimo não derruba a espera abaixo do piso da rolagem',
  esperaDevolucaoMs(10) === ESPERA_MINIMA_MS,
  `${esperaDevolucaoMs(10)} ms`,
);
check('valor inválido do Windows cai no padrão de 500 ms', esperaDevolucaoMs(0) === esperaDevolucaoMs(500));
check('valor absurdo (NaN) também cai no padrão', esperaDevolucaoMs(NaN) === esperaDevolucaoMs(500));

console.log(falhas === 0 ? '\nEmprestimo do cursor validado.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
