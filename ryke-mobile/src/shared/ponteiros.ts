/**
 * As setas da sessão: quem é cada uma, de que cor, e onde está.
 *
 * O PROBLEMA QUE ISTO RESOLVE
 *
 * O Windows tem UM ponteiro só. Enquanto o visitante mexia o mouse e nós
 * mandávamos aquilo direto para o SendInput, as duas pessoas disputavam o
 * mesmo cursor: quem estava no anfitrião via a seta dele fugir da mão, e o
 * visitante via a própria seta ser puxada de volta. Com dois visitantes ficava
 * pior — três mãos, um ponteiro.
 *
 * A saída é separar "onde eu estou apontando" de "onde o ponteiro do Windows
 * está". Cada visitante passa a ter um ponteiro VIRTUAL, que é só um desenho:
 * anda sozinho, não encosta no cursor do sistema e não atrapalha ninguém. O
 * ponteiro real do anfitrião continua sendo dele, e só é emprestado no
 * instante exato de um clique (ver `pegarCursorEmprestado` em main/index.ts),
 * e a seta branca continua sendo relatada no lugar do dono enquanto isso dura.
 *
 * A COR É A IDENTIDADE
 *
 * Quem chega primeiro fica vermelho, o segundo azul, o terceiro verde, e assim
 * por diante. O dono da máquina não recebe cor nenhuma: a seta dele é a do
 * Windows, sem alteração — é justamente a ausência de cor que a identifica.
 *
 * Debaixo de cada seta colorida vai o nome de quem a comanda, em letra
 * pequena. Sem isso, três setas coloridas na tela são três enigmas.
 */

import type { TipoCursor } from './protocol';

// A forma do cursor é parte do contrato de rede, então mora em `protocol.ts`.
// Reexportamos aqui porque quem desenha as setas pensa nela junto com a cor.
export type { TipoCursor };

export type CorPonteiro = {
  /** Nome em português, para a interface falar dela ("sua seta é a azul"). */
  nome: string;
  /** Preenchimento da seta. */
  fill: string;
  /** Contorno — separa a seta de fundos da mesma cor. */
  stroke: string;
  /** Fundo da plaquinha com o nome. */
  etiqueta: string;
  /** Texto da plaquinha, escolhido para ter contraste com `etiqueta`. */
  texto: string;
};

/**
 * A ordem importa e é a pedida: 1º vermelho, 2º azul, 3º verde.
 *
 * As seguintes foram escolhidas para continuarem distinguíveis entre si e do
 * cursor branco do Windows, inclusive por quem confunde vermelho e verde — daí
 * o azul em segundo, e não o verde.
 */
export const CORES_PONTEIRO: CorPonteiro[] = [
  { nome: 'vermelha', fill: '#ff2f2f', stroke: '#ffffff', etiqueta: '#c81111', texto: '#ffffff' },
  { nome: 'azul', fill: '#2f6bff', stroke: '#ffffff', etiqueta: '#1442c4', texto: '#ffffff' },
  { nome: 'verde', fill: '#18b84a', stroke: '#ffffff', etiqueta: '#0d8434', texto: '#ffffff' },
  { nome: 'amarela', fill: '#ffd21e', stroke: '#3a2c00', etiqueta: '#ffd21e', texto: '#2a2000' },
  { nome: 'roxa', fill: '#a24bff', stroke: '#ffffff', etiqueta: '#7a1fe0', texto: '#ffffff' },
  { nome: 'laranja', fill: '#ff7a18', stroke: '#ffffff', etiqueta: '#d95a00', texto: '#ffffff' },
  { nome: 'rosa', fill: '#ff4fa3', stroke: '#ffffff', etiqueta: '#d81b74', texto: '#ffffff' },
  { nome: 'ciano', fill: '#12c2d6', stroke: '#08323a', etiqueta: '#0b8fa0', texto: '#ffffff' },
];

