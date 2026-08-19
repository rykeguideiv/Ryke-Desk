import { useEffect, useState } from 'react';
import { formatId, type ModoAcesso } from '../../../shared/protocol';
import { SEGUNDOS_PARA_APROVAR, type Controller, type Outgoing, type State } from '../lib/controller';
import { IconEye, IconEyeOff, IconShield, IconFolder, IconAlert, IconBell } from './icons';
import { DIGITOS_NUMERO } from '../../../shared/encontro';

// ─────────────────────── discando / conectando ────────────────────

/** As etapas visíveis mudam conforme o caminho escolhido pelo visitante. */
function etapasDe(modo: Outgoing['modo']): { fase: Outgoing['phase']; texto: string }[] {
  if (modo === 'pedido') {
    return [
      { fase: 'discando', texto: 'Procurando o computador…' },
      { fase: 'aguardando-autorizacao', texto: 'Pedido enviado. Aguardando alguém permitir do outro lado…' },
      { fase: 'negociando', texto: 'Autorizado! Abrindo o caminho direto entre os dois…' },
    ];
  }
  return [
    { fase: 'discando', texto: 'Procurando o computador…' },
    { fase: 'autenticando', texto: 'Conferindo a senha…' },
    { fase: 'negociando', texto: 'Abrindo o caminho direto entre os dois…' },
  ];
}

