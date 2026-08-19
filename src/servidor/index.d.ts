/** Tipos do servidor embutido (a implementação é JavaScript puro). */

export type ServidorIce = { urls: string | string[]; username?: string; credential?: string };

export type ServidorVivo = {
  porta: number;
  parar: () => Promise<void>;
  online: () => number;
};

export function iniciarServidor(opcoes: {
  porta?: number;
  host?: string;
  arquivoDados: string;
  iceServers?: ServidorIce[];
  farol?: boolean;
  log?: (texto: string) => void;
}): Promise<ServidorVivo>;
