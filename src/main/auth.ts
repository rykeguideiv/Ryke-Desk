/**
 * Autenticação por senha entre anfitrião e visitante — desafio e resposta.
 *
 * A senha nunca sai do computador de quem a digita, e o servidor de conexão
 * jamais a vê (nem cifrada). O passo a passo:
 *
 *   1. anfitrião  →  { salt, nonce, parâmetros }        (salt fixo, nonce único)
 *   2. visitante:    chave = scrypt(senha, salt)
 *                    prova = HMAC-SHA256(chave, nonce)
 *   3. visitante  →  { prova }
 *   4. anfitrião:    confere contra HMAC-SHA256(verificador, nonce)
 *
 * O verificador guardado no anfitrião é exatamente scrypt(senha, salt). Ou
 * seja: o disco nunca guarda a senha, e a rede nunca transporta nem a senha
 * nem o verificador — só uma prova descartável, válida para um único nonce.
 */
import { randomBytes, scryptSync, createHmac, timingSafeEqual } from 'node:crypto';

import type { ScryptParams } from '../shared/config';

export type { ScryptParams };

/** ~16 MB de memória e algumas dezenas de ms por tentativa: caro para força bruta, imperceptível para o usuário. */
export const SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1, keylen: 32 };

const NONCE_TTL_MS = 60_000;

export function deriveVerifier(password: string, salt: Buffer, params: ScryptParams = SCRYPT_PARAMS): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    // scrypt precisa de ~128·N·r bytes; o padrão do Node (32 MB) fica apertado.
    maxmem: 256 * 1024 * 1024,
  });
}

export function proofFor(verifier: Buffer, nonce: Buffer): string {
  return createHmac('sha256', verifier).update(nonce).digest('hex');
}

/**
 * Chave de sessão derivada da senha, usada para carimbar o SDP.
 *
 * Sem isso o servidor de sinalização — que repassa a oferta e a resposta —
 * poderia trocar as impressões digitais DTLS dos dois lados por uma sua e
 * ficar no meio da conversa, decifrando tela e teclado. A senha nunca chega
 * ao servidor, então ele não consegue produzir este carimbo; qualquer troca
 * de SDP é detectada.
 *
 * Vale apenas no acesso com senha. No modo supervisionado não há segredo
 * partilhado — quem autoriza está olhando a tela e assume esse risco.
 */
export function sessionKeyFor(verifier: Buffer, nonce: Buffer): Buffer {
  return createHmac('sha256', verifier).update(nonce).update('ryke-sdp-v1').digest();
}

export function macFor(sessionKey: Buffer, dados: string): string {
  return createHmac('sha256', sessionKey).update(dados, 'utf8').digest('hex');
}

export function macConfere(sessionKey: Buffer, dados: string, recebido: string): boolean {
  const esperado = Buffer.from(macFor(sessionKey, dados), 'hex');
  let atual: Buffer;
  try {
    atual = Buffer.from(recebido, 'hex');
  } catch {
    return false;
  }
  return atual.length === esperado.length && timingSafeEqual(atual, esperado);
}

export function newSalt(): Buffer {
  return randomBytes(16);
}

export type Challenge = {
  salt: string;
  nonce: string;
  scrypt: ScryptParams;
};

/**
 * Emite e valida desafios. Cada nonce serve uma única vez e expira em 60 s,
 * então capturar o tráfego de uma conexão bem-sucedida não permite repeti-la.
 */
export class ChallengeBook {
  private pending = new Map<string, { peerId: string; at: number }>();

  issue(peerId: string, salt: Buffer): Challenge {
    this.#sweep();
    const nonce = randomBytes(32).toString('hex');
    this.pending.set(nonce, { peerId, at: Date.now() });
    return { salt: salt.toString('hex'), nonce, scrypt: SCRYPT_PARAMS };
  }

