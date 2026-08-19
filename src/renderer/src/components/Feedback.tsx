import type { Toast } from '../lib/controller';
import { IconX, IconSend } from './icons';

/** Avisos empilhados no canto — some sozinho, erro fica mais tempo. */
export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }): React.JSX.Element {
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          <span style={{ flex: 1 }}>{toast.text}</span>
          <button onClick={() => onDismiss(toast.id)} aria-label="Dispensar">
            <IconX width={13} height={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Copiou um arquivo no Explorador com a sessão aberta? Este aviso oferece
 * mandá-lo para o outro computador.
 *
 * O envio é sempre por clique, nunca automático: o programa vê tudo o que
 * você copia enquanto a sessão está de pé, e mandar isso sozinho para a
 * outra máquina seria um vazamento, não uma comodidade.
 */
export function ClipboardOffer({
  path,
  onSend,
  onDismiss,
}: {
  path: string;
  onSend: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const nome = path.split(/[\\/]/).pop() ?? path;

  return (
    <div className="clip-offer">
      <span style={{ color: 'var(--text-dim)' }}>Copiado:</span>
      <span className="name" title={path}>
        {nome}
      </span>
      <button className="btn primary sm" onClick={onSend}>
        <IconSend width={13} height={13} />
        Enviar para o outro PC
      </button>
      <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onDismiss} aria-label="Dispensar">
        <IconX width={13} height={13} />
      </button>
    </div>
  );
}
