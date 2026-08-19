export type BotaoMouse = 0 | 1 | 2;

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

