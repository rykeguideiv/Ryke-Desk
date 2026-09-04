/**
 * O ajuste automático reage certo às condições de rede?
 *
 * Esta lógica é pura de propósito — entra medida, sai decisão — justamente
 * para poder ser exercitada aqui contra dezenas de cenários sem depender de
 * rede nenhuma. Uma queda de qualidade mal calibrada não quebra o programa:
 * ela aparece como "meio lento" e é quase impossível de diagnosticar depois.
 *
 *   node --import ./test/ts-resolve.mjs test/adaptacao.test.mjs
 */
import { Adaptador, TETO_BITRATE, PISO_BITRATE } from '../src/shared/adaptacao.ts';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};
const mb = (n) => `${(n / 1e6).toFixed(2)} Mb/s`;

const boa = { bancaDisponivel: 20e6, rtt: 25, perda: 0, limitacao: 'none' };

// ───────── começo de sessão: não abrir borrado por precaução ─────────
//
// O estimador de banda do WebRTC começa baixo de propósito e leva alguns
// segundos para descobrir o que a rede aguenta. Obedecer a ele nesse período
// fazia toda sessão abrir em 960×540 e câmera lenta, mesmo em rede ótima —
// a pior primeira impressão possível, e foi assim que o defeito apareceu no
// teste de ponta a ponta.

let inicio = new Adaptador();
const bancaFria = { bancaDisponivel: 300_000, rtt: 3, perda: 0, limitacao: 'none' };
for (let i = 0; i < 3; i++) {
  const r = inicio.decidir(bancaFria);
  check(`medida ${i + 1}: mantém resolução cheia enquanto mede`, r.scaleResolutionDownBy === 1,
    `escala ${r.scaleResolutionDownBy}, ${r.maxFramerate} qps`);
  check(`medida ${i + 1}: mantém 30 quadros enquanto mede`, r.maxFramerate === 30);
}

// Passado o aquecimento, se a rede for mesmo ruim, aí sim cede.
let depois;
for (let i = 0; i < 20; i++) depois = inicio.decidir(bancaFria);
check('depois de medir, uma rede de fato ruim faz ceder', depois.scaleResolutionDownBy > 1,
  `escala ${depois.scaleResolutionDownBy}, ${depois.maxFramerate} qps`);

// E numa rede que só parecia ruim no começo, nada é perdido.
inicio = new Adaptador();
for (let i = 0; i < 3; i++) inicio.decidir(bancaFria);
let recuperou;
for (let i = 0; i < 20; i++) recuperou = inicio.decidir({ bancaDisponivel: 20e6, rtt: 25, perda: 0, limitacao: 'none' });
check('rede que só estava esquentando volta ao topo', recuperou.scaleResolutionDownBy === 1 && recuperou.maxFramerate === 60,
  mb(recuperou.maxBitrate));

// ───────────────── rede ótima: sobe até o teto ─────────────────

let a = new Adaptador();
let ajuste;
for (let i = 0; i < 40; i++) ajuste = a.decidir(boa);

check('numa rede boa a qualidade sobe', ajuste.maxBitrate > 4_000_000, mb(ajuste.maxBitrate));
check('mas nunca passa do teto', ajuste.maxBitrate <= TETO_BITRATE, mb(ajuste.maxBitrate));
check('e usa a resolução cheia', ajuste.scaleResolutionDownBy === 1);
// 60, e não 30: era este o teto que segurava a fluidez. Por mais banda que
// sobrasse, o adaptador nunca passava de 30 quadros — no diagnóstico dava
// para ver 30 qps gastando 0,5 de 8 Mb/s, com a GPU ociosa. 60 é o que
// separa "funciona" de "parece a máquina local".
check('com 60 quadros por segundo, que é o que a rede aguenta', ajuste.maxFramerate === 60,
  `${ajuste.maxFramerate} qps`);

