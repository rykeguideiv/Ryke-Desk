/**
 * O APK contém exatamente o que foi testado?
 *
 * O teste de ponta a ponta roda os arquivos de `dist/` num Chromium de mesa e
 * prova que o aplicativo funciona. Mas o usuário não instala `dist/`: instala
 * um APK. Entre os dois há uma compilação, e uma compilação desatualizada é o
 * tipo de erro que passa despercebido — o instalável parece novo, o número da
 * versão bate, e o comportamento é o de duas semanas atrás.
 *
 * Este teste fecha essa lacuna comparando byte a byte os arquivos de dentro do
 * APK com os que acabaram de ser testados, e confere que o aplicativo não pede
 * nenhuma permissão além de acesso à internet — o que é a garantia técnica de
 * que ele não consegue ver a tela, a câmera nem os arquivos do celular.
 *
 *   node test/apk.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join, resolve, relative, sep } from 'node:path';

const AQUI = resolve(import.meta.dirname, '..');
const APK = join(AQUI, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const DIST = join(AQUI, 'dist');

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

if (!existsSync(APK)) {
  console.log(' FALHA o APK não existe — rode a compilação antes');
  process.exit(1);
}

const tamanhoMB = statSync(APK).size / 1024 / 1024;
check('o APK existe', true, `${tamanhoMB.toFixed(1)} MB`);
// Um instalável de acesso remoto que passa de 60 MB quase sempre carrega
// alguma coisa que ninguém percebeu que entrou.
check('o tamanho é razoável para um aplicativo de celular', tamanhoMB < 60, `${tamanhoMB.toFixed(1)} MB`);

// ─────────────── o conteúdo web dentro do APK ───────────────

/**
 * Leitor de zip mínimo.
 *
 * O APK é um zip, e a tentação é chamar o `tar` do Windows. Ele recusa este
 * arquivo — e uma ferramenta externa que falha por motivo obscuro é péssima
 * base para um teste: não dá para distinguir "o APK está errado" de "o tar não
 * gostou". Ler o formato aqui tira essa ambiguidade e não depende de nada
 * instalado na máquina.
 *
 * Formato: ZIP APPNOTE, seções 4.3.6 (registro local), 4.3.12 (diretório
 * central) e 4.3.16 (fim do diretório central).
 */
function lerZip(caminho) {
  const buf = readFileSync(caminho);

  // O fim do diretório central fica no rim do arquivo, depois de um comentário
  // de tamanho variável — por isso a busca de trás para frente.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65_535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('não é um zip válido: fim do diretório não encontrado');

  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const arquivos = new Map();

  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('diretório central corrompido');
    const metodo = buf.readUInt16LE(p + 10);
    const tamComprimido = buf.readUInt32LE(p + 20);
    const tamNome = buf.readUInt16LE(p + 28);
    const tamExtra = buf.readUInt16LE(p + 30);
    const tamComentario = buf.readUInt16LE(p + 32);
    const offsetLocal = buf.readUInt32LE(p + 42);
    const nome = buf.subarray(p + 46, p + 46 + tamNome).toString('utf8');

    // O registro local tem os próprios campos de nome e extra, que podem ter
    // tamanhos diferentes dos do diretório central. Ler daqui é o único jeito
    // de achar onde os dados começam de verdade.
    const nomeLocal = buf.readUInt16LE(offsetLocal + 26);
    const extraLocal = buf.readUInt16LE(offsetLocal + 28);
    const inicio = offsetLocal + 30 + nomeLocal + extraLocal;
    const bruto = buf.subarray(inicio, inicio + tamComprimido);

    if (!nome.endsWith('/')) {
      arquivos.set(nome, metodo === 0 ? bruto : inflateRawSync(bruto));
    }
    p += 46 + tamNome + tamExtra + tamComentario;
  }
  return arquivos;
}

const dentroDoApk = lerZip(APK);
check('o APK é um pacote legível', dentroDoApk.size > 0, `${dentroDoApk.size} arquivos`);

const web = [...dentroDoApk.keys()].filter((n) => n.startsWith('assets/public/'));
check('o APK carrega os arquivos web', web.length > 0, `${web.length} arquivos`);

const resumoBytes = (b) => createHash('sha256').update(b).digest('hex');
const listar = (raiz, base = raiz) => {
  const saida = [];
  for (const nome of readdirSync(raiz)) {
    const cheio = join(raiz, nome);
    if (statSync(cheio).isDirectory()) saida.push(...listar(cheio, base));
    else saida.push(relative(base, cheio).split(sep).join('/'));
  }
  return saida;
};

const noDist = listar(DIST);
const diferentes = [];
let iguais = 0;
for (const arquivo of noDist) {
  const doApk = dentroDoApk.get(`assets/public/${arquivo}`);
  if (!doApk) {
    diferentes.push(`${arquivo} (ausente no APK)`);
    continue;
  }
  if (resumoBytes(readFileSync(join(DIST, arquivo))) === resumoBytes(doApk)) iguais++;
  else diferentes.push(`${arquivo} (conteúdo diferente)`);
}

check('todos os arquivos testados estão no APK, idênticos',
  diferentes.length === 0 && iguais === noDist.length,
  diferentes.length ? diferentes.join('; ') : `${iguais} arquivos conferidos byte a byte`);

// Se o índice estiver certo mas o programa não, o aplicativo abre em branco.
check('o programa em si está embarcado', web.some((f) => f.endsWith('.js')));
check('a folha de estilo está embarcada', web.some((f) => f.endsWith('.css')));
check('o aplicativo está assinado', [...dentroDoApk.keys()].some((n) => n.startsWith('META-INF/')));

// ─────────────── permissões: o que o app pode fazer no celular ───────────────

const sdk = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
  : join(process.env.HOME ?? '', 'Android', 'Sdk');
const buildTools = existsSync(join(sdk, 'build-tools'))
  ? readdirSync(join(sdk, 'build-tools')).sort().pop()
  : null;

if (!buildTools) {
  console.log('  --   ferramentas do Android ausentes; permissões não conferidas');
} else {
  const aapt = join(sdk, 'build-tools', buildTools, 'aapt.exe');
  const info = execFileSync(aapt, ['dump', 'badging', APK], { encoding: 'utf8' });

  const permissoes = [...info.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1]);
  const proprias = permissoes.filter((p) => !p.startsWith('br.com.ryke.desk.'));

  check('o pacote tem o identificador certo', /package: name='br\.com\.ryke\.desk'/.test(info));
  check('o nome exibido é Ryke Desk', /application-label:'Ryke Desk'/.test(info));

  // O ponto que mais importa neste aplicativo. Ele é SOMENTE visitante: não
  // captura tela, não grava áudio, não lê arquivos. A lista de permissões é a
  // prova disso que o próprio Android mostra ao usuário na instalação.
  check('pede apenas acesso à internet',
    proprias.length === 1 && proprias[0] === 'android.permission.INTERNET',
    proprias.join(', ') || 'nenhuma');

  for (const proibida of [
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.READ_CONTACTS',
    'android.permission.SYSTEM_ALERT_WINDOW',
  ]) {
    check(`não pede ${proibida.split('.').pop()}`, !permissoes.includes(proibida));
  }

  const alvo = /targetSdkVersion:'(\d+)'/.exec(info)?.[1];
  // A Play Store exige alvo recente; 34 é o piso desde 2024.
  check('mira uma versão recente do Android', Number(alvo) >= 34, `targetSdk ${alvo}`);
}

console.log(falhas === 0 ? '\nAPK confere com o que foi testado.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
