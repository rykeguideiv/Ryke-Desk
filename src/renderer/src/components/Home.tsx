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
/** Qual lista o painel de computadores está mostrando. */
type AbaPainel = 'favoritos' | 'recentes' | 'recebidos';

/**
 * Conectar a um computador já conhecido, sem digitar nada.
 *
 * Busca a senha guardada daquele número NA HORA, em vez de reaproveitar o que
 * estiver no campo da tela. Reaproveitar era o defeito: clicar num salvo logo
 * depois de digitar outra senha mandava a senha errada, e o outro lado
 * respondia "senha incorreta" sem que ninguém tivesse digitado nada.
 *
 * Sem senha guardada, conecta em branco — o modo de pedir autorização. É o
 * comportamento certo: um computador salvo é um atalho, não uma chave.
 */
function conectarSalvo(controller: Controller, numero: string): void {
  void controller.senhaGuardada(numero).then((guardada) => {
    void controller.connect(numero, guardada ?? '', false);
  });
}

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
  /** Qual aba do painel está aberta; null = painel fechado. */
  const [painel, setPainel] = useState<AbaPainel | null>(null);

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
            <MyComputer
              controller={controller}
              state={state}
              onOpenPassword={onOpenPassword}
              onAbrirPainel={setPainel}
            />
            <ConnectTo controller={controller} state={state} onAbrirPainel={setPainel} />
          </div>
        </div>
      </div>
      <Footer state={state} onOpenSettings={onOpenSettings} />

      {painel && (
        <PainelComputadores
          controller={controller}
          state={state}
          aba={painel}
          setAba={setPainel}
          onClose={() => setPainel(null)}
        />
      )}
    </>
  );
}

// ───────────────────────── este computador ────────────────────────

function MyComputer({
  controller,
  state,
  onOpenPassword,
  onAbrirPainel,
}: {
  controller: Controller;
  state: State;
  onOpenPassword: () => void;
  onAbrirPainel: (aba: AbaPainel) => void;
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

      {/* Quem acessou este computador. Era uma lista aqui dentro, com rolagem
          própria; virou um botão que abre a lista inteira numa janela.
          O botão fica visível mesmo com a contagem em zero, de propósito: um
          recurso que só aparece depois que algo acontece é um recurso que
          ninguém descobre que existe. */}
      <button className="btn ghost block ver-lista" onClick={() => onAbrirPainel('recebidos')}>
        <IconMonitor width={15} height={15} />
        Quem acessou este computador
        <span className="conta-salvos">{state.recebidos.length}</span>
      </button>
    </section>
  );
}

/**
 * Os computadores conhecidos, todos numa janela só.
 *
 * O DEFEITO QUE ISTO CORRIGE
 *
 * Favoritos, recentes e recebidos moravam dentro dos cartões da tela inicial.
 * São três listas que crescem sem limite, e o cartão não cresce junto — então
 * elas ganharam uma barra de rolagem interna. O resultado é que a tela inicial
 * tinha uma janelinha de três linhas por onde se espiava uma lista de vinte, e
 * o resto do cartão ficava apertado por causa dela.
 *
 * Rolagem dentro de um cartão de 200 pixels é sintoma, não solução: significa
 * que aquele conteúdo não cabia ali. Aqui ele tem a janela inteira, e a tela
 * inicial recupera o espaço para o que ela precisa mostrar sempre — o número
 * desta máquina e o campo de conectar.
 *
 * AS TRÊS ABAS
 *
 * Não é uma lista só com filtro porque as três respondem a perguntas
 * diferentes: "quais eu guardei", "para onde eu fui" e "quem veio até mim".
 * Misturá-las obrigaria a ler o rótulo de cada linha para saber o que se está
 * olhando.
 */
