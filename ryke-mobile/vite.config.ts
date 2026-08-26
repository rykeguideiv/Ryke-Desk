import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * O Capacitor serve estes arquivos de dentro do APK, e não de um servidor.
 * Caminhos precisam ser relativos — absolutos apontariam para a raiz do
 * esquema do Android e não achariam nada.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
});
