/// <reference types="vite/client" />

// O Vite transforma imports de imagem na URL do asset empacotado.
declare module '*.png' {
  const src: string;
  export default src;
}
