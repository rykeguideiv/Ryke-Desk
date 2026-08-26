import type { Estado } from '../lib/controlador';
import { formatId } from '../shared/protocol';

/** Etapas visíveis. Mudam conforme o caminho escolhido — com senha ou sem. */
const ETAPAS: Record<string, [string, string][]> = {
  pedido: [
    ['discando', 'Procurando o computador…'],
    ['aguardando-autorizacao', 'Pedido enviado. Aguardando alguém permitir na tela do computador…'],
    ['negociando', 'Autorizado! Abrindo o caminho direto…'],
  ],
  senha: [
    ['discando', 'Procurando o computador…'],
    ['autenticando', 'Conferindo a senha…'],
    ['negociando', 'Abrindo o caminho direto…'],
  ],
};

export function Discando({
  conexao,
  onCancelar,
}: {
  conexao: NonNullable<Estado['conexao']>;
  onCancelar: () => void;
}): React.JSX.Element {
  const etapas = ETAPAS[conexao.modo] ?? ETAPAS.senha;
  const indice = etapas.findIndex(([fase]) => fase === conexao.fase);
  const esperandoPessoa = conexao.fase === 'aguardando-autorizacao';

  return (
    <div className="cortina">
      <div className="caixa-discando">
        <div className="giro" />
        <div className="numero-grande">{formatId(conexao.peerId)}</div>
        <div className="etapa">{etapas[indice]?.[1] ?? 'Conectando…'}</div>
        {esperandoPessoa && (
          <p className="dica">
            Peça para olharem a tela do computador: apareceu uma janela do Ryke Desk pedindo permissão.
          </p>
        )}
        <div className="passos">
          {etapas.map(([fase], i) => (
            <span key={fase} className={`passo ${i <= indice ? 'feito' : ''}`} />
          ))}
        </div>
        <button className="bt" onClick={onCancelar}>Cancelar</button>
      </div>
    </div>
  );
}
