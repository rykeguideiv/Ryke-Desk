/**
 * Tradução entre o que o visitante vê e os pixels reais do anfitrião.
 *
 * O visitante manda coordenadas em fração da imagem (0..1), nunca pixels:
 * assim a mesma mensagem funciona com a janela em qualquer tamanho, com
 * qualquer resolução do outro lado e com o vídeo sendo reescalado pela rede.
 *
 * A conversão passa por dois espaços diferentes, e confundi-los é o erro
 * clássico aqui:
 *   • Electron reporta os monitores em DIP (pixels lógicos, já divididos
 *     pela escala do Windows — 150 %, 200 %...)
 *   • SendInput trabalha em pixels físicos
 * `dipToScreenRect` faz a ponte entre os dois.
 */
import { screen } from 'electron';

export type DisplayInfo = {
  id: number;
  label: string;
  primary: boolean;
  width: number;
  height: number;
  scaleFactor: number;
};

export function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => {
    const physical = screen.dipToScreenRect(null, display.bounds);
    return {
      id: display.id,
      // Um nome previsível é mais útil no menu remoto do que valores como
      // "DISPLAY1" ou o modelo técnico devolvido por alguns drivers.
      label: `Tela ${index + 1}`,
      primary: display.id === primaryId,
      width: physical.width,
      height: physical.height,
      scaleFactor: display.scaleFactor,
    };
  });
}

export function findDisplay(id: number | null) {
  const all = screen.getAllDisplays();
  return all.find((d) => d.id === id) ?? screen.getPrimaryDisplay();
}

/**
 * Converte uma fração da tela capturada no pixel físico correspondente da
 * área de trabalho virtual — que é o que SendInput espera.
 */
export function toPhysicalPoint(displayId: number | null, fx: number, fy: number): { x: number; y: number } {
  const display = findDisplay(displayId);
  const rect = screen.dipToScreenRect(null, display.bounds);
  const clampedX = Math.min(Math.max(fx, 0), 1);
  const clampedY = Math.min(Math.max(fy, 0), 1);
  return {
    x: Math.round(rect.x + clampedX * (rect.width - 1)),
    y: Math.round(rect.y + clampedY * (rect.height - 1)),
  };
}

/**
 * O caminho de volta: pixel físico da área de trabalho → fração da tela
 * capturada.
 *
 * Serve para contar ao visitante onde o cursor DESTE computador está de
 * verdade. Fora da tela que está sendo capturada — outro monitor, por
 * exemplo — devolve `null`, porque ali não existe ponto correspondente na
 * imagem que o outro lado recebe.
 */
export function toFraction(displayId: number | null, x: number, y: number): { x: number; y: number } | null {
  const display = findDisplay(displayId);
  const rect = screen.dipToScreenRect(null, display.bounds);
  if (rect.width <= 1 || rect.height <= 1) return null;
  const fx = (x - rect.x) / (rect.width - 1);
  const fy = (y - rect.y) / (rect.height - 1);
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return { x: fx, y: fy };
}
