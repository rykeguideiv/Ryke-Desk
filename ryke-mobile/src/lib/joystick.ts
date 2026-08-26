/**
 * Mover o cursor do computador com o polegar.
 *
 * POR QUE UM JOYSTICK, SE JÁ DÁ PARA TOCAR NA TELA
 *
 * Tocar na tela é ótimo para acertar um alvo grande e péssimo para tudo o
 * mais: o dedo tapa exatamente o pixel que se quer ver, uma tela de 1920
 * espremida em seis polegadas dá cerca de três pixels remotos por pixel do
 * celular, e não existe "chegar perto e ajustar" — ou o dedo acertou, ou
 * clicou noutro lugar.
 *
 * O joystick inverte isso. Ele não diz PARA ONDE ir, diz PARA QUE LADO e
 * QUÃO RÁPIDO. O dedo fica num canto morto da tela, longe do alvo, e o cursor
 * caminha até onde precisa — como um analógico de videogame, que é o gesto que
 * qualquer pessoa já tem no dedo.
 *
 * TRÊS DECISÕES QUE FAZEM A DIFERENÇA ENTRE PRECISO E INTRAGÁVEL
 *
 * 1. ZONA MORTA. O polegar apoiado nunca fica parado de verdade. Sem uma
 *    faixa central que não conta, o cursor vagaria sozinho o tempo todo.
 *
 * 2. CURVA. A velocidade não é proporcional à inclinação, é ela elevada a
 *    ~1.9. Meio caminho da haste dá menos de um quinto da velocidade máxima:
 *    o começo do movimento é lento o bastante para caçar um pixel, e a ponta
 *    é rápida o bastante para atravessar a tela sem tédio.
 *
 * 3. TEMPO REAL, COM TETO. O passo é multiplicado pelo tempo decorrido, senão
 *    a velocidade dependeria da taxa de quadros do aparelho. E o tempo é
 *    limitado a 60ms: quando o Android congela a WebView por meio segundo, o
 *    primeiro quadro de volta não pode teletransportar o cursor.
 *
 * Tudo aqui é função pura, de propósito — é o que permite provar o
 * comportamento com relógio de mentira, sem tela e sem celular.
 */

export type Ponto = { x: number; y: number };
export type Caixa = { left: number; top: number; width: number; height: number };

/**
 * Raio da base do joystick, em pixels — só o valor de partida.
 *
 * A interface mede a base de verdade a cada toque, porque ela muda de tamanho
 * entre telas pequenas e o aparelho deitado. Se o cálculo usasse um número
 * fixo, arrastar até a borda da base daria velocidade diferente em cada
 * aparelho.
 */
export const RAIO_BASE = 66;
/** Abaixo desta inclinação o cursor não anda. Polegar apoiado é polegar parado. */
export const ZONA_MORTA = 0.14;
/** Frações de tela por segundo com a haste no batente: a tela inteira em 1s. */
export const VELOCIDADE_MAX = 1.0;
/** Expoente da curva. Maior = mais preciso perto do centro. */
export const CURVA = 1.9;
/** Teto do passo de tempo, para um travamento não virar um salto. */
export const PASSO_MAXIMO_MS = 60;

const preso = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/**
 * Onde o dedo está, em relação ao centro da base, virando vetor de -1 a 1.
 *
 * Passando do raio, o vetor fica com comprimento 1 e só a direção conta — é o
 * batente. Arrastar o dedo para fora da base não acelera mais, o que evita que
 * o cursor dispare quando o polegar escorrega para a borda da tela.
 */
export function vetorDoDedo(dx: number, dy: number, raio: number = RAIO_BASE): Ponto {
  const d = Math.hypot(dx, dy);
  if (d === 0) return { x: 0, y: 0 };
  if (d <= raio) return { x: dx / raio, y: dy / raio };
  return { x: dx / d, y: dy / d };
}

