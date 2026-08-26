/**
 * Criptografia do ponto de encontro.
 *
 * A malha usa corretores públicos de mensagens que qualquer pessoa pode
 * escutar — inclusive com curinga, assinando tudo de uma vez. Então a
 * suposição de projeto é dura e simples: **o transporte é hostil**. Ele
 * entrega bytes e não merece confiança para mais nada.
 *
 * Três defesas, cada uma contra um ataque diferente:
 *
 *   1. TÓPICO DERIVADO — o número do computador nunca aparece em texto claro
 *      no endereço da mensagem. Quem assina `ryke/#` colhe tópicos opacos, não
 *      uma lista de números para atacar.
 *
 *   2. ENVELOPE CIFRADO — a carga é AES-GCM com chave derivada do próprio
 *      número. Sem conhecer o número não se lê nada. E a derivação é
 *      deliberadamente cara (PBKDF2, 210 mil voltas): os números têm só nove
 *      dígitos, e uma derivação barata deixaria um bisbilhoteiro varrer o
 *      espaço inteiro contra um envelope capturado. Cara, essa varredura passa
 *      de séculos de processamento.
 *
 *   3. ASSINATURA DE IDENTIDADE — cada lado tem um par de chaves ECDSA P-256
 *      gerado na primeira execução e assina o que envia. Isto responde ao
 *      ataque que só existe num meio aberto: alguém que descobriu o número
 *      poderia se passar pelo anfitrião e receber a conexão no lugar dele. A
 *      impressão digital é fixada no primeiro encontro e conferida depois —
 *      o mesmo modelo do SSH. Se mudar, o programa para e avisa.
 *
 * Nada aqui substitui a autenticação por senha; é a camada de baixo. A senha
 * continua sendo o que decide se a sessão acontece.
 */

const codificador = new TextEncoder();
const decodificador = new TextDecoder();

/** Rótulos fixos que separam os usos da mesma senha/número. */
const SAL_TOPICO = 'ryke-desk|topico|v2';
const SAL_CHAVE = 'ryke-desk|encontro|v2';
const VOLTAS_PBKDF2 = 210_000;

/**
 * Quantos dígitos tem o número de um computador.
 *
 * Eram nove, como no AnyDesk — mas lá existe um servidor que distribui os
 * números e garante que não se repitam. Aqui não há servidor: cada máquina
 * sorteia o seu, e a única defesa contra dois computadores ficarem com o
 * mesmo número é o tamanho do espaço.
 *
 * Nove dígitos dão 900 milhões, o que parece muito e não é: pelo paradoxo do
 * aniversário, com 10 mil instalações a chance de haver uma colisão já passa
 * de 5%, e com 50 mil chega a 75%. Doze dígitos levam o espaço a 900 bilhões
 * — com 200 mil instalações a chance fica em 2%.
 *
 * O custo é digitar três números a mais, uma vez.
 */
export const DIGITOS_NUMERO = 12;

/** Mensagens mais velhas que isto são descartadas sem olhar. */
export const VALIDADE_ENVELOPE_MS = 120_000;

function sub(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto indisponível neste ambiente');
  return c.subtle;
}

function paraBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deBase64Url(texto: string): Uint8Array<ArrayBuffer> {
  const bin = atob(texto.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─────────────────────────── Tópico e chave ───────────────────────────

/**
 * Endereço do número na malha.
 *
 * A derivação é CARA de propósito — e a razão é sutil, mas decisiva.
 *
 * Os corretores são públicos: qualquer um assina `ryke/#` e vê os tópicos de
 * todo mundo passando. Se o tópico fosse um SHA-256 simples do número (como
 * era), montar a tabela inversa tópico→número custaria menos de um segundo
 * numa placa de vídeo comum. Com o número em mãos, uma única derivação abre
 * a chave e o bisbilhoteiro lê todo o combinado daquele computador.
 *
 * Ou seja: a derivação cara da CHAVE não servia de nada, porque o TÓPICO
 * entregava o número de graça. É o elo mais fraco que define a força da
 * corrente.
 *
 * Com PBKDF2 aqui também, varrer o espaço de doze dígitos passa de anos de
 * processamento — e o tópico volta a ser o que deveria ser: opaco.
 */
export async function topicoDe(numero: string): Promise<string> {
  const bruto = await sub().deriveBits(
    {
      name: 'PBKDF2',
      salt: codificador.encode(SAL_TOPICO),
      iterations: VOLTAS_PBKDF2,
      hash: 'SHA-256',
    },
    await sub().importKey('raw', codificador.encode(numero), 'PBKDF2', false, ['deriveBits']),
    128,
  );
  return `ryke/v1/${hex(new Uint8Array(bruto))}`;
}

/** Chave simétrica do envelope, derivada do número. Cara de propósito. */
export async function chaveDe(numero: string): Promise<CryptoKey> {
  const base = await sub().importKey('raw', codificador.encode(numero), 'PBKDF2', false, ['deriveKey']);
  return sub().deriveKey(
    {
      name: 'PBKDF2',
      salt: codificador.encode(SAL_CHAVE),
      iterations: VOLTAS_PBKDF2,
      hash: 'SHA-256',
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ───────────────────────────── Identidade ─────────────────────────────

export type Identidade = {
  privada: CryptoKey;
  publica: CryptoKey;
  /** Chave pública em base64url, formato bruto — é o que viaja no envelope. */
  publicaBruta: string;
  /** Resumo legível para o usuário comparar por telefone, se quiser. */
  impressao: string;
};

/**
 * Impressão digital em blocos de quatro, no alfabeto de Crockford (sem I, L,
 * O e U, que se confundem com 1, 0 e V quando alguém lê em voz alta).
 */
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export async function impressaoDe(publicaBruta: string): Promise<string> {
  const digest = new Uint8Array(await sub().digest('SHA-256', deBase64Url(publicaBruta)));
  let bits = 0;
  let acumulado = 0;
  let saida = '';
  for (let i = 0; saida.replace(/-/g, '').length < 12; i++) {
    acumulado = (acumulado << 8) | digest[i];
    bits += 8;
    while (bits >= 5 && saida.replace(/-/g, '').length < 12) {
      bits -= 5;
      saida += ALFABETO[(acumulado >> bits) & 31];
      if (saida.replace(/-/g, '').length % 4 === 0 && saida.replace(/-/g, '').length < 12) saida += '-';
    }
  }
  return saida;
}

export async function criarIdentidade(): Promise<Identidade> {
  const par = await sub().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return montarIdentidade(par.privateKey, par.publicKey);
}

async function montarIdentidade(privada: CryptoKey, publica: CryptoKey): Promise<Identidade> {
  const bruta = paraBase64Url(new Uint8Array(await sub().exportKey('raw', publica)));
  return { privada, publica, publicaBruta: bruta, impressao: await impressaoDe(bruta) };
}

/** Guardamos a chave privada como JWK; o texto é cifrado em repouso pelo main. */
export async function exportarIdentidade(id: Identidade): Promise<string> {
  return JSON.stringify(await sub().exportKey('jwk', id.privada));
}

export async function importarIdentidade(texto: string): Promise<Identidade> {
  const jwk = JSON.parse(texto) as JsonWebKey;
  const privada = await sub().importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  // A pública sai dos mesmos parâmetros da curva; só é preciso tirar a parte
  // secreta e liberar o uso de verificação.
  const { d: _d, key_ops: _ops, ...publicoJwk } = jwk as JsonWebKey & { d?: string };
  const publica = await sub().importKey(
    'jwk',
    { ...publicoJwk, key_ops: ['verify'] },
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  return montarIdentidade(privada, publica);
}

// ────────────────────────────── Envelope ──────────────────────────────

/** O que vai dentro do envelope, antes de assinar e cifrar. */
export type Interior<T> = {
  v: 1;
  /** Identificador único da mensagem — é o que permite descartar as repetidas. */
  msg: string;
  de: string;
  para: string;
  /** Momento do envio, em ms. Corta repetição tardia. */
  ts: number;
  pk: string;
  dados: T;
};

export type Aberto<T> = { interior: Interior<T>; impressao: string };

function aleatorio(bytes: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function novoIdMensagem(): string {
  return paraBase64Url(aleatorio(12));
}

/**
 * Assina, embrulha e cifra.
 *
 * A assinatura cobre exatamente o texto que será transmitido — e não um objeto
 * reserializado do outro lado. Reserializar abriria espaço para divergência de
 * ordem de campos entre implementações; conferir sobre a string recebida não.
 */
export async function selar<T>(
  chave: CryptoKey,
  identidade: Identidade,
  interior: Omit<Interior<T>, 'v' | 'pk' | 'msg' | 'ts'> & { msg?: string; ts?: number },
): Promise<Uint8Array<ArrayBuffer>> {
  const completo: Interior<T> = {
    v: 1,
    msg: interior.msg ?? novoIdMensagem(),
    de: interior.de,
    para: interior.para,
    ts: interior.ts ?? Date.now(),
    pk: identidade.publicaBruta,
    dados: interior.dados as T,
  };
  const texto = JSON.stringify(completo);
  const assinatura = new Uint8Array(
    await sub().sign({ name: 'ECDSA', hash: 'SHA-256' }, identidade.privada, codificador.encode(texto)),
  );
  const pacote = codificador.encode(JSON.stringify({ i: texto, s: paraBase64Url(assinatura) }));

  const iv = aleatorio(12);
  const cifrado = new Uint8Array(await sub().encrypt({ name: 'AES-GCM', iv }, chave, pacote));
  const saida = new Uint8Array(iv.length + cifrado.length);
  saida.set(iv, 0);
  saida.set(cifrado, iv.length);
  return saida;
}

/**
 * Decifra, confere a assinatura e a validade.
 *
 * Devolve `null` para tudo que não presta — lixo de outro programa no mesmo
 * corretor, envelope de outro número, assinatura que não bate, mensagem
 * velha. Quem chama não precisa distinguir: nada disso deve virar sessão.
 */
export async function abrir<T>(chave: CryptoKey, bruto: Uint8Array<ArrayBuffer>, agora = Date.now()): Promise<Aberto<T> | null> {
  if (bruto.length <= 12) return null;
  let pacote: { i?: unknown; s?: unknown };
  try {
    const claro = await sub().decrypt(
      { name: 'AES-GCM', iv: bruto.subarray(0, 12) },
      chave,
      bruto.subarray(12),
    );
    pacote = JSON.parse(decodificador.decode(claro));
  } catch {
    return null; // não é para nós, ou foi adulterado
  }
  if (typeof pacote.i !== 'string' || typeof pacote.s !== 'string') return null;

  let interior: Interior<T>;
  try {
    interior = JSON.parse(pacote.i);
  } catch {
    return null;
  }
  if (interior?.v !== 1 || typeof interior.pk !== 'string' || typeof interior.msg !== 'string') return null;
  if (typeof interior.ts !== 'number' || Math.abs(agora - interior.ts) > VALIDADE_ENVELOPE_MS) return null;

  let publica: CryptoKey;
  try {
    publica = await sub().importKey(
      'raw',
      deBase64Url(interior.pk),
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
  } catch {
    return null;
  }

  const confere = await sub().verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publica,
    deBase64Url(pacote.s),
    codificador.encode(pacote.i),
  );
  if (!confere) return null;

  return { interior, impressao: await impressaoDe(interior.pk) };
}

// ──────────────────────── Números autoemitidos ────────────────────────

/**
 * Doze dígitos, sorteados com gerador criptográfico e sem zero à esquerda.
 *
 * Sem servidor não há quem distribua números, então cada computador tira o
 * seu — e o espaço precisa ser grande o bastante para que dois sorteios
 * iguais sejam desprezíveis (ver DIGITOS_NUMERO).
 *
 * A reivindicação em malha.ts ainda existe e continua necessária: ela cobre o
 * caso em que a colisão de fato atrapalha, que é dois computadores ligados ao
 * mesmo tempo com o mesmo número.
 */
export function sortearNumero(): string {
  const b = aleatorio(8);
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  return String((n % 900_000_000_000n) + 100_000_000_000n);
}
