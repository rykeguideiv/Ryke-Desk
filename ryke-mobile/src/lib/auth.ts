/**
 * Prova de senha, do lado do celular.
 *
 * O PC anfitrião guarda um verificador — scrypt(senha, sal) — e nunca a senha.
 * Para entrar, ele manda um desafio e o visitante devolve
 * HMAC-SHA256(verificador, nonce). A senha em si não trafega nunca, e quem
 * escuta a conversa não consegue reusar a prova, porque o nonce muda a cada
 * tentativa.
 *
 * POR QUE UMA IMPLEMENTAÇÃO EM JAVASCRIPT PURO
 *
 * No PC, isso roda no processo principal com o `crypto` do Node, que traz
 * scrypt pronto. Aqui não existe processo principal: o aplicativo é uma
 * página dentro do WebView do Android. E o WebCrypto do navegador, que tem
 * PBKDF2, AES e HMAC, **não tem scrypt** — a função nunca foi padronizada
 * para a web.
 *
 * Trocar por PBKDF2 no celular não era opção: o verificador guardado no PC é
 * scrypt, e trocar a função aqui simplesmente faria a senha nunca conferir.
 * Compatibilidade byte a byte com o desktop não é um detalhe, é o requisito.
 *
 * Daí a biblioteca `@noble/hashes`: implementação auditada, sem dependências,
 * e a mesma família que já usamos para as assinaturas da malha.
 */
import { scrypt } from '@noble/hashes/scrypt.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** Precisa ser idêntico ao do PC (`src/main/auth.ts`). */
export type ScryptParams = { N: number; r: number; p: number; keylen: number };
export const SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1, keylen: 32 };

const codificador = new TextEncoder();

export function deHex(texto: string): Uint8Array {
  const limpo = texto.trim();
  const out = new Uint8Array(limpo.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(limpo.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function paraHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * scrypt(senha, sal) — o mesmo verificador que o PC calculou ao definir a senha.
 *
 * `normalize('NFKC')` não é enfeite: acentos podem ser digitados como um único
 * caractere ou como letra + acento separado, e o Android e o Windows nem sempre
 * escolhem a mesma forma. Sem normalizar, a mesma senha digitada nos dois
 * teclados produziria verificadores diferentes.
 */
export function derivarVerificador(
  senha: string,
  sal: Uint8Array,
  params: ScryptParams = SCRYPT_PARAMS,
): Uint8Array {
  return scrypt(codificador.encode(senha.normalize('NFKC')), sal, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: params.keylen,
  });
}

/** A resposta ao desafio: HMAC-SHA256(verificador, nonce), em hexadecimal. */
export function provaPara(verificador: Uint8Array, nonce: Uint8Array): string {
  return paraHex(hmac(sha256, verificador, nonce));
}

/**
 * Chave que carimba o SDP.
 *
 * Sem ela, quem repassa a oferta e a resposta poderia trocar as impressões
 * digitais DTLS por uma sua e ficar no meio da conversa. Os pontos de encontro
 * não conhecem a senha, então não conseguem produzir o carimbo — e qualquer
 * reescrita do SDP é detectada do outro lado.
 */
export function chaveDeSessao(verificador: Uint8Array, nonce: Uint8Array): Uint8Array {
  const rotulo = codificador.encode('ryke-sdp-v1');
  const junto = new Uint8Array(nonce.length + rotulo.length);
  junto.set(nonce, 0);
  junto.set(rotulo, nonce.length);
  return hmac(sha256, verificador, junto);
}

export function carimbar(chave: Uint8Array, dados: string): string {
  return paraHex(hmac(sha256, chave, codificador.encode(dados)));
}

/**
 * Confere o carimbo em tempo constante.
 *
 * Comparar com `===` vazaria, pelo tempo da comparação, quantos bytes do
 * início batem — o bastante para alguém descobrir o carimbo correto byte a
 * byte, sem nunca saber a senha.
 */
export function carimboConfere(chave: Uint8Array, dados: string, recebido: string): boolean {
  const esperado = carimbar(chave, dados);
  if (typeof recebido !== 'string' || recebido.length !== esperado.length) return false;
  let diferenca = 0;
  for (let i = 0; i < esperado.length; i++) diferenca |= esperado.charCodeAt(i) ^ recebido.charCodeAt(i);
  return diferenca === 0;
}