/**
 * Um passo do cursor: posição atual + inclinação + tempo decorrido.
 *
 * O cursor é guardado em fração da tela (0 a 1), e não em pixels, porque o
 * outro lado pode ter qualquer resolução e pode até trocar de monitor no meio
 * da sessão. Quem multiplica pela resolução é o anfitrião, na hora de injetar.
 */
export function passoCursor(cursor: Ponto, vetor: Ponto, dtMs: number): Ponto {
  const bruto = Math.hypot(vetor.x, vetor.y);
  if (bruto === 0) return cursor;
  // Dois papéis separados para o mesmo vetor: o comprimento (limitado a 1) diz
  // a VELOCIDADE; a direção sai do comprimento cru. Usar o valor limitado nos
  // dois faria a diagonal andar 41% mais rápido que a reta — um controle que
  // puxa para o canto sem que o dedo tenha pedido.
  const m = Math.min(1, bruto);
  if (m <= ZONA_MORTA) return cursor;
  const util = (m - ZONA_MORTA) / (1 - ZONA_MORTA);
  const dt = preso(dtMs, 0, PASSO_MAXIMO_MS) / 1000;
  const passo = VELOCIDADE_MAX * Math.pow(util, CURVA) * dt;
  return {
    x: preso(cursor.x + (vetor.x / bruto) * passo, 0, 1),
    y: preso(cursor.y + (vetor.y / bruto) * passo, 0, 1),
  };
}

/**
 * Onde a imagem realmente está dentro do elemento de vídeo.
 *
 * O vídeo usa `object-fit: contain`, então a tela de um PC 16:9 dentro de um
 * celular 20:9 deitado deixa duas tarjas pretas nas laterais. Medir pelo
 * elemento, e não pela imagem, joga o cursor para longe do lugar onde o dedo
 * encostou — e o erro cresce justamente nas bordas, onde ficam a barra de
 * tarefas e os botões de fechar janela.
 */
export function caixaConteudo(caixa: Caixa, largura: number, altura: number): Caixa {
  if (largura <= 0 || altura <= 0 || caixa.width <= 0 || caixa.height <= 0) return caixa;
  const proporcao = largura / altura;
  const proporcaoCaixa = caixa.width / caixa.height;
  if (proporcaoCaixa > proporcao) {
    // Sobra largura: tarjas nas laterais.
    const w = caixa.height * proporcao;
    return { left: caixa.left + (caixa.width - w) / 2, top: caixa.top, width: w, height: caixa.height };
  }
  // Sobra altura: tarjas em cima e embaixo.
  const h = caixa.width / proporcao;
  return { left: caixa.left, top: caixa.top + (caixa.height - h) / 2, width: caixa.width, height: h };
}

/** Ponto na tela do celular → fração da tela do PC. Fora da imagem, gruda na borda. */
export function telaParaFracao(caixa: Caixa, ponto: Ponto): Ponto {
  return {
    x: preso((ponto.x - caixa.left) / caixa.width, 0, 1),
    y: preso((ponto.y - caixa.top) / caixa.height, 0, 1),
  };
}

/** Fração da tela do PC → ponto na tela do celular. O caminho de volta, para desenhar o marcador. */
export function fracaoParaTela(caixa: Caixa, fracao: Ponto): Ponto {
  return { x: caixa.left + fracao.x * caixa.width, y: caixa.top + fracao.y * caixa.height };
}

/**
 * Limita o arrasto da visualização ampliada.
 *
 * Sem limite, um arrasto entusiasmado empurra a imagem inteira para fora da
 * tela e o usuário fica olhando para o preto sem entender o que aconteceu.
 */
export function limitarPan(pan: Ponto, zoom: number, largura: number, altura: number): Ponto {
  if (zoom <= 1) return { x: 0, y: 0 };
  const maxX = (largura * (zoom - 1)) / 2;
  const maxY = (altura * (zoom - 1)) / 2;
  return { x: preso(pan.x, -maxX, maxX), y: preso(pan.y, -maxY, maxY) };
}
