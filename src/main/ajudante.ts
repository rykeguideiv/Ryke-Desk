/**
 * O ajudante elevado: um processo minúsculo que só injeta mouse e teclado.
 *
 * O PROBLEMA QUE ISTO RESOLVE, E POR QUE A SOLUÇÃO ANTERIOR ERA RUIM
 *
 * Para clicar numa janela de administrador, o Windows exige que quem injeta a
 * entrada esteja no mesmo nível de privilégio (é a UIPI). Até aqui, a resposta
 * a isso era reabrir o Ryke Desk INTEIRO elevado — e o preço disso era brutal:
 *
 *   • elevado, o Chromium não consegue iniciar a captura de tela
 *     (NotReadableError), e a imagem despencava de 60 quadros para 1;
 *   • a sessão caía, porque o processo reiniciava;
 *   • numa conexão sem senha salva, era preciso autorizar tudo de novo.
 *
 * Três estragos para resolver uma coisa só. E a observação que desfaz o nó é
 * simples: **só a injeção precisa de privilégio. A captura não.**
 *
 * Então o aplicativo passa a NUNCA elevar — fica sempre onde a captura funciona
 * a 60 quadros — e um ajudante elevado, que não desenha nada e não captura
 * nada, recebe os eventos de entrada e os injeta. O "Modo administrador" deixa
 * de ser um reinício e vira ligar e desligar esse ajudante.
 *
 * QUEM É SERVIDOR, E POR QUE ISSO IMPORTA
 *
 * O APLICATIVO é o servidor do cano; o ajudante é quem conecta. Nunca o
 * contrário. Um processo mais privilegiado pode abrir um cano de um menos
 * privilegiado, mas o caminho inverso esbarra no descritor de segurança e
 * exigiria mexer nele — que é o tipo de código que se escreve errado uma vez e
 * vira brecha para sempre.
 *
 * E o cano é autenticado. Um canal que injeta teclado sem autenticação é uma
 * porta aberta para qualquer processo da máquina: bastaria conectar e digitar.
 * O segredo é sorteado a cada sessão e fica num arquivo que só o usuário lê.
 */
import { createServer, connect, type Socket, type Server } from 'node:net';
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import * as input from './input';

/**
 * O nome do cano. Um por sessão de usuário — daí ser fixo.
 *
 * A variável de ambiente existe para o TESTE: sem ela, provar este caminho
 * exigiria fechar o Ryke Desk que está aberto na máquina, porque dois donos do
 * mesmo cano não cabem. O nome que vale em produção continua sendo este, e o
 * ajudante nem consulta a variável: ele usa o nome que o aplicativo gravou no
 * arquivo do segredo, junto com o segredo.
 */
const CANO = process.env.RYKE_CANO_ENTRADA || '\\\\.\\pipe\\ryke-desk-entrada';

/** O que o ajudante sabe fazer. Nada além disto atravessa o cano. */
export type Ordem =
  | { c: 'ola'; segredo: string }
  | { c: 'mv'; x: number; y: number }
  | { c: 'mvr'; dx: number; dy: number }
  | { c: 'btn'; b: 0 | 1 | 2 | 3 | 4; down: boolean }
  | { c: 'whl'; dx: number; dy: number }
  | { c: 'key'; code: string; down: boolean }
  | { c: 'combo'; codes: string[] }
  | { c: 'txt'; t: string }
  | { c: 'warp'; x: number; y: number }
  | { c: 'blk'; on: boolean }
  | { c: 'rel' };

type Diario = (linha: string) => void;

// ─────────────────────── o lado do APLICATIVO ───────────────────────

let servidor: Server | null = null;
let ajudante: Socket | null = null;
let segredoAtual = '';
let registrar: Diario = () => {};

function caminhoDoSegredo(pastaDados: string): string {
  return join(pastaDados, 'ryke-ajudante.json');
}

/** O ajudante está de pé e conectado agora? */
export function ajudanteConectado(): boolean {
  return ajudante !== null && !ajudante.destroyed;
}

/**
 * Abre o cano e espera o ajudante conectar.
 *
 * Devolve o segredo sorteado, que também fica gravado em disco — é por lá que o
 * ajudante o lê, já que uma tarefa agendada não aceita passar argumentos.
 */
export function abrirCanoDoAjudante(pastaDados: string, diario: Diario): void {
  registrar = diario;
  if (servidor) return;

  segredoAtual = randomBytes(24).toString('hex');
  try {
    writeFileSync(caminhoDoSegredo(pastaDados), JSON.stringify({ cano: CANO, segredo: segredoAtual }), 'utf8');
  } catch (e) {
    registrar(`[ajudante] não consegui gravar o segredo: ${String(e)}`);
    return;
  }

  servidor = createServer((sock) => {
    let autenticado = false;
    let sobra = '';

    sock.on('data', (pedaco) => {
      sobra += pedaco.toString('utf8');
      let quebra: number;
      while ((quebra = sobra.indexOf('\n')) >= 0) {
        const linha = sobra.slice(0, quebra).trim();
        sobra = sobra.slice(quebra + 1);
        if (!linha) continue;
        let ordem: Ordem;
        try {
          ordem = JSON.parse(linha) as Ordem;
        } catch {
          continue;
        }
        // A PRIMEIRA mensagem tem de ser o cumprimento com o segredo. Enquanto
        // não vier, nada é executado — e quem errar é desligado na hora, sem
        // segunda chance, porque não existe motivo legítimo para errar.
        if (!autenticado) {
          if (ordem.c === 'ola' && ordem.segredo === segredoAtual) {
            autenticado = true;
            ajudante = sock;
            registrar('[ajudante] conectado e autenticado — a entrada passa a ir por ele');
          } else {
            registrar('[ajudante] recusado: cumprimento inválido');
            sock.destroy();
          }
          continue;
        }
        executar(ordem);
      }
    });

    const encerrar = (): void => {
      if (ajudante === sock) {
        ajudante = null;
        registrar('[ajudante] desconectou — a entrada volta a ser injetada localmente');
      }
    };
    sock.on('close', encerrar);
    sock.on('error', encerrar);
  });

  servidor.on('error', (e) => registrar(`[ajudante] o cano falhou: ${String(e)}`));
  servidor.listen(CANO, () => registrar('[ajudante] cano aberto, aguardando o ajudante elevado'));
}

