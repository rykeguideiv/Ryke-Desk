/**
 * Compila o APK e deixa uma cópia num lugar óbvio.
 *
 * Duas coisas que este script resolve e que custaram tempo para descobrir:
 *
 *   1. `local.properties` é um arquivo .properties do Java, onde a barra
 *      invertida é ESCAPE. Escrever o caminho do SDK no formato do Windows
 *      (C:\Users\...) faz o Java ler "C:UsersRykeBR..." e o Gradle falha com
 *      "a sintaxe do nome do arquivo está incorreta" — uma mensagem que não
 *      aponta para o arquivo culpado. Barras normais resolvem.
 *
 *   2. O JDK vem dentro do Android Studio (pasta `jbr`). Não é preciso
 *      instalar Java à parte, mas o Gradle precisa saber onde ele está.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const AQUI = resolve(import.meta.dirname, '..');
const ANDROID = join(AQUI, 'android');

const sdk = join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');

/**
 * Escolhe um JDK que o Gradle deste projeto aceite RODAR.
 *
 * O JDK vem dentro do Android Studio (pasta `jbr`), mas as versões novas do
 * Studio trazem um JDK muito à frente (25+) do que o Gradle 8.11.1 sabe usar —
 * o Gradle só roda em Java 8 a 23 e simplesmente se recusa a iniciar num JDK
 * mais novo, com uma mensagem que não diz que o problema é a versão. Então:
 * preferimos um JDK 17–23 quando existir (o do `JAVA_HOME`, ou um Temurin
 * instalado à parte), e só caímos no `jbr` se for a única opção.
 */
function versaoMajor(dir) {
  try {
    const m = /JAVA_VERSION="?(\d+)/.exec(readFileSync(join(dir, 'release'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function temurinsInstalados() {
  const base = 'C:/Program Files/Eclipse Adoptium';
  try {
    return readdirSync(base).map((d) => join(base, d));
  } catch {
    return [];
  }
}

function escolherJdk() {
  const candidatos = [
    process.env.JAVA_HOME,
    ...temurinsInstalados(),
    'C:/Program Files/Android/Android Studio/jbr',
  ].filter((d) => d && existsSync(join(d, 'bin', 'java.exe')));

  let reserva = null;
  for (const dir of candidatos) {
    reserva ??= dir;
    const major = versaoMajor(dir);
    if (major !== null && major >= 17 && major <= 23) return dir;
  }
  return reserva;
}

const jdk = escolherJdk();

if (!existsSync(sdk)) {
  console.error(`SDK do Android não encontrado em ${sdk}`);
  process.exit(1);
}
if (!jdk) {
  console.error('Nenhum JDK encontrado (instale o Android Studio ou um JDK 17–21).');
  process.exit(1);
}
console.log(`usando JDK: ${jdk} (Java ${versaoMajor(jdk) ?? '?'})`);

// Barras normais: ver o comentário no topo.
writeFileSync(join(ANDROID, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '/')}\n`);

console.log('compilando o APK…');
// Via cmd, e com o caminho relativo: o Node recusa executar .bat diretamente
// desde a correção da CVE-2024-27980 (falha com EINVAL), e o caminho absoluto
// deste projeto tem um espaço no meio, que o interpretador de comandos
// quebraria em dois argumentos. Rodar de dentro da pasta resolve os dois.
execFileSync(process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', '.\\gradlew.bat assembleDebug --no-daemon'], {
  cwd: ANDROID,
  stdio: 'inherit',
  env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk, ELECTRON_RUN_AS_NODE: '' },
});

const gerado = join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const destino = join(AQUI, 'release');
mkdirSync(destino, { recursive: true });
copyFileSync(gerado, join(destino, 'RykeDesk-Mobile.apk'));
console.log(`\nAPK pronto: ${join(destino, 'RykeDesk-Mobile.apk')}`);
