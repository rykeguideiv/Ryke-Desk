import { useState } from 'react';
import type { Papel } from '../../../shared/config';
import { IconMonitor, IconSend, IconShield } from './icons';
import { logoUrl } from '../assets';

/**
 * Primeira tela, obrigatória, com as duas perguntas que definem o papel deste
 * computador na conexão. Aparece só enquanto o papel ainda não foi escolhido;
 * depois some para sempre (dá para trocar em Ajustes).
 *
 * Por baixo, os dois caminhos fazem a mesma coisa: entrar na malha de
 * encontro. A escolha muda só o que a tela destaca — o número para passar
 * adiante, ou o campo para digitar o número de alguém. Duas perguntas de
 * sim/não resolvem isso sem obrigar ninguém a entender uma tela de ajustes.
 */
export function Welcome({
  onEscolher,
  machineName,
}: {
  onEscolher: (papel: Papel) => Promise<void>;
  machineName: string;
}): React.JSX.Element {
  const [ocupado, setOcupado] = useState<Papel>(null);

  const escolher = async (papel: Exclude<Papel, null>): Promise<void> => {
    if (ocupado) return;
    setOcupado(papel);
    await onEscolher(papel);
    // Se algo falhar, o App volta a mostrar esta tela; liberamos o botão.
    setOcupado(null);
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-head">
          <img className="welcome-logo" src={logoUrl} alt="Ryke Desk" draggable={false} />
          <p>
            Antes de começar, escolha o que este computador — <strong>{machineName}</strong> — vai fazer. Você pode
            trocar depois nos Ajustes.
          </p>
        </div>

        <div className="welcome-cards">
          <button
            className="welcome-card"
            onClick={() => void escolher('receber')}
            disabled={ocupado !== null}
          >
            <span className="welcome-icon receber">
              <IconMonitor width={26} height={26} />
            </span>
            <strong>Este PC vai receber conexão</strong>
            <span className="welcome-desc">
              Alguém vai acessar este computador. Vou preparar tudo automaticamente e deixá-lo pronto para receber.
            </span>
            <span className="welcome-nota">
              <IconShield width={13} height={13} />
              Fica disponível para acesso de qualquer lugar
            </span>
            {ocupado === 'receber' && <span className="welcome-load">Preparando…</span>}
          </button>

          <button
            className="welcome-card"
            onClick={() => void escolher('conectar')}
            disabled={ocupado !== null}
          >
            <span className="welcome-icon conectar">
              <IconSend width={24} height={24} />
            </span>
            <strong>Vou conectar em outro PC</strong>
            <span className="welcome-desc">
              Você vai acessar outro computador a partir daqui. Basta o número de quem vai receber.
            </span>
            <span className="welcome-nota">
              <IconSend width={13} height={13} />
              Alcança computadores em qualquer cidade
            </span>
            {ocupado === 'conectar' && <span className="welcome-load">Preparando…</span>}
          </button>
        </div>

        <p className="welcome-rodape">
          Funciona entre cidades diferentes, sem cadastro e sem configurar nada. Os dois computadores conversam
          diretamente entre si, com a imagem e o teclado criptografados de ponta a ponta.
        </p>
      </div>
    </div>
  );
}
