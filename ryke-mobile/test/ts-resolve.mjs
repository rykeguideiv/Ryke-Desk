/**
 * Deixa o Node executar os módulos do processo principal diretamente, sem
 * passo de build: resolve imports sem extensão (`../shared/protocol`) para o
 * arquivo .ts correspondente, do mesmo jeito que o electron-vite faz.
 *
 * Uso: node --import ./test/ts-resolve.mjs test/algum.test.mjs
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATOS = ['.ts', '.tsx', '/index.ts'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relativo = specifier.startsWith('./') || specifier.startsWith('../');
    const semExtensao = !/\.[cm]?[jt]sx?$/i.test(specifier);
    if (relativo && semExtensao && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      for (const ext of CANDIDATOS) {
        const tentativa = new URL(base.href + ext);
        if (existsSync(fileURLToPath(tentativa))) {
          return nextResolve(tentativa.href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
