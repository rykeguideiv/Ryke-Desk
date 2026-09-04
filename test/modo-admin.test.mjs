/**
 * O "Modo administrador" reabre o app elevado — ou não reabre nunca mais.
 *
 * ESTE TESTE EXISTE POR CAUSA DE UM DEFEITO QUE VOLTOU TRÊS VEZES: apertar o
 * botão fechava o Ryke Desk e ele não subia de volta. As três causas foram
 * diferentes, e as três eram invisíveis — o app simplesmente sumia.
 *
 *   1ª: o lançador era um `cmd` que ESPERAVA 3 s antes de agir. Os filhos do
 *       Chromium vivem num "job object": ao encerrar o app, o cmd ainda-esperando
 *       morria junto, antes de disparar a tarefa.
 *   2ª: a trava de instância única é compartilhada entre a cópia normal e a
 *       elevada. A nova subia, esbarrava na trava da velha e desistia.
 *   3ª: o comando ia montado numa STRING para o `cmd /c`. O Node envolve esse
 *       argumento em aspas e o cmd, com as aspas dos caminhos por dentro, saía
 *       com CÓDIGO 0 sem executar nada — nem o primeiro `echo`. Nem no log
 *       ficava rastro, porque o log era escrito pelo próprio comando que não
 *       rodava.
 *
 * Por isso as regras abaixo são conferidas no código-fonte: são baratas de
 * verificar e cada uma marca um defeito que já custou uma versão.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const AQUI = resolve(import.meta.dirname, '..');
const fonte = readFileSync(join(AQUI, 'src', 'main', 'index.ts'), 'utf8');
const nsh = readFileSync(join(AQUI, 'build', 'installer.nsh'), 'utf8');

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

// Recorta só a função, para as regras falarem do relançamento e não do arquivo.
const i = fonte.indexOf('function trocarModo(');
const trocarModo = i >= 0 ? fonte.slice(i, fonte.indexOf('\n}\n', i)) : '';
check('a troca de modo existe', trocarModo.length > 0);

// ── A 3ª causa: nada de linha de comando montada à mão ──
//
// O cmd tem regras próprias para aspas dentro de aspas e falha em SILÊNCIO,
// devolvendo 0. Chamando o executável direto, o Windows recebe os argumentos
// já separados e não há string para interpretar errado.
check(
  'o relançamento NÃO passa por um shell (nada de cmd.exe / shell: true)',
  !fonte.includes('cmd.exe') && !/spawn\([^)]*shell:\s*true/.test(fonte),
);
check(
  'a tarefa é disparada com os argumentos SEPARADOS, não numa string só',
  /\['\/Run',\s*'\/TN',\s*'RykeDesk-Admin'\]/.test(trocarModo),
);
check('e pelo caminho completo do schtasks, não confiando no PATH', /system32,\s*'schtasks\.exe'/.test(trocarModo));

// ── A 2ª causa: a trava tem de ser solta ANTES de a nova cópia nascer ──
const soltaTrava = trocarModo.indexOf('releaseSingleInstanceLock');
const disparaTarefa = trocarModo.indexOf("'/Run'");
check('a trava de instância é solta na troca de modo', soltaTrava >= 0);
check('e ela é solta ANTES de a nova cópia ser disparada', soltaTrava >= 0 && disparaTarefa > soltaTrava);

// ── A 1ª causa: nenhuma espera dentro do lançador ──
//
// Quem sobe a cópia nova é o Agendador/Explorer — serviços do Windows, não
// filhos deste app. Um filho nosso que espere para agir morre junto com o app.
check('o lançador não espera nada antes de agir (sem ping/timeout/sleep)', !/ping |timeout \/t|\bsleep\b/i.test(trocarModo));
check('quem sobe a cópia elevada é o Agendador de Tarefas', trocarModo.includes('schtasks'));
check('e a volta ao normal passa pelo explorer, que des-eleva', trocarModo.includes('explorer.exe'));

// ── Nunca mais sumir em silêncio ──
check('a troca é registrada no diagnóstico', /registrarDiag\(`\[modo\]/.test(trocarModo));
check('o resultado do lançador também é registrado', /registrarDiag\(`\[relanc\]/.test(fonte));
check(
  'o código de saída do lançador é conferido (o cmd antigo mentia devolvendo 0)',
  /responder\(codigo === 0\)/.test(fonte),
);

// ── O plano B: se a tarefa faltar, ainda assim REABRE ──
//
// Um prompt de UAC é pior que nenhum, mas é muito melhor que o app sumir.
check('existe plano B quando a tarefa falha', trocarModo.includes('caindo para o UAC'));
check('e o plano B reabre o app elevado', /-Verb RunAs/.test(trocarModo));

// ── A tarefa precisa EXISTIR: só o instalador (elevado) consegue criá-la ──
//
// Um processo sem elevação recebe "Acesso negado" ao criar uma tarefa
// /RL HIGHEST — por isso ela não pode ser criada sob demanda pelo app.
check('o instalador cria a tarefa do modo administrador', nsh.includes('/TN "RykeDesk-Admin"'));
check('com privilégio mais alto, que é o que dispensa o UAC', /RykeDesk-Admin[\s\S]{0,200}\/RL HIGHEST/.test(nsh));
check('e o desinstalador a remove', /customUnInstall[\s\S]*schtasks \/Delete \/TN "RykeDesk-Admin"/.test(nsh));

// ── O PASSE DE RETORNO: não pedir autorização duas vezes ──
//
// Trocar para o modo administrador REABRE o programa. Numa conexão
// supervisionada (sem senha salva), isso obrigava a pessoa desta máquina a
// autorizar tudo de novo — sendo que foi ELA quem pediu a troca, segundos
// antes. A pergunta não protegia nada e só deixava o visitante esperando.
//
// O passe dispensa essa segunda autorização, e SÓ ela. As amarras abaixo são
// o que o mantém sendo um passe, e não uma porta aberta.
const controlador = readFileSync(join(AQUI, 'src', 'renderer', 'src', 'lib', 'controller.ts'), 'utf8');
const preloadFonte = readFileSync(join(AQUI, 'src', 'preload', 'index.ts'), 'utf8');

check('o passe é guardado ao trocar de modo', /salvarPasseDeRetorno/.test(fonte));
check('AMARRA 1: vale só para quem JÁ estava conectado', fonte.includes('salvarPasseDeRetorno([...ponteiros.keys()])'));
check('AMARRA 2: vence sozinho', fonte.includes('Date.now() > expira'));
check('e a validade é curta — dois minutos', /PASSE_VALIDO_MS = 120_000/.test(fonte));
check('AMARRA 3: é gasto na primeira usada', /const restantes = peers.filter/.test(fonte));
check('quando o último usa, o arquivo some', fonte.includes('rmSync(caminhoPasse()'));
check('o uso do passe fica gravado no diagnóstico', /[passe]/.test(fonte));
check('o preload expõe o passe', /passe: {/.test(preloadFonte));
check('e o visitante entra por ele, sem nova autorização', controlador.includes('await window.ryke.passe.consumir(from)'));
// Sem passe válido, NADA muda: continua pedindo autorização como sempre.
check('sem passe, o pedido de autorização continua de pé', controlador.includes("return this.pedirAutorizacao(from, 'pedido');"));
console.log(falhas === 0 ? '\nModo administrador validado.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
