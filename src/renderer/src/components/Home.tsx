import { useEffect, useState } from 'react';
import { formatId } from '../../../shared/protocol';
import type { Controller, State } from '../lib/controller';
import {
  IconCopy,
  IconCheck,
  IconLock,
  IconEye,
  IconEyeOff,
  IconSettings,
  IconShield,
  IconSend,
  IconBell,
  IconMonitor,
  IconStar,
  IconPencil,
  IconTrash,
  IconRefresh,
} from './icons';
import { DIGITOS_NUMERO } from '../../../shared/encontro';

/**
 * Tela inicial: o número deste computador de um lado, o campo para entrar em
 * outro do lado oposto. Essa simetria é proposital — a mesma janela serve
 * para quem vai atender e para quem vai acessar, sem escolher "modo" nenhum.
 */
export function Home({
  controller,
  state,
  onOpenSettings,
  onOpenPassword,
}: {
  controller: Controller;
  state: State;
  onOpenSettings: () => void;
  onOpenPassword: () => void;
}): React.JSX.Element {

  return (
    <>
      {/* A tela inteira cabe na janela, sem rolagem.
          Antes o conteúdo simplesmente crescia e empurrava o resto para fora:
          para ver os favoritos ou o botão de conectar era preciso rolar, e num
          programa cuja tela inicial tem duas colunas curtas isso nunca deveria
          acontecer. Agora a altura é fixa e quem rola, quando precisa, é só a
          lista de computadores salvos — dentro dela mesma. */}
      <div className="home">
        <div className="home-inner">
          <div className="home-topbar">
            <span className="home-papel">
              <IconMonitor width={14} height={14} />
              Pronto para receber e para conectar
              {state.minhaImpressao && (
                <span
                  className="home-ip"
                  title="Identidade deste computador. Quem já se conectou aqui confere este código."
                >
                  identidade {state.minhaImpressao}
                </span>
              )}
            </span>
          </div>
          <div className="panels">
            <MyComputer controller={controller} state={state} onOpenPassword={onOpenPassword} />
            <ConnectTo controller={controller} state={state} />
          </div>
        </div>
      </div>
      <Footer state={state} onOpenSettings={onOpenSettings} />
    </>
  );
}

// ───────────────────────── este computador ────────────────────────

