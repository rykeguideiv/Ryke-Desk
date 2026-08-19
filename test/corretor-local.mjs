/**
 * Corretor MQTT mínimo, só para os testes.
 *
 * Os testes não podem depender de broker.emqx.io estar de pé: um teste que
 * falha por causa da internet de terceiros não diz nada sobre o nosso código.
 * Este corretor faz o suficiente para a malha funcionar — conectar, assinar,
 * publicar, repassar — e roda em memória.
 *
 * Ele também serve de banco de provas: dá para derrubá-lo no meio de uma
 * conversa e conferir se a malha aguenta.
 */
import { WebSocketServer } from 'ws';

function lerTamanhoVariavel(dados, inicio) {
  let mult = 1;
  let valor = 0;
  let i = inicio;
  for (let v = 0; v < 4; v++) {
    if (i >= dados.length) return null;
    const b = dados[i++];
    valor += (b & 0x7f) * mult;
    if ((b & 0x80) === 0) return { valor, bytes: i - inicio };
    mult *= 128;
  }
  return null;
}

function tamanhoVariavel(valor) {
  const saida = [];
  let n = valor;
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    saida.push(b);
  } while (n > 0);
  return saida;
}

const montar = (tipo, flags, corpo) =>
  Buffer.from([(tipo << 4) | flags, ...tamanhoVariavel(corpo.length), ...corpo]);

/** Assinantes casam por igualdade simples; a malha não usa curinga. */
export async function iniciarCorretorLocal(porta = 0) {
  const wss = new WebSocketServer({ port: porta, handleProtocols: () => 'mqtt' });
  await new Promise((r) => wss.once('listening', r));

  /** socket → Set<tópico> */
  const assinaturas = new Map();
  let entregues = 0;

  wss.on('connection', (ws) => {
    assinaturas.set(ws, new Set());
    let buffer = Buffer.alloc(0);

    ws.on('message', (dados) => {
      buffer = Buffer.concat([buffer, Buffer.from(dados)]);
      for (;;) {
        if (buffer.length < 2) return;
        const cab = lerTamanhoVariavel(buffer, 1);
        if (!cab) return;
        const total = 1 + cab.bytes + cab.valor;
        if (buffer.length < total) return;
        const tipo = buffer[0] >> 4;
        const corpo = buffer.subarray(1 + cab.bytes, total);
        buffer = buffer.subarray(total);

        if (tipo === 1) {
          ws.send(montar(2, 0, [0, 0])); // CONNACK: sessão nova, aceito
        } else if (tipo === 8) {
          // SUBSCRIBE: id do pacote, depois pares (tópico, qos)
          const id = (corpo[0] << 8) | corpo[1];
          let p = 2;
          const concedidos = [];
          while (p < corpo.length) {
            const tam = (corpo[p] << 8) | corpo[p + 1];
            assinaturas.get(ws).add(corpo.subarray(p + 2, p + 2 + tam).toString('utf8'));
            p += 2 + tam + 1;
            concedidos.push(0);
          }
          ws.send(montar(9, 0, [id >> 8, id & 0xff, ...concedidos]));
        } else if (tipo === 3) {
          const tam = (corpo[0] << 8) | corpo[1];
          const topico = corpo.subarray(2, 2 + tam).toString('utf8');
          const carga = corpo.subarray(2 + tam);
          const pacote = montar(3, 0, [...corpo.subarray(0, 2 + tam), ...carga]);
          for (const [outro, topicos] of assinaturas) {
            if (outro.readyState === 1 && topicos.has(topico)) {
              outro.send(pacote);
              entregues++;
            }
          }
        } else if (tipo === 12) {
          ws.send(montar(13, 0, []));
        } else if (tipo === 14) {
          ws.close();
        }
      }
    });

    ws.on('close', () => assinaturas.delete(ws));
    ws.on('error', () => assinaturas.delete(ws));
  });

  const { port } = wss.address();
  return {
    url: `ws://127.0.0.1:${port}/mqtt`,
    get entregues() {
      return entregues;
    },
    get clientes() {
      return assinaturas.size;
    },
    /** Derruba todas as conexões sem fechar a porta — simula queda do corretor. */
    derrubarClientes() {
      for (const ws of assinaturas.keys()) ws.terminate();
      assinaturas.clear();
    },
    async parar() {
      for (const ws of assinaturas.keys()) ws.terminate();
      await new Promise((r) => wss.close(r));
    },
  };
}
