/**
 * O julgamento por trás do EMPRÉSTIMO DO CURSOR.
 *
 * O Windows tem um ponteiro só. A seta de cada visitante é virtual — um
 * desenho —, mas clicar exige o ponteiro de verdade embaixo do alvo: não existe
 * "clicar ali" sem estar ali. Então o cursor real é pego emprestado pelo tempo
 * do clique e devolvido depois.
 *
 * Duas decisões desse empréstimo deram defeito de verdade, e é por isso que
 * moram aqui, separadas do Electron e cobertas por teste:
 *
 *   1. "O cursor ainda está onde eu o pus?" — se saiu, quem o moveu foi a
 *      pessoa sentada na máquina, e devolvê-lo arrancaria o ponteiro da mão
 *      dela. O erro estava em perguntar isso CEDO DEMAIS (ver a carência).
 *   2. "Quanto esperar antes de devolver?" — devolver rápido demais quebra o
 *      duplo clique e a rolagem contínua.
 */

/** Folga em pixels para considerar que o cursor não saiu de onde o pusemos. */
export const TOLERANCIA_CURSOR_PX = 2;

/**
 * Quanto esperar até acreditar no que o Windows responde sobre a posição.
 *
 * O `SendInput` não aparece no `GetCursorPos` no mesmo instante: há uma janela
 * de alguns milissegundos em que o Windows ainda devolve a posição ANTIGA.
 */
export const GRACA_INJECAO_MS = 120;

export type Ponto = { x: number; y: number };

export type EstadoDoCursor = {
  /** O último ponto que NÓS injetamos; null se nunca injetamos nada. */
  ultimoInjetado: Ponto | null;
  /** Há quantos milissegundos aquela injeção foi feita. */
  desdeAInjecaoMs: number;
  /**
   * Onde o Windows diz que o cursor está; null quando a leitura falhou.
   *
   * É uma função, e não um valor, porque durante a carência a resposta é
   * ignorada — e perguntar custa uma chamada ao sistema a cada 50 ms.
   */
  lerPosicao: () => Ponto | null;
};

/**
 * O cursor ainda está onde NÓS o pusemos?
 *
 * `false` significa "a pessoa daqui pegou o mouse de volta" — e a partir daí o
 * empréstimo não vale mais: não devolvemos nada e voltamos a relatar a posição
 * real dela.
 *
 * A CARÊNCIA é o que conserta o "ponteiro branco preso no vermelho". Num DUPLO
 * CLIQUE o soltar vem poucos milissegundos depois do apertar; perguntado nesse
 * intervalo, o Windows ainda respondia a posição ANTIGA, concluíamos que a
 * pessoa daqui tinha mexido no mouse e abandonávamos o empréstimo sem devolver
 * coisa alguma — deixando o cursor plantado em cima da seta do visitante, para
 * sempre. Dentro da carência, acreditamos no que acabamos de injetar em vez da
 * leitura ainda atrasada.
 *
 * Quando a leitura falha, o seguro é MANTER o empréstimo: devolver o cursor
 * depois é reversível; deixá-lo preso na seta do visitante não.
 */
export function cursorAindaOndeDeixamos(
  estado: EstadoDoCursor,
  tolerancia = TOLERANCIA_CURSOR_PX,
  graca = GRACA_INJECAO_MS,
): boolean {
  const { ultimoInjetado, desdeAInjecaoMs, lerPosicao } = estado;
  if (!ultimoInjetado) return false;
  if (desdeAInjecaoMs < graca) return true;
  const leitura = lerPosicao();
  if (!leitura) return true;
  return (
    Math.abs(leitura.x - ultimoInjetado.x) <= tolerancia &&
    Math.abs(leitura.y - ultimoInjetado.y) <= tolerancia
  );
}

/** Piso da espera: cobre a rajada de tiques de uma rolagem contínua. */
export const ESPERA_MINIMA_MS = 400;
/** Folga sobre o duplo clique, para o atraso de rede entre soltar e apertar. */
export const FOLGA_DUPLO_CLIQUE_MS = 150;

/**
 * Quanto o cursor emprestado espera antes de voltar para o dono.
 *
 * Precisa cobrir DOIS intervalos:
 *   • a rajada de tiques de uma rolagem contínua — devolver entre um tique e o
 *     outro faria o cursor tremer de ida e volta;
 *   • a pausa entre os dois cliques de um DUPLO CLIQUE — se o cursor voltar no
 *     meio do par, o Windows vê um movimento entre eles e entrega dois cliques
 *     soltos em vez de um duplo.
 *
 * O intervalo do duplo clique vem do próprio Windows (`GetDoubleClickTime`), e
 * não de um chute: quem afrouxou esse tempo no painel do mouse seria
 * exatamente quem ficaria sem duplo clique.
 */
export function esperaDevolucaoMs(duploCliqueMs: number): number {
  const base = Number.isFinite(duploCliqueMs) && duploCliqueMs > 0 ? duploCliqueMs : 500;
  return Math.max(ESPERA_MINIMA_MS, Math.round(base) + FOLGA_DUPLO_CLIQUE_MS);
}