function PainelComputadores({
  controller,
  state,
  aba,
  setAba,
  onClose,
}: {
  controller: Controller;
  state: State;
  aba: AbaPainel;
  setAba: (aba: AbaPainel) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [renomeando, setRenomeando] = useState<string | null>(null);
  const [nome, setNome] = useState('');
  const busy = state.outgoing !== null;

  const salvar = (): void => {
    if (renomeando && nome.trim()) void controller.salvarFavorito(renomeando, nome);
    setRenomeando(null);
    setNome('');
  };

  const nomeDe = (numero: string): string | undefined =>
    state.favoritos.find((f) => f.numero === numero)?.nome;

  const abrirRenome = (numero: string): void => {
    setRenomeando(numero);
    setNome(nomeDe(numero) ?? '');
  };

  const conectar = (numero: string): void => {
    if (busy) return;
    conectarSalvo(controller, numero);
    onClose();
  };

  const abas: { id: AbaPainel; titulo: string; quantos: number }[] = [
    { id: 'favoritos', titulo: 'Salvos', quantos: state.favoritos.length },
    { id: 'recentes', titulo: 'Recentes', quantos: state.recent.length },
    { id: 'recebidos', titulo: 'Acessaram este PC', quantos: state.recebidos.length },
  ];

  /** Uma linha da lista. As três abas usam a mesma, com ações diferentes. */
  const linha = (
    numero: string,
    opcoes: { conectavel: boolean; removivel?: boolean },
  ): React.JSX.Element => {
    const salvo = nomeDe(numero);
    return (
      <div key={numero} className={`pc-linha ${numero === renomeando ? 'renomeando' : ''}`}>
        <button
          className="pc-identidade"
          disabled={!opcoes.conectavel || busy}
          title={opcoes.conectavel ? `Conectar a ${formatId(numero)}` : formatId(numero)}
          onClick={() => opcoes.conectavel && conectar(numero)}
        >
          <span className="pc-nome">{salvo ?? formatId(numero)}</span>
          {salvo && <span className="pc-numero">{formatId(numero)}</span>}
          {state.comSenhaSalva.includes(numero) && (
            <span className="pc-chave" title="Senha guardada para este computador">
              <IconLock width={11} height={11} />
            </span>
          )}
        </button>

        <div className="pc-acoes">
          {opcoes.conectavel && (
            <button
              className="pc-acao conectar"
              title="Conectar agora"
              disabled={busy}
              onClick={() => conectar(numero)}
            >
              <IconSend width={14} height={14} />
            </button>
          )}
          <button
            className="pc-acao"
            title={salvo ? 'Renomear' : 'Dar um nome a este computador'}
            onClick={() => abrirRenome(numero)}
          >
            {salvo ? <IconPencil /> : <IconStar width={13} height={13} />}
          </button>
          {opcoes.removivel && salvo && (
            <button
              className="pc-acao remover"
              title="Remover dos salvos"
              onClick={() => void controller.removerFavorito(numero)}
            >
              <IconTrash />
            </button>
          )}
        </div>
      </div>
    );
  };

  const listaAtual =
    aba === 'favoritos'
      ? state.favoritos.map((f) => f.numero)
      : aba === 'recentes'
        ? state.recent
        : state.recebidos;

  const vazio =
    aba === 'favoritos'
      ? 'Nenhum computador salvo ainda. Conecte-se a um e dê um nome a ele — doze dígitos ninguém decora.'
      : aba === 'recentes'
        ? 'Você ainda não se conectou a nenhum computador a partir daqui.'
        : 'Ninguém acessou este computador ainda.';

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal painel-pcs">
        <h2>Computadores</h2>

        <div className="painel-abas" role="tablist">
          {abas.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={aba === t.id}
              className={`painel-aba ${aba === t.id ? 'ativa' : ''}`}
              onClick={() => setAba(t.id)}
            >
              {t.titulo}
              <span className="conta-salvos">{t.quantos}</span>
            </button>
          ))}
        </div>

        {/* O campo de renomear fica no ALTO, e não colado na linha clicada:
            numa lista de vinte itens, um campo que nasce no meio empurra tudo
            para baixo e o cursor perde de vista o que estava fazendo. */}
        {renomeando && (
          <div className="input-with-action painel-renome">
            <input
              className="input"
              autoFocus
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') salvar();
                if (e.key === 'Escape') setRenomeando(null);
              }}
              placeholder={`Nome para ${formatId(renomeando)}`}
              maxLength={40}
            />
            <button onClick={salvar} title="Salvar">
              <IconStar />
            </button>
          </div>
        )}

        {/* A rolagem vive aqui, e só aqui: uma lista longa numa janela grande
            é o lugar certo para ela, ao contrário de um cartão de 200px. */}
        <div className="painel-lista">
          {listaAtual.length === 0 ? (
            <p className="painel-vazio">{vazio}</p>
          ) : (
            listaAtual.map((numero) =>
              linha(numero, {
                // Recebidos não conecta de volta: quem apareceu aqui foi
                // acessar, e oferecer "conectar" ali sugeriria uma reciprocidade
                // que não existe — o número dele pode nem aceitar conexões.
                conectavel: aba !== 'recebidos',
                removivel: aba === 'favoritos',
              }),
            )
          )}
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

// ────────────────────── conectar a outro PC ───────────────────────

function ConnectTo({
  controller,
  state,
  onAbrirPainel,
}: {
  controller: Controller;
  state: State;
  onAbrirPainel: (aba: AbaPainel) => void;
}): React.JSX.Element {
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
    conectarSalvo(controller, numero);
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

  /**
   * Os quatro salvos mais recentes — o que cabe numa linha sem apertar.
   *
   * `favoritos` já chega ordenado do mais usado para o menos (ver `usadoEm` em
   * shared/config.ts), então cortar os quatro primeiros dá justamente os que
   * têm chance de serem clicados.
   */
  const atalhos = state.favoritos.slice(0, 4);
  /** Onde o painel abre: na aba que tem algo para mostrar. */
  const abaInicial: AbaPainel = state.favoritos.length > 0 ? 'favoritos' : 'recentes';

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

      {/* ATALHOS: os quatro computadores salvos mais recentes, numa linha só.

          Aqui estava a lista inteira de favoritos e recentes, com rolagem
          própria dentro do cartão — e era ela que apertava tudo o mais. O
          resto da lista foi para o painel, atrás do botão logo abaixo.

          Estes quatro ficaram porque conectar a quem se usa todo dia deveria
          custar um clique, não dois. A linha NÃO quebra e NÃO rola: a altura
          dela é fixa, então a lista pode crescer à vontade que este cartão
          nunca mais volta a ser empurrado para fora da tela. */}
      {atalhos.length > 0 && (
        <div className="field">
          <label>Ir direto</label>
          <div className="atalhos">
            {atalhos.map((fav) => (
              <button
                key={fav.numero}
                className={`atalho ${fav.numero === numeroLimpo ? 'escolhido' : ''}`}
                disabled={busy}
                title={`Conectar a ${formatId(fav.numero)}`}
                onClick={() => abrirFavorito(fav.numero)}
              >
                <span className="atalho-nome">{fav.nome}</span>
                {state.comSenhaSalva.includes(fav.numero) && <IconLock width={10} height={10} />}
              </button>
            ))}
          </div>
        </div>
      )}

      <button className="btn ghost block ver-lista" onClick={() => onAbrirPainel(abaInicial)}>
        <IconStar width={15} height={15} />
        Computadores salvos e recentes
        <span className="conta-salvos">{state.favoritos.length + state.recent.length}</span>
      </button>
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
