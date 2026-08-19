/**
 * O corretor próprio, quando existe, tem endereço válido?
 *
 * Este campo deixou de ser obrigatório quando o encontro passou a acontecer
 * na malha pública: hoje o valor normal é vazio, e o programa funciona assim.
 * O que ainda precisa valer é a distinção entre vazio (intencional, "use só a
 * malha") e endereço pela metade (engano de quem compilou) — porque um
 * endereço quebrado entraria na roda de corretores e ficaria tentando
 * reconectar para sempre, sem nunca dizer por quê.
 *
 *   node --import ./test/ts-resolve.mjs test/servidor-padrao.test.mjs
 */
import { servidorConfigurado } from '../src/shared/servidor-padrao.ts';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

// ── endereços válidos ──
check('wss:// com domínio', servidorConfigurado('wss://ryke.meudominio.com.br') === true);
check('wss:// com porta', servidorConfigurado('wss://ryke.meudominio.com.br:443') === true);
check('ws:// com domínio', servidorConfigurado('ws://ryke.meudominio.com.br:8787') === true);
check('ws:// com IP', servidorConfigurado('ws://200.10.20.30:8787') === true);
check('espaços em volta não atrapalham', servidorConfigurado('  wss://ryke.exemplo.com  ') === true);

// ── ausências e enganos de compilação ──
check('vazio significa "só a malha pública"', servidorConfigurado('') === false);
check('só espaços também', servidorConfigurado('   ') === false);
check('esquema sem endereço não vale', servidorConfigurado('wss://') === false);
check('http não é WebSocket', servidorConfigurado('https://ryke.exemplo.com') === false);
check('endereço solto, sem esquema, não vale', servidorConfigurado('ryke.exemplo.com') === false);

console.log(falhas === 0 ? '\nCorretor próprio (opcional) validado.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
