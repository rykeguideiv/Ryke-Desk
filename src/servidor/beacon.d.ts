/** Tipos do farol de descoberta (a implementação é JavaScript puro). */

export const PORTA_FAROL: number;

export type ServidorDescoberto = { endereco: string; porta: number; desde: number };

export function iniciarFarol(
  portaServidor: number,
  desde?: number,
  log?: (texto: string) => void,
): { close: () => void };

export function procurarServidores(esperaMs?: number): Promise<ServidorDescoberto[]>;

export function escolherServidor(servidores: ServidorDescoberto[]): ServidorDescoberto | null;
