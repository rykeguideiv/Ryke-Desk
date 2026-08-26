import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Controlador } from './lib/controlador';
import { Inicio } from './ui/Inicio';
import { Visualizador } from './ui/Visualizador';
import { AlertaIdentidade } from './ui/AlertaIdentidade';
import { Discando } from './ui/Discando';

export function App(): React.JSX.Element {
  const controlador = useMemo(() => new Controlador(), []);
  const estado = useSyncExternalStore(controlador.assinar, controlador.instantaneo);

  useEffect(() => {
    void controlador.iniciar();
    return () => controlador.encerrar();
  }, [controlador]);

  const emSessao = estado.conexao?.fase === 'conectado';

  return (
    <div className="app">
      {emSessao ? (
        <Visualizador controlador={controlador} estado={estado} />
      ) : (
        <Inicio controlador={controlador} estado={estado} />
      )}

      {estado.conexao && estado.conexao.fase !== 'conectado' && (
        <Discando conexao={estado.conexao} onCancelar={() => controlador.desconectar()} />
      )}

      {estado.identidadeSuspeita && (
        <AlertaIdentidade
          suspeita={estado.identidadeSuspeita}
          onConfiar={() => void controlador.confiarNovaIdentidade()}
          onFechar={() => controlador.descartarAvisoDeIdentidade()}
        />
      )}

      <div className="avisos">
        {estado.avisos.map((a) => (
          <div key={a.id} className={`aviso ${a.tipo}`}>
            {a.texto}
          </div>
        ))}
      </div>
    </div>
  );
}
