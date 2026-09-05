/**
 * Os módulos nativos (.node) saíram assinados?
 *
 * POR QUE ISTO MERECE UM PASSO PRÓPRIO NA CONSTRUÇÃO
 *
 * O `electron-builder` assina o `.exe`. Ele NÃO assina os `.node` que ficam
 * desempacotados ao lado — e são justamente eles que o Windows avalia na hora
 * de carregar. Num Windows 11 recém-instalado, com o Smart App Control ligado,
 * um `.node` sem assinatura é bloqueado.
 *
 * O sintoma disso no cliente é cruel: a sessão conecta, mostra a tela, e não
 * responde a teclado nem mouse — porque o `koffi`, que é a ponte para o
 * `SendInput`, não carregou. Parece problema de rede. Não há nada no aplicativo
 * que aponte a causa.
 *
 * Já aconteceu neste projeto, durante o desenvolvimento:
 *
 *     Uma política de Controle de Aplicativo bloqueou este arquivo.
 *     \\?\...\build\Release\ryke_captura.node
 *
 * Então este passo existe para que ninguém publique uma versão nesse estado sem
 * ao menos ter sido avisado.
 *
 * COMPORTAMENTO
 *   - Por padrão AVISA e deixa passar, porque enquanto o certificado não existe
 *     a alternativa seria não conseguir publicar nada.
 *   - Com EXIGIR_ASSINATURA=1, FALHA. É assim que se liga a trava no dia em que
 *     a assinatura estiver funcionando.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');

const RAIZ = join(__dirname, '..');
const EXIGIR = process.env.EXIGIR_ASSINATURA === '1';

/** Onde procuramos .node: o que vai para o instalador e o que compilamos. */
const PASTAS = [
  join(RAIZ, 'release', 'win-unpacked'),
  join(RAIZ, 'ryke-sistema', 'nativo', 'build', 'Release'),
];

function procurarNode(dir, achados = []) {
  if (!existsSync(dir)) return achados;
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    let info;
    try {
      info = statSync(caminho);
    } catch {
      continue;
    }
    if (info.isDirectory()) procurarNode(caminho, achados);
    else if (nome.endsWith('.node')) achados.push(caminho);
  }
  return achados;
}

/** O estado da assinatura, pela própria ferramenta do Windows. */
function estadoDaAssinatura(caminho) {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${caminho.replace(/'/g, "''")}').Status`],
    { encoding: 'utf8' },
  );
  if (r.error || r.status !== 0) return 'NaoVerificado';
  return (r.stdout || '').trim() || 'NaoVerificado';
}

if (process.platform !== 'win32') {
  console.log('  --  fora do Windows; nada a conferir');
  process.exit(0);
}

const arquivos = PASTAS.flatMap((p) => procurarNode(p));
if (arquivos.length === 0) {
  console.log('  --  nenhum .node encontrado (nada foi empacotado ainda?)');
  process.exit(0);
}

let semAssinatura = 0;
for (const arquivo of arquivos) {
  const estado = estadoDaAssinatura(arquivo);
  const ok = estado === 'Valid';
  if (!ok) semAssinatura++;
  console.log(`${ok ? '  ok  ' : ' SEM  '} ${relative(RAIZ, arquivo)} — ${estado}`);
}

if (semAssinatura === 0) {
  console.log(`\n${arquivos.length} módulo(s) nativo(s), todos assinados.\n`);
  process.exit(0);
}

const recado =
  `\n${semAssinatura} de ${arquivos.length} módulo(s) nativo(s) SEM assinatura válida.\n\n` +
  '  Num Windows 11 com Smart App Control ligado, esses arquivos são bloqueados\n' +
  '  ao carregar. Para quem instalar, o sintoma é a sessão conectar, mostrar a\n' +
  '  tela e não responder a teclado nem mouse — sem nenhuma pista da causa.\n\n' +
  '  Para resolver: a configuração de artefato do SignPath precisa entrar no\n' +
  '  instalador e assinar também os .node de dentro, não só o .exe.\n';

if (EXIGIR) {
  console.error(recado);
  process.exit(1);
}
console.warn(recado + '  (avisando apenas; use EXIGIR_ASSINATURA=1 para travar a publicação)\n');
process.exit(0);
