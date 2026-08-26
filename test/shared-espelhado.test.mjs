/**
 * O `src/shared/` do celular é uma CÓPIA do computador. Ela ainda bate?
 *
 * Os dois projetos compartilham o protocolo, a malha, a criptografia do
 * encontro e o mapa de teclas. Enquanto o celular morava fora do repositório,
 * manter as duas cópias iguais era trabalho manual — e trabalho manual num
 * arquivo que os dois lados precisam interpretar do MESMO jeito é uma bomba de
 * efeito retardado: a divergência não quebra a compilação de ninguém, não
 * aparece em nenhum teste, e só se manifesta como "o celular não conecta mais"
 * meses depois, com o commit culpado enterrado no histórico.
 *
 * Aconteceu de verdade nesta versão: o `protocol.ts` do computador ganhou as
 * mensagens das setas coloridas e a cópia do celular ficou para trás.
 *
 * Este teste é o alarme. Ele não conserta a duplicação — conserta o SILÊNCIO
 * dela. Quando falhar, a correção é uma linha:
 *
 *   cp src/shared/<arquivo>.ts ryke-mobile/src/shared/<arquivo>.ts
 *
 * A solução definitiva é o celular importar direto de `../../src/shared`, e
 * agora que os dois estão no mesmo repositório isso passou a ser possível.
 * Enquanto não for feito, este teste segura a peça.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const AQUI = resolve(import.meta.dirname, '..');
const PC = join(AQUI, 'src', 'shared');
const CELULAR = join(AQUI, 'ryke-mobile', 'src', 'shared');

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

if (!existsSync(CELULAR)) {
  console.log('  --   o projeto do celular não está neste repositório; nada a comparar');
  process.exit(0);
}

const doCelular = readdirSync(CELULAR).filter((f) => f.endsWith('.ts'));
check('o celular tem arquivos compartilhados para conferir', doCelular.length > 0, `${doCelular.length} arquivos`);

for (const arquivo of doCelular) {
  const noPc = join(PC, arquivo);
  if (!existsSync(noPc)) {
    // Não é erro: o celular pode ter um módulo só dele dentro de shared/.
    console.log(`  --   ${arquivo} só existe no celular`);
    continue;
  }
  const igual = readFileSync(noPc, 'utf8') === readFileSync(join(CELULAR, arquivo), 'utf8');
  check(
    `${arquivo} é idêntico nos dois projetos`,
    igual,
    igual ? '' : `rode: cp src/shared/${arquivo} ryke-mobile/src/shared/${arquivo}`,
  );
}

console.log(
  falhas === 0 ? '\nO compartilhado do celular está em dia.\n' : `\n${falhas} falha(s) — as cópias divergiram.\n`,
);
process.exit(falhas === 0 ? 0 : 1);
