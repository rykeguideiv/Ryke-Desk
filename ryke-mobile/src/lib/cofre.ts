/**
 * Onde o celular guarda número, chave e favoritos.
 *
 * No PC isso vive num arquivo em %APPDATA%, cifrado pela DPAPI do Windows.
 * No Android não existe equivalente direto, então usamos o `Preferences` do
 * Capacitor — que grava no armazenamento privado do aplicativo, uma área que
 * o próprio sistema isola: nenhum outro aplicativo instalado consegue ler, e
 * o conteúdo some junto com a desinstalação.
 *
 * Vale dizer o que isso NÃO protege: um aparelho com root, ou uma cópia de
 * segurança do Android habilitada, podem expor esses bytes.
 *
 * SOBRE GUARDAR A SENHA DO COMPUTADOR
 *
 * Guardar senha é sempre uma troca: comodidade de um lado, superfície de
 * ataque do outro. Ela só é gravada quando a pessoa marca a caixinha, só
 * depois de o computador ter aceitado, e vai cifrada com AES-GCM — nunca em
 * texto puro, para que um despejo do armazenamento ou uma cópia de segurança
 * não entreguem a senha de bandeja.
 *
 * E é preciso ser honesto sobre o alcance disso: a chave que cifra é derivada
 * da identidade desta instalação, que mora no mesmo aparelho. Quem tiver
 * acesso ao armazenamento privado do aplicativo com privilégio de root tem os
 * dois lados, e a cifragem não o detém. O que ela detém é leitura casual, e é
 * exatamente isso que a tela promete — nada além.
 */
import { Preferences } from '@capacitor/preferences';
import type { Cofre } from '../shared/malha';

const CHAVE_NUMERO = 'ryke.numero';
const CHAVE_PRIVADA = 'ryke.chave';
const CHAVE_PINOS = 'ryke.pinos';
const CHAVE_FAVORITOS = 'ryke.favoritos';
const CHAVE_RECENTES = 'ryke.recentes';
const CHAVE_SENHAS = 'ryke.senhas';
const CHAVE_SEGREDO = 'ryke.segredo';

async function ler(chave: string): Promise<string | null> {
  const { value } = await Preferences.get({ key: chave });
  return value ?? null;
}

export const cofreDoAndroid: Cofre = {
  async ler() {
    const [numero, chavePrivada] = await Promise.all([ler(CHAVE_NUMERO), ler(CHAVE_PRIVADA)]);
    return { numero, chavePrivada };
  },
  async gravar(numero, chavePrivada) {
    await Preferences.set({ key: CHAVE_NUMERO, value: numero });
    await Preferences.set({ key: CHAVE_PRIVADA, value: chavePrivada });
  },
  async lerPinos() {
    const bruto = await ler(CHAVE_PINOS);
    if (!bruto) return {};
    try {
      const lido: unknown = JSON.parse(bruto);
      return lido && typeof lido === 'object' ? (lido as Record<string, string>) : {};
    } catch {
      return {};
    }
  },
  async gravarPino(numero, impressao) {
    const atuais = await cofreDoAndroid.lerPinos();
    await Preferences.set({ key: CHAVE_PINOS, value: JSON.stringify({ ...atuais, [numero]: impressao }) });
  },
};

/** Esquece a impressão de um número (o outro lado reinstalou o programa). */
export async function esquecerPino(numero: string): Promise<void> {
  const atuais = await cofreDoAndroid.lerPinos();
  delete atuais[numero];
  await Preferences.set({ key: CHAVE_PINOS, value: JSON.stringify(atuais) });
}

// ───────────────────────────── favoritos ─────────────────────────────

/** Um computador guardado com nome próprio. Sem senha, de propósito. */
export type Favorito = { numero: string; nome: string; usadoEm: number };

export async function lerFavoritos(): Promise<Favorito[]> {
  const bruto = await ler(CHAVE_FAVORITOS);
  if (!bruto) return [];
  try {
    const lista: unknown = JSON.parse(bruto);
    if (!Array.isArray(lista)) return [];
    return (lista as Favorito[])
      .filter((f) => f && typeof f.numero === 'string' && typeof f.nome === 'string')
      .sort((a, b) => (b.usadoEm ?? 0) - (a.usadoEm ?? 0));
  } catch {
    return [];
  }
}

async function gravarFavoritos(lista: Favorito[]): Promise<Favorito[]> {
  await Preferences.set({ key: CHAVE_FAVORITOS, value: JSON.stringify(lista) });
  return lerFavoritos();
}

/** Cria ou renomeia. O número é a identidade; o nome é só rótulo. */
export async function salvarFavorito(numero: string, nome: string): Promise<Favorito[]> {
  const limpo = nome.trim().slice(0, 40);
  if (!limpo) return lerFavoritos();
  const atuais = await lerFavoritos();
  const anterior = atuais.find((f) => f.numero === numero);
  const outros = atuais.filter((f) => f.numero !== numero);
  return gravarFavoritos([...outros, { numero, nome: limpo, usadoEm: anterior?.usadoEm ?? Date.now() }]);
}

