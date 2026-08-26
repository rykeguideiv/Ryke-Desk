import { useEffect, useState } from 'react';
import type { Controlador, Estado } from '../lib/controlador';
import { formatId } from '../shared/protocol';
import { DIGITOS_NUMERO } from '../shared/encontro';
import { esquecerRecente, removerFavorito, salvarFavorito } from '../lib/cofre';

/** Formata enquanto digita: 481922730155 → "481 922 730 155". */
function mascara(bruto: string): string {
  const digitos = bruto.replace(/[^0-9]/g, '').slice(0, DIGITOS_NUMERO);
  return digitos.replace(/(\d{3})(?=\d)/g, '$1 ');
}

export function Inicio({
  controlador,
  estado,
}: {
  controlador: Controlador;
  estado: Estado;
}): React.JSX.Element {
  const [numero, setNumero] = useState('');
  const [senha, setSenha] = useState('');
  const [verSenha, setVerSenha] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [nomeFavorito, setNomeFavorito] = useState('');
  const [lembrarSenha, setLembrarSenha] = useState(false);
  const [verDiagnostico, setVerDiagnostico] = useState(false);

  const digitados = numero.replace(/[^0-9]/g, '').length;
  const faltam = DIGITOS_NUMERO - digitados;
  const limpo = numero.replace(/[^0-9]/g, '');
  const nomeAtual = estado.favoritos.find((f) => f.numero === limpo)?.nome ?? '';
  const temSenhaSalva = estado.comSenhaSalva.includes(limpo);
  const offline = estado.rede !== 'online';

  // Número completo: traz a senha guardada, se houver. O pedido era não ter de
  // digitar toda vez — e a caixinha já vem marcada, para ninguém ser
  // surpreendido por uma senha que não lembra ter salvo.
  useEffect(() => {
    let valendo = true;
    if (limpo.length !== DIGITOS_NUMERO) return;
    void controlador.senhaGuardada(limpo).then((guardada) => {
      if (!valendo || !guardada) return;
      setSenha(guardada);
      setLembrarSenha(true);
    });
    return () => {
      valendo = false;
    };
  }, [limpo, controlador]);

  /**
   * Por que ainda não dá para conectar — sempre dito na tela.
   *
   * Botão apagado sem explicação é um beco sem saída: quem digitou o número
   * certo não teria como descobrir se falta dígito ou se é a rede do aparelho.
   */
  const impedimento =
    digitados === 0
      ? 'Digite o número que aparece no computador.'
      : faltam > 0
        ? `Faltam ${faltam} ${faltam === 1 ? 'dígito' : 'dígitos'}.`
        : offline
          ? 'Entrando na rede de encontro…'
          : null;

  const pontosVivos = estado.pontos.filter((p) => p.conectado);

  return (
    <div className="inicio">
      <header>
        <h1>Ryke Desk</h1>
        <span className={`selo ${offline ? 'off' : 'on'}`}>
          {estado.rede === 'online' ? 'pronto' : estado.rede === 'conectando' ? 'entrando…' : 'sem conexão'}
        </span>
      </header>

      <section className="cartao">
        <label htmlFor="numero">Número do computador</label>
        <input
          id="numero"
          className="campo numero"
          value={numero}
          onChange={(e) => setNumero(mascara(e.target.value))}
          placeholder="000 000 000 000"
          inputMode="numeric"
          autoComplete="off"
        />

        <label htmlFor="senha">
          Senha <span className="fraco">— opcional</span>
        </label>
        <div className="campo-com-botao">
          <input
            id="senha"
            className="campo"
            type={verSenha ? 'text' : 'password'}
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            placeholder="Vazio = pedir autorização"
            autoComplete="off"
          />
          <button onClick={() => setVerSenha(!verSenha)}>{verSenha ? '🙈' : '👁'}</button>
        </div>

        {/* Guardar senha é sempre uma troca: comodidade de um lado, risco do
            outro. A caixinha diz os dois, para a escolha ser informada. */}
        {senha.length > 0 && (
          <label className="caixinha">
            <input
              type="checkbox"
              checked={lembrarSenha}
              onChange={(e) => {
                setLembrarSenha(e.target.checked);
                if (!e.target.checked && temSenhaSalva) void controlador.esquecerSenha(limpo);
              }}
            />
            <span>
              Guardar a senha deste computador
              <small>
                Fica cifrada e só serve neste aparelho. Mas quem destravar este celular vai conseguir
                entrar sem saber a senha.
              </small>
            </span>
          </label>
        )}

        <p className={`modo ${senha ? 'senha' : 'pedido'}`}>
          {senha
            ? 'Entra direto com a senha, sem depender de ninguém no computador.'
            : 'Vai pedir autorização: alguém precisa clicar em “Permitir” na tela do computador.'}
        </p>

        {/* Sempre visível, mesmo antes do número completo.
            Escondê-lo até o décimo segundo dígito fazia o recurso simplesmente
            não existir para quem nunca chegou a digitar tudo — e foi assim que
            passou despercebido. */}
        {salvando ? (
          <div className="salvar">
            <input
              className="campo"
              value={nomeFavorito}
              onChange={(e) => setNomeFavorito(e.target.value)}
              placeholder="Ex.: PC do trabalho"
              maxLength={40}
              autoFocus
            />
            <button
              className="bt"
              onClick={async () => {
                await salvarFavorito(limpo, nomeFavorito);
                await controlador.recarregarFavoritos();
                setSalvando(false);
              }}
            >
              Salvar
            </button>
            <button className="bt" onClick={() => setSalvando(false)}>
              ✕
            </button>
          </div>
        ) : (
          <button
            className="link"
            disabled={faltam !== 0}
            onClick={() => {
              setNomeFavorito(nomeAtual);
              setSalvando(true);
            }}
          >
            ★{' '}
            {faltam !== 0
              ? 'Salvar nos favoritos com um nome'
              : nomeAtual
                ? `Renomear “${nomeAtual}”`
                : 'Salvar nos favoritos com um nome'}
          </button>
        )}

        {impedimento && <div className="impedimento">{impedimento}</div>}

        <button
          className="bt principal"
          disabled={digitados === 0 || estado.conexao !== null}
          onClick={() => {
            void controlador.conectar(numero, senha, lembrarSenha);
            setSenha('');
          }}
        >
          {senha ? 'Conectar' : 'Pedir acesso'}
        </button>
      </section>

      {estado.favoritos.length > 0 && (
        <section className="cartao">
          <label>Favoritos</label>
          <div className="favoritos">
            {estado.favoritos.map((f) => (
              <div key={f.numero} className="favorito">
                <button className="abrir" onClick={() => setNumero(formatId(f.numero))}>
                  <strong>{f.nome}</strong>
                  <small>{formatId(f.numero)}</small>
                </button>
                <button
                  className="remover"
                  onClick={async () => {
                    await removerFavorito(f.numero);
                    await controlador.recarregarFavoritos();
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recentes: o caminho natural é acessar primeiro e dar nome depois —
          ninguém batiza um computador antes de saber se a conexão funciona. */}
      {estado.recentes.filter((n) => !estado.favoritos.some((f) => f.numero === n)).length > 0 && (
        <section className="cartao">
          <label>Conexões recentes</label>
          <div className="favoritos">
            {estado.recentes
              .filter((n) => !estado.favoritos.some((f) => f.numero === n))
              .map((n) => (
                <div key={n} className="favorito">
                  <button className="abrir" onClick={() => setNumero(formatId(n))}>
                    <strong>{formatId(n)}</strong>
                    <small>{estado.comSenhaSalva.includes(n) ? 'senha guardada' : 'acessado recentemente'}</small>
                  </button>
                  <button
                    className="remover estrela"
                    title="Salvar nos favoritos com um nome"
                    onClick={() => {
                      setNumero(formatId(n));
                      setNomeFavorito('');
                      setSalvando(true);
                    }}
                  >
                    ★
                  </button>
                  <button
                    className="remover"
                    title="Esquecer"
                    onClick={async () => {
                      await esquecerRecente(n);
                      await controlador.recarregarRecentes();
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
          </div>
        </section>
      )}

      <section className="cartao">
        <button className="link" onClick={() => setVerDiagnostico(!verDiagnostico)}>
          {verDiagnostico ? '▾' : '▸'} Diagnóstico da rede ({pontosVivos.length} de {estado.pontos.length})
        </button>
        {verDiagnostico && (
          <>
            <div className="pontos">
              {estado.pontos.map((p) => (
                <span key={p.nome} className={`ponto ${p.conectado ? 'on' : 'off'}`}>
                  {p.nome}
                  {p.familia === 'nostr' && <b>443</b>}
                </span>
              ))}
            </div>
            <p className="dica">
              {pontosVivos.length === 0
                ? 'Nenhum ponto alcançado — este aparelho não está saindo para a internet.'
                : pontosVivos.some((p) => p.familia === 'nostr')
                  ? 'Rede boa. Para dois aparelhos se acharem basta um ponto em comum.'
                  : 'Nenhum ponto na porta 443: pode não encontrar quem estiver em rede restrita.'}
            </p>
            {estado.meuNumero && <p className="dica">Identificador deste aparelho: {formatId(estado.meuNumero)}</p>}
          </>
        )}
      </section>

      <footer>
        Este aplicativo <strong>só acessa</strong> computadores. Ele nunca é acessado — ninguém consegue ver ou
        controlar este celular pelo Ryke Desk.
      </footer>
    </div>
  );
}
