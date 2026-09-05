/**
 * Igual ao ts-resolve, mais um `electron` de mentira — o suficiente para
 * carregar `src/main/input.ts` fora do Electron e exercitar o código de
 * verdade, em vez de uma cópia dele.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const CANDIDATOS = ['.ts', '.tsx', '/index.ts'];
const STUB = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'electron-de-mentira.mjs')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: STUB, shortCircuit: true };
    const relativo = specifier.startsWith('./') || specifier.startsWith('../');
    const semExtensao = !/\.[cm]?[jt]sx?$/i.test(specifier);
    if (relativo && semExtensao && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      for (const ext of CANDIDATOS) {
        const tentativa = new URL(base.href + ext);
        if (existsSync(fileURLToPath(tentativa))) return nextResolve(tentativa.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
