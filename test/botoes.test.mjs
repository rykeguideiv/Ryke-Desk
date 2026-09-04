/**
 * Os botões do mouse — inclusive os dois LATERAIS (voltar e avançar).
 *
 * Os laterais não funcionavam no acesso remoto, e o motivo era simples e
 * silencioso: o visitante DESCARTAVA qualquer botão acima do 2 (`e.button > 2`)
 * antes de enviar. Nada chegava do outro lado, então não havia o que depurar no
 * anfitrião. Como a correção atravessa seis arquivos — o visitante, o contrato
 * de rede, o preload, o IPC, o tipo compartilhado e a injeção no Windows —, o
 * teste confere a CORRENTE INTEIRA: basta um elo continuar estreito para o
 * botão sumir de novo sem erro nenhum.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mudarBotao } from '../src/shared/botoes.ts';

const AQUI = resolve(import.meta.dirname, '..');
const ler = (...p) => readFileSync(join(AQUI, ...p), 'utf8');

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

// ── o controle de apertar/soltar, que vale para todos os botões ──
const pressionados = new Set();
check('não envia soltar direito se ele nunca foi pressionado', mudarBotao(pressionados, 2, false) === false);
check('envia o primeiro pressionar direito', mudarBotao(pressionados, 2, true) === true);
check('não duplica o pressionar direito', mudarBotao(pressionados, 2, true) === false);
check('envia o soltar correspondente', mudarBotao(pressionados, 2, false) === true);
check('não repete o soltar ao encerrar a sessão', mudarBotao(pressionados, 2, false) === false);
check('o conjunto termina vazio', pressionados.size === 0);

// Os laterais seguem a mesma regra, e um não pode apagar o estado do outro:
// segurar "voltar" enquanto se aperta "avançar" acontece de verdade.
check('o lateral "voltar" (3) aperta', mudarBotao(pressionados, 3, true) === true);
check('o lateral "avançar" (4) aperta sem desfazer o outro', mudarBotao(pressionados, 4, true) === true);
check('os dois laterais coexistem', pressionados.size === 2);
check('soltar o "voltar" não solta o "avançar"', mudarBotao(pressionados, 3, false) === true && pressionados.has(4));
check('e o "avançar" solta depois', mudarBotao(pressionados, 4, false) === true && pressionados.size === 0);

// ── a corrente: nenhum elo pode continuar estreito ──
const botoes = ler('src', 'shared', 'botoes.ts');
const protocolo = ler('src', 'shared', 'protocol.ts');
const viewer = ler('src', 'renderer', 'src', 'components', 'Viewer.tsx');
const sessao = ler('src', 'renderer', 'src', 'lib', 'session.ts');
const preload = ler('src', 'preload', 'index.ts');
const principal = ler('src', 'main', 'index.ts');
const entrada = ler('src', 'main', 'input.ts');

check('o tipo compartilhado inclui os laterais', /BotaoMouse = 0 \| 1 \| 2 \| 3 \| 4/.test(botoes));
check('o contrato de rede aceita os laterais', /BotaoDoMouse = 0 \| 1 \| 2 \| 3 \| 4/.test(protocolo));
check('as mensagens de clique usam esse tipo', /b: BotaoDoMouse/.test(protocolo));

// O elo que estava quebrado.
check('o visitante NÃO descarta mais os botões acima de 2', !viewer.includes('e.button > 2'));
check('e não envia botões que não existem (para de 4 em diante)', viewer.includes('e.button > 4'));
check(
  'o visitante impede o Chromium de navegar com os laterais',
  /e\.button >= 3\) e\.preventDefault\(\)/.test(viewer),
);

for (const [nome, fonte] of [['a sessão', sessao], ['o preload', preload], ['o IPC do anfitrião', principal]]) {
  check(`${nome} não estreita o botão para 0|1|2`, !/button: 0 \| 1 \| 2/.test(fonte));
}

// ── a injeção no Windows ──
//
// Os laterais dividem UM par de sinalizadores e se distinguem pelo `mouseData`.
// Uma constante errada aqui não dá erro: o Windows simplesmente ignora o evento
// e o botão "não funciona" — exatamente o sintoma que estamos consertando.
check('XDOWN é 0x0080, como manda o Win32', /MOUSEEVENTF_XDOWN = 0x0080/.test(entrada));
check('XUP é 0x0100', /MOUSEEVENTF_XUP = 0x0100/.test(entrada));
check('XBUTTON1 (voltar) é 0x0001', /XBUTTON1 = 0x0001/.test(entrada));
check('XBUTTON2 (avançar) é 0x0002', /XBUTTON2 = 0x0002/.test(entrada));
check('o botão 3 é o "voltar" e o 4 é o "avançar"', /\{ 3: XBUTTON1, 4: XBUTTON2 \}/.test(entrada));
check(
  'e o lateral vai pelo mouseData, não por um par próprio',
  /mouseInput\(down \? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP, 0, 0, lateral\)/.test(entrada),
);
// Soltar tudo ao fim da sessão precisa alcançar os laterais também, senão um
// lateral preso fica travado no anfitrião depois que o visitante sai.
check('os laterais também são soltos ao encerrar', /for \(const button of \[\.\.\.heldButtons\]\)/.test(entrada));

console.log(falhas === 0 ? '\nBotões do mouse validados.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