function MyComputer({
  controller,
  state,
  onOpenPassword,
}: {
  controller: Controller;
  state: State;
  onOpenPassword: () => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    if (!state.myId) return;
    await window.ryke.clipboard.write(state.myId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const online = state.server.status === 'online' && Boolean(state.myId);
  const supervisionadoLigado = state.settings?.allowSupervisedAccess !== false;
  // Basta uma das duas portas estar aberta para alguém conseguir entrar:
  // a senha (sem ninguém aqui) ou a autorização na tela (com alguém aqui).
  const pronto = online && state.acceptingConnections && (state.hasPassword || supervisionadoLigado);

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">Este computador</span>
        <span className="status">
          <span className={`dot ${pronto ? 'on' : online ? 'wait' : 'off'}`} />
          {!online
            ? 'Sem conexão'
            : !state.acceptingConnections
              ? 'Não está aceitando conexões'
              : pronto
                ? 'Pronto para receber'
                : 'Nenhuma forma de acesso liberada'}
        </span>
      </div>

      <div>
        <div className="card-sub" style={{ marginBottom: 6 }}>
          Passe este número para quem vai acessar
        </div>
        <div className="my-id">
          <span className={`my-id-value ${state.myId ? '' : 'pending'}`}>
            {state.myId ? formatId(state.myId) : '— — —'}
          </span>
          <button className="icon-btn" onClick={copy} disabled={!state.myId} title="Copiar número">
            {copied ? <IconCheck style={{ color: 'var(--ok)' }} /> : <IconCopy />}
          </button>
        </div>

        {/* Trocar a numeração fica AQUI, colado no número, e não lá dentro dos
            Ajustes. O número é a única coisa desta tela que a pessoa passa
            adiante, e quando ele precisa mudar — porque vazou, porque foi
            parar num lugar errado — ela está olhando justamente para ele.
            Obrigar a caçar o botão em outra janela era esconder a ação no
            exato momento em que ela é procurada. */}
        <button
          className="link-acao trocar-num"
          disabled={!state.myId}
          title="Sorteia um número novo para este computador"
          onClick={() => {
            const certeza = window.confirm(
              [
                'Trocar a numeração deste computador?',
                '',
                'Quem tem o número atual anotado ou salvo nos favoritos deixa de conseguir chegar aqui.',
                'Você vai precisar avisar seus contatos do número novo.',
              ].join('\n'),
            );
            if (certeza) void controller.trocarNumero();
          }}
        >
          <IconRefresh />
          Trocar numeração
        </button>
      </div>

      <div className="field">
        <label>Como podem entrar aqui</label>

        <div className="acesso-modo">
          <IconBell style={{ color: supervisionadoLigado ? 'var(--accent-hi)' : 'var(--text-faint)' }} />
          <div>
            <strong>Pedindo autorização</strong>
            <span>
              {supervisionadoLigado
                ? 'Sem senha. Um aviso aparece aqui e você decide na hora.'
                : 'Desligado nos Ajustes — só entram com senha.'}
            </span>
          </div>
        </div>

        {/* Trancado enquanto alguém controla esta máquina.
            Quem está do outro lado enxerga esta tela e comanda o teclado: sem a
            trava, poderia abrir esta janela daqui e trocar a senha por uma
            dele — e passaria a entrar quando quisesse, sem que o dono
            percebesse até a própria senha parar de funcionar. */}
        <button className="btn block" onClick={onOpenPassword} disabled={state.senhaTravada}>
          {state.senhaTravada ? (
            <>
              <IconLock style={{ color: 'var(--warn)' }} />
              Senha trancada durante a conexão
            </>
          ) : state.hasPassword ? (
            <>
              <IconShield style={{ color: 'var(--ok)' }} />
              Com senha — definida, alterar ou remover
            </>
          ) : (
            <>
              <IconLock style={{ color: 'var(--text-faint)' }} />
              Com senha — definir (acesso sem ninguém aqui)
            </>
          )}
        </button>
        <span className="hint">
          {state.senhaTravada
            ? 'Alguém está controlando este computador agora. Encerre a sessão para poder mexer na senha — quem está conectado veria e poderia trocá-la.'
            : state.hasPassword
              ? 'Quem tiver a senha entra mesmo com este computador sozinho.'
              : 'Enquanto não houver senha, toda conexão precisa da sua autorização na tela.'}
        </span>
      </div>

      <label className="switch">
        <div className="switch-text">
          <strong>Aceitar conexões</strong>
          <span>Desligue para ficar invisível sem fechar o programa</span>
        </div>
        <input
          type="checkbox"
          checked={state.acceptingConnections}
          onChange={(e) => controller.setAcceptingConnections(e.target.checked)}
        />
        <span className="switch-track" />
      </label>

      {state.incoming?.phase === 'ativa' && (
        <div className="badge ok" style={{ alignSelf: 'flex-start' }}>
          <span className="dot on" style={{ width: 6, height: 6 }} />
          Em sessão com {formatId(state.incoming.peerId)}
          <button
            className="btn ghost sm"
            style={{ height: 22, padding: '0 8px', marginLeft: 6 }}
            onClick={() => controller.endHostSession('encerrada pelo anfitrião')}
          >
            Encerrar
          </button>
        </div>
      )}
    </section>
  );
}

// ────────────────────── conectar a outro PC ───────────────────────

function ConnectTo({ controller, state }: { controller: Controller; state: State }): React.JSX.Element {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);

  // A senha é opcional de propósito: em branco, o outro computador recebe um
  // pedido na tela e alguém decide na hora (acesso supervisionado).
  const busy = state.outgoing !== null;
  const offline = state.server.status !== 'online';
  const supervisionado = password.length === 0;

  const digitados = id.replace(/\D/g, '').length;
  const faltam = DIGITOS_NUMERO - digitados;

  const [salvando, setSalvando] = useState(false);
  const [nomeFavorito, setNomeFavorito] = useState('');
  const [lembrarSenha, setLembrarSenha] = useState(false);
  const numeroLimpo = id.replace(/\D/g, '');
  const nomeAtual = state.favoritos.find((f) => f.numero === numeroLimpo)?.nome ?? '';
  const temSenhaSalva = state.comSenhaSalva.includes(numeroLimpo);

  // Ao completar o número, traz a senha guardada — o pedido era não ter de
  // digitar toda vez. A caixa fica marcada, para ninguém ser surpreendido por
  // uma senha que não lembra ter salvo.
  useEffect(() => {
    let valendo = true;
    if (numeroLimpo.length !== DIGITOS_NUMERO) return;
    void controller.senhaGuardada(numeroLimpo).then((guardada) => {
      if (!valendo || !guardada) return;
      setPassword(guardada);
      setLembrarSenha(true);
    });
    return () => {
      valendo = false;
    };
  }, [numeroLimpo, controller]);

  const gravarFavorito = (): void => {
    void controller.salvarFavorito(numeroLimpo, nomeFavorito);
    setSalvando(false);
  };

  /**
   * Conectar direto num computador salvo.
   *
   * Vai buscar a senha guardada daquele número na hora, em vez de depender do
   * campo estar preenchido: o efeito colateral de reaproveitar o campo era que
   * clicar num favorito logo depois de digitar outra senha mandava a senha
   * errada — e o outro lado respondia "senha incorreta" sem que ninguém
   * tivesse digitado nada.
   *
   * Sem senha guardada, conecta em branco, que é o modo de pedir autorização.
   * É o comportamento certo: o favorito é um atalho, não uma chave.
   */
  const abrirFavorito = (numero: string): void => {
    if (busy) return;
    setId(formatId(numero));
    void controller.senhaGuardada(numero).then((guardada) => {
      void controller.connect(numero, guardada ?? '', false);
    });
  };

  /**
   * Por que ainda não dá para conectar — dito na tela, sempre.
   *
   * Antes o botão simplesmente ficava apagado quando faltava dígito ou quando
   * este computador ainda não tinha entrado na malha. Quem estava do outro
   * lado digitava o número certo, via o botão morto e não tinha como saber o
   * que estava errado. Botão desligado sem explicação é um beco sem saída.
   */
  const impedimento =
    digitados === 0
      ? 'Digite o número que aparece no outro computador.'
      : faltam > 0
        ? `Faltam ${faltam} ${faltam === 1 ? 'dígito' : 'dígitos'}.`
        : offline
          ? 'Este computador ainda está entrando na rede de encontro…'
          : null;

  const submit = (): void => {
    if (busy) return;
    // Sem guarda de validade aqui: o controlador confere e explica em voz
    // alta o que faltou. Recusar em silêncio foi o defeito que isto corrige.
    void controller.connect(id, password, lembrarSenha);
    setPassword('');
  };

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">Conectar a outro computador</span>
      </div>

      <div className="field">
        <label htmlFor="peer-id">Número do computador</label>
        <input
          id="peer-id"
          className="input id-input"
          value={id}
          onChange={(e) => setId(maskId(e.target.value))}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="000 000 000 000"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {/* Salvar como favorito, sempre à vista.
          Antes só aparecia depois do décimo segundo dígito, e o resultado foi
          que o recurso não existia para quem nunca chegou a digitar o número
          inteiro nesta tela — quem clica num favorito ou num recente já entra
          direto. Ficar visível e desligado ensina que ele está ali. */}
      {(
        salvando ? (
          <div className="field salvar-favorito">
            <label htmlFor="fav-nome">Nome para este computador</label>
            <div className="input-with-action">
              <input
                id="fav-nome"
                className="input"
                value={nomeFavorito}
                onChange={(e) => setNomeFavorito(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') gravarFavorito();
                  if (e.key === 'Escape') setSalvando(false);
                }}
                placeholder="Ex.: Notebook da Ana"
                maxLength={40}
                autoFocus
              />
              <button onClick={gravarFavorito} title="Salvar">
                <IconStar />
              </button>
            </div>
            <span className="hint">A senha não é guardada — o favorito é um atalho, não uma chave.</span>
          </div>
        ) : (
          <button
            className="link-acao"
            disabled={faltam !== 0}
            title={faltam !== 0 ? 'Digite o número completo para poder salvar' : 'Guarda este computador com um nome'}
            onClick={() => { setNomeFavorito(nomeAtual); setSalvando(true); }}
          >
            <IconStar />
            {nomeAtual ? `Renomear “${nomeAtual}”` : 'Salvar nos favoritos com um nome'}
          </button>
        )
      )}

      <div className="field">
        <label htmlFor="peer-password">
          Senha de acesso <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>— opcional</span>
        </label>
        <div className="input-with-action">
          <input
            id="peer-password"
            className="input"
            type={reveal ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Deixe em branco para pedir autorização"
            autoComplete="off"
          />
          <button onClick={() => setReveal(!reveal)} title={reveal ? 'Ocultar' : 'Mostrar'} tabIndex={-1}>
            {reveal ? <IconEyeOff /> : <IconEye />}
          </button>
        </div>
      </div>

      {/* Também sempre à vista, pelo mesmo motivo: escondida até haver senha
          digitada, ninguém descobria que dava para não digitar de novo. */}
      <label className={`caixinha ${supervisionado ? 'apagada' : ''}`}>
        <input
          type="checkbox"
          checked={lembrarSenha && !supervisionado}
          disabled={supervisionado}
          onChange={(e) => {
            setLembrarSenha(e.target.checked);
            if (!e.target.checked && temSenhaSalva) void controller.esquecerSenha(numeroLimpo);
          }}
        />
        <span>
          Guardar a senha deste computador
          <small>
            {supervisionado
              ? 'Digite a senha acima para poder guardá-la e não precisar digitar de novo.'
              : 'Fica cifrada nesta máquina e só serve nela. Mas quem usar este Windows com a sua conta vai conseguir entrar sem saber a senha.'}
          </small>
        </span>
      </label>

      <div className={`mode-hint ${supervisionado ? 'supervisionado' : ''}`}>
        {supervisionado ? (
          <>
            <IconBell />
            <span>
              <strong>Vai pedir autorização.</strong> Alguém precisa estar no outro computador para clicar em
              “Permitir”.
            </span>
          </>
        ) : (
          <>
            <IconLock />
            <span>
              <strong>Entra direto com a senha.</strong> Não é preciso ninguém do outro lado.
            </span>
          </>
        )}
      </div>

      {impedimento && <div className="impedimento">{impedimento}</div>}

      <button className="btn primary block" onClick={submit} disabled={busy || digitados === 0}>
        <IconSend />
        {busy ? 'Conectando…' : supervisionado ? 'Pedir acesso' : 'Conectar'}
      </button>

      {/* A ÚNICA PARTE QUE ROLA.
          Favoritos e recentes são as duas listas que crescem sem limite —
          eram elas que empurravam o botão de conectar para fora da tela. Aqui
          elas ficam contidas: a lista rola dentro de si mesma e todo o resto
          do cartão permanece onde está, sempre à vista. */}
      <div className="listas-salvos">
        {state.favoritos.length > 0 && (
          <div className="field">
            <label>
              Favoritos
              <span className="conta-salvos">{state.favoritos.length}</span>
            </label>
            <div className="favoritos">
              {state.favoritos.map((fav) => (
                <div
                  key={fav.numero}
                  className={`favorito ${fav.numero === numeroLimpo ? 'escolhido' : ''}`}
                >
                  {/* Um clique preenche o número; dois já conectam. Guardar um
                      computador com nome só compensa se chegar nele for curto —
                      preencher e ainda ter de mirar em "Conectar" desperdiçava
                      metade do ganho de tê-lo salvo. */}
                  <button
                    className="favorito-abrir"
                    onClick={() => setId(formatId(fav.numero))}
                    onDoubleClick={() => abrirFavorito(fav.numero)}
                    title={`${formatId(fav.numero)} — clique para usar, dois cliques para conectar`}
                  >
                    <span className="favorito-nome">{fav.nome}</span>
                    <span className="favorito-num">
                      {formatId(fav.numero)}
                      {state.comSenhaSalva.includes(fav.numero) && (
                        <span className="favorito-chave" title="Senha guardada para este computador">
                          <IconLock width={11} height={11} />
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    className="favorito-acao conectar"
                    title="Conectar agora"
                    disabled={busy}
                    onClick={() => abrirFavorito(fav.numero)}
                  >
                    <IconSend width={14} height={14} />
                  </button>
                  <button
                    className="favorito-acao"
                    title="Renomear"
                    onClick={() => {
                      setNomeFavorito(fav.nome);
                      setId(formatId(fav.numero));
                      setSalvando(true);
                    }}
                  >
                    <IconPencil />
                  </button>
                  <button
                    className="favorito-acao remover"
                    title="Remover dos favoritos"
                    onClick={() => void controller.removerFavorito(fav.numero)}
                  >
                    <IconTrash />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {state.recent.length > 0 && (
          <div className="field">
            <label>Conexões recentes</label>
            <div className="recent-list">
              {state.recent
                .filter((recent) => !state.favoritos.some((f) => f.numero === recent))
                .map((recent) => (
                  <span key={recent} className="recent-chip">
                    <button className="recent-usar" onClick={() => setId(formatId(recent))}>
                      {formatId(recent)}
                    </button>
                    {/* Guardar com nome direto daqui: depois de uma sessão o
                        número entra em "recentes", e era ali que faltava o
                        caminho para transformá-lo em favorito. */}
                    <button
                      className="recent-estrela"
                      title="Salvar nos favoritos com um nome"
                      onClick={() => {
                        setId(formatId(recent));
                        setNomeFavorito('');
                        setSalvando(true);
                      }}
                    >
                      <IconStar width={13} height={13} />
                    </button>
                  </span>
                ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** Formata enquanto o usuário digita: 481922730155 → "481 922 730 155". */
function maskId(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, DIGITOS_NUMERO);
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ');
}

// ───────────────────────────── rodapé ─────────────────────────────

function Footer({ state, onOpenSettings }: { state: State; onOpenSettings: () => void }): React.JSX.Element {
  const rotulo =
    state.server.status === 'online'
      ? 'Pronto para conectar'
      : state.server.status === 'conectando'
        ? 'Entrando na rede de encontro…'
        : `Sem conexão com a internet${state.server.detail ? ` — ${state.server.detail}` : ''}`;

  return (
    <footer className="footer">
      <div className="footer-left">
        <span className="status">
          <span className={`dot ${state.server.status === 'online' ? 'on' : state.server.status === 'conectando' ? 'wait' : 'off'}`} />
          {rotulo}
        </span>
        <span>{state.machineName}</span>
      </div>
      <div className="footer-left">
        <span>versão {state.version}</span>
        <button className="btn ghost sm" onClick={onOpenSettings}>
          <IconSettings />
          Ajustes
        </button>
      </div>
    </footer>
  );
}
