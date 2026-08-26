import { formatId } from '../shared/protocol';

/**
 * Um número conhecido apareceu com outra identidade.
 *
 * Único ponto do aplicativo em que a decisão é genuinamente do usuário: os
 * dois motivos possíveis — a pessoa reinstalou o Windows, ou alguém está
 * tentando ocupar o número dela — produzem exatamente o mesmo sinal. O
 * programa não tem como distinguir, então recusa e explica.
 */
export function AlertaIdentidade({
  suspeita,
  onConfiar,
  onFechar,
}: {
  suspeita: { numero: string; esperada: string; recebida: string };
  onConfiar: () => void;
  onFechar: () => void;
}): React.JSX.Element {
  return (
    <div className="cortina">
      <div className="caixa">
        <h2>A identidade mudou</h2>
        <p>
          O número <strong>{formatId(suspeita.numero)}</strong> respondeu, mas o computador por trás dele não é o
          mesmo de antes. A conexão foi recusada.
        </p>
        <div className="par">
          <span>Assinatura registrada</span>
          <code>{suspeita.esperada}</code>
        </div>
        <div className="par">
          <span>Assinatura que respondeu agora</span>
          <code>{suspeita.recebida}</code>
        </div>
        <p className="dica">
          Se a pessoa reinstalou o Windows ou o Ryke Desk, isso é esperado. Se não foi o caso,{' '}
          <strong>alguém pode estar tentando se passar por ela</strong>. Confirme por telefone antes de confiar —
          nunca por este número.
        </p>
        <div className="botoes">
          <button className="bt" onClick={onFechar}>Cancelar</button>
          <button className="bt perigo" onClick={onConfiar}>Já confirmei, confiar</button>
        </div>
      </div>
    </div>
  );
}
