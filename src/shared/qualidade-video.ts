/**
 * Perfis de qualidade do vídeo WebRTC — o que muda quando se escolhe
 * Baixa / Média / Alta / Automático.
 *
 * POR QUE ESTE ARQUIVO EXISTE (E POR QUE "BAIXAR A QUALIDADE NÃO ADIANTAVA")
 *
 * A redução de resolução era um FATOR FIXO (`scaleResolutionDownBy`): "baixa"
 * encolhia 1,5×, "média" não encolhia nada. Numa tela grande isso não resolve:
 * 1,5× de um monitor 4K ainda são 1440p, e "média" mandava o codificador
 * engolir os 4K inteiros. O resultado era o pior dos mundos — muito
 * processador gasto codificando uma imagem enorme, pouca banda para tanta
 * área, e por isso a imagem saía borrada E atrasada ao mesmo tempo. Baixar a
 * qualidade só apertava a banda: a imagem piorava e o custo de codificação —
 * que é onde mora o atraso — continuava o mesmo.
 *
 * A correção é mirar uma ALTURA de vídeo, não um fator. "Baixa" mira 720p e
 * "média" 1080p seja qual for o tamanho do monitor. Assim, baixar a qualidade
 * de fato reduz a área que o codificador precisa comprimir — o processador
 * respira, a fila de codificação esvazia e a latência cai junto. É o número
 * que o usuário sente quando move o mouse.
 *
 * A lógica aqui é pura de propósito (entra resolução da fonte, sai o fator de
 * escala) para poder ser exercitada nos testes sem WebRTC nenhum.
 */
import type { Quality } from './config';

/**
 * Preferência de degradação do codificador, em texto puro.
 *
 * O tipo nativo do navegador (`RTCDegradationPreference`) mora na biblioteca
 * DOM, que o processo principal não inclui. Como este módulo é compartilhado
 * pelos dois ambientes, usamos a união de strings equivalente — os valores são
 * exatamente os que o WebRTC espera.
 */
export type Degradacao = 'balanced' | 'maintain-framerate' | 'maintain-resolution';

export type PerfilQualidade = {
  /** Teto de banda do codificador, em bits/s. */
  maxBitrate: number;
  /**
   * Altura de vídeo, em linhas, que o codificador deve mirar. `0` = resolução
   * nativa (não encolhe). É o coração do conserto explicado no topo.
   */
  alturaAlvo: number;
  /** Quadros por segundo no codificador. Ausente = sem limite explícito. */
  framerate?: number;
  /** Dica ao codificador: 'detail' preserva texto; 'motion' prioriza fluidez. */
  hint: 'detail' | 'motion';
  degradation: Degradacao;
};

/**
 * Teto de altura do modo automático.
 *
 * Em 'auto', mesmo com rede sobrando, codificar 4K cheio custa muito
 * processador e enche a fila de codificação — atraso que ninguém pediu. 1440p
 * mantém o texto nítido por uma fração do custo. Quem quer o pixel exato de 4K
 * tem o preset 'alta', que libera a resolução nativa de propósito.
 */
export const ALTURA_MAX_AUTO = 1440;

export const PERFIS_QUALIDADE: Record<Quality, PerfilQualidade> = {
  // Tudo o que a máquina e a rede derem: resolução nativa, 60 quadros, banda
  // larga. 'balanced' em vez de 'maintain-resolution' porque o pedido é imagem
  // boa E veloz — sob pressão, é melhor ceder um pouco dos dois do que travar
  // os quadros para segurar cada pixel.
  alta: { maxBitrate: 24_000_000, alturaAlvo: 0, framerate: 60, hint: 'detail', degradation: 'balanced' },
  // Meio-termo real: 1080p com banda suficiente para ficar nítido nessa altura.
  media: { maxBitrate: 5_000_000, alturaAlvo: 1080, framerate: 30, hint: 'detail', degradation: 'maintain-framerate' },
  // Leve de verdade: 720p, poucos bits, movimento fluido — para máquina ou rede
  // fraca. Agora encolher a imagem REALMENTE alivia o processador.
  baixa: { maxBitrate: 1_500_000, alturaAlvo: 720, framerate: 30, hint: 'motion', degradation: 'maintain-framerate' },
  // Padrão adaptativo. A banda aqui vale só até a primeira medida do adaptador;
  // a altura-alvo é o teto que o adaptador nunca ultrapassa (ver ALTURA_MAX_AUTO).
  auto: { maxBitrate: 8_000_000, alturaAlvo: ALTURA_MAX_AUTO, hint: 'detail', degradation: 'balanced' },
};

/**
 * Fator de redução (`scaleResolutionDownBy`) para mirar uma altura a partir da
 * resolução real da fonte.
 *
 * Nunca amplia: se a tela já é menor que o alvo, devolve 1. `alturaAlvo <= 0`
 * também devolve 1 (resolução nativa). Fonte inválida cai para 1, para nunca
 * devolver um fator absurdo ao WebRTC.
 */
export function escalaParaAltura(alturaFonte: number, alturaAlvo: number): number {
  if (alturaAlvo <= 0) return 1;
  if (!Number.isFinite(alturaFonte) || alturaFonte <= 0) return 1;
  return Math.max(1, alturaFonte / alturaAlvo);
}
