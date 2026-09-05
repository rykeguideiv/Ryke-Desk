/**
 * Compila a captura nativa contra o ABI do ELECTRON, e não o do Node.
 *
 * POR QUE ISTO NÃO É UMA LINHA NO package.json
 *
 * A versão do Electron precisa ser a MESMA que o aplicativo usa, e ela muda.
 * Cravar o número aqui cria um defeito silencioso e desagradável: o módulo
 * compila sem reclamar, o instalador sai, e só quando alguém abre o programa é
 * que aparece
 *
 *   Error: The module was compiled against a different Node.js version using
 *   NODE_MODULE_VERSION 127. This version requires NODE_MODULE_VERSION 133.
 *
 * — uma mensagem que não diz "você compilou para o alvo errado". Então o número
 * é lido do package.json do aplicativo, que é a única fonte que não sai de
 * sincronia com ele.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const RAIZ_APP = join(__dirname, '..', '..');

function versaoDoElectron() {
  const pkg = JSON.parse(readFileSync(join(RAIZ_APP, 'package.json'), 'utf8'));
  const bruto = pkg.devDependencies?.electron ?? pkg.dependencies?.electron;
  if (!bruto) throw new Error('não achei a dependência "electron" no package.json do aplicativo');
  // "^39.2.7" → "39.2.7". O acento circunflexo é intenção do npm, não do node-gyp.
  const limpo = String(bruto).replace(/^[^\d]*/, '');
  if (!/^\d+\.\d+\.\d+/.test(limpo)) throw new Error(`versão do electron ilegível: ${bruto}`);
  return limpo;
}

// A versão EXATA instalada vale mais que a faixa do package.json: é ela que vai
// rodar. Só caímos na faixa quando o módulo ainda não foi instalado.
function versaoInstalada() {
  try {
    const pkg = JSON.parse(readFileSync(join(RAIZ_APP, 'node_modules', 'electron', 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return null;
  }
}

const alvo = versaoInstalada() ?? versaoDoElectron();
console.log(`compilando a captura nativa para o Electron ${alvo}`);

const r = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'node-gyp',
    'rebuild',
    '--runtime=electron',
    `--target=${alvo}`,
    '--dist-url=https://electronjs.org/headers',
    `--arch=${process.arch}`,
  ],
  { cwd: __dirname, stdio: 'inherit' },
);

if (r.error) {
  console.error(`não consegui chamar o node-gyp: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
