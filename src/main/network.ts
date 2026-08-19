/**
 * Informações de rede do computador.
 *
 * O Ryke Desk trabalha sempre pela internet, e sem servidor: os dois
 * computadores se encontram numa malha de corretores públicos de mensagens
 * (ver `src/shared/malha.ts`), esteja cada um em que cidade estiver. Não
 * existe modo "rede local" — descoberta por difusão UDP não atravessa
 * roteador e só serviria para o mesmo escritório, que não é o caso de uso
 * deste programa.
 *
 * O que sobrou aqui é puramente informativo: o IP local aparece na tela de
 * diagnóstico e não participa de nenhuma decisão de conexão.
 */
import { networkInterfaces } from 'node:os';

/** IP desta máquina na rede local. Só informativo, para diagnóstico. */
export function ipLocal(): string {
  const candidatos: string[] = [];
  for (const enderecos of Object.values(networkInterfaces())) {
    for (const endereco of enderecos ?? []) {
      if (endereco.family !== 'IPv4' || endereco.internal) continue;
      if (endereco.address.startsWith('169.254.')) continue; // "sem rede" do Windows
      candidatos.push(endereco.address);
    }
  }
  candidatos.sort((a, b) => pontuar(b) - pontuar(a));
  return candidatos[0] ?? '127.0.0.1';
}

function pontuar(ip: string): number {
  if (ip.startsWith('192.168.')) return 3;
  if (ip.startsWith('10.')) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
  return 0;
}