// O degrau só vale com banda de verdade: em rede apertada, mais quadros
// significa menos bits por quadro, e a imagem vira um borrão em movimento.
const redeModesta = new Adaptador();
let modesto;
for (let i = 0; i < 40; i++) modesto = redeModesta.decidir({ bancaDisponivel: 3.2e6, rtt: 40, perda: 0, limitacao: 'none' });
check('em rede modesta os quadros NÃO sobem a 60', modesto.maxFramerate < 60, `${modesto.maxFramerate} qps`);

// ───────────── nunca ultrapassa o que a rede comporta ─────────────

a = new Adaptador();
const apertada = { bancaDisponivel: 1.5e6, rtt: 30, perda: 0, limitacao: 'none' };
for (let i = 0; i < 40; i++) ajuste = a.decidir(apertada);
check('respeita a estimativa da rede', ajuste.maxBitrate <= 1.5e6, mb(ajuste.maxBitrate));
check('e ainda deixa folga para não encher fila', ajuste.maxBitrate <= 1.5e6 * 0.9,
  `${((ajuste.maxBitrate / 1.5e6) * 100).toFixed(0)}% da banca`);

// ───────────────── perda de pacotes: recuo rápido ─────────────────

a = new Adaptador();
for (let i = 0; i < 20; i++) a.decidir(boa);
const antesDaPerda = a.alvoAtual;
ajuste = a.decidir({ ...boa, perda: 0.08 });
check('perda de pacotes derruba a taxa na hora', ajuste.maxBitrate < antesDaPerda * 0.7,
  `${mb(antesDaPerda)} → ${mb(ajuste.maxBitrate)}`);
check('e o motivo aparece em português', /perda/i.test(ajuste.motivo), ajuste.motivo);

// ───────────── atraso crescente: recua ANTES de perder ─────────────
//
// É o caso que mais importa. A fila no meio do caminho cresce, o atraso sobe,
// mas nada se perde ainda. Quem só olha perda não vê nada de errado — e o
// usuário já está sentindo o mouse atrasado.

a = new Adaptador();
for (let i = 0; i < 20; i++) a.decidir({ ...boa, rtt: 30 });
const antesDoAtraso = a.alvoAtual;
ajuste = a.decidir({ ...boa, rtt: 140, perda: 0 });
check('atraso subindo faz recuar mesmo sem perda', ajuste.maxBitrate < antesDoAtraso,
  `${mb(antesDoAtraso)} → ${mb(ajuste.maxBitrate)}`);
check('e explica que é para limpar a fila', /fila|atraso/i.test(ajuste.motivo), ajuste.motivo);

// A régua é a própria rede: 140 ms é ruim numa rede de 25 ms e normal numa de 120.
a = new Adaptador();
for (let i = 0; i < 20; i++) a.decidir({ ...boa, rtt: 120 });
const estavelLonge = a.alvoAtual;
ajuste = a.decidir({ ...boa, rtt: 140 });
check('rede naturalmente distante não é punida por isso', ajuste.maxBitrate >= estavelLonge,
  `base 120 ms, medida 140 ms → ${mb(ajuste.maxBitrate)}`);

// ───────────────── computador no limite ─────────────────

a = new Adaptador();
for (let i = 0; i < 20; i++) a.decidir(boa);
const antesDaCpu = a.alvoAtual;
ajuste = a.decidir({ ...boa, limitacao: 'cpu' });
check('processador no limite também reduz', ajuste.maxBitrate < antesDaCpu,
  `${mb(antesDaCpu)} → ${mb(ajuste.maxBitrate)}`);

// ─────────────── rede ruim: degrada na ordem certa ───────────────

a = new Adaptador();
const ruim = { bancaDisponivel: 500_000, rtt: 30, perda: 0, limitacao: 'none' };
for (let i = 0; i < 40; i++) ajuste = a.decidir(ruim);
check('em rede fraca ainda funciona, sem parar', ajuste.maxBitrate >= PISO_BITRATE, mb(ajuste.maxBitrate));
check('cede quadros antes de cortar resolução', ajuste.maxFramerate <= 12, `${ajuste.maxFramerate} qps`);
check('e só então encolhe a imagem', ajuste.scaleResolutionDownBy > 1, `escala ${ajuste.scaleResolutionDownBy}`);

