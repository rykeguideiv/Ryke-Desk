/**
 * Baixar a qualidade ALIVIA a máquina — ou só borra a imagem à toa?
 *
 * Este é o teste do conserto principal de desempenho. O defeito relatado era
 * exato: "mesmo baixando a qualidade não melhora o desempenho, só piora a
 * imagem". A causa era a escala de resolução ser um fator fixo — numa tela
 * grande, "média" ainda mandava o codificador engolir quase a resolução
 * inteira, gastando o mesmo processador (e o mesmo atraso) de antes.
 *
 * A correção mira uma ALTURA de vídeo por preset. Aqui provamos, sem WebRTC
 * nenhum, que cada degrau abaixo de fato reduz a ÁREA que o codificador
 * comprime — que é o trabalho de onde nasce o atraso.
 *
 *   node --import ./test/ts-resolve.mjs test/qualidade-video.test.mjs
 */
import { PERFIS_QUALIDADE, ALTURA_MAX_AUTO, escalaParaAltura } from '../src/shared/qualidade-video.ts';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};
const perto = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── escalaParaAltura: mira uma altura sem NUNCA ampliar ──
check('4K mirando 720p encolhe 3×', perto(escalaParaAltura(2160, 720), 3), `${escalaParaAltura(2160, 720)}`);
check('4K mirando 1080p encolhe 2×', perto(escalaParaAltura(2160, 1080), 2));
check('1080p mirando 1080p fica nativo', escalaParaAltura(1080, 1080) === 1);
check('1080p mirando 720p encolhe 1,5×', perto(escalaParaAltura(1080, 720), 1.5));
check('tela menor que o alvo nunca amplia', escalaParaAltura(720, 1080) === 1);
check('altura-alvo 0 = resolução nativa', escalaParaAltura(2160, 0) === 1);
check('fonte inválida cai para 1', escalaParaAltura(0, 720) === 1 && escalaParaAltura(NaN, 720) === 1 && escalaParaAltura(-5, 720) === 1);

// ── os presets miram alturas que descem de verdade ──
check('baixa mira 720p', PERFIS_QUALIDADE.baixa.alturaAlvo === 720);
check('média mira 1080p', PERFIS_QUALIDADE.media.alturaAlvo === 1080);
check('alta usa resolução nativa (0)', PERFIS_QUALIDADE.alta.alturaAlvo === 0);
check('auto tem teto de 1440p', PERFIS_QUALIDADE.auto.alturaAlvo === ALTURA_MAX_AUTO);

// ── a prova do conserto: em 4K, cada degrau abaixo codifica MENOS ÁREA ──
//
// Área codificada = (largura/escala) × (altura/escala). É proporcional ao
// trabalho do codificador. Se ela cai a cada degrau, baixar a qualidade
// realmente alivia — e não só aperta a banda como antes.
const areaEncodada4K = (preset) => {
  const escala = escalaParaAltura(2160, PERFIS_QUALIDADE[preset].alturaAlvo);
  return (3840 / escala) * (2160 / escala);
};
const aBaixa = areaEncodada4K('baixa');
const aMedia = areaEncodada4K('media');
const aAlta = areaEncodada4K('alta');
console.log(`   área em 4K → baixa ${(aBaixa / 1e6).toFixed(2)}MP  média ${(aMedia / 1e6).toFixed(2)}MP  alta ${(aAlta / 1e6).toFixed(2)}MP`);
check('em 4K, baixa codifica menos área que média', aBaixa < aMedia);
check('em 4K, média codifica menos área que alta', aMedia < aAlta);
check('baixa em 4K equivale a 720p', perto(aBaixa, 1280 * 720, 1));
check('média em 4K equivale a 1080p', perto(aMedia, 1920 * 1080, 1));

// ── banda, quadros e degradação coerentes com o que a aba promete ──
check('a banda acompanha o preset',
  PERFIS_QUALIDADE.baixa.maxBitrate < PERFIS_QUALIDADE.media.maxBitrate &&
    PERFIS_QUALIDADE.media.maxBitrate < PERFIS_QUALIDADE.alta.maxBitrate);
check('alta entrega 60 quadros', PERFIS_QUALIDADE.alta.framerate === 60);
check('média e baixa ficam em 30 quadros (60 só gastaria à toa)',
  PERFIS_QUALIDADE.media.framerate === 30 && PERFIS_QUALIDADE.baixa.framerate === 30);
check('presets leves preferem manter os quadros sob pressão (responsividade)',
  PERFIS_QUALIDADE.baixa.degradation === 'maintain-framerate' &&
    PERFIS_QUALIDADE.media.degradation === 'maintain-framerate');
check('baixa prioriza movimento; média e alta, detalhe',
  PERFIS_QUALIDADE.baixa.hint === 'motion' &&
    PERFIS_QUALIDADE.media.hint === 'detail' &&
    PERFIS_QUALIDADE.alta.hint === 'detail');

console.log(falhas === 0 ? '\nQualidade de vídeo validada.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
