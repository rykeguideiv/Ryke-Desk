/// <reference types="vite/client" />

// O Vite transforma imports de imagem na URL do asset empacotado.
declare module '*.png' {
  const src: string;
  export default src;
}

/**
 * A ponte da camada de setas (ver src/preload/ponteiros.ts).
 *
 * Fica separada de `window.ryke` de propósito: a camada é uma janela que cobre
 * a tela inteira e só precisa desenhar. Dar a ela a ponte completa seria
 * entregar disco, área de transferência e injeção de teclado a uma página cujo
 * trabalho inteiro é posicionar quatro elementos.
 */
declare global {
  interface Window {
    rykePonteiros: {
      on: (fn: (lista: import('../../shared/ponteiros').Ponteiro[]) => void) => void;
    };
  }
}

export {};
