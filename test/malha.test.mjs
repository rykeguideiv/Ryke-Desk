/**
 * A malha entrega o recado, e só o recado certo?
 *
 * Aqui não se testa criptografia (isso é encontro.test.mjs) e sim o
 * comportamento de rede: dois computadores que nunca se viram trocando
 * mensagens por corretores públicos que não são de ninguém. O que precisa
 * valer:
 *
 *   · a mensagem chega, mesmo saindo por três caminhos ao mesmo tempo;
 *   · chega UMA vez, não três;
 *   · dois computadores nunca ficam com o mesmo número;
 *   · derrubar um corretor no meio da conversa não derruba a conversa;
 *   · um número trocado de máquina é denunciado, não aceito em silêncio.
 *
 *   node --import ./test/ts-resolve.mjs test/malha.test.mjs
 */
import WebSocket from 'ws';
import { Malha } from '../src/shared/malha.ts';
import { ClienteMqtt } from '../src/shared/mqtt.ts';
import { criarIdentidade, chaveDe, topicoDe, selar } from '../src/shared/encontro.ts';
import { iniciarCorretorLocal } from './corretor-local.mjs';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

const abrir = (url, subs) => new WebSocket(url, subs);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function cofreDeMemoria(numero = null) {
  const dados = { numero, chavePrivada: null, pinos: {} };
  return {
    dados,
    ler: async () => ({ numero: dados.numero, chavePrivada: dados.chavePrivada }),
    gravar: async (n, c) => {
      dados.numero = n;
      dados.chavePrivada = c;
    },
    lerPinos: async () => ({ ...dados.pinos }),
    gravarPino: async (n, i) => {
      dados.pinos[n] = i;
    },
  };
}

/** Sobe uma malha e devolve quando ela já tem número. */
function subirMalha(cofre, corretores) {
  // relays: [] mantem o teste hermetico — sem isto ele abriria relays reais
  // da internet e passaria a falhar por causa da rede alheia.
  const malha = new Malha({ cofre, abrir, corretores, relays: [], esperaPresencaMs: 400 });
  const recebidos = [];
  const avisos = [];
  malha.on('signal', (de, dados) => recebidos.push({ de, dados }));
  malha.on('identidadeMudou', (n, esperada, recebida) => avisos.push({ n, esperada, recebida }));
  const duplicados = [];
  malha.on('numeroDuplicado', (n) => duplicados.push(n));
  return new Promise((resolve) => {
    malha.on('welcome', ({ id, iceServers, impressao }) => {
      resolve({ malha, id, iceServers, impressao, recebidos, avisos, duplicados });
    });
    malha.connect();
  });
}

// ───────────────── Conversa por três corretores ─────────────────

const c1 = await iniciarCorretorLocal();
const c2 = await iniciarCorretorLocal();
const c3 = await iniciarCorretorLocal();
const TRES = [c1.url, c2.url, c3.url];

const ana = await subirMalha(cofreDeMemoria(), TRES);
const bento = await subirMalha(cofreDeMemoria(), TRES);

check('os dois receberam número de doze dígitos', /^\d{12}$/.test(ana.id) && /^\d{12}$/.test(bento.id));
check('os números são diferentes', ana.id !== bento.id, `${ana.id} e ${bento.id}`);
check('os dois estão online', ana.malha.connected && bento.malha.connected);
check('cada um tem sua impressão digital', ana.impressao !== bento.impressao);
// A lista de descoberta de endereço é longa de propósito — um servidor fora
// do ar ou bloqueado pela rede do usuário não pode custar a conexão. E não
// carrega retransmissor nenhum: nenhum público sobreviveu sem cadastro, e
// endereço morto na lista só atrasa a negociação (ver ICE_PADRAO).
const enderecos = ana.iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
check('há vários servidores de descoberta de endereço', enderecos.length >= 4, `${enderecos.length}`);
check('de operadores independentes',
  new Set(enderecos.map((u) => u.split(':')[1].split('.').slice(-2).join('.'))).size >= 3);
check('nenhum retransmissor morto embutido', !enderecos.some((u) => /^turns?:/i.test(u)));

ana.malha.send(bento.id, { t: 'knock', app: 'ryke-desk', name: 'PC da Ana', modo: 'pedido' });
await esperar(1200);

check('a mensagem chegou ao destino', bento.recebidos.length > 0);
check('chegou uma única vez, apesar dos três corretores', bento.recebidos.length === 1,
  `${bento.recebidos.length} entregas`);
