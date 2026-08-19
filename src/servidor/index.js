import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Registry, formatId } from './registry.js';
import { iniciarFarol } from './beacon.js';

/**
 * Servidor de rendezvous do Ryke Desk.
 *
 * Antes era um programa à parte; agora é uma função que roda dentro do próprio
 * aplicativo quando o computador responde "sim" a "vou receber conexão". A
 * mesma função também serve de servidor numa VPS (ver servidor-vps/), sem
 * nenhuma duplicação de código.
 *
 * Ele é um carteiro burro: sabe que o número X está online e que X quer falar
 * com Y, e repassa envelopes fechados. Tela, teclado, arquivos e senha nunca
 * passam por aqui.
 */

const STUN_PADRAO = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

/**
 * @param {object} opcoes
 * @param {number} [opcoes.porta]
 * @param {string} [opcoes.host]
 * @param {string} opcoes.arquivoDados  onde persistir os números emitidos
 * @param {object[]} [opcoes.iceServers]
 * @param {boolean} [opcoes.farol]      anunciar-se na rede local (não usar em VPS)
 * @param {(texto: string) => void} [opcoes.log]
 * @returns {Promise<{ porta: number, parar: () => Promise<void>, online: () => number }>}
 */
export function iniciarServidor(opcoes) {
  const porta = opcoes.porta ?? 8787;
  const host = opcoes.host ?? '0.0.0.0';
  const iceServers = opcoes.iceServers ?? STUN_PADRAO;
  const log = opcoes.log ?? (() => {});
  const registry = new Registry(opcoes.arquivoDados);

  /** @type {Map<string, Peer>} id -> peer online */
  const online = new Map();
  let proximaConexao = 1;

  class Peer {
    constructor(socket, ip) {
      this.socket = socket;
      this.ip = ip;
      this.conexao = proximaConexao++;
      this.id = null;
      this.vivo = true;
      // Balde de fichas: 30 mensagens de partida, recarrega 10 por segundo.
      this.fichas = 30;
      this.ultimaRecarga = Date.now();
    }

    /** @returns {boolean} false quando o peer estourou o limite */
    gastar() {
      const agora = Date.now();
      this.fichas = Math.min(30, this.fichas + ((agora - this.ultimaRecarga) / 1000) * 10);
      this.ultimaRecarga = agora;
      if (this.fichas < 1) return false;
      this.fichas -= 1;
      return true;
    }

    enviar(msg) {
      if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(msg));
    }

    falhar(motivo, detalhe) {
      this.enviar({ t: 'error', reason: motivo, detail: detalhe });
    }
  }

  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, online: online.size, uptime: process.uptime() }));
      return;
    }
    res.writeHead(404).end('Ryke Desk');
  });

  // maxPayload baixo de propósito: aqui só trafega texto de sinalização.
  const wss = new WebSocketServer({ server: http, maxPayload: 256 * 1024 });

  wss.on('connection', (socket, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress;
    const peer = new Peer(socket, ip);

    socket.on('pong', () => {
      peer.vivo = true;
    });

    socket.on('message', (bruto) => {
      let msg;
      try {
        msg = JSON.parse(bruto.toString());
      } catch {
        return peer.falhar('bad-json');
      }
      if (!peer.gastar()) return peer.falhar('rate-limit', 'muitas mensagens em pouco tempo');
      tratar(peer, msg);
    });

    socket.on('close', () => {
      if (peer.id && online.get(peer.id) === peer) {
        online.delete(peer.id);
        log(`[-] ${formatId(peer.id)} saiu (${online.size} online)`);
      }
    });

    socket.on('error', () => socket.terminate());
  });

  function tratar(peer, msg) {
    switch (msg.t) {
      case 'hello': {
        const { id, token, isNew } = registry.claim(msg.token);

        // Se o mesmo número já estava online (app reaberto, rede caiu), a
        // sessão antiga perde a vez para a nova.
        const anterior = online.get(id);
        if (anterior && anterior !== peer) {
          anterior.falhar('replaced', 'este número foi registrado em outra sessão');
          anterior.socket.close(4000, 'replaced');
        }

        peer.id = id;
        online.set(id, peer);
        peer.enviar({ t: 'welcome', id, token, iceServers });
        log(`[+] ${formatId(id)}${isNew ? ' (novo)' : ''} de ${peer.ip} (${online.size} online)`);
        return;
      }

      case 'probe': {
        if (!peer.id) return peer.falhar('not-registered');
        const alvo = normalizarId(msg.to);
        peer.enviar({ t: 'probe-result', to: alvo, online: online.has(alvo) });
        return;
      }

      case 'signal': {
        if (!peer.id) return peer.falhar('not-registered');
        const alvo = normalizarId(msg.to);
        if (!alvo) return peer.falhar('bad-target');

        const destino = online.get(alvo);
        if (!destino) {
          peer.enviar({ t: 'peer-offline', to: alvo });
          return;
        }
        destino.enviar({ t: 'signal', from: peer.id, data: msg.data });
        return;
      }

      case 'bye': {
        if (!peer.id) return;
        const destino = online.get(normalizarId(msg.to));
        if (destino) destino.enviar({ t: 'signal', from: peer.id, data: { t: 'bye', reason: msg.reason } });
        return;
      }

      default:
        peer.falhar('unknown-type', msg.t);
    }
  }

  // Derruba conexões zumbis (cabo arrancado, notebook suspenso) para o número
  // não ficar marcado como online indevidamente.
  const batimento = setInterval(() => {
    for (const peer of online.values()) {
      if (!peer.vivo) {
        peer.socket.terminate();
        continue;
      }
      peer.vivo = false;
      peer.socket.ping();
    }
  }, 30_000);

  let farol = null;

  return new Promise((resolve, reject) => {
    http.once('error', (err) => {
      clearInterval(batimento);
      reject(err);
    });

    http.listen(porta, host, () => {
      log(`servidor de conexão no ar em ws://${host}:${porta}`);
      if (opcoes.farol !== false) farol = iniciarFarol(porta, Date.now(), log);

      resolve({
        porta,
        online: () => online.size,
        parar: () =>
          new Promise((pronto) => {
            clearInterval(batimento);
            farol?.close();
            for (const peer of online.values()) peer.socket.close(1001, 'servidor encerrando');
            wss.close();
            http.close(() => pronto());
          }),
      });
    });
  });
}

/** Aceita "123 456 789", "123-456-789" ou "123456789". */
function normalizarId(valor) {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  return digitos.length === 9 ? digitos : null;
}