/**
 * A cor do visitante de número `indice` (0 = o primeiro que entrou).
 *
 * Passa a repetir depois da oitava. Repetir é ruim, mas menos ruim do que
 * inventar tons que ninguém distingue: oito pessoas comandando o mesmo
 * computador ao mesmo tempo é um cenário que a cor já não resolve sozinha, e
 * para ele existe o nome embaixo da seta.
 */
export function corDoPonteiro(indice: number): CorPonteiro {
  const n = CORES_PONTEIRO.length;
  return CORES_PONTEIRO[((indice % n) + n) % n];
}

/**
 * O menor índice de cor que ainda não está em uso.
 *
 * Reaproveitar o buraco que alguém deixou ao sair é o que mantém a promessa
 * "o primeiro é vermelho": se o vermelho desconecta e outro entra, o novo
 * herda o vermelho em vez de virar o quarto de uma fila que já não existe.
 */
export function proximaCorLivre(usados: Iterable<number>): number {
  const ocupados = new Set(usados);
  let i = 0;
  while (ocupados.has(i)) i++;
  return i;
}

/** O contorno da seta, nas mesmas proporções da seta padrão do Windows. */
export const SETA_PATH = 'M1.6 1.2 L1.6 17 L5.4 13.4 L8 19.9 L10.7 18.8 L8.1 12.5 L13.2 12.5 Z';

/** Ponta da seta, em pixels dentro do desenho — é por onde ela aponta. */
export const SETA_HOTSPOT = { x: 2, y: 2 };

/**
 * O desenho de cada forma de cursor, na cor do visitante, e por onde ela aponta.
 *
 * `inner` recebe as cores e devolve o miolo do SVG (sem a plaquinha do nome).
 * `hx/hy` é o ponto ativo dentro do desenho — o pixel que fica exatamente sobre
 * o alvo, usado para encostar a forma no lugar certo (o "hotspot").
 *
 * Formas que não têm desenho próprio caem na seta comum: a SUA seta ainda
 * mostra a forma exata, porque usa o cursor nativo do sistema; só o desenho que
 * os OUTROS veem, e o da camada do anfitrião, recai na seta — um detalhe
 * secundário que não vale um glifo tosco.
 */
type Glifo = { inner: (fill: string, stroke: string) => string; hx: number; hy: number };

const setaGlifo: Glifo = {
  inner: (fill, stroke) =>
    `<path d="${SETA_PATH}" fill="${fill}" stroke="${stroke}" stroke-width="1.3" stroke-linejoin="round"/>`,
  hx: SETA_HOTSPOT.x,
  hy: SETA_HOTSPOT.y,
};

