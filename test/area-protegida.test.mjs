/**
 * A área protegida do Windows (o UAC) — e o congelamento que ela causava.
 *
 * O DEFEITO: numa sessão sem modo administrador, clicar em algo que pede
 * elevação (um instalador, por exemplo) CONGELAVA A SESSÃO PARA SEMPRE. Só
 * entrar no modo administrador destravava.
 *
 * A causa eram duas coisas que se somavam e se escondiam uma na outra:
 *   • o Windows troca para a área protegida e a captura para de entregar
 *     quadros — mas a trilha continua "viva", então o evento `ended`, que é
 *     quem manda recapturar, NUNCA dispara;
 *   • a vigilância da sessão via os dois lados parados e concluía, corretamente
 *     pelas regras dela, que era apenas uma "tela quieta" (ver vigilancia.ts).
 *
 * Ou seja: ninguém reerguia a captura, nem depois que o UAC saía da frente. A
 * saída é perguntar ao Windows de quem é a área de entrada — o único sinal que
 * distingue "parado porque ninguém mexeu" de "parado porque o Windows saiu de
 * baixo de nós".
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const AQUI = resolve(import.meta.dirname, '..');
const ler = (...p) => readFileSync(join(AQUI, ...p), 'utf8');
const entrada = ler('src', 'main', 'input.ts');
const principal = ler('src', 'main', 'index.ts');
const sessao = ler('src', 'renderer', 'src', 'lib', 'session.ts');
const preload = ler('src', 'preload', 'index.ts');

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

// ── perguntar ao Windows, em vez de adivinhar pelos quadros ──
check('existe como saber se a área protegida está na frente', /export function desktopSeguroAtivo/.test(entrada));
check('e a pergunta é OpenInputDesktop, que falha justamente nesse caso', /OpenInputDesktop/.test(entrada));
check('a alça é devolvida, para não vazar a cada meio segundo', /CloseDesktop\(h\)/.test(entrada));
// Um falso "está bloqueado" dispararia recapturas à toa; na dúvida, normal.
check('em caso de erro assume área NORMAL', /catch \{[\s\S]{0,200}return false;/.test(entrada));

// ── o vigia, que só roda enquanto há alguém conectado ──
check('o anfitrião vigia a área protegida', /comecarAVigiarAreaProtegida/.test(principal));
check('e para de vigiar quando ninguém está conectado', /pararDeVigiarAreaProtegida/.test(principal));
check('a mudança é avisada à interface', /send\('captura:areaProtegida', agora\)/.test(principal));
check('e fica gravada no diagnóstico', /\[uac\]/.test(principal));
check('o preload repassa o aviso', /onAreaProtegida/.test(preload));

// ── o conserto de fato: reerguer a captura quando o UAC sai ──
check('a sessão observa a área protegida', /observarAreaProtegida/.test(sessao));
const obs = sessao.slice(sessao.indexOf('function observarAreaProtegida'));
check(
  'ao SAIR da área protegida, a captura é reerguida',
  /if \(ativa \|\| consumidoresTela\.size === 0\) return;[\s\S]{0,120}recapturarTelaCompartilhada\(\)/.test(obs),
);
check(
  'entrar na área protegida NÃO dispara recaptura (não adianta, e só gastaria)',
  /if \(ativa \|\|/.test(obs),
);

console.log(falhas === 0 ? '\nArea protegida validada.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
