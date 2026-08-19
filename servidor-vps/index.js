/**
 * Servidor Ryke Desk para VPS.
 *
 * É a mesma implementação que roda dentro do aplicativo (src/servidor), só que
 * como processo próprio e sem o farol de rede local — difusão UDP não sai da
 * rede e num datacenter só responderia a vizinhos indesejados.
 *
 *   node servidor-vps/index.js
 */
import { iniciarServidor } from '../src/servidor/index.js';

const PORTA = Number(process.env.RYKE_PORT ?? 8787);
const HOST = process.env.RYKE_HOST ?? '0.0.0.0';
const DADOS = process.env.RYKE_DATA ?? './data/devices.json';

/**
 * STUN resolve a maioria dos NATs; TURN é o plano B obrigatório para NAT
 * simétrico (4G/5G, redes corporativas), onde o tráfego precisa ser
 * retransmitido por um intermediário.
 */
function servidoresIce() {
  if (process.env.RYKE_ICE_JSON) return JSON.parse(process.env.RYKE_ICE_JSON);
  const lista = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.RYKE_TURN_URL) {
    lista.push({
      urls: process.env.RYKE_TURN_URL.split(',').map((u) => u.trim()),
      username: process.env.RYKE_TURN_USER,
      credential: process.env.RYKE_TURN_PASS,
    });
  }
  return lista;
}

const servidor = await iniciarServidor({
  porta: PORTA,
  host: HOST,
  arquivoDados: DADOS,
  iceServers: servidoresIce(),
  farol: false,
  log: (texto) => console.log(texto),
}).catch((err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  A porta ${PORTA} ja esta em uso.\n`);
  } else {
    console.error(`\n  Falha ao subir: ${err.message}\n`);
  }
  process.exit(1);
});

console.log(`
  ## Ryke Desk - servidor de conexao
  escutando  ws://${HOST}:${PORTA}
  saude      http://${HOST}:${PORTA}/health
`);

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, async () => {
    console.log('\nencerrando...');
    await servidor.parar();
    process.exit(0);
  });
}