export async function removerFavorito(numero: string): Promise<Favorito[]> {
  const atuais = await lerFavoritos();
  return gravarFavoritos(atuais.filter((f) => f.numero !== numero));
}

/** Marca uso, para o favorito subir na lista sem ninguém organizar nada. */
export async function marcarUso(numero: string): Promise<void> {
  const atuais = await lerFavoritos();
  if (!atuais.some((f) => f.numero === numero)) return;
  await gravarFavoritos(atuais.map((f) => (f.numero === numero ? { ...f, usadoEm: Date.now() } : f)));
}

// ───────────────────────────── recentes ─────────────────────────────

/**
 * Os últimos computadores acessados.
 *
 * Existe porque ninguém decora doze dígitos, e porque dar nome a uma máquina
 * antes de saber se a conexão vai funcionar é pedir trabalho à toa: acessa-se
 * primeiro, e o número fica aqui esperando virar favorito com um toque.
 */
const MAX_RECENTES = 8;

export async function lerRecentes(): Promise<string[]> {
  const bruto = await ler(CHAVE_RECENTES);
  if (!bruto) return [];
  try {
    const lista: unknown = JSON.parse(bruto);
    return Array.isArray(lista) ? (lista as unknown[]).filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

export async function marcarRecente(numero: string): Promise<string[]> {
  const atuais = await lerRecentes();
  const lista = [numero, ...atuais.filter((n) => n !== numero)].slice(0, MAX_RECENTES);
  await Preferences.set({ key: CHAVE_RECENTES, value: JSON.stringify(lista) });
  return lista;
}

export async function esquecerRecente(numero: string): Promise<string[]> {
  const lista = (await lerRecentes()).filter((n) => n !== numero);
  await Preferences.set({ key: CHAVE_RECENTES, value: JSON.stringify(lista) });
  return lista;
}

// ──────────────────────── senhas guardadas ────────────────────────

const codificador = new TextEncoder();
const decodificador = new TextDecoder();

const hex = (b: Uint8Array): string => [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
const deHex = (t: string): Uint8Array<ArrayBuffer> => {
  const saida = new Uint8Array(new ArrayBuffer(t.length / 2));
  for (let i = 0; i < saida.length; i++) saida[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
  return saida;
};

/**
 * A chave que cifra as senhas guardadas.
 *
 * Sai da identidade desta instalação — a mesma chave privada que prova quem
 * este aparelho é na malha. Assim a senha guardada só serve neste aplicativo,
 * neste aparelho: copiar o arquivo de preferências para outro telefone
 * entrega bytes que não abrem em lugar nenhum. Se por algum motivo a
 * identidade ainda não existir, geramos um segredo próprio em vez de cifrar
 * com algo previsível.
 */
async function chaveDasSenhas(): Promise<CryptoKey> {
  let base = await ler(CHAVE_PRIVADA);
  if (!base) {
    base = await ler(CHAVE_SEGREDO);
    if (!base) {
      base = hex(crypto.getRandomValues(new Uint8Array(32)));
      await Preferences.set({ key: CHAVE_SEGREDO, value: base });
    }
  }
  const material = await crypto.subtle.importKey('raw', codificador.encode(base), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: codificador.encode('ryke-senhas-guardadas-v1'),
      iterations: 120_000,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

type SenhasGuardadas = Record<string, { iv: string; dados: string }>;

async function lerCaixa(): Promise<SenhasGuardadas> {
  const bruto = await ler(CHAVE_SENHAS);
  if (!bruto) return {};
  try {
    const lido: unknown = JSON.parse(bruto);
    return lido && typeof lido === 'object' ? (lido as SenhasGuardadas) : {};
  } catch {
    return {};
  }
}

/** Quais números têm senha guardada. Só os números — nunca as senhas. */
export async function numerosComSenha(): Promise<string[]> {
  return Object.keys(await lerCaixa());
}

export async function salvarSenha(numero: string, senha: string): Promise<void> {
  if (!senha) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await chaveDasSenhas(),
    codificador.encode(senha),
  );
  const caixa = await lerCaixa();
  caixa[numero] = { iv: hex(iv), dados: hex(new Uint8Array(cifrado)) };
  await Preferences.set({ key: CHAVE_SENHAS, value: JSON.stringify(caixa) });
}

export async function senhaGuardada(numero: string): Promise<string | null> {
  const guardada = (await lerCaixa())[numero];
  if (!guardada) return null;
  try {
    const aberto = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: deHex(guardada.iv) },
      await chaveDasSenhas(),
      deHex(guardada.dados),
    );
    return decodificador.decode(aberto);
  } catch {
    // Selo que não confere: bytes mexidos, ou identidade trocada. Some com o
    // registro em vez de insistir — senha que não abre só atrapalha.
    await esquecerSenha(numero);
    return null;
  }
}

export async function esquecerSenha(numero: string): Promise<void> {
  const caixa = await lerCaixa();
  if (!(numero in caixa)) return;
  delete caixa[numero];
  await Preferences.set({ key: CHAVE_SENHAS, value: JSON.stringify(caixa) });
}