check('o conteúdo está certo', bento.recebidos[0]?.dados?.name === 'PC da Ana');
check('o remetente está certo', bento.recebidos[0]?.de === ana.id);
check('quem publicou não recebe a própria mensagem', ana.recebidos.length === 0);

bento.malha.send(ana.id, { t: 'aguardando', hostName: 'PC do Bento' });
await esperar(1200);
check('a resposta volta pelo mesmo caminho', ana.recebidos.length === 1);
check('e traz o conteúdo certo', ana.recebidos[0]?.dados?.hostName === 'PC do Bento');

// ─────────────── Conversa de terceiros não vaza ───────────────

const carla = await subirMalha(cofreDeMemoria(), TRES);
ana.malha.send(bento.id, { t: 'bye', reason: 'tchau' });
await esperar(1000);
check('quem não é o destinatário não recebe nada', carla.recebidos.length === 0);
check('o destinatário recebeu', bento.recebidos.length === 2);

// ─────────────────── Colisão de número ───────────────────

// Uma instalação clonada pode carregar tanto o número quanto a chave privada.
// Mesmo nesse caso os dois processos precisam ser reconhecidos como PCs
// diferentes, e o que entrou depois recebe automaticamente um número livre.

const mesmoNumero = '481922730155';
const cofrePrimeiro = cofreDeMemoria(mesmoNumero);
const primeiro = await subirMalha(cofrePrimeiro, TRES);
check('o primeiro fica com o número que pediu', primeiro.id === mesmoNumero);

const cofreSegundo = cofreDeMemoria(mesmoNumero);
cofreSegundo.dados.chavePrivada = cofrePrimeiro.dados.chavePrivada;
const segundo = await subirMalha(cofreSegundo, TRES);
check('o segundo troca automaticamente o número repetido',
  segundo.id !== mesmoNumero && /^\d{12}$/.test(segundo.id), `recebeu ${segundo.id}`);
check('a colisão é informada enquanto o número novo é gerado',
  segundo.duplicados.includes(mesmoNumero), segundo.duplicados.join(',') || 'nenhum aviso');
check('e o primeiro mantém o dele', primeiro.id === mesmoNumero);
check('o número exclusivo do segundo fica salvo', cofreSegundo.dados.numero === segundo.id);

// A troca manual continua existindo.
const numeroAntesDaTroca = segundo.id;
const trocado = await segundo.malha.trocarNumero();
check('trocar por pedido explícito funciona',
  trocado !== numeroAntesDaTroca && /^\d{12}$/.test(trocado),
  `${numeroAntesDaTroca} → ${trocado}`);

// E o número guardado sobrevive a reabrir o programa — é o que faz um
// favorito anotado continuar valendo amanhã.
const cofreFixo = cofreDeMemoria('700100200300');
const primeiraAbertura = await subirMalha(cofreFixo, TRES);
primeiraAbertura.malha.disconnect();
const segundaAbertura = await subirMalha(cofreFixo, TRES);
check('o número é o mesmo depois de fechar e abrir', segundaAbertura.id === '700100200300',
  segundaAbertura.id);
segundaAbertura.malha.disconnect();

// ────────── Número gravado por uma versão anterior ──────────
//
// Regressão real, e das que enganam: a configuração fica em %APPDATA% e
// sobrevive de propósito à desinstalação, para ninguém precisar avisar os
// contatos de um número novo a cada atualização. Quando o formato mudou de
// nove para doze dígitos, esse mesmo cuidado virou armadilha — a máquina
// atualizada continuou anunciando o número velho, que o outro lado nem
// conseguia digitar.

const cofreAntigo = cofreDeMemoria('649148991'); // nove dígitos, formato antigo
const atualizado = await subirMalha(cofreAntigo, TRES);
check('número de versão anterior é descartado', atualizado.id !== '649148991');
check('e um do formato novo é sorteado no lugar', /^\d{12}$/.test(atualizado.id), atualizado.id);
check('o número novo é gravado no cofre', cofreAntigo.dados.numero === atualizado.id);

// Lixo no arquivo de configuração não pode impedir o programa de abrir.
for (const ruim of ['', 'abc', '12345678901234567890', '00000000000']) {
  const c = cofreDeMemoria(ruim);
  const m = await subirMalha(c, TRES);
  check(`configuração inválida (${ruim || 'vazia'}) não trava o programa`,
    /^\d{12}$/.test(m.id), m.id);
  m.malha.disconnect();
}

