/**
 * Ctrl+Alt+Del no computador remoto — a Secure Attention Sequence.
 *
 * POR QUE O BOTÃO NÃO FUNCIONAVA
 *
 * Ele mandava a combinação pelo mesmo caminho de todas as outras teclas:
 * `SendInput`. E `SendInput` NUNCA vai produzir um Ctrl+Alt+Del, em máquina
 * nenhuma, por mais privilégio que o programa tenha.
 *
 * Isso não é limitação nem defeito — é o ponto inteiro da SAS. O Windows
 * intercepta essa combinação antes de qualquer processo em modo usuário, num
 * caminho reservado ao Winlogon. É essa reserva que garante que a tela de
 * bloqueio seja mesmo do Windows, e não de um impostor pedindo sua senha. Se
 * um programa comum pudesse injetá-la, a garantia deixaria de existir.
 *
 * O CAMINHO QUE EXISTE
 *
 * A Microsoft oferece uma porta oficial: `SendSAS`, da `sas.dll`. Ela exige
 * duas coisas, e as duas por bons motivos:
 *
 *   1. O programa tem de estar ELEVADO (ou ser um serviço). O Ryke Desk é
 *      instalado com `requireAdministrator`, então isto costuma estar de pé.
 *
 *   2. A política `SoftwareSASGeneration` precisa permitir. Ela vem desligada
 *      no Windows, e ligá-la é uma decisão de quem é dono da máquina — por
 *      isso o Ryke Desk não a liga sozinho. Fica atrás de um interruptor nos
 *      Ajustes, no computador que vai ser acessado.
 *
 * O QUE ISSO MUDA NA MÁQUINA, dito com todas as letras: ligado, um programa
 * elevado passa a poder CHAMAR a tela de segurança do Windows. Ele não passa a
 * poder imitá-la, nem a ler o que se digita nela — a tela continua sendo
 * desenhada pelo Winlogon, na área de trabalho segura, fora do alcance de
 * qualquer programa. É o mesmo mecanismo que todo programa de acesso remoto
 * usa para isto, e é reversível: desligar o interruptor devolve a política ao
 * estado anterior.
 */
import { spawnSync } from 'node:child_process';
import koffi from 'koffi';

import { isElevated } from './elevation';

const CHAVE = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';
const VALOR = 'SoftwareSASGeneration';

/**
 * Valores possíveis da política:
 *   0 = ninguém   1 = serviços   2 = programas de acessibilidade   3 = ambos
 *
 * Usamos 3 porque o Ryke Desk pode chamar tanto do processo elevado quanto,
 * um dia, de um serviço — e porque restringir a 1 quebraria justamente o caso
 * atual, que é o processo com UAC.
 */
const PERMITIDO = 3;

let sas: { SendSAS: (asUser: number) => void } | null = null;
let tentouCarregar = false;

/**
 * Carrega a `sas.dll` sob demanda.
 *
 * Sob demanda, e não na inicialização, porque a maioria das sessões nunca pede
 * Ctrl+Alt+Del — e carregar uma DLL do sistema logo ao abrir é exatamente o
 * tipo de coisa que faz um antivírus olhar torto para um programa que já
 * captura tela e injeta teclado.
 */
function carregar(): boolean {
  if (tentouCarregar) return sas !== null;
  tentouCarregar = true;
  if (process.platform !== 'win32') return false;
  try {
    const lib = koffi.load('sas.dll');
    sas = { SendSAS: lib.func('void __stdcall SendSAS(int AsUser)') as (asUser: number) => void };
    return true;
  } catch (err) {
    console.error('[sas] não foi possível carregar sas.dll:', err);
    sas = null;
    return false;
  }
}

/** Lê o valor atual da política. `null` = a chave nem existe. */
function lerPolitica(): number | null {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('reg', ['query', CHAVE, '/v', VALOR], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  // Saída: "    SoftwareSASGeneration    REG_DWORD    0x3"
  const m = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.stdout);
  return m ? parseInt(m[1], 16) : null;
}

export type EstadoSas = {
  /** O processo tem privilégio de administrador? */
  elevado: boolean;
  /** A política do Windows já permite? */
  liberado: boolean;
  /** A sas.dll está disponível nesta máquina? */
  disponivel: boolean;
};

export function estadoSas(): EstadoSas {
  const politica = lerPolitica();
  return {
    elevado: isElevated(),
    liberado: politica !== null && (politica & PERMITIDO) !== 0,
    disponivel: carregar(),
  };
}

/**
 * Liga ou desliga a política. Exige elevação; devolve o que aconteceu.
 *
 * Desligar grava 0 em vez de apagar a chave: apagar deixaria o Windows cair no
 * padrão dele, que é o mesmo 0 — mas um valor explícito é o que permite a
 * quem administra a máquina ver, numa auditoria, que a decisão foi tomada.
 */
