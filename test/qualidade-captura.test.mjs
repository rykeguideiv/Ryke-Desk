/** Perfis da captura reserva precisam corresponder de verdade aos botões. */
import { maiorQualidade, PERFIS_CAPTURA_SOFTWARE as P } from '../src/shared/qualidade-captura.ts';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

check('Alta comprime menos o JPEG que Média', P.alta.jpegQuality > P.media.jpegQuality);
check('Média comprime menos que Baixa', P.media.jpegQuality > P.baixa.jpegQuality);
check('Alta elimina a compressão JPEG da fonte', P.alta.lossless === true);
check('os demais modos preservam desempenho usando JPEG', !P.auto.lossless && !P.media.lossless && !P.baixa.lossless);
check('Alta pede quadros com mais frequência que Média', P.alta.intervalMs < P.media.intervalMs);
check('Média pede quadros com mais frequência que Baixa', P.media.intervalMs < P.baixa.intervalMs);
check('Automática não reduz uma tela Full HD', P.auto.maxWidth >= 1920 && P.auto.maxHeight >= 1080);
check('uma sessão em Alta eleva a fonte compartilhada', maiorQualidade(['baixa', 'alta', 'media']) === 'alta');
check('sem pedido alto, Média prevalece sobre Baixa', maiorQualidade(['baixa', 'media']) === 'media');

console.log(falhas === 0 ? '\nQualidade da captura reserva validada.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
