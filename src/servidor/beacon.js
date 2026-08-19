import { createSocket } from 'node:dgram';

/**
 * Farol de descoberta na rede local.
 *
 * Existe para que ninguém precise digitar endereço de servidor. Quem vai
 * abrir o Ryke Desk pergunta em difusão "tem servidor aí?" e quem estiver
 * servindo responde com sua porta e o instante em que subiu.
 *
 * O instante é o que resolve o empate quando dois computadores ligam quase
 * juntos: todo mundo escolhe o servidor MAIS ANTIGO, então os dois lados
 * convergem para o mesmo, sem eleição nem coordenação.
 *
 * Só vale para a rede local — difusão UDP não atravessa roteador. Para
 * internet, o endereço da VPS é configurado uma vez e este farol fica ocioso.
 */

export const PORTA_FAROL = 8788;
const PERGUNTA = 'ryke-desk:quem-esta-ai';
const RESPOSTA = 'ryke-desk:servidor';

/**
 * @param {number} portaServidor porta do WebSocket a anunciar
 * @param {number} desde timestamp (ms) em que o servidor subiu
 * @returns {{ close: () => void }}
 */
export function iniciarFarol(portaServidor, desde = Date.now(), log = console.log) {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('message', (dados, remetente) => {
    if (dados.toString('utf8', 0, PERGUNTA.length) !== PERGUNTA) return;
    const anuncio = JSON.stringify({ tipo: RESPOSTA, porta: portaServidor, desde });
    // Responde direto a quem perguntou, não em difusão.
    socket.send(anuncio, remetente.port, remetente.address);
  });

  socket.on('error', (err) => {
    // Farol é conveniência: se a porta estiver ocupada ou o firewall barrar,
    // o servidor continua perfeitamente utilizável por endereço explícito.
    log(`[farol] descoberta na rede local indisponível: ${err.message}`);
    socket.close();
  });

  socket.bind(PORTA_FAROL, () => {
    socket.setBroadcast(true);
    log(`[farol] anunciando na rede local (UDP ${PORTA_FAROL})`);
  });

  return { close: () => socket.close() };
}

/**
 * Pergunta na rede local quem está servindo.
 *
 * @param {number} esperaMs quanto tempo aguardar por respostas
 * @returns {Promise<{ endereco: string, porta: number, desde: number }[]>}
 */
export function procurarServidores(esperaMs = 1500) {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4' });
    const achados = new Map();

    socket.on('message', (dados, remetente) => {
      try {
        const resposta = JSON.parse(dados.toString());
        if (resposta.tipo !== RESPOSTA) return;
        achados.set(remetente.address, {
          endereco: remetente.address,
          porta: resposta.porta,
          desde: resposta.desde ?? 0,
        });
      } catch {
        /* pacote de outra coisa qualquer na rede */
      }
    });

    socket.on('error', () => {
      socket.close();
      resolve([]);
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      // Duas perguntas espaçadas: pacote UDP se perde sem aviso, e uma única
      // tentativa perdida faria o computador achar que está sozinho na rede.
      const perguntar = () => socket.send(PERGUNTA, PORTA_FAROL, '255.255.255.255');
      perguntar();
      setTimeout(perguntar, Math.min(400, esperaMs / 2));

      setTimeout(() => {
        socket.close();
        resolve([...achados.values()]);
      }, esperaMs);
    });
  });
}

/** O servidor mais antigo vence; empate se decide pelo menor IP. */
export function escolherServidor(servidores) {
  if (servidores.length === 0) return null;
  return [...servidores].sort((a, b) => {
    if (a.desde !== b.desde) return a.desde - b.desde;
    return compararIp(a.endereco, b.endereco);
  })[0];
}

function compararIp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