const GLIFOS: Partial<Record<TipoCursor, Glifo>> = {
  default: setaGlifo,
  // Cursor de texto (viga em I): duas barras horizontais e uma vertical.
  text: {
    inner: (fill, stroke) =>
      `<g fill="${fill}" stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round">` +
      `<rect x="8.6" y="2" width="2.8" height="18" rx="0.5"/>` +
      `<rect x="5.6" y="2" width="8.8" height="2.4" rx="0.6"/>` +
      `<rect x="5.6" y="17.6" width="8.8" height="2.4" rx="0.6"/></g>`,
    hx: 10,
    hy: 11,
  },
  // Setas duplas de redimensionamento — a família do "arrastar a borda".
  'ew-resize': {
    inner: (fill, stroke) =>
      `<g fill="${fill}" stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round">` +
      `<rect x="4" y="9.4" width="14" height="3.2" rx="0.6"/>` +
      `<path d="M1.5 11 L6 7 L6 15 Z"/><path d="M20.5 11 L16 7 L16 15 Z"/></g>`,
    hx: 11,
    hy: 11,
  },
  'ns-resize': {
    inner: (fill, stroke) =>
      `<g fill="${fill}" stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round">` +
      `<rect x="9.4" y="4" width="3.2" height="14" rx="0.6"/>` +
      `<path d="M11 1.5 L7 6 L15 6 Z"/><path d="M11 20.5 L7 16 L15 16 Z"/></g>`,
    hx: 11,
    hy: 11,
  },
  'nwse-resize': {
    inner: (fill, stroke) =>
      `<g fill="${fill}" stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round">` +
      `<path d="M5 6.4 L6.4 5 L18 16.6 L16.6 18 Z"/>` +
      `<path d="M2.2 2.2 L9 3.4 L3.4 9 Z"/><path d="M19.8 19.8 L13 18.6 L18.6 13 Z"/></g>`,
    hx: 11,
    hy: 11,
  },
  'nesw-resize': {
    inner: (fill, stroke) =>
      `<g fill="${fill}" stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round">` +
      `<path d="M17 6.4 L15.6 5 L4 16.6 L5.4 18 Z"/>` +
      `<path d="M19.8 2.2 L13 3.4 L18.6 9 Z"/><path d="M2.2 19.8 L9 18.6 L3.4 13 Z"/></g>`,
    hx: 11,
    hy: 11,
  },
  // Mover (quatro setas): o cursor de arrastar uma janela ou seleção inteira.
  move: {
    inner: (fill, stroke) =>
      `<g fill="${fill}" stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round">` +
      `<rect x="9.4" y="5" width="3.2" height="12" rx="0.6"/><rect x="5" y="9.4" width="12" height="3.2" rx="0.6"/>` +
      `<path d="M11 1.5 L7.6 5.5 L14.4 5.5 Z"/><path d="M11 20.5 L7.6 16.5 L14.4 16.5 Z"/>` +
      `<path d="M1.5 11 L5.5 7.6 L5.5 14.4 Z"/><path d="M20.5 11 L16.5 7.6 L16.5 14.4 Z"/></g>`,
    hx: 11,
    hy: 11,
  },
  // Cruz de precisão.
  crosshair: {
    inner: (fill, stroke) =>
      `<g fill="${fill}" stroke="${stroke}" stroke-width="0.7" stroke-linejoin="round">` +
      `<rect x="9.9" y="1.5" width="2.2" height="19" rx="0.3"/><rect x="1.5" y="9.9" width="19" height="2.2" rx="0.3"/></g>`,
    hx: 11,
    hy: 11,
  },
  // Proibido: o círculo cortado.
  'not-allowed': {
    inner: (_fill, stroke) =>
      `<g fill="none" stroke-linecap="round">` +
      `<circle cx="11" cy="11" r="7.6" stroke="${stroke}" stroke-width="4.2"/>` +
      `<line x1="5.6" y1="5.6" x2="16.4" y2="16.4" stroke="${stroke}" stroke-width="4.2"/>` +
      `<circle cx="11" cy="11" r="7.6" stroke="#e11d1d" stroke-width="2.5"/>` +
      `<line x1="5.6" y1="5.6" x2="16.4" y2="16.4" stroke="#e11d1d" stroke-width="2.5"/></g>`,
    hx: 11,
    hy: 11,
  },
};

/** A forma cai na seta comum quando não há desenho próprio. */
function glifoDoCursor(tipo: TipoCursor | undefined): Glifo {
  return (tipo && GLIFOS[tipo]) || setaGlifo;
}

/** Por onde a forma aponta — usado para encostá-la no ponto certo na tela. */
export function hotspotDaSeta(tipo?: TipoCursor): { x: number; y: number } {
  const g = glifoDoCursor(tipo);
  return { x: g.hx, y: g.hy };
}

/**
 * Só a forma do cursor, sem a plaquinha do nome.
 *
 * É o que a seta do ANFITRIÃO usa: o nome da máquina já vai numa etiqueta
 * separada ao lado, então aqui basta o desenho — na cor clara e neutra do
 * cursor do dono, que muda de forma sem virar mais uma seta colorida.
 */
export function svgDoCursorSozinho(cor: CorPonteiro, tipo?: TipoCursor): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
    glifoDoCursor(tipo).inner(cor.fill, cor.stroke) +
    `</svg>`
  );
}

/** É a seta comum? Então o visitante mantém a própria seta colorida. */
export function ehCursorPadrao(tipo?: TipoCursor): boolean {
  return !tipo || tipo === 'default';
}

