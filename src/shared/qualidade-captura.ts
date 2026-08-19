import type { Quality } from './config';

/** Qualidade da rota de captura por quadros, antes da compressão WebRTC. */
export type PerfilCapturaSoftware = {
  maxWidth: number;
  maxHeight: number;
  jpegQuality: number;
  intervalMs: number;
  /** Alta usa PNG para não somar artefatos JPEG antes do WebRTC. */
  lossless: boolean;
};

/**
 * Na captura reserva, os botões precisam alterar a FONTE — ajustar somente o
 * bitrate do WebRTC não recupera detalhes que já saíram borrados daqui.
 */
export const PERFIS_CAPTURA_SOFTWARE: Record<Quality, PerfilCapturaSoftware> = {
  baixa: { maxWidth: 1920, maxHeight: 1080, jpegQuality: 60, intervalMs: 350, lossless: false },
  media: { maxWidth: 2560, maxHeight: 1440, jpegQuality: 78, intervalMs: 200, lossless: false },
  auto: { maxWidth: 2560, maxHeight: 1440, jpegQuality: 88, intervalMs: 140, lossless: false },
  alta: { maxWidth: 3840, maxHeight: 2160, jpegQuality: 95, intervalMs: 120, lossless: true },
};

/** Uma captura é compartilhada; usamos a maior qualidade pedida por qualquer visitante. */
export function maiorQualidade(qualidades: Iterable<Quality>): Quality {
  const ordem: Quality[] = ['baixa', 'media', 'auto', 'alta'];
  let maior: Quality = 'baixa';
  for (const qualidade of qualidades) {
    if (ordem.indexOf(qualidade) > ordem.indexOf(maior)) maior = qualidade;
  }
  return maior;
}
