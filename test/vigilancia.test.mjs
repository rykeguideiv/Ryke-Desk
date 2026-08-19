/**
 * A sessão sobrevive ao tempo?
 *
 * O defeito relatado em uso real: depois de mais de meia hora a sessão
 * congelava — imagem parada, teclado e mouse mortos — e o WebRTC continuava
 * dizendo "connected". Esperar meia hora num teste é inviável; a política que
 * decide "isto morreu, refaça o caminho" é pura de propósito, e aqui ela é
 * exercitada contra o relógio que quisermos.
 *
 * Um erro de calibragem aqui não quebra nada de forma visível: vira "às vezes
 * trava" ou "fica reconectando à toa" — o tipo de problema impossível de
 * reproduzir depois de acontecer.
 *
 *   node --import ./test/ts-resolve.mjs test/vigilancia.test.mjs
 */
import {
  Vigilancia,
  SILENCIO_FATAL_MS,
  CONGELAMENTO_MS,
  MAX_RECUPERACOES,
  INTERVALO_ENTRE_TENTATIVAS_MS,
  RESTABELECIDA_MS,
} from '../src/shared/vigilancia.ts';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

const min = (n) => n * 60_000;

/** Uma sessão saudável: mensagens chegando e quadros avançando. */
function sessaoSaudavel(minutos) {
  const v = new Vigilancia();
  let t = 0;
  let quadros = 0;
  const decisoes = [];
  v.reiniciar(t);
  // Uma leitura por segundo, como na vida real.
  for (let s = 0; s < minutos * 60; s++) {
    t += 1000;
    quadros += 30;
    decisoes.push(v.avaliar({ agora: t, ultimaMensagem: t, quadros, conexao: 'connected' }));
  }
  return { v, t, quadros, decisoes };
}

// ───────── uma hora de sessão saudável não pode ser incomodada ─────────

const longa = sessaoSaudavel(60);
check('uma hora de sessão saudável, nenhuma interrupção',
  longa.decisoes.every((d) => d.acao === 'nada'), `${longa.decisoes.length} leituras`);
check('e a sessão é considerada viva o tempo todo', longa.decisoes.every((d) => d.viva));
check('nenhuma recuperação foi gasta à toa', longa.v.recuperacoes === 0);

// ───────── o defeito relatado: 30 min e a imagem congela ─────────
//
// Tudo normal por meia hora e então os quadros param, mas o WebRTC segue
// dizendo "connected" — foi exatamente assim que o problema apareceu.

const v1 = new Vigilancia();
let t = 0;
let quadros = 0;
v1.reiniciar(t);
for (let s = 0; s < 30 * 60; s++) {
  t += 1000;
  quadros += 30;
  v1.avaliar({ agora: t, ultimaMensagem: t, quadros, conexao: 'connected' });
}

// A partir daqui os quadros param de CHEGAR, mas o outro lado continua
// dizendo que manda: alguma coisa se perdeu no meio do caminho.
let decisao = { acao: 'nada' };
let segundosAteReagir = 0;
let mandadosPeloOutro = 50_000;
for (let s = 0; s < 60 && decisao.acao === 'nada'; s++) {
  t += 1000;
  segundosAteReagir++;
  mandadosPeloOutro += 30;
  decisao = v1.avaliar({
    agora: t, ultimaMensagem: t, quadros, quadrosDoOutro: mandadosPeloOutro, conexao: 'connected',
  });
}
check('imagem congelada é detectada mesmo com a conexão dizendo estar viva',
  decisao.acao === 'recuperar', `reagiu em ${segundosAteReagir}s`);
check('e reage num prazo razoável, não em minutos',
  segundosAteReagir <= CONGELAMENTO_MS / 1000 + 2, `${segundosAteReagir}s`);
check('o motivo é dito em português', /imagem/i.test(decisao.motivo), decisao.motivo);
check('e a sessão é marcada como não viva', decisao.viva === false);

// ───────── TELA QUIETA NÃO É SESSÃO MORTA ─────────
//
// O defeito que este bloco tranca: a sessão se fechava sozinha quando ninguém
// mexia no computador do outro lado. Captura de tela não manda quadro quando
// nada muda, então uma pessoa lendo um documento produzia exatamente a mesma
// leitura que um caminho de rede morto — e em pouco mais de meio minuto a
// conexão caía dizendo que não conseguiu restabelecer.

