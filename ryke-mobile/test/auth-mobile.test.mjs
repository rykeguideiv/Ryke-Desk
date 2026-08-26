/**
 * O celular calcula a MESMA prova que o PC?
 *
 * Este é o teste que decide se o aplicativo Android consegue entrar num
 * computador com senha. O PC guarda scrypt(senha, sal) e confere um
 * HMAC sobre o nonce; o celular precisa chegar exatamente aos mesmos bytes,
 * usando uma biblioteca completamente diferente — o `crypto` do Node de um
 * lado, JavaScript puro do outro.
 *
 * Um erro aqui não aparece como falha de criptografia: aparece como "senha
 * incorreta" para o usuário, com a senha certa digitada.
 *
 *   node --import ./test/ts-resolve.mjs test/auth-mobile.test.mjs
 */
import { scryptSync, createHmac, randomBytes } from 'node:crypto';
import {
  derivarVerificador,
  provaPara,
  chaveDeSessao,
  carimbar,
  carimboConfere,
  paraHex,
  deHex,
  SCRYPT_PARAMS,
} from '../src/lib/auth.ts';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

// ── o que o PC faz (cópia fiel de ryke-desk/src/main/auth.ts) ──
const pcVerificador = (senha, sal) =>
  scryptSync(senha.normalize('NFKC'), sal, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: 256 * 1024 * 1024,
  });
const pcProva = (v, nonce) => createHmac('sha256', v).update(nonce).digest('hex');
const pcChaveSessao = (v, nonce) =>
  createHmac('sha256', v).update(nonce).update('ryke-sdp-v1').digest();
const pcCarimbo = (chave, dados) => createHmac('sha256', chave).update(dados, 'utf8').digest('hex');

// ─────────────── senhas comuns e casos de borda ───────────────

const senhas = [
  'melancia-42-azul',
  'senha simples',
  'ÇÃOáéíóú',              // acentuação: o ponto onde as normalizações divergem
  'Ryke#2026!@$%',
  '☕ emoji e espaço  ',
  'a'.repeat(200),
];

for (const senha of senhas) {
  const sal = randomBytes(16);
  const nonce = randomBytes(16);

  const doPc = pcVerificador(senha, sal);
  const doCelular = derivarVerificador(senha, new Uint8Array(sal));

  const rotulo = senha.length > 24 ? `${senha.slice(0, 21)}…` : senha;
  check(`verificador idêntico: "${rotulo}"`,
    Buffer.from(doCelular).equals(doPc),
    `${paraHex(doCelular).slice(0, 16)}… vs ${doPc.toString('hex').slice(0, 16)}…`);

  check(`prova aceita pelo PC: "${rotulo}"`,
    provaPara(doCelular, new Uint8Array(nonce)) === pcProva(doPc, nonce));

  check(`chave de sessão igual: "${rotulo}"`,
    Buffer.from(chaveDeSessao(doCelular, new Uint8Array(nonce))).equals(pcChaveSessao(doPc, nonce)));
}

// ─────────── acentuação escrita de duas formas ───────────
//
// "ç" pode ser um caractere só (U+00E7) ou "c" + cedilha (U+0063 U+0327).
// O teclado do Android e o do Windows nem sempre escolhem a mesma forma; sem
// normalizar, a mesma senha digitada nos dois produziria verificadores
// diferentes e o usuário veria "senha incorreta" sem entender por quê.

const sal = randomBytes(16);
const comporta = derivarVerificador('a\u00e7\u00e3o', new Uint8Array(sal));
const decomposta = derivarVerificador('ac\u0327a\u0303o', new Uint8Array(sal));
check('acento composto e decomposto dão o mesmo verificador',
  Buffer.from(comporta).equals(Buffer.from(decomposta)));

// ─────────────── carimbo do SDP ───────────────

const chave = chaveDeSessao(derivarVerificador('melancia-42-azul', new Uint8Array(sal)), new Uint8Array(randomBytes(16)));
const sdp = 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AB:CD';
check('carimbo bate com o do PC', carimbar(chave, sdp) === pcCarimbo(Buffer.from(chave), sdp));
check('carimbo correto é aceito', carimboConfere(chave, sdp, carimbar(chave, sdp)));
check('carimbo de outro SDP é recusado', !carimboConfere(chave, sdp, carimbar(chave, `${sdp}x`)));
check('carimbo truncado é recusado', !carimboConfere(chave, sdp, carimbar(chave, sdp).slice(0, 40)));
check('lixo no lugar do carimbo é recusado', !carimboConfere(chave, sdp, 'nao-e-um-carimbo'));

// ─────────────── hexadecimal ida e volta ───────────────

const bytes = new Uint8Array(randomBytes(32));
check('hex ida e volta preserva os bytes', paraHex(deHex(paraHex(bytes))) === paraHex(bytes));
check('hex do PC é lido igual', paraHex(deHex(Buffer.from(bytes).toString('hex'))) === paraHex(bytes));

// ─────────────── senha errada não passa ───────────────

const salFixo = randomBytes(16);
const nonceFixo = randomBytes(16);
const certo = pcVerificador('senha-certa', salFixo);
const errado = derivarVerificador('senha-errada', new Uint8Array(salFixo));
check('senha errada produz prova diferente',
  provaPara(errado, new Uint8Array(nonceFixo)) !== pcProva(certo, nonceFixo));

console.log(falhas === 0 ? '\nAutenticação do celular compatível com o PC.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
