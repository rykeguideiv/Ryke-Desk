/**
 * Exercita o desafio/resposta de senha direto no módulo real
 * (Node 24 executa TypeScript apagando os tipos).
 *
 *   node test/auth.test.mjs
 */
import { deriveVerifier, proofFor, newSalt, ChallengeBook, Throttle, SCRYPT_PARAMS } from '../src/main/auth.ts';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const SENHA = 'Uva-Roxa-2026!';
const salt = newSalt();
const verifier = deriveVerifier(SENHA, salt);

check('verificador tem 32 bytes', verifier.length === 32);
check('mesma senha + mesmo salt = mesmo verificador', deriveVerifier(SENHA, salt).equals(verifier));
check('salt diferente muda o verificador', !deriveVerifier(SENHA, newSalt()).equals(verifier));

const t0 = Date.now();
deriveVerifier(SENHA, salt);
const custo = Date.now() - t0;
check('scrypt custa tempo suficiente para travar força bruta', custo >= 15, `${custo} ms por tentativa`);

// ── fluxo feliz: o visitante conhece a senha ──
const book = new ChallengeBook();
const VISITANTE = '123456789';

const desafio = book.issue(VISITANTE, salt);
check('desafio traz salt, nonce e parâmetros',
  desafio.salt === salt.toString('hex') && desafio.nonce.length === 64 && desafio.scrypt.N === SCRYPT_PARAMS.N);

const chaveDoVisitante = deriveVerifier(SENHA, Buffer.from(desafio.salt, 'hex'), desafio.scrypt);
const prova = proofFor(chaveDoVisitante, Buffer.from(desafio.nonce, 'hex'));
check('senha correta é aceita', book.redeem(VISITANTE, desafio.nonce, prova, verifier) === 'ok');

// ── o mesmo nonce não pode ser reaproveitado ──
check('nonce já usado é rejeitado (anti-replay)',
  book.redeem(VISITANTE, desafio.nonce, prova, verifier) === 'nonce-invalido');

// ── senha errada ──
const d2 = book.issue(VISITANTE, salt);
const provaErrada = proofFor(deriveVerifier('senha-errada', Buffer.from(d2.salt, 'hex')), Buffer.from(d2.nonce, 'hex'));
check('senha errada é recusada', book.redeem(VISITANTE, d2.nonce, provaErrada, verifier) === 'senha-incorreta');

// ── outro peer não pode usar o desafio alheio ──
const d3 = book.issue(VISITANTE, salt);
const provaValida = proofFor(chaveDoVisitante, Buffer.from(d3.nonce, 'hex'));
check('desafio emitido para outro número é recusado',
  book.redeem('987654321', d3.nonce, provaValida, verifier) === 'nonce-invalido');

// ── prova malformada não derruba o anfitrião ──
const d4 = book.issue(VISITANTE, salt);
check('prova com lixo é recusada sem lançar erro',
  book.redeem(VISITANTE, d4.nonce, 'nao-e-hex!!', verifier) === 'senha-incorreta');

// ── freio contra adivinhação ──
const freio = new Throttle();
check('sem tentativas erradas, nada de espera', freio.lockedFor(VISITANTE) === 0);
check('1ª falha ainda não bloqueia', freio.fail(VISITANTE) === 0);
check('2ª falha ainda não bloqueia', freio.fail(VISITANTE) === 0);
check('3ª falha ainda não bloqueia', freio.fail(VISITANTE) === 0);
check('4ª falha impõe espera', freio.fail(VISITANTE) === 5);
check('espera fica ativa', freio.lockedFor(VISITANTE) > 0);
check('5ª falha aumenta a espera', freio.fail(VISITANTE) === 15);
freio.succeed(VISITANTE);
check('acerto zera o histórico', freio.lockedFor(VISITANTE) === 0);

// ── trocar de número não pode servir de escapatória ──
//
// O número do visitante é escolhido por ele: basta reconectar sem token para
// o servidor emitir um novo. Se o freio fosse só por número, cada tentativa
// viria de um número virgem e o bloqueio nunca chegaria.
const freio2 = new Throttle();
for (let i = 0; i < 6; i++) freio2.fail(`90000000${i}`);
check(
  'seis erros de números DIFERENTES bloqueiam mesmo assim',
  freio2.lockedFor('999999999') > 0,
  `${freio2.lockedFor('999999999')}s de espera para um número nunca visto`,
);
const esperaSeguinte = freio2.fail('123123123');
check('a espera global cresce a cada nova tentativa', esperaSeguinte >= 30, `${esperaSeguinte}s`);
freio2.succeed('123123123');
check('acerto também absolve o histórico global', freio2.lockedFor('555555555') === 0);

console.log(failures === 0 ? '\nAutenticação validada.\n' : `\n${failures} falha(s).\n`);
process.exit(failures === 0 ? 0 : 1);