{
  const v = new Vigilancia();
  let t = 0;
  v.reiniciar(t);
  // Meia hora de sessão viva, com a tela absolutamente parada: o pulso vai e
  // volta, e os dois lados relatam o mesmo número de quadros o tempo todo.
  const decisoes = [];
  for (let s = 0; s < 30 * 60; s++) {
    t += 1000;
    decisoes.push(
      v.avaliar({ agora: t, ultimaMensagem: t, quadros: 900, quadrosDoOutro: 900, conexao: 'connected' }),
    );
  }
  check('meia hora com a tela parada não derruba a sessão',
    decisoes.every((d) => d.acao === 'nada'),
    `${decisoes.filter((d) => d.acao !== 'nada').length} interrupções em ${decisoes.length} leituras`);
  check('e ela continua sendo considerada viva', decisoes.every((d) => d.viva));
  check('sem gastar uma única tentativa de recuperação', v.recuperacoes === 0);
}

{
  // Mexer o mouse depois de muito tempo parado volta a produzir quadros, e
  // isso não pode ser lido como "acabou de se recuperar de um problema".
  const v = new Vigilancia();
  let t = 0;
  v.reiniciar(t);
  let quadrosVistos = 900;
  const decisoes = [];
  for (let s = 0; s < 300; s++) {
    t += 1000;
    // Cinco minutos parados, e então volta a andar.
    if (s > 240) quadrosVistos += 30;
    decisoes.push(
      v.avaliar({
        agora: t, ultimaMensagem: t, quadros: quadrosVistos, quadrosDoOutro: quadrosVistos,
        conexao: 'connected',
      }),
    );
  }
  check('parar e voltar a mexer atravessa sem sobressalto', decisoes.every((d) => d.acao === 'nada'));
}

{
  // Versão antiga do outro lado: não informa nada. A imagem deixa de valer
  // como sinal, e a sessão segue — o silêncio do pulso continua protegendo.
  const v = new Vigilancia();
  let t = 0;
  v.reiniciar(t);
  const decisoes = [];
  for (let s = 0; s < 600; s++) {
    t += 1000;
    decisoes.push(v.avaliar({ agora: t, ultimaMensagem: t, quadros: 400, conexao: 'connected' }));
  }
  check('com uma versão antiga do outro lado, imagem parada não derruba nada',
    decisoes.every((d) => d.acao === 'nada'));
}

// ───────── o outro lado emudece (canal de controle morto) ─────────

const v2 = new Vigilancia();
t = 0;
v2.reiniciar(t);
const ultimaMensagem = 0;
decisao = { acao: 'nada' };
let segundos = 0;
// Quadros continuam avançando (vídeo em cache/decodificador), mas nada mais
// chega pelo canal de controle: teclado e mouse estão mortos.
for (let s = 0; s < 60 && decisao.acao === 'nada'; s++) {
  t += 1000;
  segundos++;
  decisao = v2.avaliar({ agora: t, ultimaMensagem, quadros: 30 * s + 1, conexao: 'connected' });
}
check('silêncio no canal de controle é detectado', decisao.acao === 'recuperar', `em ${segundos}s`);
check('dentro do prazo esperado', segundos <= SILENCIO_FATAL_MS / 1000 + 2, `${segundos}s`);

// ───────── não insiste em rajada ─────────

const v3 = new Vigilancia();
t = 0;
v3.reiniciar(t);
let recuperacoes = 0;
for (let s = 0; s < 30; s++) {
  t += 1000;
  if (v3.avaliar({ agora: t, ultimaMensagem: 0, quadros: 0, conexao: 'connected' }).acao === 'recuperar') {
    recuperacoes++;
  }
}
check('não dispara recuperação a cada segundo', recuperacoes <= 3, `${recuperacoes} em 30s`);
check('respeita o intervalo entre tentativas',
  recuperacoes <= Math.ceil(30_000 / INTERVALO_ENTRE_TENTATIVAS_MS), `${recuperacoes} tentativas`);

// ───────── desiste depois de tentar de verdade ─────────

const v4 = new Vigilancia();
t = 0;
v4.reiniciar(t);
let desistiu = false;
let tentativas = 0;
for (let s = 0; s < 600 && !desistiu; s++) {
  t += 1000;
  const d = v4.avaliar({ agora: t, ultimaMensagem: 0, quadros: 0, conexao: 'connected' });
  if (d.acao === 'recuperar') tentativas++;
  if (d.acao === 'desistir') desistiu = true;
}
check('desiste depois de esgotar as tentativas', desistiu === true);
check('mas só depois de tentar o número previsto', tentativas === MAX_RECUPERACOES,
  `${tentativas} de ${MAX_RECUPERACOES}`);
check('e demora o bastante para não desistir de um soluço',
  t >= MAX_RECUPERACOES * INTERVALO_ENTRE_TENTATIVAS_MS, `${Math.round(t / 1000)}s até desistir`);

// ───────── a sessão se recupera e o contador zera ─────────

