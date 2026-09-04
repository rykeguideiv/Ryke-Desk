/**
 * Os botões do mouse, na numeração do DOM — a mesma que o navegador entrega em
 * `MouseEvent.button` e que o visitante repassa sem traduzir:
 *
 *   0 esquerdo · 1 meio · 2 direito · 3 voltar · 4 avançar
 *
 * Os dois últimos são os laterais, os do polegar. Eles não cabem no mesmo molde
 * dos três primeiros: no Windows, cada um daqueles tem o próprio par de
 * sinalizadores (LEFTDOWN/LEFTUP…), enquanto os laterais dividem UM par só
 * (XDOWN/XUP) e informam qual deles foi num campo à parte. Ver `mouseButton`.
 */
export type BotaoMouse = 0 | 1 | 2 | 3 | 4;

/**
 * Atualiza o estado de um botão e diz se um evento precisa ser enviado.
 * Um RIGHTUP sem RIGHTDOWN pode abrir o menu de contexto do Windows; por isso
 * transições duplicadas são ignoradas, principalmente durante entrar/sair.
 */
export function mudarBotao(
  pressionados: Set<BotaoMouse>,
  botao: BotaoMouse,
  pressionado: boolean,
): boolean {
  const jaEstava = pressionados.has(botao);
  if (pressionado === jaEstava) return false;
  if (pressionado) pressionados.add(botao);
  else pressionados.delete(botao);
  return true;
}

