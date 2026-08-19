/**
 * Ensaio contra a infraestrutura pública de verdade.
 *
 * Os outros testes usam corretores locais de propósito: precisam falhar por
 * causa do nosso código, não porque um serviço de terceiro saiu do ar. Mas
 * essa escolha esconde exatamente a pergunta que decide se o produto funciona
 * na casa do usuário — os corretores públicos aceitam mesmo o nosso tráfego?
 *
 * Este arquivo faz essa pergunta. Fica FORA da suíte padrão porque depende da
 * internet e de serviços que não controlamos; é para rodar antes de publicar
 * uma versão, e para diagnosticar quando alguém disser "não conecta".
 *
 *   node --import ./test/ts-resolve.mjs test/internet.mjs
 */
import WebSocket from 'ws';
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { Malha, CORRETORES_PADRAO, RELAYS_PADRAO, ICE_PADRAO } from '../src/shared/malha.ts';

let falhas = 0;
let avisos = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};
/** Para o que é bom ter, mas cuja ausência não impede de conectar. */
const observar = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : '  --  '} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) avisos++;
};

const abrir = (url, subs) => new WebSocket(url, subs);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function cofreDeMemoria() {
  const dados = { numero: null, chavePrivada: null, pinos: {} };
  return {
    ler: async () => ({ numero: dados.numero, chavePrivada: dados.chavePrivada }),
    gravar: async (n, c) => { dados.numero = n; dados.chavePrivada = c; },
    lerPinos: async () => ({ ...dados.pinos }),
    gravarPino: async (n, i) => { dados.pinos[n] = i; },
  };
}

// ───────────────── cada corretor público, um a um ─────────────────

console.log('\n— corretores públicos —');
let vivos = 0;
for (const url of CORRETORES_PADRAO) {
  const t0 = Date.now();
  const ok = await new Promise((res) => {
    let ws;
    try {
      ws = new WebSocket(url, ['mqtt']);
    } catch {
      return res(false);
    }
    const fim = (v) => { try { ws.close(); } catch {} res(v); };
    const limite = setTimeout(() => fim(false), 15000);
    ws.on('open', () => { clearTimeout(limite); fim(true); });
    ws.on('error', () => { clearTimeout(limite); fim(false); });
  });
  const nome = new URL(url).hostname;
  observar(nome.padEnd(24), ok, ok ? `${Date.now() - t0}ms` : 'não respondeu');
  if (ok) vivos++;
}
check('pelo menos um corretor público responde', vivos >= 1, `${vivos} de ${CORRETORES_PADRAO.length}`);
observar('mais de um responde (redundância real)', vivos >= 2, `${vivos} de ${CORRETORES_PADRAO.length}`);

// ────────── dois computadores se achando pela internet ──────────

console.log('\n— encontro pela internet —');

function subirMalha(cofre, extra = {}) {
  const malha = new Malha({ cofre, abrir, ...extra });
  const recebidos = [];
  malha.on('signal', (de, dados) => recebidos.push({ de, dados }));
  return new Promise((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error('não entrou na malha em 60s')), 60_000);
    malha.on('welcome', ({ id, impressao }) => {
      clearTimeout(limite);
      resolve({ malha, id, impressao, recebidos });
    });
    malha.connect();
  });
}

const t0 = Date.now();
const ana = await subirMalha(cofreDeMemoria());
const bento = await subirMalha(cofreDeMemoria());
check('os dois entraram na malha pública', ana.malha.connected && bento.malha.connected,
  `${Date.now() - t0}ms`);
check('cada um recebeu um número', /^\d{12}$/.test(ana.id) && /^\d{12}$/.test(bento.id),
  `${ana.id} e ${bento.id}`);

// Uma carga do tamanho de um SDP com candidatos ICE — o que de fato trafega.
const sdpFalso = 'v=0\r\n' + 'a=candidate:' + 'x'.repeat(60) + '\r\n'.repeat(1);
const recheio = sdpFalso.repeat(60);
const tEnvio = Date.now();
ana.malha.send(bento.id, { t: 'offer', sdp: recheio, mac: null });

