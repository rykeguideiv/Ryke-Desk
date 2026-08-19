/**
 * Gera o ícone do aplicativo (build/icon.ico) a partir do logo oficial
 * (build/logo-original.png), sem dependências externas.
 *
 * Usa o próprio Chromium do Electron para rasterizar o PNG nos vários tamanhos
 * que o Windows pede e monta o cabeçalho ICO à mão (é só um diretório de PNGs
 * embutidos). Rodar via electron:
 *
 *   electron build/make-icon.mjs
 */
import { app, nativeImage } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

await app.whenReady();

const TAMANHOS = [16, 24, 32, 48, 64, 128, 256];
// A pasta build é onde este próprio script vive — independe de como o Electron
// foi invocado.
const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const original = nativeImage.createFromBuffer(readFileSync(join(raiz, 'build', 'logo-original.png')));

/** Redimensiona o logo para um tamanho e devolve o PNG. */
function emTamanho(tamanho) {
  return original.resize({ width: tamanho, height: tamanho, quality: 'best' }).toPNG();
}

/** Empacota vários PNGs num arquivo .ico (ICONDIR + PNGs embutidos). */
function montarIco(imagens) {
  const contagem = imagens.length;
  const cabecalho = Buffer.alloc(6);
  cabecalho.writeUInt16LE(0, 0); // reservado
  cabecalho.writeUInt16LE(1, 2); // tipo 1 = ícone
  cabecalho.writeUInt16LE(contagem, 4);

  const entradas = [];
  const dados = [];
  let deslocamento = 6 + contagem * 16;

  for (const { tamanho, png } of imagens) {
    const entrada = Buffer.alloc(16);
    entrada.writeUInt8(tamanho >= 256 ? 0 : tamanho, 0); // largura (0 = 256)
    entrada.writeUInt8(tamanho >= 256 ? 0 : tamanho, 1); // altura
    entrada.writeUInt8(0, 2);
    entrada.writeUInt8(0, 3);
    entrada.writeUInt16LE(1, 4); // planos de cor
    entrada.writeUInt16LE(32, 6); // bits por pixel
    entrada.writeUInt32LE(png.length, 8);
    entrada.writeUInt32LE(deslocamento, 12);
    deslocamento += png.length;
    entradas.push(entrada);
    dados.push(png);
  }

  return Buffer.concat([cabecalho, ...entradas, ...dados]);
}

const imagens = TAMANHOS.map((tamanho) => ({ tamanho, png: emTamanho(tamanho) }));
writeFileSync(join(raiz, 'build', 'icon.ico'), montarIco(imagens));
writeFileSync(join(raiz, 'build', 'icon.png'), emTamanho(256));

console.log(`ícone gerado a partir do logo oficial (${TAMANHOS.length} tamanhos)`);
// Encerra o processo do Electron sem depender de app.quit() (que às vezes
// trava quando não há janela aberta neste modo de script).
process.exit(0);
