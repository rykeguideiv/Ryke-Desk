import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Endereço do servidor público, gravado no binário na hora de compilar:
 *
 *   set RYKE_SERVIDOR=wss://ryke.seudominio.com.br && npm run dist
 *
 * É isto que faz o programa instalado no Ceará achar o de São Paulo sem
 * ninguém digitar endereço nenhum. Sem esta variável o app nasce em modo rede
 * local (descoberta por difusão UDP), que só serve para o mesmo escritório.
 */
const SERVIDOR_PADRAO = JSON.stringify(process.env.RYKE_SERVIDOR ?? '');

export default defineConfig({
  main: {
    // koffi e ws carregam binários/protocolos por caminho — ficam fora do bundle.
    // O servidor embutido (src/servidor/*.js) é bundlado junto do main.
    plugins: [externalizeDepsPlugin()],
    define: { __RYKE_SERVIDOR__: SERVIDOR_PADRAO },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: { __RYKE_SERVIDOR__: SERVIDOR_PADRAO },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // Ponte separada, e mínima, da camada de setas. Ver src/preload/ponteiros.ts.
          ponteiros: resolve(__dirname, 'src/preload/ponteiros.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') },
    },
    plugins: [react()],
    define: { __RYKE_SERVIDOR__: SERVIDOR_PADRAO },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // A camada transparente de setas que fica por cima da tela do
          // anfitrião — janela própria, página própria, sem React.
          ponteiros: resolve(__dirname, 'src/renderer/ponteiros.html'),
        },
      },
    },
  },
});
