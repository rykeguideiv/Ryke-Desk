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
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const AQUI = resolve(import.meta.dirname, '..');
const ANDROID = join(AQUI, 'android');

const sdk = join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const jdk = 'C:/Program Files/Android/Android Studio/jbr';

if (!existsSync(sdk)) {
  console.error(`SDK do Android não encontrado em ${sdk}`);
  process.exit(1);
}
if (!existsSync(jdk)) {
  console.error(`JDK não encontrado em ${jdk} (instale o Android Studio)`);
  process.exit(1);
}

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
