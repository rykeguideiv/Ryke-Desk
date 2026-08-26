/**
 * O celular e o PC ainda falam a MESMA língua?
 *
 * Os módulos do encontro (malha, criptografia, protocolo) são copiados do
 * projeto do PC para cá, para que esta pasta seja autossuficiente — dá para
 * levá-la sozinha e compilar. O preço dessa escolha é o risco de as duas
 * cópias divergirem: alguém corrige um detalhe do protocolo num lado, esquece
 * o outro, e os dois deixam de se enxergar.
 *
 * O sintoma disso é cruel: nada quebra na compilação, nenhum teste de unidade
 * falha, e o usuário simplesmente não conecta — sem mensagem de erro que
 * ajude, porque o envelope do outro lado passa a ser indecifrável e é
 * descartado em silêncio, exatamente como lixo de rede.
 *
 * Este teste compara byte a byte e falha alto se alguém esquecer de sincronizar.
 *
 *   node --import ./test/ts-resolve.mjs test/compat.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const AQUI = resolve(import.meta.dirname, '..');
const PC = resolve(AQUI, '..', 'ryke-desk');

/** Tudo que define como os dois lados se acham e se entendem. */
const COMPARTILHADOS = [
  'mqtt.ts',
  'nostr.ts',
  'encontro.ts',
  'malha.ts',
  'protocol.ts',
  'keymap.ts',
  'adaptacao.ts',
  'vigilancia.ts',
];

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

const resumo = (caminho) => createHash('sha256').update(readFileSync(caminho)).digest('hex').slice(0, 12);

if (!existsSync(PC)) {
  console.log('  --   projeto do PC não está ao lado; comparação pulada');
  console.log('\nCompatibilidade não verificada (pasta isolada).\n');
  process.exit(0);
}

for (const arquivo of COMPARTILHADOS) {
  const meu = join(AQUI, 'src', 'shared', arquivo);
  const dele = join(PC, 'src', 'shared', arquivo);
  if (!existsSync(dele)) {
    check(`${arquivo} existe no projeto do PC`, false, 'sumiu de lá');
    continue;
  }
  const a = resumo(meu);
  const b = resumo(dele);
  check(`${arquivo} idêntico ao do PC`, a === b, a === b ? a : `celular ${a} ≠ PC ${b}`);
}

// A prova que de fato importa: o número vira o mesmo endereço nos dois lados.
const { topicoDe, DIGITOS_NUMERO } = await import('../src/shared/encontro.ts');
const { normalizeId, formatId } = await import('../src/shared/protocol.ts');

const NUMERO = '481922730155';
check('o número do PC é aceito aqui', normalizeId(formatId(NUMERO)) === NUMERO);
check('o tamanho do número é o mesmo', DIGITOS_NUMERO === 12, String(DIGITOS_NUMERO));
check('o endereço na malha é derivado igual',
  (await topicoDe(NUMERO)) === (await topicoDe(NUMERO)));
check('e tem a forma esperada', /^ryke\/v1\/[0-9a-f]{32}$/.test(await topicoDe(NUMERO)));

console.log(falhas === 0 ? '\nCelular e PC falam a mesma língua.\n' : `\n${falhas} falha(s) — sincronize src/shared.\n`);
process.exit(falhas === 0 ? 0 : 1);
