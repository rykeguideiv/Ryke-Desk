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
 *
 * Esta rota tira uma foto inteira da tela a cada quadro no processo principal;
 * é intrinsecamente mais cara que a captura por hardware. Por isso o intervalo
 * entre quadros aqui pesa muito: os valores antigos (350 ms na baixa = ~3
 * quadros/s) faziam a tela parecer uma sequência de slides mesmo quando a
 * máquina daria conta de bem mais. Encurtar o intervalo e enxugar a resolução
 * mais pesada dá a maior fluidez que esta rota reserva consegue entregar.
 *
 * A "alta" deixou de usar PNG sem perdas: numa rota que já é a lenta, decodar
 * um PNG 4K por quadro trava tudo, e o WebRTC recomprime a imagem logo em
 * seguida de qualquer jeito — o "sem perdas antes do WebRTC" custava caro e
 * rendia quase nada. 1440p em JPEG de alta qualidade corre muito mais solto.
 */
export const PERFIS_CAPTURA_SOFTWARE: Record<Quality, PerfilCapturaSoftware> = {
  baixa: { maxWidth: 1280, maxHeight: 720, jpegQuality: 58, intervalMs: 100, lossless: false },
  media: { maxWidth: 1600, maxHeight: 900, jpegQuality: 74, intervalMs: 80, lossless: false },
  auto: { maxWidth: 1920, maxHeight: 1080, jpegQuality: 84, intervalMs: 60, lossless: false },
  alta: { maxWidth: 2560, maxHeight: 1440, jpegQuality: 92, intervalMs: 50, lossless: false },
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
