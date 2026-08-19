/**
 * O cliente MQTT fala mesmo o protocolo, ou só parece?
 *
 * Escrevi este cliente à mão para não pôr mais uma dependência de terceiro
 * dentro de um instalador que antivírus já olham com desconfiança. A dívida
 * que isso cria é esta: se os bytes saírem errados, nenhum corretor público
 * vai reclamar de forma legível — a conexão simplesmente fecha. Então os
 * pacotes são conferidos aqui contra a especificação, byte a byte.
 *
 * Referência: MQTT 3.1.1, OASIS Standard, seções 2 e 3.
 *
 *   node --import ./test/ts-resolve.mjs test/mqtt.test.mjs
 */
import { ClienteMqtt, _interno } from '../src/shared/mqtt.ts';
import { iniciarCorretorLocal } from './corretor-local.mjs';
import WebSocket from 'ws';

const { tamanhoVariavel, lerTamanhoVariavel, texto, montar } = _interno;

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};
const iguais = (a, b) => a.length === b.length && [...a].every((v, i) => v === b[i]);

// ────────────────── inteiro de tamanho variável ──────────────────
//
// Os valores de fronteira da tabela 2.2.3 da especificação: é onde a
// codificação ganha mais um byte.

check('0 cabe em um byte', iguais(tamanhoVariavel(0), [0x00]));
check('127 é o último de um byte', iguais(tamanhoVariavel(127), [0x7f]));
check('128 vira dois bytes', iguais(tamanhoVariavel(128), [0x80, 0x01]));
check('16 383 é o último de dois', iguais(tamanhoVariavel(16383), [0xff, 0x7f]));
check('16 384 vira três bytes', iguais(tamanhoVariavel(16384), [0x80, 0x80, 0x01]));
check('2 097 152 vira quatro bytes', iguais(tamanhoVariavel(2097152), [0x80, 0x80, 0x80, 0x01]));

for (const valor of [0, 1, 127, 128, 300, 16383, 16384, 100000, 268435455]) {
  const bytes = Uint8Array.from([0xaa, ...tamanhoVariavel(valor)]);
  const lido = lerTamanhoVariavel(bytes, 1);
  check(`${valor} sobrevive à ida e volta`, lido?.valor === valor, `leu ${lido?.valor}`);
}

check('pacote incompleto não é adivinhado', lerTamanhoVariavel(Uint8Array.from([0xaa, 0x80]), 1) === null);
check('sequência inválida é rejeitada',
  lerTamanhoVariavel(Uint8Array.from([0xaa, 0x80, 0x80, 0x80, 0x80]), 1) === null);

// ─────────────────────────── strings ───────────────────────────

check('string leva o tamanho em dois bytes na frente', iguais(texto('MQTT'), [0, 4, 77, 81, 84, 84]));
check('string vazia é só o tamanho', iguais(texto(''), [0, 0]));
check('acento vira UTF-8, não um byte por letra', iguais(texto('ã'), [0, 2, 0xc3, 0xa3]));

// ─────────────────────────── CONNECT ───────────────────────────

const connect = montar(1, 0, [...texto('MQTT'), 4, 0x02, 0, 45, ...texto('ryke-1')]);
check('CONNECT tem o tipo 1 no nibble alto', connect[0] === 0x10, `0x${connect[0].toString(16)}`);
check('o tamanho declarado bate com o corpo', connect[1] === connect.length - 2);
check('o nome do protocolo é MQTT', String.fromCharCode(...connect.subarray(4, 8)) === 'MQTT');
check('o nível declarado é 4 (3.1.1)', connect[8] === 4);
check('a flag de sessão limpa está ligada', (connect[9] & 0x02) === 0x02);
check('não declaramos usuário nem senha', (connect[9] & 0xc0) === 0);
check('o keepalive vai em dois bytes', connect[10] === 0 && connect[11] === 45);