for (let i = 0; i < 40 && bento.recebidos.length === 0; i++) await esperar(500);

check('a oferta atravessou a internet', bento.recebidos.length > 0,
  bento.recebidos.length ? `${Date.now() - tEnvio}ms` : 'não chegou em 20s');
check('chegou uma única vez, apesar dos vários corretores', bento.recebidos.length === 1,
  `${bento.recebidos.length} entregas`);
check('o SDP chegou íntegro', bento.recebidos[0]?.dados?.sdp === recheio,
  `${bento.recebidos[0]?.dados?.sdp?.length ?? 0} de ${recheio.length} bytes`);
check('o remetente é quem diz ser', bento.recebidos[0]?.de === ana.id);

// Resposta de volta, fechando o ciclo do aperto de mão.
const tVolta = Date.now();
bento.malha.send(ana.id, { t: 'answer', sdp: 'v=0\r\nresposta', mac: null });
for (let i = 0; i < 40 && ana.recebidos.length === 0; i++) await esperar(500);
check('a resposta voltou', ana.recebidos.length === 1, `${Date.now() - tVolta}ms`);

// Sondagem: o número do outro aparece como ligado?
const offline = [];
ana.malha.on('peerOffline', (n) => offline.push(n));
ana.malha.probe(bento.id);
await esperar(6000);
check('o número do outro é encontrado como ligado', !offline.includes(bento.id));

ana.malha.disconnect();
bento.malha.disconnect();

// ────────── só pela porta 443, como numa rede de empresa ──────────
//
// Este é o caso que quebrou de verdade: rede de trabalho que libera apenas
// 80 e 443 e barra as portas dos corretores MQTT (8084, 8884, 8081). Aqui a
// malha é obrigada a usar somente os relays da 443 — se isto passar, aquele
// escritório conecta.

console.log('\n— só porta 443 (rede restrita) —');

for (const url of RELAYS_PADRAO) {
  const t0 = Date.now();
  const ok = await new Promise((res) => {
    let ws;
    try { ws = new WebSocket(url); } catch { return res(false); }
    const fim = (v) => { try { ws.close(); } catch {} res(v); };
    const limite = setTimeout(() => fim(false), 15000);
    ws.on('open', () => { clearTimeout(limite); fim(true); });
    ws.on('error', () => { clearTimeout(limite); fim(false); });
  });
  observar(new URL(url).hostname.padEnd(24), ok, ok ? `${Date.now() - t0}ms` : 'não respondeu');
}

const t443 = Date.now();
const clara = await subirMalha(cofreDeMemoria(), { corretores: [] });
const davi = await subirMalha(cofreDeMemoria(), { corretores: [] });
check('dois computadores entram na malha usando só a 443',
  clara.malha.connected && davi.malha.connected, `${Date.now() - t443}ms`);

const t443msg = Date.now();
clara.malha.send(davi.id, { t: 'offer', sdp: recheio, mac: null });
for (let i = 0; i < 60 && davi.recebidos.length === 0; i++) await esperar(500);
check('e conseguem trocar a oferta só pela 443', davi.recebidos.length > 0,
  davi.recebidos.length ? `${Date.now() - t443msg}ms` : 'não chegou em 30s');
check('o SDP chegou íntegro pela 443', davi.recebidos[0]?.dados?.sdp === recheio,
  `${davi.recebidos[0]?.dados?.sdp?.length ?? 0} de ${recheio.length} bytes`);
check('sem duplicata, apesar dos vários relays', davi.recebidos.length === 1,
  `${davi.recebidos.length} entregas`);

const pontos443 = clara.malha.diagnostico();
check('o diagnóstico mostra só pontos da 443',
  pontos443.length > 0 && pontos443.every((p) => p.familia === 'nostr'),
  pontos443.map((p) => `${p.nome}${p.conectado ? '' : ' (fora)'}`).join(', '));

clara.malha.disconnect();
davi.malha.disconnect();