// E um número válido do formato atual precisa ser preservado: a estabilidade
// do número é o que faz o contato anotado continuar valendo.
const guardado = '481922730177';
const estavel = await subirMalha(cofreDeMemoria(guardado), TRES);
check('número válido já gravado é mantido', estavel.id === guardado, estavel.id);
estavel.malha.disconnect();
atualizado.malha.disconnect();

// ─────────────────── Sondagem de presença ───────────────────

const semNinguem = [];
ana.malha.on('peerOffline', (n) => semNinguem.push(n));
ana.malha.probe('100000001999');
await esperar(1500);
check('número que não existe é reportado como offline', semNinguem.includes('100000001999'));

semNinguem.length = 0;
ana.malha.probe(bento.id);
await esperar(1500);
check('número que existe não é reportado como offline', !semNinguem.includes(bento.id));

// ─────────────── Queda de corretor no meio ───────────────

await c1.parar();
await esperar(600);
check('a malha continua online com dois corretores', ana.malha.connected && bento.malha.connected);

const antes = bento.recebidos.length;
ana.malha.send(bento.id, { t: 'accepted' });
await esperar(1500);
check('a mensagem passa mesmo com um corretor fora do ar', bento.recebidos.length === antes + 1);

await c2.parar();
await esperar(600);
const antes2 = bento.recebidos.length;
ana.malha.send(bento.id, { t: 'denied', reason: 'recusado' });
await esperar(1500);
check('com um único corretor de pé ainda funciona', bento.recebidos.length === antes2 + 1);

// ───────── Identidade fixada na primeira conexão (TOFU) ─────────
//
// O ataque que só existe num meio aberto: alguém descobriu o número do Bento
// e quer atender, no lugar dele, a chamada que a Ana está fazendo. Sabe o
// número, então cifra e endereça certo — o que ele não tem é a chave do Bento.
//
// Note onde o golpe precisa ser dado: no tópico do ANFITRIÃO, que é onde a
// conversa acontece e onde a Ana está escutando. Publicar em qualquer outro
// lugar não alcançaria ninguém.
//
// E um impostor de verdade não usa o programa normal — ele sortearia outro
// número ao ver aquele ocupado. O ataque fala direto no protocolo, que é o
// que este trecho faz, publicando o envelope na mão.

const impostor = await criarIdentidade();
const chaveDoNumeroDoBento = await chaveDe(bento.id);
const topicoDoBento = await topicoDe(bento.id);

const forjado = await selar(chaveDoNumeroDoBento, impostor, {
  de: bento.id, // dizendo-se o Bento
  para: ana.id,
  dados: { k: 'sinal', p: { t: 'accepted' } },
});

const bocaDoImpostor = new ClienteMqtt({
  url: c3.url,
  abrir,
  clientId: `impostor-${Date.now().toString(16)}`,
  aoConectar: () => bocaDoImpostor.publicar(topicoDoBento, forjado),
});

const antesAviso = ana.avisos.length;
const antesSinal = ana.recebidos.length;
bocaDoImpostor.conectar();
await esperar(1500);

check('a troca de identidade é detectada', ana.avisos.length === antesAviso + 1);
check('e a mensagem do impostor é descartada', ana.recebidos.length === antesSinal,
  `${ana.recebidos.length - antesSinal} passaram`);
if (ana.avisos.length > antesAviso) {
  const aviso = ana.avisos[ana.avisos.length - 1];
  check('o aviso aponta o número usado no golpe', aviso.n === bento.id, `número ${aviso.n}`);
  check('e mostra a impressão esperada', aviso.esperada === bento.impressao);
  check('e a que chegou no lugar', aviso.recebida === impostor.impressao);
  check('as duas são diferentes', aviso.esperada !== aviso.recebida,
    `${aviso.esperada} ≠ ${aviso.recebida}`);
}

// O Bento legítimo continua passando: a fixação não pode quebrar quem é honesto.
const antesLegitimo = ana.recebidos.length;
bento.malha.send(ana.id, { t: 'bye', reason: 'fim' });
await esperar(1200);
check('o dono verdadeiro do número segue aceito', ana.recebidos.length === antesLegitimo + 1);

// ───────────────────────── Encerramento ─────────────────────────

bocaDoImpostor.encerrar();
for (const m of [ana, bento, carla, primeiro, segundo]) m.malha.disconnect();
await c3.parar();

console.log(falhas === 0 ? '\nMalha de encontro validada.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
