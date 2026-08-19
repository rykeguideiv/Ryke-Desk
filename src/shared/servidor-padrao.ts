/**
 * Ponto de encontro próprio — opcional, e quase sempre ausente.
 *
 * Houve uma época em que este valor era obrigatório: o programa só funcionava
 * se quem gerasse o instalador tivesse um servidor na internet e gravasse o
 * endereço dele aqui. Isso ficou para trás. Hoje os computadores se encontram
 * numa malha de corretores públicos (ver `malha.ts`) e o valor normal deste
 * campo é string vazia.
 *
 * O que sobrou é uma porta para quem quiser um corretor MQTT próprio — por
 * política interna, ou para não depender de serviço de cortesia de terceiros.
 * O endereço entra *somando* aos públicos, nunca substituindo: quem aponta o
 * seu não fica sem saída se ele cair.
 *
 *   set RYKE_SERVIDOR=wss://mqtt.suaempresa.com.br && npm run dist
 */

declare const __RYKE_SERVIDOR__: string;

export const SERVIDOR_PADRAO: string =
  typeof __RYKE_SERVIDOR__ === 'string' ? __RYKE_SERVIDOR__ : '';

/**
 * O texto é um endereço de corretor utilizável?
 *
 * Vazio é resposta legítima — significa "use só a malha pública", que é o
 * caminho normal. Esta função existe para separar o vazio (intencional) de um
 * endereço digitado pela metade (engano), e não para decidir se o programa
 * pode funcionar: ele pode, com ou sem isto.
 */
export function servidorConfigurado(url: string): boolean {
  return /^wss?:\/\/.+/i.test(url.trim());
}