// ───────────── descoberta de endereço e retransmissão ─────────────
//
// Uma requisição STUN Binding crua. Servidores TURN também respondem a ela,
// então serve para saber se estão de pé — o que importa em rede de operadora
// com CGNAT, onde sem retransmissão a conexão direta não fecha.

console.log('\n— descoberta de endereço (STUN/TURN) —');

function pedirBinding(host, porta) {
  return new Promise((res) => {
    const soquete = createSocket('udp4');
    const transacao = randomBytes(12);
    const pedido = Buffer.alloc(20);
    pedido.writeUInt16BE(0x0001, 0); // Binding Request
    pedido.writeUInt16BE(0, 2); // sem atributos
    pedido.writeUInt32BE(0x2112a442, 4); // magic cookie
    transacao.copy(pedido, 8);

    const fim = (v) => { try { soquete.close(); } catch {} res(v); };
    const limite = setTimeout(() => fim(null), 6000);

    soquete.on('message', (msg) => {
      clearTimeout(limite);
      // 0x0101 = Binding Success Response
      if (msg.readUInt16BE(0) !== 0x0101 || !msg.subarray(8, 20).equals(transacao)) return fim(null);
      // XOR-MAPPED-ADDRESS: o endereço público visto de fora.
      let p = 20;
      while (p + 4 <= msg.length) {
        const tipo = msg.readUInt16BE(p);
        const tam = msg.readUInt16BE(p + 2);
        if (tipo === 0x0020 && tam >= 8) {
          const porta = msg.readUInt16BE(p + 6) ^ 0x2112;
          const ip = [...msg.subarray(p + 8, p + 12)].map((b, i) => b ^ [0x21, 0x12, 0xa4, 0x42][i]);
          return fim(`${ip.join('.')}:${porta}`);
        }
        p += 4 + tam + ((4 - (tam % 4)) % 4);
      }
      fim('respondeu');
    });
    soquete.on('error', () => { clearTimeout(limite); fim(null); });
    soquete.send(pedido, porta, host);
  });
}

const stun = ICE_PADRAO.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
  .map((u) => {
    const m = /^(stun|turn|turns):([^:?]+):(\d+)/.exec(u);
    return m ? { esquema: m[1], host: m[2], porta: Number(m[3]), url: u } : null;
  })
  .filter(Boolean)
  // A variante TCP não responde a UDP; conferi-la aqui daria falso negativo.
  .filter((s) => !s.url.includes('transport=tcp'));

let meuEndereco = null;
let respondendo = 0;
for (const alvo of stun) {
  const r = await pedirBinding(alvo.host, alvo.porta);
  observar(`${alvo.esquema}:${alvo.host}:${alvo.porta}`.padEnd(40), r !== null, r ?? 'sem resposta');
  if (r && r.includes(':')) meuEndereco = r;
  if (r) respondendo++;
}

check('a descoberta de endereço funciona', meuEndereco !== null, meuEndereco ?? 'nenhum respondeu');
// A lista é longa justamente para sobreviver a quedas; se sobrar só um, ainda
// funciona, mas é sinal de que ela precisa ser revista.
check('sobra folga se algum cair', respondendo >= 2, `${respondendo} de ${stun.length} respondendo`);

// Não há retransmissor embutido, e isso é decisão, não esquecimento: nenhum
// serviço público de TURN sobreviveu sem cadastro (ver o comentário de
// ICE_PADRAO). Este teste trava a decisão para que ninguém volte a incluir um
// endereço morto sem perceber — endereço morto atrasa toda negociação.
const turns = ICE_PADRAO
  .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
  .filter((u) => /^turns?:/i.test(u));
check('nenhum retransmissor morto na lista embutida', turns.length === 0, turns.join(', ') || 'nenhum');

// ─────────────────────────── resumo ───────────────────────────

console.log(
  falhas === 0
    ? `\nInfraestrutura pública validada${avisos ? ` (${avisos} observação(ões) acima)` : ''}.\n`
    : `\n${falhas} falha(s).\n`,
);
process.exit(falhas === 0 ? 0 : 1);
