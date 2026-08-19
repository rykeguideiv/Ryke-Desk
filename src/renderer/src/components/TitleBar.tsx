import { useEffect, useState } from 'react';
import { IconMinus, IconSquare, IconClose } from './icons';
import { logoUrl } from '../assets';

/**
 * Barra de título própria — a janela é sem moldura para o visualizador poder
 * ocupar a tela inteira sem uma faixa cinza do Windows por cima do conteúdo.
 * A área arrastável vem do CSS (`-webkit-app-region: drag`).
 */
export function TitleBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.ryke.window.state().then((s) => setMaximized(s.maximized));
    return window.ryke.window.onState((s) => setMaximized(s.maximized));
  }, []);

  return (
    <div className="titlebar">
      <div className="brand">
        <img className="brand-logo" src={logoUrl} alt="Ryke Desk" draggable={false} />
      </div>
      <div className="spacer" />
      <div className="win-controls">
        <button onClick={() => window.ryke.window.minimize()} title="Minimizar" aria-label="Minimizar">
          <IconMinus />
        </button>
        <button
          onClick={() => window.ryke.window.toggleMaximize()}
          title={maximized ? 'Restaurar' : 'Maximizar'}
          aria-label={maximized ? 'Restaurar' : 'Maximizar'}
        >
          <IconSquare />
        </button>
        <button className="close" onClick={() => window.ryke.window.close()} title="Fechar" aria-label="Fechar">
          <IconClose />
        </button>
      </div>
    </div>
  );
}
