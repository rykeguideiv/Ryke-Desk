/**
 * O "Modo administrador" — que deixou de reiniciar o programa.
 *
 * A HISTÓRIA, PORQUE ELA EXPLICA CADA REGRA ABAIXO
 *
 * Durante três versões, entrar em modo administrador reabria o Ryke Desk
 * INTEIRO elevado. Cada tentativa de fazer isso funcionar quebrou de um jeito
 * diferente e invisível — o programa simplesmente sumia:
 *
 *   1.0.35: o lançador esperava 3 s antes de agir. Os filhos do Chromium vivem
 *           num "job object" e morrem junto no encerramento, antes de disparar.
 *   1.0.36: a trava de instância é compartilhada entre a cópia normal e a
 *           elevada; a nova esbarrava nela e desistia.
 *   1.0.37: o comando ia numa STRING para o `cmd /c`. Com as aspas dos caminhos
 *           por dentro, o cmd saía com CÓDIGO 0 SEM EXECUTAR NADA.
 *
 * E, mesmo depois de tudo isso funcionar, o preço continuava alto: elevado, o
 * Chromium não consegue iniciar a captura (NotReadableError) e a imagem caía de
 * 60 quadros para 1 — medido em produção. Além de a sessão cair no reinício e
 * de ser preciso autorizar de novo.
 *
 * A OBSERVAÇÃO QUE DESFEZ O NÓ: só a INJEÇÃO de mouse e teclado precisa de
 * privilégio. A captura não. Então o aplicativo NUNCA mais eleva, e quem eleva
 * é um ajudante que não desenha nem captura nada.
 *
 * As regras abaixo guardam esse desenho. A mais importante é a primeira: no
 * dia em que alguém "consertar" o modo administrador voltando a elevar o
 * aplicativo, os 60 quadros vão embora de novo — e o teste precisa gritar.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const AQUI = resolve(import.meta.dirname, '..');
const ler = (...p) => readFileSync(join(AQUI, ...p), 'utf8');

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

const principal = ler('src', 'main', 'index.ts');
const ajudante = ler('src', 'main', 'ajudante.ts');
const entrada = ler('src', 'main', 'entrada.ts');
const nsh = ler('build', 'installer.nsh');
const controlador = ler('src', 'renderer', 'src', 'lib', 'controller.ts');
const preload = ler('src', 'preload', 'index.ts');
const home = ler('src', 'renderer', 'src', 'components', 'Home.tsx');
const viewer = ler('src', 'renderer', 'src', 'components', 'Viewer.tsx');

// Recorta a função, para as regras falarem da troca de modo e não do arquivo.
const i = principal.indexOf('async function trocarModo(');
const trocarModo = i >= 0 ? principal.slice(i, principal.indexOf('\n}\n', i)) : '';
check('a troca de modo existe', trocarModo.length > 0);

// ── A REGRA QUE VALE MAIS: trocar de modo NÃO reinicia nada ──
//
// É disto que dependem os 60 quadros, a sessão não cair e ninguém precisar
// autorizar de novo. Todas as três de uma vez.
check('a troca de modo NÃO encerra o aplicativo', !/app\.exit\(/.test(trocarModo));
check('não solta a trava de instância (não há cópia nova para subir)', !/releaseSingleInstanceLock/.test(trocarModo));
check('não relança o aplicativo pelo explorer', !/explorer\.exe/.test(trocarModo));
check('e não dispara a tarefa que reabria o app elevado', !/RykeDesk-Admin/.test(trocarModo));

// ── O que ela faz, então ──
check('abre o cano do ajudante', /abrirCanoDoAjudante/.test(trocarModo));
check('e dispara a tarefa que sobe o AJUDANTE', /'\/Run', '\/TN', 'RykeDesk-Entrada'/.test(trocarModo));
check('pelo caminho completo do schtasks, sem confiar no PATH', /System32.*schtasks\.exe/.test(trocarModo));
check('desligar apenas fecha o cano — o ajudante morre sozinho', /fecharCanoDoAjudante/.test(trocarModo));
check('espera o ajudante conectar antes de dizer que ligou', /esperarAjudante/.test(trocarModo));
check('e admite a falha em vez de mentir que ligou', /ok: false/.test(trocarModo));
check('a troca fica registrada no diagnóstico', /registrarDiag\('\[modo\]/.test(trocarModo));

// ── O ajudante: um satélite, não uma segunda cópia do programa ──
check('existe o modo de execução do ajudante', /--ajudante-entrada/.test(principal));
check('o ajudante NÃO disputa a trava de instância', /!EH_AJUDANTE && !app\.requestSingleInstanceLock\(\)/.test(principal));
check('e não monta interface nenhuma', /if \(EH_AJUDANTE\) return;/.test(principal));
check('o instalador cria a tarefa do ajudante', nsh.includes('/TN "RykeDesk-Entrada"'));
check('com privilégio mais alto, que é o que dispensa o UAC', /RykeDesk-Entrada[\s\S]{0,220}\/RL HIGHEST/.test(nsh));
check('e ela é removida na desinstalação', /customUnInstall[\s\S]*RykeDesk-Entrada/.test(nsh));

// ── A segurança do cano ──
//
// Um canal que injeta teclado sem autenticação é uma porta aberta: bastaria
// qualquer processo da máquina conectar e digitar.
check('o cano é autenticado por segredo', /segredo/.test(ajudante));
check('o segredo é sorteado, não fixo', /randomBytes/.test(ajudante));
check('quem erra o cumprimento é desligado na hora', /sock\.destroy\(\)/.test(ajudante));
// Um processo mais privilegiado abre o cano de um menos privilegiado; o
// caminho inverso exigiria mexer em descritor de segurança.
check('o APLICATIVO é o servidor, e o ajudante quem conecta', /createServer/.test(ajudante) && /rodarComoAjudante[\s\S]*connect\(/.test(ajudante));
check('o ajudante morre quando o cano cai (nada de órfão elevado)', /sock\.on\('close', sair\)/.test(ajudante));
check('e solta as teclas presas antes de morrer', /releaseAll\(\)[\s\S]{0,200}process\.exit/.test(ajudante));

// ── O roteamento, e o recuo que impede piorar ──
check('só a injeção é roteada; as perguntas ficam locais', /export const cursorPosition = input\.cursorPosition/.test(entrada));
check('sem ajudante, injeta local como sempre foi', /if \(enviarAoAjudante[\s\S]{0,80}input\.moveMouseTo\(x, y\)/.test(entrada));
// Uma tecla presa na máquina de outra pessoa é o pior estrago possível, e não
// dá para saber de qual lado ela ficou.
check('soltar tudo vai aos DOIS lados, sem atalho', /enviarAoAjudante\(\{ c: 'rel' \}\);\s*\n\s*input\.releaseAll\(\)/.test(entrada));

// ── A interface não pode mentir sobre o que mudou ──
check('"modo admin" passou a refletir o ajudante, não o processo', /elevated: ajudanteConectado\(\)/.test(principal));
check('o processo elevado continua visível para o diagnóstico', /processoElevado: isElevated\(\)/.test(principal));
for (const [nome, fonte] of [['a Home', home], ['o Viewer', viewer]]) {
  check(`${nome} não promete mais que a imagem fica lenta`, !/imagem fica lenta/.test(fonte));
  check(`${nome} não promete mais que o app reabre`, !/reabre/.test(fonte) || !/sess(ã|a)o reabre/.test(fonte));
}

// ── O passe de retorno: continua valendo, para reinícios de verdade ──
check('o passe é guardado ao SAIR do programa', /before-quit[\s\S]{0,400}salvarPasseDeRetorno/.test(principal));
check('AMARRA 1: vale só para quem JÁ estava conectado', principal.includes('salvarPasseDeRetorno([...ponteiros.keys()])'));
check('AMARRA 2: vence sozinho', principal.includes('Date.now() > expira'));
check('e a validade é curta — dois minutos', /PASSE_VALIDO_MS = 120_000/.test(principal));
check('AMARRA 3: é gasto na primeira usada', /const restantes = peers\.filter/.test(principal));
check('o preload expõe o passe', /passe: \{/.test(preload));
check('e o visitante entra por ele, sem nova autorização', controlador.includes('await window.ryke.passe.consumir(from)'));
check('sem passe, o pedido de autorização continua de pé', controlador.includes("return this.pedirAutorizacao(from, 'pedido');"));

// ── CLIQUE EM JANELA ELEVADA: avisar, em vez de sumir em silêncio ──
//
// O DEFEITO: sem modo administrador, clicar em "Concluir" no instalador fazia
// a sessão parecer TRAVADA. A janela do instalador é elevada, o Windows
// descarta em silêncio a entrada vinda de um processo comum (é a UIPI), e como
// ela cobre a tela e nunca fecha, nada mais parece responder. Só entrar em
// modo administrador resolvia — e ninguém tinha como adivinhar isso.
//
// As checagens aqui usam comparação de texto, e não expressão regular, de
// propósito: uma regex mal escapada passa a valer para qualquer coisa e o
// teste vira enfeite que nunca falha.
const entradaFonte = ler('src', 'main', 'input.ts');
const roteador = ler('src', 'main', 'entrada.ts');
const protocolo = ler('src', 'shared', 'protocol.ts');
const estilos = ler('src', 'renderer', 'src', 'styles.css');
const sessao = ler('src', 'renderer', 'src', 'lib', 'session.ts');

check('existe como saber se a janela sob o ponto exige administrador',
  entradaFonte.includes('export function janelaExigeAdmin'));
// UM ERRO QUE JÁ FOI COMETIDO, E QUE ESTE TESTE IMPEDE DE VOLTAR.
//
// A primeira versão DEDUZIA: supunha que um processo comum não conseguiria
// ler o token de um elevado, e tratava a recusa como resposta. A suposição
// era falsa — com PROCESS_QUERY_LIMITED_INFORMATION o Windows deixa ler o
// token de um processo elevado sem reclamar. Testado contra uma janela real
// do Editor do Registro: "token lido", e a detecção respondia "pode clicar"
// justamente onde o clique não passa.
//
// A correção é PERGUNTAR, e não deduzir.
check('pergunta TokenElevation, em vez de deduzir por uma recusa',
  entradaFonte.includes('TOKEN_ELEVATION = 20') &&
    entradaFonte.includes('GetTokenInformationFn(token[0], TOKEN_ELEVATION, buf, 4, usado)'));
check('e a resposta é o valor lido, não o sucesso da chamada',
  entradaFonte.includes('return buf.readUInt32LE(0) !== 0;'));
check('abre o processo para consulta limitada, que é o que basta',
  entradaFonte.includes('OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0])'));
// Já elevados, alcançamos qualquer janela: não há o que recusar.
check('estando elevados, nada é recusado', entradaFonte.includes('if (isElevated()) return false;'));
check('as alças do processo e do token são fechadas',
  entradaFonte.includes('CloseHandle(token[0])') && entradaFonte.includes('CloseHandle(processo)'));
// Um falso alarme recusaria cliques legítimos, que é pior do que perder um.
const catchSeguro = [
  '  } catch {',
  '    return false;',
  '  } finally {',
].join('\n');
check('na dúvida assume que DÁ para clicar', entradaFonte.includes(catchSeguro));
check('o roteador reexporta a checagem',
  roteador.includes('export const janelaExigeAdmin = input.janelaExigeAdmin'));

check('o clique é recusado quando a janela exige admin e o modo está desligado',
  principal.includes('if (down && !ajudanteConectado() && input.janelaExigeAdmin'));
// Puxar o cursor real para dentro de uma janela onde não se pode clicar só
// aumentaria a confusão: a recusa acontece ANTES de mexer em qualquer coisa.
const trechoBotao = principal.slice(principal.indexOf("ipcMain.on('input:button'"));
const recusa = trechoBotao.indexOf('avisarPrecisaAdmin');
const emprestimo = trechoBotao.indexOf('pegarCursorEmprestado');
check('e recusado ANTES de emprestar o cursor',
  recusa >= 0 && emprestimo >= 0 && recusa < emprestimo);
check('o aviso tem limite de repetição',
  principal.includes('ultimoAvisoAdmin.get(peerId) ?? 0) < 1500'));
check('a recusa fica registrada no diagnóstico',
  principal.includes('[entrada] clique recusado'));

check('o contrato de rede carrega o aviso',
  protocolo.includes("CtrlPrecisaAdmin = { t: 'precisaAdmin'"));
check('o anfitrião envia o aviso ao visitante',
  sessao.includes('avisarPrecisaAdmin(x: number, y: number)'));
check('o visitante recebe e emite o evento', sessao.includes("case 'precisaAdmin':"));
check('o visitante desenha a marca no ponto clicado', viewer.includes('className="aviso-admin"'));
check('com o "x" e a explicação',
  viewer.includes('aviso-admin-x') && viewer.includes('exige o modo administrador'));
check('e ela some sozinha', viewer.includes('setAvisoAdmin(null), 2600'));

// A posição do clique vive no `transform` em linha. Se a animação tocasse em
// transform, ela o sobrescreveria e jogaria a marca para o canto da tela.
const quadros = estilos.slice(estilos.indexOf('@keyframes aviso-admin-entra'));
check('a animação mexe só na opacidade, nunca no transform',
  quadros.length > 0 && !quadros.includes('transform'));
check('a marca não intercepta o mouse', estilos.includes('pointer-events: none'));

console.log(falhas === 0 ? '\nModo administrador validado.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