/** Fecha o cano e esquece o segredo — usado ao sair do modo administrador. */
export function fecharCanoDoAjudante(pastaDados: string): void {
  try {
    ajudante?.destroy();
  } catch {
    /* já caiu */
  }
  ajudante = null;
  try {
    servidor?.close();
  } catch {
    /* idem */
  }
  servidor = null;
  segredoAtual = '';
  try {
    rmSync(caminhoDoSegredo(pastaDados), { force: true });
  } catch {
    /* o arquivo some no próximo início de qualquer forma */
  }
}

/**
 * Manda a ordem ao ajudante. Devolve false quando ele não está lá — e é esse
 * false que faz a entrada continuar sendo injetada localmente, em vez de
 * simplesmente sumir.
 */
export function enviarAoAjudante(ordem: Ordem): boolean {
  if (!ajudanteConectado()) return false;
  try {
    // ATENÇÃO ao que NÃO devolvemos aqui: o resultado de `write`.
    //
    // `socket.write` devolve `false` quando o buffer de saída encheu — e isso
    // NÃO quer dizer que a ordem falhou: ela foi aceita e sai assim que o cano
    // vazar. Devolvendo aquele `false`, quem chama entendia "o ajudante não
    // recebeu" e injetava de novo AQUI, localmente. A entrada acontecia duas
    // vezes: um clique virava dois, um "soltar" virava dois. E o buffer só
    // enche num momento — durante um arrasto, com sessenta mensagens por
    // segundo, que é exatamente quando não pode falhar.
    ajudante!.write(`${JSON.stringify(ordem)}\n`);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────── o lado do AJUDANTE ───────────────────────

function executar(ordem: Ordem): void {
  switch (ordem.c) {
    case 'mv':
      input.moveMouseTo(ordem.x, ordem.y);
      break;
    case 'mvr':
      input.moveMouseRelative(ordem.dx, ordem.dy);
      break;
    case 'btn':
      input.mouseButton(ordem.b, ordem.down);
      break;
    case 'whl':
      input.mouseWheel(ordem.dx, ordem.dy);
      break;
    case 'key':
      input.key(ordem.code, ordem.down);
      break;
    case 'combo':
      input.combo(ordem.codes);
      break;
    case 'txt':
      input.typeText(ordem.t);
      break;
    case 'warp':
      input.warpCursor(ordem.x, ordem.y);
      break;
    case 'blk':
      input.blockLocalInput(ordem.on);
      break;
    case 'rel':
      input.releaseAll();
      break;
    default:
      break;
  }
}

/**
 * O processo lançado com `--ajudante-entrada`.
 *
 * Não abre janela, não captura nada, não entra na malha: conecta no cano do
 * aplicativo, autentica e passa a injetar o que chegar. Se o aplicativo sair, o
 * cano cai e o ajudante sai junto — um processo elevado órfão injetando teclado
 * é exatamente o que não pode existir.
 */
export function rodarComoAjudante(pastaDados: string): void {
  let dados: { cano?: string; segredo?: string };
  try {
    dados = JSON.parse(readFileSync(caminhoDoSegredo(pastaDados), 'utf8')) as {
      cano?: string;
      segredo?: string;
    };
  } catch {
    // Sem segredo não há o que fazer: ou o aplicativo não pediu ajudante, ou
    // alguém disparou a tarefa por fora. Sair calado é o certo.
    process.exit(0);
  }
  if (!dados.segredo) process.exit(0);

  const sock = connect(dados.cano ?? CANO);

  sock.on('connect', () => {
    sock.write(`${JSON.stringify({ c: 'ola', segredo: dados.segredo })}\n`);
  });

  let sobra = '';
  sock.on('data', (pedaco) => {
    sobra += pedaco.toString('utf8');
    let quebra: number;
    while ((quebra = sobra.indexOf('\n')) >= 0) {
      const linha = sobra.slice(0, quebra).trim();
      sobra = sobra.slice(quebra + 1);
      if (!linha) continue;
      try {
        executar(JSON.parse(linha) as Ordem);
      } catch {
        /* uma ordem malformada não derruba o ajudante */
      }
    }
  });

  const sair = (): void => {
    // Solta o que estiver preso antes de morrer: deixar um Ctrl pressionado ou
    // a entrada local bloqueada seria um desastre para quem está na máquina.
    try {
      input.releaseAll();
      if (input.isLocalInputBlocked()) input.blockLocalInput(false);
    } catch {
      /* melhor esforço */
    }
    process.exit(0);
  };
  sock.on('close', sair);
  sock.on('error', sair);
}
