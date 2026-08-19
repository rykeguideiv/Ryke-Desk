import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Guarda o vínculo permanente entre um dispositivo e o seu número Ryke.
 *
 * O dispositivo recebe, no primeiro contato, um par { id, token }. O token é o
 * segredo que prova "eu sou o dono deste número" nas reconexões seguintes —
 * é ele que impede alguém de reivindicar o ID de outra pessoa no servidor.
 * A senha de acesso NÃO passa por aqui: ela é verificada ponta-a-ponta entre
 * os dois PCs (ver docs/PROTOCOLO.md).
 */
export class Registry {
  /** @param {string} file caminho do JSON de persistência */
  constructor(file) {
    this.file = resolve(file);
    /** @type {Map<string, {id: string, createdAt: number, lastSeen: number}>} token -> device */
    this.byToken = new Map();
    /** @type {Set<string>} */
    this.usedIds = new Set();
    this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [token, device] of Object.entries(raw.devices ?? {})) {
        this.byToken.set(token, device);
        this.usedIds.add(device.id);
      }
      console.log(`[registry] ${this.byToken.size} dispositivo(s) carregado(s)`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[registry] falha ao ler estado:', err.message);
    }
  }

  #persist() {
    const devices = Object.fromEntries(this.byToken);
    mkdirSync(dirname(this.file), { recursive: true });
    // Escrita atômica: um crash no meio do write não corrompe o arquivo.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ devices }, null, 2));
    renameSync(tmp, this.file);
  }

  /** Gera um número de 9 dígitos ainda não usado, formatado como 123 456 789. */
  #allocateId() {
    for (let attempt = 0; attempt < 10_000; attempt++) {
      // Primeiro dígito de 1 a 9 para o número nunca começar com zero.
      const first = 1 + (randomBytes(1)[0] % 9);
      let rest = '';
      while (rest.length < 8) rest += (randomBytes(1)[0] % 10).toString();
      const id = `${first}${rest}`;
      if (!this.usedIds.has(id)) return id;
    }
    throw new Error('espaço de IDs esgotado');
  }

  /**
   * Devolve o dispositivo dono do token, ou cria um novo se o token for
   * ausente/desconhecido.
   * @param {string | undefined | null} token
   * @returns {{ id: string, token: string, isNew: boolean }}
   */
  claim(token) {
    if (typeof token === 'string' && token.length === 64) {
      const existing = this.byToken.get(token);
      if (existing) {
        existing.lastSeen = Date.now();
        this.#persist();
        return { id: existing.id, token, isNew: false };
      }
    }

    const newToken = randomBytes(32).toString('hex');
    const id = this.#allocateId();
    this.byToken.set(newToken, { id, createdAt: Date.now(), lastSeen: Date.now() });
    this.usedIds.add(id);
    this.#persist();
    return { id, token: newToken, isNew: true };
  }

  /** Confere se o token realmente pertence ao id informado (comparação constante). */
  verify(token, id) {
    const device = this.byToken.get(token);
    if (!device) return false;
    const a = Buffer.from(device.id);
    const b = Buffer.from(String(id));
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** Apresentação amigável: 123456789 -> "123 456 789". */
export function formatId(id) {
  return String(id).replace(/(\d{3})(?=\d)/g, '$1 ');
}
