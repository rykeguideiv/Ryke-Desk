/**
 * Quando a barra da sessão aparece, e quando some.
 *
 * O DEFEITO QUE ISTO CORRIGE
 *
 * A barra abria com o cursor a menos de 70 pixels do topo da janela. Só que 70
 * pixels do alto de um computador é onde moram as guias do navegador, a barra
 * de título de toda janela e o menu de todo programa. Ir clicar numa guia do
 * Chrome do computador remoto fazia a barra saltar na frente e receber o
 * clique: o recurso pensado para dar acesso rápido tornava inalcançável
 * justamente a parte mais usada da tela do outro lado.
 *
 * A REGRA
 *
 *   · ENCOSTAR no topo abre. Não chegar perto — encostar.
 *   · Enquanto o cursor estiver na faixa que a barra ocupa, nada muda: é o que
 *     permite descer do topo até os botões sem ela fugir.
 *   · Abaixo dessa faixa, fecha.
 *
 * Encostar é um gesto que ninguém faz por acaso, e é fácil de acertar de
 * propósito porque o sistema prende o cursor na borda da tela: dá para jogar o
 * mouse para cima com força que ele para lá. É a mesma convenção do modo tela
 * cheia de qualquer programa.
 *
 * POR QUE ISTO É UMA FUNÇÃO PURA
 *
 * Porque no navegador não dá para testar honestamente. Ao abrir, a barra muda
 * o que está sob o cursor, e o Chromium dispara um evento de ponteiro novo com
 * a posição REAL do mouse — que num teste automatizado está em outro lugar,
 * fechando a barra de novo. O teste então acusaria um defeito que não existe.
 */

/** Encostou no topo da janela: dois pixels de tolerância, não setenta. */
export const ENCOSTOU_NO_TOPO = 2;

/**
 * Faixa que a barra flutuante ocupa (8px de margem + ~44 de altura, com folga).
 * Dentro dela o estado não muda — é a histerese que impede a barra de fechar
 * no primeiro pixel de descida, antes de o cursor alcançar os botões.
 */
export const FAIXA_DA_BARRA = 62;

/** Quanto a janela pode estar acima do visível, quando maximizada sem moldura. */
export const FOLGA_JANELA = 10;

/**
 * Faixa maior, para quando a barra de abas empurra a barra de menu para baixo.
 *
 * Com duas ou mais conexões, a barra de abas ocupa o topo e a barra de menu
 * desce para baixo dela — seus botões passam a ficar por volta de 46 a 90px do
 * alto. Com a faixa normal de 62, descer até os botões já os "perdia": o cursor
 * cruzava os 62px e a barra fechava antes de o clique acontecer. Esta faixa
 * cobre a barra de abas mais a de menu inteira.
 */
export const FAIXA_COM_ABAS = 108;

/**
 * O novo estado da barra, dado onde o cursor está.
 *
 * `screenY` entra como segunda chance para o caso de a janela estar alguns
 * pixels acima do visível — coisa que acontece com janela sem moldura
 * maximizada. Sem isso, `clientY` nunca chegaria a zero nessas máquinas e a
 * barra seria impossível de abrir. As duas condições juntas, e não `screenY`
 * sozinho, porque num monitor posicionado ACIMA do principal o `screenY` é
 * negativo em toda a área — e a barra viveria aberta.
 */
export function decidirBarra(
  aberta: boolean,
  clientY: number,
  screenY: number,
  faixa: number = FAIXA_DA_BARRA,
): boolean {
  if (clientY <= ENCOSTOU_NO_TOPO) return true;
  if (screenY <= 1 && clientY <= FOLGA_JANELA) return true;
  if (clientY > faixa) return false;
  return aberta;
}
