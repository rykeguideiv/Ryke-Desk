/**
 * Atualizar por cima: o programa aberto fecha, e a versao antiga sai.
 *
 * O QUE ESTAVA ERRADO
 *
 * O instalador escrevia por cima da instalacao anterior. Com o Ryke Desk
 * aberto, os arquivos em uso nao eram substituidos: a instalacao terminava
 * dizendo "concluida" e o programa continuava sendo o antigo. E o pior tipo de
 * falha, porque se parece com sucesso.
 *
 * COMO ISTO E TESTADO SEM MEXER NA MAQUINA
 *
 * Instalar o Ryke Desk de verdade exige elevacao e mexe em Arquivos de
 * Programas. Entao compilamos duas versoes de um instalador de mentira — mesmo
 * AppId, mesmo codigo Pascal (`installer\atualizar.pas`, um `#include` nos
 * dois), instalando numa pasta do usuario e sem pedir admin.
 *
 * O "programa" instalado e uma copia do node.exe rodando em laco. Ele e
 * aberto de proposito antes da segunda instalacao, que e justamente o cenario
 * que falhava.
 *
 * O que fica de fora: elevacao (UAC) e o nome real do executavel. O mecanismo
 * — achar a versao anterior no registro, fechar o que estiver aberto,
 * desinstalar e esperar terminar — e exercitado inteiro.
 *
 *   node test/instalador.test.mjs
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acharISCC } from '../installer/compilar.mjs';

const AQUI = resolve(import.meta.dirname);
const RECEITA = join(AQUI, 'instalador', 'versao.iss');
const DESTINO = join(process.env.LOCALAPPDATA ?? '', 'RykeTesteInstalador');
const CHAVE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{9F1C2D3E-4B5A-6C7D-8E9F-0A1B2C3D4E5F}_is1';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

const descartaveis = [];
const filhos = [];

/** O processo de mentira ainda esta vivo? */
function vivo(nome) {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${nome}`, '/NH'], { encoding: 'utf8' });
  return (r.stdout ?? '').includes(nome);
}

function limparRegistro() {
  spawnSync('reg', ['delete', CHAVE, '/f'], { stdio: 'ignore' });
}

async function principal() {
  const pacote = JSON.parse(readFileSync(resolve(AQUI, '..', 'package.json'), 'utf8'));
  const receitaNsis = readFileSync(resolve(AQUI, '..', 'build', 'installer.nsh'), 'utf8');
  check('o instalador mostra o assistente padrão', pacote.build.nsis.oneClick === false);
  check('a instalação substitui a versão de todos os usuários', pacote.build.nsis.perMachine === true);
  check('o aplicativo sempre solicita administrador ao iniciar',
    pacote.build.win.requestedExecutionLevel === 'requireAdministrator');
  check('o usuário pode escolher a pasta de instalação', pacote.build.nsis.allowToChangeInstallationDirectory === true);
  check('a tela final não pergunta se deve abrir o aplicativo', pacote.build.nsis.runAfterFinish === false);
  check('a migração NSIS está incluída', pacote.build.nsis.include === 'build/installer.nsh');

  // ── atualizar por dentro de uma sessão remota ──
  //
  // O defeito: `taskkill` morava em `customInit`, que roda no duplo clique do
  // instalador — antes de qualquer tela. Numa atualização feita remotamente a
  // sessão caía no ato de ABRIR o .exe, e quem estava do outro lado perdia a
  // tela sem nunca ter clicado em "Instalar", deixando a máquina remota
  // sozinha com um instalador aberto e nenhum caminho de volta.
  const corpoDe = (macro) => {
    const inicio = receitaNsis.indexOf(`!macro ${macro}`);
    if (inicio < 0) return '';
    const fim = receitaNsis.indexOf('!macroend', inicio);
    return receitaNsis.slice(inicio, fim < 0 ? undefined : fim);
  };

  check('abrir o instalador NÃO fecha o Ryke Desk que está sustentando a sessão',
    corpoDe('customInit').includes('taskkill') === false,
    'customInit roda no duplo clique, antes de a pessoa confirmar');
  check('fechar o aplicativo acontece só quando a troca de arquivos começa',
    corpoDe('customCheckAppRunning').includes('taskkill'),
    'customCheckAppRunning é inserido no início da seção de instalação');
  check('a limpeza das versões antigas também esperou a confirmação',
    corpoDe('customInit').includes('UninstallString') === false &&
      corpoDe('customCheckAppRunning').includes('UninstallString'));
  check('o instalador reabre o Ryke Desk automaticamente ao concluir',
    corpoDe('customInstall').includes('Exec '));
  check('e o reabre herdando a elevação, sem UAC na área de trabalho segura',
    corpoDe('customInstall').includes('ExecShellAsUser') === false,
    'UAC desenha na área protegida, invisível para quem acessa remotamente');

  check('a migração reconhece o instalador Inno antigo',
    receitaNsis.includes('{B7E4B3A2-9C1D-4E6F-8A5B-2D3C4E5F6A7B}_is1'));
  check('a migração reconhece as versões 1.0.5/1.0.6',
    receitaNsis.includes('c475af87-7409-5f50-a0b8-25adac0144b6'));

  const iscc = acharISCC();
  check('compilador do Inno Setup encontrado', !!iscc, iscc ?? 'nenhum');
  if (!iscc) return;

  // Máquina limpa: se uma execução anterior deixou restos, o teste começaria
  // já com a resposta pronta e não provaria nada.
  if (existsSync(DESTINO)) rmSync(DESTINO, { recursive: true, force: true });
  limparRegistro();

  const saida = mkdtempSync(join(tmpdir(), 'ryke-inst-saida-'));
  const origem1 = mkdtempSync(join(tmpdir(), 'ryke-inst-v1-'));
  const origem2 = mkdtempSync(join(tmpdir(), 'ryke-inst-v2-'));
  descartaveis.push(saida, origem1, origem2);

  // O "aplicativo": um node.exe com outro nome, e um arquivo que só existe
  // naquela versão — é ele que denuncia se a antiga foi mesmo removida ou
  // apenas coberta.
  for (const [pasta, marca] of [[origem1, 'marca-v1.txt'], [origem2, 'marca-v2.txt']]) {
    copyFileSync(process.execPath, join(pasta, 'AppTeste.exe'));
    writeFileSync(join(pasta, marca), 'versao de teste\n');
  }

  const compilar = (origem, nome, versao) =>
    execFileSync(iscc, [`/DORIGEM=${origem}`, `/DSAIDA=${saida}`, `/DNOME=${nome}`, `/DVERSAO=${versao}`, RECEITA],
      { stdio: 'ignore' });

  compilar(origem1, 'teste-v1', '1.0.0');
  compilar(origem2, 'teste-v2', '2.0.0');
  check('os dois instaladores compilaram',
    existsSync(join(saida, 'teste-v1.exe')) && existsSync(join(saida, 'teste-v2.exe')));

  const instalar = (nome) =>
    execFileSync(join(saida, `${nome}.exe`), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'ignore' });

  // ── a primeira instalação ──
  instalar('teste-v1');
  await dorme(1200);
  check('a versão antiga instalou', existsSync(join(DESTINO, 'marca-v1.txt')));
  check('e ficou registrada para poder ser encontrada depois',
    (spawnSync('reg', ['query', CHAVE, '/v', 'UninstallString'], { encoding: 'utf8' }).stdout ?? '').includes('unins'));

  // ── o programa aberto, que era o que quebrava tudo ──
  const processo = spawn(join(DESTINO, 'AppTeste.exe'), ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  filhos.push(processo);
  await dorme(1500);
  check('o programa de teste está aberto antes de atualizar', vivo('AppTeste.exe') === true);

  // ── a atualização ──
  instalar('teste-v2');
  await dorme(1500);

  check('atualizar fechou o programa que estava aberto', vivo('AppTeste.exe') === false);
  check('a versão nova entrou', existsSync(join(DESTINO, 'marca-v2.txt')));
  check('a versão antiga foi REMOVIDA, e não coberta',
    existsSync(join(DESTINO, 'marca-v1.txt')) === false,
    'o arquivo que só existia na versão anterior sumiu');
  check('e o executável está lá, substituído',
    existsSync(join(DESTINO, 'AppTeste.exe')) === true);

  // ── e a desinstalação também fecha o que estiver aberto ──
  const outra = spawn(join(DESTINO, 'AppTeste.exe'), ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  filhos.push(outra);
  await dorme(1500);

  const desinstalador = join(DESTINO, 'unins000.exe');
  check('o desinstalador existe', existsSync(desinstalador));
  spawnSync(desinstalador, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'ignore' });
  for (let i = 0; i < 40 && existsSync(desinstalador); i++) await dorme(500);

  check('desinstalar também fecha o programa aberto', vivo('AppTeste.exe') === false);
  check('e não deixa a pasta para trás', existsSync(join(DESTINO, 'AppTeste.exe')) === false);
}

principal()
  .catch((err) => {
    console.error('\n  ERRO:', err.message);
    falhas++;
  })
  .finally(() => {
    for (const p of filhos) {
      try {
        process.kill(p.pid);
      } catch {
        /* já morreu */
      }
    }
    spawnSync('taskkill', ['/F', '/IM', 'AppTeste.exe'], { stdio: 'ignore' });
    if (existsSync(DESTINO)) rmSync(DESTINO, { recursive: true, force: true });
    limparRegistro();
    for (const c of descartaveis) rmSync(c, { recursive: true, force: true });
    console.log(falhas === 0 ? '\nAtualizacao por cima validada.\n' : `\n${falhas} falha(s).\n`);
    process.exit(falhas === 0 ? 0 : 1);
  });