/** Um ponteiro virtual em trânsito: posição em fração da tela (0..1). */
export type Ponteiro = {
  /** Número Ryke de quem comanda esta seta. */
  id: string;
  /** O que vai escrito embaixo da seta. */
  nome: string;
  /** Índice na paleta; -1 = o dono da máquina, que não recebe cor. */
  cor: number;
  x: number;
  y: number;
  /**
   * Não desenhe a seta — mas NÃO finja que esta pessoa não está aqui.
   *
   * Ligado enquanto o visitante está no Modo Gamer, onde a mira é desenhada
   * pelo próprio jogo e uma seta colorida parada em cima dela só atrapalha.
   *
   * A distinção entre "esconder a seta" e "tirar da lista" é de segurança, e
   * custou uma versão para ficar clara: a tarja de "este computador está sendo
   * controlado" é montada a partir desta mesma lista. Se entrar no Modo Gamer
   * removesse a pessoa da lista, bastaria ligar o modo para a tarja sumir — um
   * botão de invisibilidade dentro de um programa de acesso remoto, que é
   * exatamente o que ele não pode ter.
   */
  oculta?: boolean;
  /**
   * A forma da seta agora, conforme o que há embaixo dela no anfitrião.
   *
   * Ausente ou 'default' = a seta comum. Ver `TipoCursor`.
   */
  tipo?: TipoCursor;
};

/** Corta nomes longos para a plaquinha não virar uma faixa atravessando a tela. */
export function nomeCurto(nome: string, limite = 18): string {
  const limpo = nome.trim();
  if (limpo.length <= limite) return limpo;
  return `${limpo.slice(0, limite - 1)}…`;
}

/** Escapa o que vai dentro de um texto de SVG. */
function escaparXml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * O desenho completo de uma seta: o bico colorido e o nome logo abaixo.
 *
 * Um só gerador serve aos três lugares onde a seta aparece — o cursor do
 * sistema no visitante, a camada por cima da tela do anfitrião e as setas dos
 * outros visitantes desenhadas sobre o vídeo. Desenhá-la três vezes deixaria
 * as três versões envelhecerem separadas, que é como uma delas acaba com a
 * cor certa e o nome errado.
 */
export function svgDaSeta(cor: CorPonteiro, nome: string, tipo?: TipoCursor): string {
  const texto = escaparXml(nomeCurto(nome));
  // ~6,2 px por caractere a 10 px de altura, mais um respiro de cada lado.
  const larguraEtiqueta = Math.max(28, Math.round(texto.length * 6.2) + 12);
  const largura = Math.max(24, larguraEtiqueta + 4);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="42" viewBox="0 0 ${largura} 42">`,
    glifoDoCursor(tipo).inner(cor.fill, cor.stroke),
    `<rect x="4" y="24" width="${larguraEtiqueta}" height="14" rx="4" fill="${cor.etiqueta}" opacity="0.95"/>`,
    `<text x="${4 + larguraEtiqueta / 2}" y="34" font-family="Segoe UI, Arial, sans-serif" font-size="10"`,
    ` font-weight="600" fill="${cor.texto}" text-anchor="middle">${texto}</text>`,
    `</svg>`,
  ].join('');
}

/**
 * O mesmo desenho, pronto para entrar num `cursor:` do CSS.
 *
 * É assim que o visitante vê a PRÓPRIA seta: não é um elemento desenhado pela
 * página, é o cursor do sistema, trocado. A diferença se sente na mão — um
 * elemento da página persegue o mouse com um quadro de atraso, o cursor do
 * sistema não tem atraso nenhum porque é o Windows que o move.
 *
 * O Chromium recusa cursores acima de 128 px; por isso o nome é cortado antes.
 */
export function cursorCssDaSeta(cor: CorPonteiro, nome: string): string {
  const svg = svgDaSeta(cor, nome);
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${SETA_HOTSPOT.x} ${SETA_HOTSPOT.y}, default`;
}
