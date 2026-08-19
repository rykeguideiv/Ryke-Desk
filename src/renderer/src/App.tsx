import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Controller } from './lib/controller';
import { TitleBar } from './components/TitleBar';
import { Home } from './components/Home';
import { Viewer } from './components/Viewer';
import { Dialing, IncomingRequest, SettingsModal, PasswordModal, IdentityAlert } from './components/Modals';
import { Toasts } from './components/Feedback';
import { fundoUrl } from './assets';

/**
 * Raiz da interface.
 *
 * O aplicativo tem duas telas e nada mais: a inicial (número, senha, campo
 * para conectar) e o visualizador em tela cheia. Tudo o mais aparece por
 * cima, como sobreposição — o que mantém o caminho principal curto.
 */

// Um controlador por processo, criado fora do React para sobreviver a
// qualquer re-renderização.
const controller = new Controller();

export function App(): React.JSX.Element {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [showSettings, setShowSettings] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void controller.boot();
    return () => controller.dispose();
  }, []);

  /**
   * O visualizador aparece quando QUALQUER aba está conectada.
   *
   * Antes bastava olhar "a" conexão. Com abas, abrir a segunda deixaria a
   * primeira no ar mas devolveria a janela à tela inicial enquanto a nova
   * disca — apagando a sessão que a pessoa está usando naquele instante.
   */
  const connected = state.abas.some((aba) => aba.phase === 'conectado');
  /** A primeira conexão ainda usa a tela de discagem; as seguintes discam na aba. */
  const discandoSozinho = !connected && state.outgoing !== null && state.outgoing.phase !== 'conectado';

  /**
   * Esc minimiza o programa, esteja em que tela estiver.
   *
   * Dentro da sessão quem trata é o visualizador, que antes de sumir precisa
   * soltar as teclas pressionadas e sair da tela cheia. Fora dela, é aqui.
   *
   * Inclusive em campos de texto: Esc é sempre a saída imediata pedida pelo
   * usuário e tem prioridade sobre qualquer controle da interface.
   */
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape' || connected) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      window.ryke.window.minimize();
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [connected]);
  // As duas perguntas iniciais têm de ser respondidas antes de qualquer coisa.

  return (
    <div className="app">
      {/* Fundo da marca, discreto: fica atrás de tudo e some no visualizador,
          onde a tela remota precisa de contraste total. */}
      {!connected && (
        <div className="app-fundo" style={{ backgroundImage: `url(${fundoUrl})` }} aria-hidden="true" />
      )}
      {!connected && <TitleBar />}

      {connected ? (
        <Viewer controller={controller} state={state} />
      ) : (
        <Home
          controller={controller}
          state={state}
          onOpenSettings={() => setShowSettings(true)}
          onOpenPassword={() => setShowPassword(true)}
        />
      )}

      {/* Vem antes de tudo: se a identidade de um número mudou, nenhuma outra
          decisão faz sentido antes de o usuário resolver esta. */}
      {state.identidadeSuspeita && (
        <IdentityAlert
          suspeita={state.identidadeSuspeita}
          onConfiar={() => void controller.confiarNovaIdentidade()}
          onFechar={() => controller.descartarAvisoDeIdentidade()}
        />
      )}

      {discandoSozinho && state.outgoing && (
        <Dialing outgoing={state.outgoing} onCancel={() => controller.disconnect()} />
      )}

      {state.incoming?.phase === 'pedindo' && (
        <IncomingRequest
          peerId={state.incoming.peerId}
          modo={state.incoming.modo}
          onApprove={() => controller.approveIncoming()}
          onDeny={() => controller.denyIncoming()}
        />
      )}

      {showSettings && state.settings && (
        <SettingsModal controller={controller} state={state} onClose={() => setShowSettings(false)} />
      )}

      {showPassword && (
        <PasswordModal
          defined={state.hasPassword}
          onSave={async (senha) => {
            await controller.setPassword(senha);
            setShowPassword(false);
          }}
          onClose={() => setShowPassword(false)}
        />
      )}

      <Toasts toasts={state.toasts} onDismiss={(id) => controller.dismissToast(id)} />
    </div>
  );
}