  /**
   * Consome o nonce e confere a prova.
   * @returns 'ok' | 'nonce-invalido' | 'senha-incorreta'
   */
  redeem(peerId: string, nonce: string, proof: string, verifier: Buffer): 'ok' | 'nonce-invalido' | 'senha-incorreta' {
    this.#sweep();
    const entry = this.pending.get(nonce);
    // Um nonce só vale uma vez, e só para quem o pediu.
    if (!entry || entry.peerId !== peerId) return 'nonce-invalido';
    this.pending.delete(nonce);

    const expected = Buffer.from(proofFor(verifier, Buffer.from(nonce, 'hex')), 'hex');
    let received: Buffer;
    try {
      received = Buffer.from(proof, 'hex');
    } catch {
      return 'senha-incorreta';
    }
    if (received.length !== expected.length) return 'senha-incorreta';
    return timingSafeEqual(received, expected) ? 'ok' : 'senha-incorreta';
  }

  #sweep(): void {
    const cutoff = Date.now() - NONCE_TTL_MS;
    for (const [nonce, entry] of this.pending) {
      if (entry.at < cutoff) this.pending.delete(nonce);
    }
  }
}

/**
 * Freio contra tentativa de adivinhar a senha.
 *
 * As três primeiras tentativas erradas passam sem espera (gente erra a
 * digitação). Depois disso a espera cresce e, combinada com o custo do scrypt,
 * torna a varredura de senhas inviável mesmo com o número Ryke conhecido.
 */
export class Throttle {
  private strikes = new Map<string, { count: number; until: number }>();
  /**
   * Freio que NÃO depende de quem está batendo à porta.
   *
   * Sem ele o bloqueio seria contornável de forma trivial: o número do
   * visitante é escolhido por ele mesmo — basta reconectar ao servidor sem
   * token para receber um número novo em folha e, com ele, um contador de
   * falhas zerado. Contando também as falhas do computador como um todo, mil
   * números diferentes continuam esbarrando no mesmo limite.
   */
  private global = { count: 0, until: 0, primeiraFalha: 0 };

  // Indexada pela contagem de falhas (posição 0 nunca é usada): as falhas
  // 1, 2 e 3 passam livres; da 4ª em diante a espera cresce até 15 minutos.
  private static readonly LADDER = [0, 0, 0, 0, 5, 15, 60, 300, 900];
  /** A escada global é mais curta: 6 erros vindos de qualquer origem já travam. */
  private static readonly LADDER_GLOBAL = [0, 0, 0, 0, 0, 0, 10, 30, 120, 600, 1800];
  /** Depois de 10 minutos sem erro nenhum, o histórico global é esquecido. */
  private static readonly JANELA_GLOBAL_MS = 10 * 60 * 1000;

  /** @returns segundos restantes de bloqueio, ou 0 se pode tentar agora */
  lockedFor(peerId: string): number {
    const restante = (until: number): number => {
      const s = Math.ceil((until - Date.now()) / 1000);
      return s > 0 ? s : 0;
    };
    this.#expirarGlobal();
    const porPeer = this.strikes.get(peerId);
    // Vale o mais restritivo dos dois.
    return Math.max(porPeer ? restante(porPeer.until) : 0, restante(this.global.until));
  }

  /** @returns segundos de espera aplicados a partir de agora */
  fail(peerId: string): number {
    this.#expirarGlobal();

    const entry = this.strikes.get(peerId) ?? { count: 0, until: 0 };
    entry.count += 1;
    const espera = Throttle.LADDER[Math.min(entry.count, Throttle.LADDER.length - 1)];
    entry.until = Date.now() + espera * 1000;
    this.strikes.set(peerId, entry);

    if (this.global.count === 0) this.global.primeiraFalha = Date.now();
    this.global.count += 1;
    const esperaGlobal =
      Throttle.LADDER_GLOBAL[Math.min(this.global.count, Throttle.LADDER_GLOBAL.length - 1)];
    this.global.until = Date.now() + esperaGlobal * 1000;

    return Math.max(espera, esperaGlobal);
  }

  succeed(peerId: string): void {
    this.strikes.delete(peerId);
    // Uma senha correta absolve também o histórico global: quem acertou
    // provou que não é uma varredura.
    this.global = { count: 0, until: 0, primeiraFalha: 0 };
  }

  /** Esquece o histórico global depois de um período tranquilo. */
  #expirarGlobal(): void {
    if (this.global.count === 0) return;
    const quieto = Date.now() - this.global.primeiraFalha > Throttle.JANELA_GLOBAL_MS;
    if (quieto && Date.now() > this.global.until) {
      this.global = { count: 0, until: 0, primeiraFalha: 0 };
    }
  }
}
