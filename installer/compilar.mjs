/**
 * Chama o compilador do Inno Setup para gerar o instalador.
 *
 * Existe porque `iscc` só está no PATH se quem instalou o Inno Setup marcou a
 * opção — e quando não está, a compilação morre no fim de um empacotamento de
 * vários minutos, com uma mensagem que não diz o que fazer. Aqui procuramos o
 * programa nos lugares onde ele realmente fica e, se não houver nenhum,
 * dizemos exatamente o que falta.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const AQUI = resolve(import.meta.dirname);
const RECEITA = join(AQUI, 'RykeDesk.iss');

const CANDIDATOS = [
  join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
  join(process.env.ProgramFiles ?? 'C:/Program Files', 'Inno Setup 6', 'ISCC.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
];

/** O compilador do Inno, ou `null`. O teste de atualização usa a mesma busca. */
export function acharISCC() {
  return CANDIDATOS.find((caminho) => existsSync(caminho)) ?? null;
}

// Só compila quando chamado direto pela linha de comando; importado, apenas
// empresta `acharISCC`.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const compilador = acharISCC();
  if (!compilador) {
    console.error(
      [
        'Compilador do Inno Setup não encontrado.',
        '',
        'O aplicativo já está empacotado em release/win-unpacked — falta só embrulhar no instalador.',
        'Instale o Inno Setup 6 (https://jrsoftware.org/isdl.php) e rode de novo:',
        '',
        '    npm run dist',
        '',
        'Procurado em:',
        ...CANDIDATOS.map((c) => `    ${c}`),
      ].join('\n'),
    );
    process.exit(1);
  }
  execFileSync(compilador, [RECEITA], { stdio: 'inherit' });
}
