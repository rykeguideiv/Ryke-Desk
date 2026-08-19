/**
 * Exercita o módulo de disco: sanitização de nomes vindos da rede, ciclo
 * completo de envio+recebimento e as travas contra abuso.
 *
 *   node test/transfers.test.mjs
 */
import { Transfers, sanitizeFileName } from '../src/main/transfers.ts';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const raiz = mkdtempSync(join(tmpdir(), 'ryke-test-'));
const destino = join(raiz, 'recebidos');
const origem = join(raiz, 'origem');
import { mkdirSync } from 'node:fs';
mkdirSync(origem, { recursive: true });

// ── sanitização: o nome vem da rede, portanto é hostil até prova em contrário ──
check('remove travessia de diretório',
  sanitizeFileName('..\\..\\Windows\\System32\\evil.dll') === 'evil.dll');
check('remove travessia com barra normal',
  sanitizeFileName('../../etc/passwd') === 'passwd');
check('preserva espaços e acentos',
  sanitizeFileName('Relatório final 2026.pdf') === 'Relatório final 2026.pdf');
check('troca caracteres proibidos do Windows',
  sanitizeFileName('nota:fiscal|"?.txt') === 'nota_fiscal___.txt');
check('protege nomes reservados de dispositivo',
  sanitizeFileName('CON.txt') === '_CON.txt');
check('nome vazio vira algo utilizável', sanitizeFileName('   ') === 'arquivo');
check('nome só com pontos vira algo utilizável', sanitizeFileName('...') === 'arquivo');
check('corta nome absurdamente longo mantendo a extensão', (() => {
  const out = sanitizeFileName('a'.repeat(500) + '.png');
  return out.length <= 200 && out.endsWith('.png');
})());

// ── ciclo completo: enviar um arquivo de verdade e recebê-lo do outro lado ──
const conteudo = randomBytes(700 * 1024); // 700 KB, vários blocos
const arquivoOrigem = join(origem, 'Relatório final.pdf');
writeFileSync(arquivoOrigem, conteudo);

const remetente = new Transfers(destino);
const receptor = new Transfers(destino);

const enviado = await remetente.openForSend(arquivoOrigem);
check('abre o arquivo para envio com nome e tamanho corretos',
  enviado.name === 'Relatório final.pdf' && enviado.size === conteudo.length);

const { path: caminhoDestino } = await receptor.begin('t1', enviado.name, enviado.size);
check('destino fica dentro da pasta de downloads', dirname(caminhoDestino) === destino);

const CHUNK = 16 * 1024;
let offset = 0;
while (offset < enviado.size) {
  const bloco = await remetente.readSlice(enviado.id, offset, CHUNK);
  if (bloco.length === 0) break;
  await receptor.write('t1', bloco);
  offset += bloco.length;
}
const final = await receptor.finish('t1');
await remetente.closeSend(enviado.id);

check('transferiu o total de bytes', final.size === conteudo.length);
check('conteúdo chegou byte a byte idêntico', readFileSync(final.path).equals(conteudo));

// ── colisão de nome não sobrescreve o arquivo anterior ──
await receptor.begin('t2', 'Relatório final.pdf', 10);
await receptor.write('t2', Buffer.alloc(10, 7));
const segundo = await receptor.finish('t2');
check('segundo arquivo de mesmo nome ganha sufixo',
  basename(segundo.path) === 'Relatório final (2).pdf' && readFileSync(final.path).equals(conteudo));

// ── travas ──
let recusou = false;
try {
  await receptor.begin('t3', 'gigante.bin', 600 * 1024 * 1024);
} catch (err) {
  recusou = /500 MB/.test(err.message);
}
check('recusa arquivo acima de 500 MB', recusou);

// Remetente mentiroso: anuncia 10 bytes e tenta despejar 5000.
await receptor.begin('t4', 'mentiroso.bin', 10);
let cortou = false;
try {
  await receptor.write('t4', Buffer.alloc(5000));
} catch {
  cortou = true;
}
check('corta remetente que envia mais que o anunciado', cortou);
check('arquivo parcial do remetente mentiroso foi apagado',
  !readdirSync(destino).some((f) => f.startsWith('mentiroso')));

// Arquivo que chega pela metade não deve ficar salvo.
await receptor.begin('t5', 'incompleto.bin', 1000);
await receptor.write('t5', Buffer.alloc(400));
let detectou = false;
let caminhoIncompleto = null;
try {
  await receptor.finish('t5');
} catch (err) {
  detectou = /incompleto/.test(err.message);
  caminhoIncompleto = join(destino, 'incompleto.bin');
}
check('detecta arquivo incompleto', detectou);
check('apaga o arquivo incompleto', caminhoIncompleto && !existsSync(caminhoIncompleto));

// Cancelamento no meio não deixa sobras.
await receptor.begin('t6', 'cancelado.bin', 5000);
await receptor.write('t6', Buffer.alloc(1000));
await receptor.abort('t6', 'usuário cancelou');
check('cancelamento não deixa arquivo parcial', !existsSync(join(destino, 'cancelado.bin')));

// Um nome com travessia realmente grava dentro da pasta certa.
const { path: seguro } = await receptor.begin('t7', '..\\..\\..\\evil.exe', 4);
await receptor.write('t7', Buffer.alloc(4));
await receptor.finish('t7');
check('nome com travessia grava dentro da pasta de downloads',
  dirname(seguro) === destino && basename(seguro) === 'evil.exe');

// Pasta não é arquivo.
let rejeitouPasta = false;
try {
  await remetente.openForSend(origem);
} catch {
  rejeitouPasta = true;
}
check('recusa enviar uma pasta', rejeitouPasta);

await receptor.closeAll();
await remetente.closeAll();
rmSync(raiz, { recursive: true, force: true });

console.log(failures === 0 ? '\nTransferência de arquivos validada.\n' : `\n${failures} falha(s).\n`);
process.exit(failures === 0 ? 0 : 1);
