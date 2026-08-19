/**
 * Converte a posição do ponteiro dentro do elemento <video> em fração da tela
 * remota (0..1).
 *
 * O detalhe que costuma passar batido: com `object-fit: contain` o vídeo quase
 * nunca preenche o elemento — sobram barras pretas em cima/embaixo ou nas
 * laterais. Ignorar essa borda faz o clique cair alguns centímetros longe de
 * onde o usuário mirou, e o erro cresce conforme a janela muda de proporção.
 */
export type Fraction = { x: number; y: number };

export function pointerToFraction(video: HTMLVideoElement, clientX: number, clientY: number): Fraction | null {
  const rect = video.getBoundingClientRect();
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight || rect.width === 0 || rect.height === 0) return null;

  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const drawnWidth = videoWidth * scale;
  const drawnHeight = videoHeight * scale;
  const offsetX = rect.left + (rect.width - drawnWidth) / 2;
  const offsetY = rect.top + (rect.height - drawnHeight) / 2;

  const x = (clientX - offsetX) / drawnWidth;
  const y = (clientY - offsetY) / drawnHeight;

  // Fora da imagem (na tarja preta) não existe pixel remoto correspondente.
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/**
 * Normaliza a rolagem do navegador para "cliques" de roda do Windows.
 * O DOM entrega deltas em pixels, linhas ou páginas conforme o dispositivo, e
 * com o sinal invertido em relação ao que o Windows espera.
 */
export function wheelToTicks(event: WheelEvent): { dx: number; dy: number } {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  const clamp = (value: number) => Math.max(-10, Math.min(10, value));
  return {
    dx: clamp((event.deltaX * unit) / 100),
    dy: clamp((-event.deltaY * unit) / 100),
  };
}