export function definirPoliticaSas(ligar: boolean): { ok: boolean; motivo: string } {
  if (process.platform !== 'win32') return { ok: false, motivo: 'Só existe no Windows.' };
  if (!isElevated()) {
    return {
      ok: false,
      motivo: 'É preciso executar o Ryke Desk como administrador para mexer nesta política do Windows.',
    };
  }
  const r = spawnSync(
    'reg',
    ['add', CHAVE, '/v', VALOR, '/t', 'REG_DWORD', '/d', String(ligar ? PERMITIDO : 0), '/f'],
    { windowsHide: true, encoding: 'utf8' },
  );
  if (r.status !== 0) {
    return { ok: false, motivo: `O Windows recusou a alteração da política. ${(r.stderr ?? '').trim()}`.trim() };
  }
  return { ok: true, motivo: ligar ? 'Ctrl+Alt+Del remoto liberado neste computador.' : 'Ctrl+Alt+Del remoto bloqueado.' };
}

/** Nome da tarefa que dispara o SAS como SISTEMA. Ver `enviarSas`. */
const TAREFA_SAS = 'RykeDesk-SAS';

/**
 * Dispara o SAS a partir de um processo rodando como SISTEMA.
 *
 * Chamado pelo próprio Ryke Desk quando lançado com `--sas` pela tarefa
 * agendada abaixo. Aqui `SendSAS(0)` é o CERTO: 0 = "sou um serviço LocalSystem",
 * e é esse o contexto em que a tarefa nos coloca. Ver o porquê em `enviarSas`.
 */
export function dispararComoSistema(): void {
  if (!carregar() || !sas) return;
  sas.SendSAS(0);
}

/**
 * Dispara o Ctrl+Alt+Del nesta máquina.
 *
 * POR QUE ISTO PRECISOU MUDAR
 *
 * O código antigo chamava `SendSAS(0)` direto do processo elevado, e não
 * acontecia nada — dizia "enviado" e a tela de segurança não vinha. O motivo é
 * do Windows: `SendSAS(FALSE)` só funciona de um SERVIÇO rodando como
 * LocalSystem, e `SendSAS(TRUE)` só de um app de ACESSIBILIDADE assinado
 * (uiAccess). O Ryke Desk não é nem um nem outro — é um app comum, elevado —,
 * então as duas formas eram um botão mudo.
 *
 * O CAMINHO QUE FUNCIONA é o mesmo dos programas de acesso remoto sérios: uma
 * peça rodando como SISTEMA. Em vez de instalar um serviço, reaproveitamos o
 * Agendador de Tarefas: criamos uma tarefa que roda o PRÓPRIO Ryke Desk como
 * SISTEMA, só para chamar `SendSAS(0)` (ver `dispararComoSistema`), e a
 * disparamos na hora. É a tarefa que dá o contexto LocalSystem que o Windows
 * exige — sem serviço para instalar e sem certificado de assinatura.
 */
export function enviarSas(): { ok: boolean; motivo: string } {
  const estado = estadoSas();

  if (!estado.disponivel) {
    return { ok: false, motivo: 'Este Windows não oferece a API de Ctrl+Alt+Del (sas.dll não encontrada).' };
  }
  if (!estado.elevado) {
    return {
      ok: false,
      motivo:
        'O Ryke Desk do outro computador não está rodando como administrador. Ctrl+Alt+Del só pode ser disparado por um programa elevado — é o Windows que exige isso.',
    };
  }
  if (!estado.liberado) {
    return {
      ok: false,
      motivo:
        'O outro computador ainda não liberou o Ctrl+Alt+Del remoto. Lá, em Ajustes, ligue "Permitir Ctrl+Alt+Del remoto".',
    };
  }

  const exe = process.execPath;
  // Cria/atualiza a tarefa que roda o Ryke Desk como SISTEMA com `--sas`. `/F`
  // sobrescreve, então é idempotente; criar exige admin, que já temos.
  const criar = spawnSync(
    'schtasks',
    ['/Create', '/TN', TAREFA_SAS, '/TR', `"${exe}" --sas`, '/SC', 'ONCE', '/ST', '00:00', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F'],
    { windowsHide: true, encoding: 'utf8' },
  );
  if (criar.status !== 0) {
    return { ok: false, motivo: `Não foi possível preparar o Ctrl+Alt+Del: ${(criar.stderr ?? '').trim()}`.trim() };
  }
  // Dispara agora. A tarefa sobe o Ryke Desk como SISTEMA, ele chama SendSAS e sai.
  const rodar = spawnSync('schtasks', ['/Run', '/TN', TAREFA_SAS], { windowsHide: true, encoding: 'utf8' });
  if (rodar.status !== 0) {
    return { ok: false, motivo: `O Windows recusou disparar o Ctrl+Alt+Del: ${(rodar.stderr ?? '').trim()}`.trim() };
  }
  return { ok: true, motivo: 'Ctrl+Alt+Del enviado.' };
}