// Ordem de degradação: comparando faixas, quadros caem antes da resolução.
const faixas = [3e6, 2e6, 1.3e6, 1e6, 800e3, 500e3].map((b) => {
  const t = new Adaptador();
  let r;
  for (let i = 0; i < 40; i++) r = t.decidir({ bancaDisponivel: b, rtt: 30, perda: 0, limitacao: 'none' });
  return { banca: b, ...r };
});
console.log('\n   banca      →  taxa       quadros  escala');
for (const f of faixas) {
  console.log(`   ${mb(f.banca).padEnd(10)} →  ${mb(f.maxBitrate).padEnd(10)} ${String(f.maxFramerate).padStart(4)}    ${f.scaleResolutionDownBy}`);
}
check('a taxa acompanha a banca, sempre',
  faixas.every((f, i) => i === 0 || f.maxBitrate <= faixas[i - 1].maxBitrate));
check('os quadros nunca sobem quando a banca cai',
  faixas.every((f, i) => i === 0 || f.maxFramerate <= faixas[i - 1].maxFramerate));
check('a resolução nunca melhora quando a banca cai',
  faixas.every((f, i) => i === 0 || f.scaleResolutionDownBy >= faixas[i - 1].scaleResolutionDownBy));
check('resolução cheia enquanto houver banca razoável',
  faixas.filter((f) => f.banca >= 2e6).every((f) => f.scaleResolutionDownBy === 1));

// ─────────────── recuperação: sobe, mas devagar ───────────────

a = new Adaptador();
for (let i = 0; i < 20; i++) a.decidir({ bancaDisponivel: 600_000, rtt: 30, perda: 0, limitacao: 'none' });
const noFundo = a.alvoAtual;
const logo = a.decidir(boa);
check('não dispara para o topo assim que a rede melhora', logo.maxBitrate < noFundo * 1.5,
  `${mb(noFundo)} → ${mb(logo.maxBitrate)}`);

let subiu;
for (let i = 0; i < 30; i++) subiu = a.decidir(boa);
check('mas se recupera se a melhora se mantém', subiu.maxBitrate > noFundo * 3,
  `${mb(noFundo)} → ${mb(subiu.maxBitrate)}`);

// ─────────────── estabilidade: nada de oscilar ───────────────
//
// Imagem que melhora e piora sem parar incomoda mais do que imagem
// constante um pouco pior.

a = new Adaptador();
const media = { bancaDisponivel: 3e6, rtt: 40, perda: 0, limitacao: 'none' };
for (let i = 0; i < 30; i++) a.decidir(media);
const amostras = [];
for (let i = 0; i < 20; i++) amostras.push(a.decidir(media).maxBitrate);
const menor = Math.min(...amostras);
const maior = Math.max(...amostras);
check('em rede constante a taxa fica constante', maior / menor < 1.05,
  `variou ${(((maior - menor) / menor) * 100).toFixed(1)}%`);

const escalas = new Set(amostras.map((_, i) => i));
check('sem trocas de resolução para lá e para cá', escalas.size === amostras.length);

// ─────────────── entradas estranhas não quebram ───────────────

a = new Adaptador();
for (const m of [
  { bancaDisponivel: null, rtt: 0, perda: 0, limitacao: 'none' },
  { bancaDisponivel: 0, rtt: 0, perda: 0, limitacao: 'other' },
  { bancaDisponivel: -1, rtt: -5, perda: -1, limitacao: 'none' },
  { bancaDisponivel: 1e12, rtt: 99999, perda: 1, limitacao: 'bandwidth' },
]) {
  const r = a.decidir(m);
  const saudavel =
    Number.isFinite(r.maxBitrate) &&
    r.maxBitrate >= PISO_BITRATE &&
    r.maxBitrate <= TETO_BITRATE &&
    r.maxFramerate > 0 &&
    r.scaleResolutionDownBy >= 1;
  check(`medida estranha não quebra (banca ${m.bancaDisponivel})`, saudavel,
    `${mb(r.maxBitrate)}, ${r.maxFramerate} qps, escala ${r.scaleResolutionDownBy}`);
}

console.log(falhas === 0 ? '\nAjuste automático validado.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
