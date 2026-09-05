/**
 * Como o anfitrião remonta um gesto de mouse a partir de mensagens que podem
 * chegar fora de ordem — ou não chegar.
 *
 * O DEFEITO QUE ISTO CORRIGE
 *
 * Um arrasto são três coisas em sequência: apertar, mover, soltar. O apertar e
 * o soltar viajam pelo canal CONFIÁVEL (ordenado, com retransmissão); os
 * movimentos viajam pelo canal RÁPIDO (sem ordem, sem retransmissão). São dois
 * fluxos independentes do mesmo WebRTC, e entre fluxos não existe promessa de
 * ordem nenhuma.
 *
 * Na mesa, com zero perda, isso nunca aparece. Numa conexão de verdade, o
 * "apertar" espera uma retransmissão enquanto meia dúzia de movimentos passa
 * voando por fora — e o anfitrião, que só movia o cursor "se houver botão
 * apertado", jogava todos eles fora. O gesto chegava despedaçado ou não
 * chegava: apertar e soltar no mesmo ponto, ou seja, um clique parado. Foi
 * medido: com o apertar 220 ms atrasado, 7 dos 14 movimentos se perdiam.
 *
 * A IDEIA
 *
 * Cada mensagem passa a se bastar. Ela diz QUANDO foi dita (`n`, um contador
 * que só cresce) e O QUE ESTAVA APERTADO naquele instante (`b`, uma máscara de
 * bits). Com isso o anfitrião não precisa mais que as mensagens cheguem em
 * ordem — ele descarta as atrasadas e corrige o estado pelo que a mensagem
 * conta, em vez de depender de ter visto o "apertar" antes.
 *
 * Este módulo é só a decisão, sem Windows e sem rede, para o teste alcançar.
 */

/** Bit de cada botão, na numeração do DOM. */
export const BIT_ESQUERDO = 1;
export const BIT_MEIO = 2;
export const BIT_DIREITO = 4;
export const BIT_VOLTAR = 8;
export const BIT_AVANCAR = 16;

/** Todos os botões que o programa conhece, na ordem em que são numerados. */
export const BOTOES = [0, 1, 2, 3, 4] as const;
export type BotaoDoGesto = (typeof BOTOES)[number];

/** O bit correspondente a um botão. */
export function bitDoBotao(botao: number): number {
  return botao >= 0 && botao <= 4 ? 1 << botao : 0;
}

/** A máscara que representa este conjunto de botões apertados. */
export function mascaraDe(botoes: Iterable<number>): number {
  let m = 0;
  for (const b of botoes) m |= bitDoBotao(b);
  return m;
}

/** Os botões apertados nesta máscara. */
export function botoesDa(mascara: number): BotaoDoGesto[] {
  return BOTOES.filter((b) => (mascara & bitDoBotao(b)) !== 0);
}

/**
 * Esta mensagem é mais velha do que a última que já tratamos?
 *
 * O contador vem do visitante e só cresce. Uma mensagem com número MENOR do
 * que o último visto atravessou o canal rápido e chegou atrasada: obedecê-la
 * puxaria o arrasto de volta para um ponto onde ele já não está.
 *
 * Sem contador (`undefined`) nada é descartado — é o caso de um Ryke Desk mais
 * antigo do outro lado, que continua funcionando como antes.
 */
export function estaAtrasada(n: number | undefined, ultimoVisto: number): boolean {
  return typeof n === 'number' && n <= ultimoVisto;
}

/**
 * O que fazer para que os botões apertados aqui virem os da máscara.
 *
 * É a auto-correção: se a mensagem diz "o esquerdo está apertado" e nós não
 * temos nenhum botão registrado, o "apertar" se perdeu ou está atrasado — e o
 * certo é apertar agora, não ignorar o gesto inteiro. Se ela diz "nada
 * apertado" e nós achamos que há, foi o "soltar" que se perdeu — e o certo é
 * soltar, senão o botão fica preso na máquina de outra pessoa, que é o pior
 * estrago que este programa pode causar.
 *
 * @param segurados o que o anfitrião acredita estar apertado
 * @param mascara   o que o visitante diz que está apertado
 */
export function ajustarBotoes(
  segurados: Iterable<number>,
  mascara: number,
): { pressionar: BotaoDoGesto[]; soltar: BotaoDoGesto[] } {
  const agora = mascaraDe(segurados);
  return {
    pressionar: botoesDa(mascara & ~agora),
    soltar: botoesDa(agora & ~mascara),
  };
}

/**
 * O movimento faz parte de um gesto — e por isso precisa do canal ordenado?
 *
 * Com botão apertado, sim: o movimento tem de chegar depois do apertar e antes
 * do soltar, e só o canal confiável garante isso. Sem botão apertado, não: é
 * só a seta passeando, onde perder um quadro não custa nada e a próxima
 * posição já corrige.
 */
export function movimentoPrecisaDeOrdem(mascara: number): boolean {
  return mascara !== 0;
}