const v5 = new Vigilancia();
t = 0;
v5.reiniciar(t);
for (let s = 0; s < 20; s++) {
  t += 1000;
  v5.avaliar({ agora: t, ultimaMensagem: 0, quadros: 0, conexao: 'connected' });
}
check('gastou tentativas durante o problema', v5.recuperacoes > 0, `${v5.recuperacoes}`);

// O caminho foi refeito: o WebRTC avisa 'connected' de novo.
v5.reiniciar(t);
check('voltar a conectar zera o contador de tentativas', v5.recuperacoes === 0);

let quadrosPos = 0;
const depois = [];
for (let s = 0; s < 120; s++) {
  t += 1000;
  quadrosPos += 30;
  depois.push(v5.avaliar({ agora: t, ultimaMensagem: t, quadros: quadrosPos, conexao: 'connected' }));
}
check('e a sessão recuperada roda limpa', depois.every((d) => d.acao === 'nada' && d.viva));

// ───────── um dia de trabalho com soluços espaçados ─────────
//
// O orçamento de recuperações é por incidente, não por sessão. Sem isto,
// quatro soluços resolvidos ao longo de horas derrubavam a conexão no quinto.

{
  const v = new Vigilancia();
  let t = 0;
  v.reiniciar(t);
  let desistiu = false;
  let incidentes = 0;

  for (let hora = 0; hora < 6 && !desistiu; hora++) {
    // Cinquenta minutos bons.
    for (let s = 0; s < 50 * 60; s++) {
      t += 1000;
      const d = v.avaliar({
        agora: t, ultimaMensagem: t, quadros: 30 * (t / 1000), quadrosDoOutro: 30 * (t / 1000),
        conexao: 'connected',
      });
      if (d.acao === 'desistir') desistiu = true;
    }
    // E um soluço de 15 segundos, que uma recuperação resolve.
    incidentes++;
    const congelou = t;
    for (let s = 0; s < 15 && !desistiu; s++) {
      t += 1000;
      const d = v.avaliar({ agora: t, ultimaMensagem: congelou, quadros: 30 * (congelou / 1000), conexao: 'connected' });
      if (d.acao === 'desistir') desistiu = true;
    }
    v.reiniciar(t);
  }

  check('seis horas com um soluço por hora não derrubam a sessão', desistiu === false,
    `${incidentes} incidentes atravessados`);
}

{
  // E o contador se devolve mesmo sem o WebRTC anunciar reconexão — o reinício
  // de ICE muitas vezes acontece sem trocar de estado.
  const v = new Vigilancia();
  let t = 0;
  v.reiniciar(t);
  for (let s = 0; s < 20; s++) {
    t += 1000;
    v.avaliar({ agora: t, ultimaMensagem: 0, quadros: 0, conexao: 'connected' });
  }
  const gastas = v.recuperacoes;
  check('gastou tentativas no problema', gastas > 0, `${gastas}`);
  for (let s = 0; s < RESTABELECIDA_MS / 1000 + 2; s++) {
    t += 1000;
    v.avaliar({ agora: t, ultimaMensagem: t, quadros: 30 * s + 1, quadrosDoOutro: 30 * s + 1, conexao: 'connected' });
  }
  check('tempo saudável devolve as tentativas, sem precisar de anúncio do WebRTC',
    v.recuperacoes === 0, `${gastas} → ${v.recuperacoes}`);
}

// ───────── queda declarada não fica tentando ─────────

const v6 = new Vigilancia();
v6.reiniciar(0);
const morta = v6.avaliar({ agora: 1000, ultimaMensagem: 1000, quadros: 100, conexao: 'failed' });
check('conexão declarada morta faz desistir de imediato', morta.acao === 'desistir', morta.motivo);

const fechada = new Vigilancia();
fechada.reiniciar(0);
check('conexão fechada também', fechada.avaliar({ agora: 1000, ultimaMensagem: 1000, quadros: 1, conexao: 'closed' }).acao === 'desistir');

// ───────── início de sessão não é confundido com queda ─────────
//
// Nos primeiros segundos ainda não há quadros: o vídeo está negociando. Tratar
// isso como congelamento faria toda sessão nascer "reconectando".

const v7 = new Vigilancia();
t = 0;
v7.reiniciar(t);
const inicio = [];
for (let s = 0; s < 8; s++) {
  t += 1000;
  inicio.push(v7.avaliar({ agora: t, ultimaMensagem: t, quadros: 0, conexao: 'connected' }));
}
check('sessão recém-aberta não é acusada de congelada',
  inicio.every((d) => d.acao === 'nada'), inicio.map((d) => d.acao).join(','));

console.log(falhas === 0 ? '\nVigilância de sessão validada.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
