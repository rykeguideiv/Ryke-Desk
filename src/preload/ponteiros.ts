/**
 * Ponte da camada de setas — deliberadamente minúscula.
 *
 * A camada é uma janela que fica sempre por cima da tela inteira. Dar a ela a
 * mesma ponte da interface principal seria entregar disco, área de
 * transferência e injeção de teclado a uma página que só precisa desenhar
 * setas. Aqui ela recebe exatamente uma coisa: a lista de posições.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { Ponteiro } from '../shared/ponteiros';

contextBridge.exposeInMainWorld('rykePonteiros', {
  on: (fn: (lista: Ponteiro[]) => void) => {
    ipcRenderer.on('ponteiros:desenhar', (_e, lista: Ponteiro[]) => fn(lista));
  },
});
