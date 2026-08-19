/**
 * Repara pontuação perdida numa conversão de codificação malfeita.
 *
 * Quando bytes UTF-8 são reinterpretados pela tabela Latin-1 (em vez da
 * Windows-1252), os caracteres da faixa 0x80–0x9F — travessão, reticências,
 * aspas curvas, linhas de moldura — não existem no destino e viram o caractere
 * de substituição U+FFFD. O texto ao redor sobrevive; só essa pontuação se
 * perde, sempre no mesmo padrão.
 *
 * Este script desfaz exatamente esses padrões. É de uso pontual, não faz parte
 * do build.
 *
 *   node build/reparar-pontuacao.mjs test/e2e.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const R = '�'; // caractere de substituição

/** Ordem importa: os padrões mais longos primeiro. */
const TROCAS = [
  [`${R}?"`, '—'],      // travessão —
  [`${R}"?`, '─'],      // linha de moldura ─
  [`${R}?'`, '→'],      // seta →
  [`${R}?${R}`, '…'],   // reticências …
  [`${R}.${R}`, '═'],   // moldura dupla ═
  [`N${R}fO`, 'NÃO'],   // NÃO
  [`${R}?`, 'É'],       // É (o que sobrar)
];

const arquivo = process.argv[2];
if (!arquivo) {
  console.error('uso: node build/reparar-pontuacao.mjs <arquivo>');
  process.exit(1);
}

let texto = readFileSync(arquivo, 'utf8');
const antes = (texto.match(new RegExp(R, 'g')) ?? []).length;

for (const [de, para] of TROCAS) {
  texto = texto.split(de).join(para);
}

const depois = (texto.match(new RegExp(R, 'g')) ?? []).length;
writeFileSync(arquivo, texto, 'utf8');

console.log(`${arquivo}: ${antes} caracteres perdidos -> ${depois} restantes`);
process.exit(depois === 0 ? 0 : 1);