export function Dialing({ outgoing, onCancel }: { outgoing: Outgoing; onCancel: () => void }): React.JSX.Element {
  const etapas = etapasDe(outgoing.modo);
  const indice = etapas.findIndex((e) => e.fase === outgoing.phase);
  const esperandoPessoa = outgoing.phase === 'aguardando-autorizacao';

  return (
    <div className="dialing">
      <div className="dialing-box">
        <div className="spinner" />
        <div className="dialing-id">{formatId(outgoing.peerId)}</div>
        <div className="dialing-phase">{etapas[indice]?.texto ?? 'Conectando…'}</div>
        {esperandoPessoa && (
          <div className="hint" style={{ maxWidth: 380, textAlign: 'center' }}>
            Peça para a pessoa olhar a tela: apareceu uma janela do Ryke Desk pedindo permissão.
          </div>
        )}
        <div className="steps">
          {etapas.map((etapa, i) => (
            <span key={etapa.fase} className={`step ${i <= indice ? 'done' : ''}`} />
          ))}
        </div>
        <button className="btn ghost" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

// ─────────────────────── abrir outra conexão ──────────────────────

/**
 * Conectar a mais um computador sem largar os que já estão abertos.
 *
 * Precisa existir como janela própria porque a tela inicial — onde mora o
 * campo de conectar — some assim que a primeira sessão sobe. Sem isto, a
 * segunda aba seria inalcançável: para abri-la seria preciso encerrar a
 * primeira, que é exatamente o que as abas vieram resolver.
 *
 * É deliberadamente enxuto. Quem já está numa sessão quer digitar um número e
 * seguir; ajustar senha guardada, apelido e favoritos continua na tela
 * inicial, onde há espaço para isso.
 */
export function NovaConexao({
  controller,
  state,
  onClose,
}: {
  controller: Controller;
  state: State;
  onClose: () => void;
}): React.JSX.Element {
  const [id, setId] = useState('');
  const [senha, setSenha] = useState('');
  const numero = id.replace(/\D/g, '');
  const completo = numero.length === DIGITOS_NUMERO;
  // Já aberto em outra aba: conectar de novo só traria aquela para a frente.
  const jaAberto = state.abas.some((aba) => aba.peerId === numero);

  const conectar = (alvo = numero, senhaDele = senha): void => {
    if (alvo.length !== DIGITOS_NUMERO) return;
    void controller.connect(alvo, senhaDele);
    onClose();
  };

  /** Favorito: busca a senha guardada dele, como na tela inicial. */
  const abrirFavorito = (alvo: string): void => {
    void controller.senhaGuardada(alvo).then((guardada) => conectar(alvo, guardada ?? ''));
  };

  const disponiveis = state.favoritos.filter((f) => !state.abas.some((aba) => aba.peerId === f.numero));

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 430 }}>
        <h2>Conectar a outro computador</h2>

        <div className="field">
          <label htmlFor="nova-id">Número do computador</label>
          <input
            id="nova-id"
            className="input id-input"
            value={id}
            onChange={(e) => setId(e.target.value.replace(/\D/g, '').slice(0, DIGITOS_NUMERO).replace(/(\d{3})(?=\d)/g, '$1 '))}
            onKeyDown={(e) => e.key === 'Enter' && conectar()}
            placeholder="000 000 000 000"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor="nova-senha">
            Senha <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>— em branco pede autorização</span>
          </label>
          <input
            id="nova-senha"
            className="input"
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && conectar()}
            autoComplete="off"
          />
        </div>

        {jaAberto && <div className="impedimento">Este computador já está aberto em outra aba.</div>}

        {disponiveis.length > 0 && (
          <div className="field">
            <label>Favoritos</label>
            <div className="recent-list">
              {disponiveis.map((fav) => (
                <button key={fav.numero} className="recent-chip" onClick={() => abrirFavorito(fav.numero)}>
                  <span className="recent-usar">{fav.nome}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!completo || jaAberto} onClick={() => conectar()}>
            Conectar
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────── pedido de acesso recebido ───────────────────

/**
 * Só aparece quando o anfitrião desligou a entrada automática. A senha já foi
 * conferida neste ponto — isto aqui é a segunda tranca, para quem quer olhar
 * quem está entrando antes de liberar a própria tela.
 */
export function IncomingRequest({
  peerId,
  modo,
  onApprove,
  onDeny,
}: {
  peerId: string;
  modo: ModoAcesso;
  onApprove: () => void;
  onDeny: () => void;
}): React.JSX.Element {
  const [restante, setRestante] = useState(SEGUNDOS_PARA_APROVAR);
  const semSenha = modo === 'pedido';

  useEffect(() => {
    // A janela pode estar minimizada ou atrás de tudo. Sem chamar atenção, o
    // pedido expira sem ninguém sequer saber que existiu.
    window.ryke.window.chamarAtencao();
    const timer = setInterval(() => setRestante((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
    // A contagem é só visual: quem recusa de fato ao esgotar o prazo é o
    // controlador, que também avisa o outro lado.
  }, []);

  return (
    <div className="overlay">
      <div className="modal">
        <h2>{semSenha ? 'Pedido de acesso a este computador' : 'Alguém quer acessar este computador'}</h2>
        <div className="knock-id">{formatId(peerId)}</div>

        {semSenha ? (
          <>
            <div className="aviso-forte">
              <IconAlert />
              <span>
                Este pedido chegou <strong>sem senha</strong>. Só permita se você reconhece o número acima e sabe quem
                está do outro lado.
              </span>
            </div>
            <p>
              Se você permitir, esta pessoa vai <strong>ver sua tela</strong> e poderá <strong>usar o teclado e o
              mouse</strong> deste computador até você encerrar.
            </p>
          </>
        ) : (
          <p>
            A senha de acesso foi digitada corretamente. Se você permitir, esta pessoa verá sua tela e poderá usar o
            teclado e o mouse deste computador.
          </p>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onDeny}>
            Recusar ({restante}s)
          </button>
          <button className="btn primary" onClick={onApprove}>
            Permitir acesso
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────── identidade trocada ───────────────────────

/**
 * Um número conhecido apareceu com outra identidade.
 *
 * Este é o único ponto do programa em que a decisão é genuinamente do usuário,
 * e não há como o software decidir por ele: os dois motivos possíveis produzem
 * exatamente o mesmo sinal. Ou a pessoa formatou o computador — comum, inocente
 * — ou alguém está tentando ocupar o número dela.
 *
 * Por isso a tela não tem um botão "OK" fácil. Ela diz o que aconteceu, mostra
 * as duas assinaturas para comparação, e deixa claro que confiar exige
 * confirmar por fora, num canal que o atacante não controla.
 */
export function IdentityAlert({
  suspeita,
  onConfiar,
  onFechar,
}: {
  suspeita: { numero: string; esperada: string; recebida: string };
  onConfiar: () => void;
  onFechar: () => void;
}): React.JSX.Element {
  return (
    <div className="overlay">
      <div className="modal" style={{ maxWidth: 520 }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconAlert width={20} height={20} />
          A identidade mudou
        </h2>

        <p>
          O número <strong>{formatId(suspeita.numero)}</strong> respondeu, mas o computador por trás dele não é o
          mesmo de antes. A conexão foi recusada.
        </p>

        <div className="setting-row">
          <label>Assinatura registrada</label>
          <span className="path">{suspeita.esperada}</span>
        </div>
        <div className="setting-row">
          <label>Assinatura que respondeu agora</label>
          <span className="path">{suspeita.recebida}</span>
        </div>

        <p className="hint">
          Se a pessoa formatou o computador ou reinstalou o Ryke Desk, isso é esperado. Se não foi o caso,{' '}
          <strong>alguém pode estar tentando se passar por ela</strong>.
        </p>
        <p className="hint">
          Antes de confiar, fale com ela por telefone ou mensagem — nunca por este número — e confirme se a assinatura
          acima é a que aparece nos Ajustes do computador dela.
        </p>

        <div className="modal-actions">
          <button className="btn" onClick={onFechar}>
            Cancelar
          </button>
          <button className="btn danger" onClick={onConfiar}>
            Já confirmei, confiar nesta
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────── senha de acesso ───────────────────────

export function PasswordModal({
  defined,
  onSave,
  onClose,
}: {
  defined: boolean;
  onSave: (password: string | null) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [senha, setSenha] = useState('');
  const [repetir, setRepetir] = useState('');
  const [reveal, setReveal] = useState(false);

  const curta = senha.length > 0 && senha.length < 6;
  const diferentes = repetir.length > 0 && senha !== repetir;
  const pronta = senha.length >= 6 && senha === repetir;

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>{defined ? 'Alterar a senha de acesso' : 'Definir a senha de acesso'}</h2>
        <p>
          Esta é a senha que a outra pessoa vai digitar junto com o número deste computador. Ela nunca sai daqui: o
          servidor não a recebe, e no disco fica guardada apenas de forma embaralhada.
        </p>

        <div className="field">
          <label htmlFor="nova-senha">Nova senha</label>
          <div className="input-with-action">
            <input
              id="nova-senha"
              className="input"
              type={reveal ? 'text' : 'password'}
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              placeholder="Ao menos 6 caracteres"
              autoFocus
            />
            <button onClick={() => setReveal(!reveal)} tabIndex={-1}>
              {reveal ? <IconEyeOff /> : <IconEye />}
            </button>
          </div>
          {curta && <span className="hint" style={{ color: 'var(--warn)' }}>Use ao menos 6 caracteres.</span>}
        </div>

        <div className="field">
          <label htmlFor="repetir-senha">Repita a senha</label>
          <input
            id="repetir-senha"
            className="input"
            type={reveal ? 'text' : 'password'}
            value={repetir}
            onChange={(e) => setRepetir(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && pronta && void onSave(senha)}
          />
          {diferentes && <span className="hint" style={{ color: 'var(--warn)' }}>As duas senhas não são iguais.</span>}
        </div>

        <div className="hint">
          <IconShield style={{ verticalAlign: -3, marginRight: 6 }} />
          Depois de 3 tentativas erradas, quem estiver tentando entrar passa a esperar cada vez mais entre uma
          tentativa e outra.
        </div>

        <div className="modal-actions">
          {defined && (
            <button className="btn danger" onClick={() => void onSave(null)} style={{ marginRight: 'auto' }}>
              Remover senha
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={() => void onSave(senha)} disabled={!pronta}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────── ajustes ──────────────────────────

export function SettingsModal({
  controller,
  state,
  onClose,
}: {
  controller: Controller;
  state: State;
  onClose: () => void;
}): React.JSX.Element {
  const settings = state.settings!;
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [turnUrl, setTurnUrl] = useState(settings.turnUrl);
  const [turnUser, setTurnUser] = useState(settings.turnUser);
  const [turnPass, setTurnPass] = useState(settings.turnPass);

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 540 }}>
        <h2>Ajustes</h2>

        {/* Trocar a numeração mudou de lugar: agora fica na tela inicial,
            logo abaixo do próprio número. Aqui era o lugar errado — a pessoa
            que precisa trocar está olhando para o número, não caçando ajustes. */}
        <div className="setting-row">
          <label>Numeração deste computador</label>
          <span className="path">{state.myId ? formatId(state.myId) : '…'}</span>
          <span className="hint">
            O número não muda sozinho — nem quando o programa é reinstalado por cima. Para trocá-lo, use
            “Trocar numeração” na tela inicial, embaixo do número.
          </span>
        </div>

        <div className="setting-row">
          <label>Identidade deste computador</label>
          <span className="path">{state.minhaImpressao ?? 'gerando…'}</span>
          <span className="hint">
            É a assinatura permanente desta máquina. Quem se conecta aqui guarda este código e é avisado se ele mudar —
            o que impede alguém de assumir o seu número. Se você reinstalar o Windows, ele muda, e seus contatos vão
            precisar confirmar a mudança.
          </span>
        </div>

        {/* Diagnóstico. Fica no topo dos Ajustes de propósito: é a primeira
            coisa que alguém precisa ver quando a conexão não acontece. */}
        <div className="setting-row">
          <label>Pontos de encontro alcançados</label>
          <div className="pontos-lista">
            {state.pontos.length === 0 ? (
              <span className="hint">procurando…</span>
            ) : (
              state.pontos.map((p) => (
                <span key={p.nome} className={`ponto ${p.conectado ? 'on' : 'off'}`}>
                  <span className="ponto-luz" />
                  {p.nome}
                  <span className="ponto-porta">{p.familia === 'nostr' ? '443' : 'alternativa'}</span>
                </span>
              ))
            )}
          </div>
          <span className="hint">
            {(() => {
              const vivos = state.pontos.filter((p) => p.conectado);
              const n443 = vivos.filter((p) => p.familia === 'nostr').length;
              if (vivos.length === 0) {
                return 'Nenhum ponto alcançado — este computador não está conseguindo sair para a internet.';
              }
              if (n443 === 0) {
                return `Alcançou ${vivos.length}, mas nenhum na porta 443. Se o outro computador estiver numa rede
                  restrita (empresa), pode ser que vocês não se encontrem: os dois precisam compartilhar pelo menos
                  um ponto.`;
              }
              return `Alcançou ${vivos.length} pontos, ${n443} na porta 443 — os que atravessam rede de empresa.
                Para dois computadores se acharem, basta um ponto em comum.`;
            })()}
          </span>
        </div>

        <div className="setting-row">
          <label htmlFor="server-url">Ponto de encontro próprio (opcional)</label>
          <input
            id="server-url"
            className="input"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            onBlur={() => serverUrl !== settings.serverUrl && void controller.updateSettings({ serverUrl })}
            placeholder="deixe em branco — não é necessário"
            spellCheck={false}
          />
          <span className="hint">
            <strong>Deixe vazio.</strong> O Ryke Desk encontra o outro computador sozinho, por uma rede pública de
            mensageria, sem servidor e sem cadastro. Este campo só existe para quem tem um corretor MQTT próprio e
            quer somá-lo à roda — ele entra <em>junto</em> com os públicos, nunca no lugar deles.
          </span>
        </div>

        <div className="setting-row">
          <label htmlFor="turn-url">Retransmissor para redes difíceis (opcional)</label>
          <input
            id="turn-url"
            className="input"
            value={turnUrl}
            onChange={(e) => setTurnUrl(e.target.value)}
            onBlur={() => turnUrl !== settings.turnUrl && void controller.updateSettings({ turnUrl })}
            placeholder="turn:host:3478 — deixe vazio"
            spellCheck={false}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              value={turnUser}
              onChange={(e) => setTurnUser(e.target.value)}
              onBlur={() => turnUser !== settings.turnUser && void controller.updateSettings({ turnUser })}
              placeholder="usuário"
              spellCheck={false}
            />
            <input
              className="input"
              type="password"
              value={turnPass}
              onChange={(e) => setTurnPass(e.target.value)}
              onBlur={() => turnPass !== settings.turnPass && void controller.updateSettings({ turnPass })}
              placeholder="senha"
            />
          </div>
          <span className="hint">
            <strong>Quase ninguém precisa disto.</strong> A conexão normalmente é direta entre os dois computadores.
            Mas quando <em>as duas pontas</em> usam internet com CGNAT — comum em alguns provedores —, não existe
            caminho direto possível, e só um retransmissor no meio resolve. Ele repassa o vídeo inteiro, o que custa
            banda: por isso não há nenhum gratuito embutido, e este campo fica com você.
          </span>
        </div>

        <div className="setting-row">
          <label>Pasta dos arquivos recebidos</label>
          <span className="path">{settings.downloadDir}</span>
          <button
            className="btn sm"
            style={{ alignSelf: 'flex-start', marginTop: 4 }}
            onClick={async () => {
              const dir = await window.ryke.settings.pickFolder();
              if (dir) void controller.updateSettings({ downloadDir: dir });
            }}
          >
            <IconFolder />
            Escolher outra pasta
          </button>
        </div>

        <label className="switch setting-row">
          <div className="switch-text">
            <strong>
              <IconBell style={{ verticalAlign: -2, marginRight: 6 }} />
              Aceitar pedidos sem senha
            </strong>
            <span>Um aviso aparece na tela e você decide na hora. Desligue num computador que fica sozinho.</span>
          </div>
          <input
            type="checkbox"
            checked={settings.allowSupervisedAccess}
            onChange={(e) => void controller.updateSettings({ allowSupervisedAccess: e.target.checked })}
          />
          <span className="switch-track" />
        </label>

        <label className="switch setting-row">
          <div className="switch-text">
            <strong>Compartilhar a área de transferência</strong>
            <span>
              Copiar aqui e colar lá. Atenção: com a sessão aberta, tudo o que você copiar vai para o outro
              computador — inclusive senhas.
            </span>
          </div>
          <input
            type="checkbox"
            checked={settings.syncClipboard}
            onChange={(e) => void controller.updateSettings({ syncClipboard: e.target.checked })}
          />
          <span className="switch-track" />
        </label>

        <label className="switch setting-row">
          <div className="switch-text">
            <strong>Aceitar conexões ao abrir</strong>
            <span>Deixa este computador disponível assim que o programa inicia</span>
          </div>
          <input
            type="checkbox"
            checked={settings.hostOnLaunch}
            onChange={(e) => void controller.updateSettings({ hostOnLaunch: e.target.checked })}
          />
          <span className="switch-track" />
        </label>

        <div className="setting-row">
          <label>Nome exibido</label>
          <input
            className="input"
            defaultValue={settings.displayName}
            onBlur={(e) => void controller.updateSettings({ displayName: e.target.value })}
          />
          <span className="hint">Aparece para quem se conectar a este computador.</span>
        </div>

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