// ────────────────────── SUBSCRIBE e PUBLISH ──────────────────────

const sub = montar(8, 0x02, [0, 1, ...texto('ryke/v1/abc'), 0]);
check('SUBSCRIBE carrega a flag 0x02 obrigatória', sub[0] === 0x82, `0x${sub[0].toString(16)}`);
check('o QoS pedido é 0', sub[sub.length - 1] === 0);

const pub = montar(3, 0, [...texto('ryke/v1/abc'), 9, 9, 9]);
check('PUBLISH tem o tipo 3', pub[0] === 0x30, `0x${pub[0].toString(16)}`);
check('em QoS 0 não há identificador de pacote', pub.length === 2 + 2 + 11 + 3);

const ping = montar(12, 0, []);
check('PINGREQ é um pacote de dois bytes', ping.length === 2 && ping[0] === 0xc0 && ping[1] === 0);

// ─────────────── remontagem de pacotes partidos ───────────────
//
// WebSocket entrega quadros, não pacotes. O cliente precisa aguentar receber
// meio pacote num quadro e o resto no seguinte — e dois pacotes juntos no
// mesmo quadro.

const corretor = await iniciarCorretorLocal();
const abrir = (url, subs) => new WebSocket(url, subs);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const recebidas = [];
const ouvinte = new ClienteMqtt({
  url: corretor.url, abrir, clientId: 'teste-ouvinte',
  aoConectar: () => ouvinte.assinar('ryke/v1/fatiado'),
  aoMensagem: (t, carga) => recebidas.push(new TextDecoder().decode(carga)),
});
ouvinte.conectar();
await esperar(400);

const falante = new ClienteMqtt({ url: corretor.url, abrir, clientId: 'teste-falante' });
falante.conectar();
await esperar(400);

// Uma carga grande obriga o corretor a partir o quadro em algum ponto.
const grande = 'A'.repeat(70000);
falante.publicar('ryke/v1/fatiado', new TextEncoder().encode(grande));
// E várias pequenas em rajada tendem a chegar coladas.
for (let i = 0; i < 20; i++) {
  falante.publicar('ryke/v1/fatiado', new TextEncoder().encode(`n${i}`));
}
await esperar(1200);

check('a carga de 70 KB chegou inteira', recebidas[0] === grande,
  `${recebidas[0]?.length ?? 0} de ${grande.length} bytes`);
check('as 20 mensagens em rajada chegaram todas', recebidas.length === 21, `${recebidas.length} de 21`);
check('e na ordem em que foram enviadas',
  recebidas.slice(1).every((m, i) => m === `n${i}`));

// ───────────────────── conexão que cai ─────────────────────

const quedas = [];
const frouxo = new ClienteMqtt({
  url: corretor.url, abrir, clientId: 'teste-frouxo',
  aoFechar: (motivo) => quedas.push(motivo),
});
frouxo.conectar();
await esperar(400);
check('conectou antes da queda', frouxo.conectado);

corretor.derrubarClientes();
await esperar(500);
check('a queda é reportada', quedas.length === 1, quedas[0] ?? 'nenhuma');
check('e o cliente sabe que não está mais conectado', !frouxo.conectado);
check('publicar depois da queda não estoura', frouxo.publicar('x', new Uint8Array(1)) === false);

// Encerrar de propósito não deve ser confundido com queda.
const limpo = new ClienteMqtt({
  url: corretor.url, abrir, clientId: 'teste-limpo',
  aoFechar: (m) => quedas.push(`limpo:${m}`),
});
limpo.conectar();
await esperar(400);
limpo.encerrar();
await esperar(300);
check('encerramento pedido por nós não vira aviso de queda',
  !quedas.some((q) => q.startsWith('limpo:')), quedas.join(', '));

ouvinte.encerrar();
falante.encerrar();
await corretor.parar();

console.log(falhas === 0 ? '\nCliente MQTT validado.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
