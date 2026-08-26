import { useEffect, useRef, useState } from 'react';
import type { Controlador, Estado } from '../lib/controlador';
import { TecladoRemoto } from './TecladoRemoto';
import { ControleMouse } from './ControleMouse';
import { caixaConteudo, fracaoParaTela, limitarPan, telaParaFracao, type Ponto } from '../lib/joystick';

/**
 * A tela do computador, dentro do celular.
 *
 * TRADUZIR DEDO EM MOUSE
 *
 * Este é o ponto onde um aplicativo de acesso remoto no celular dá certo ou
 * vira um brinquedo inútil. O dedo é grosso, o cursor do Windows é fino, e
 * uma tela de 1920×1080 espremida em seis polegadas dá cerca de três pixels
 * remotos por pixel do celular — clicar num botão de menu seria loteria.
 *
 * Há dois modos, e eles servem a coisas diferentes:
 *
 * TOQUE DIRETO (padrão) — rápido para alvos grandes:
 *   · TOQUE CURTO       → clique esquerdo onde o dedo encostou
 *   · TOQUE LONGO       → clique direito (o menu de contexto do Windows)
 *   · ARRASTAR UM DEDO  → segura o botão e arrasta (mover janela, selecionar)
 *   · DOIS DEDOS        → rolagem, como a roda do mouse
 *   · PINÇA             → amplia a VISUALIZAÇÃO, não o computador
 *
 * CONTROLE DE MOUSE (botão na barra) — preciso para trabalho fino: aparece um
 * joystick no canto de baixo, e só ele move o cursor. O dedo sai de cima do
 * alvo, o cursor passa a ter posição própria e visível, e os botões do outro
 * canto clicam onde ele está. Com o controle ligado, o dedo na imagem só
 * navega — arrastar desloca a visualização ampliada, e não o mouse do PC.
 *
 * A pinça é o que salva a precisão nos dois modos: ampliando três vezes, cada
 * pixel remoto ganha tamanho de dedo. O zoom é local — o PC não sabe que
 * existe, e continua mandando a tela inteira.
 */

/** Acima disto o toque virou arrasto, e não vale mais como clique. */
const TOLERANCIA_CLIQUE = 12;
/** Tempo até um toque parado virar clique direito. */
const TOQUE_LONGO_MS = 550;

export function Visualizador({
  controlador,
  estado,
}: {
  controlador: Controlador;
  estado: Estado;
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const palcoRef = useRef<HTMLDivElement>(null);
  const marcadorRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Ponto>({ x: 0, y: 0 });
  const [teclado, setTeclado] = useState(false);
  const [controle, setControle] = useState(false);
  const [barra, setBarra] = useState(true);

  const sessao = controlador.sessaoAtiva;
  const stats = estado.conexao?.stats ?? null;

  /**
   * Onde o cursor está, em fração da tela do PC.
   *
   * Vive aqui, e não dentro do joystick, porque três coisas precisam dele: o
   * joystick para caminhar, os botões para clicar no lugar certo, e o marcador
   * para desenhar. O toque direto também o atualiza, de modo que ligar o
   * controle continua de onde o dedo parou, em vez de recomeçar do meio.
   */
  const cursor = useRef<Ponto>({ x: 0.5, y: 0.5 });

  useEffect(() => {
    const video = videoRef.current;
    const stream = sessao?.streamRemoto;
    if (video && stream && video.srcObject !== stream) {
      video.srcObject = stream;
      void video.play().catch(() => {});
    }
  }, [sessao, sessao?.streamRemoto]);

  // ─────────────────── geometria da imagem ───────────────────

  /**
   * A caixa onde a imagem realmente está, em coordenadas da tela.
   *
   * O elemento de vídeo ocupa o palco inteiro, mas a imagem dentro dele é
   * centralizada com tarjas pretas quando as proporções não batem — e batem
   * quase nunca: um PC 16:9 num celular deitado 20:9 deixa quase 20% da
   * largura em tarja. Medir pelo elemento erraria o alvo justo nas bordas,
   * onde ficam a barra de tarefas e o botão de fechar janela.
   */
  const caixaImagem = (): { left: number; top: number; width: number; height: number } | null => {
    const video = videoRef.current;
    if (!video) return null;
    const r = video.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return caixaConteudo(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      video.videoWidth,
      video.videoHeight,
    );
  };

  /** Toque na tela do celular → fração da tela do PC (0 a 1). */
  const paraFracao = (cliente: Ponto): Ponto | null => {
    const caixa = caixaImagem();
    return caixa ? telaParaFracao(caixa, cliente) : null;
  };

  /**
   * Redesenha o marcador do cursor.
   *
   * Escrito direto no estilo, sem passar pelo estado do React: isto roda a
   * cada quadro enquanto o joystick anda, e rerenderizar a árvore sessenta
   * vezes por segundo para mexer um círculo seria caro à toa.
   */
  const posicionarMarcador = (): void => {
    const marca = marcadorRef.current;
    const palco = palcoRef.current;
    const caixa = caixaImagem();
    if (!marca || !palco || !caixa) return;
    const p = palco.getBoundingClientRect();
    const alvo = fracaoParaTela(caixa, cursor.current);
    marca.style.transform = `translate(${alvo.x - p.left}px, ${alvo.y - p.top}px)`;
  };

  // O marcador precisa acompanhar zoom, arrasto e giro do aparelho — a fração
  // não muda, mas o lugar dela na tela sim.
  useEffect(() => {
    if (!controle) return;
    posicionarMarcador();
    const aoRedimensionar = (): void => posicionarMarcador();
    window.addEventListener('resize', aoRedimensionar);
    window.addEventListener('orientationchange', aoRedimensionar);
    return () => {
      window.removeEventListener('resize', aoRedimensionar);
      window.removeEventListener('orientationchange', aoRedimensionar);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controle, zoom, pan, stats?.width, stats?.height]);

  const alternarControle = (): void => {
    if (controle) {
      setControle(false);
      return;
    }
    setControle(true);
    // Leva o cursor de verdade para onde o marcador vai nascer. Sem isto o
    // primeiro toque na haste faria o cursor saltar de um canto ao outro sem
    // explicação — o protocolo trabalha com posição absoluta, não relativa.
    const c = cursor.current;
    sessao?.moverMouse(c.x, c.y);
    requestAnimationFrame(posicionarMarcador);
  };

  // ─────────────────── gestos ───────────────────

  const toques = useRef(new Map<number, Ponto>());
  const inicio = useRef<Ponto | null>(null);
  const arrastando = useRef(false);
  const relogioLongo = useRef<number | null>(null);
  const distanciaInicial = useRef(0);
  const zoomInicial = useRef(1);
  const panInicial = useRef<Ponto>({ x: 0, y: 0 });
  const centroInicial = useRef<Ponto>({ x: 0, y: 0 });
  const rolagemAnterior = useRef<Ponto | null>(null);
  /** O botão esquerdo está preso por um arrasto de dedo? */
  const segurandoBotao = useRef(false);

  /** Mantém o arrasto da visualização dentro dos limites da imagem ampliada. */
  const arrumarPan = (p: Ponto, z: number): Ponto => {
    const palco = palcoRef.current;
    if (!palco) return p;
    const r = palco.getBoundingClientRect();
    return limitarPan(p, z, r.width, r.height);
  };

  const cancelarToqueLongo = (): void => {
    if (relogioLongo.current !== null) {
      clearTimeout(relogioLongo.current);
      relogioLongo.current = null;
    }
  };

  const aoDescer = (e: React.PointerEvent): void => {
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // Ponteiro que o navegador já não reconhece. Sem captura o gesto ainda
      // funciona; com exceção aqui, ele nem começaria.
    }
    toques.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (toques.current.size === 1) {
      inicio.current = { x: e.clientX, y: e.clientY };
      panInicial.current = pan;
      arrastando.current = false;
      // Com o joystick ligado, o dedo na imagem não comanda o mouse: quem
      // comanda é a haste. Um toque longo aqui abriria menu de contexto no
      // meio de uma navegação, que é exatamente o que se quer evitar.
      if (controle) return;
      // Toque parado por meio segundo é clique direito — o gesto que dá
      // acesso ao menu de contexto, sem o qual metade do Windows fica fora
      // de alcance no celular.
      relogioLongo.current = window.setTimeout(() => {
        const f = paraFracao({ x: e.clientX, y: e.clientY });
        if (!f) return;
        cursor.current = f;
        sessao?.botaoMouse(2, true, f.x, f.y);
        sessao?.botaoMouse(2, false, f.x, f.y);
        relogioLongo.current = null;
        inicio.current = null;
        if (navigator.vibrate) navigator.vibrate(18);
      }, TOQUE_LONGO_MS);
    } else if (toques.current.size === 2) {
      cancelarToqueLongo();
      const [a, b] = [...toques.current.values()];
      distanciaInicial.current = Math.hypot(a.x - b.x, a.y - b.y);
      zoomInicial.current = zoom;
      panInicial.current = pan;
      centroInicial.current = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      rolagemAnterior.current = centroInicial.current;
    }
  };

  const aoMover = (e: React.PointerEvent): void => {
    if (!toques.current.has(e.pointerId)) return;
    toques.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (toques.current.size >= 2) {
      const [a, b] = [...toques.current.values()];
      const distancia = Math.hypot(a.x - b.x, a.y - b.y);
      const centro = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

      if (distanciaInicial.current > 0) {
        const novo = Math.min(6, Math.max(1, (zoomInicial.current * distancia) / distanciaInicial.current));
        setZoom(novo);
        // Ampliar em torno do meio dos dedos, e não do canto: é o que faz a
        // pinça parecer que puxa a imagem, em vez de deslizá-la para longe.
        setPan(
          arrumarPan(
            {
              x: panInicial.current.x + (centro.x - centroInicial.current.x),
              y: panInicial.current.y + (centro.y - centroInicial.current.y),
            },
            novo,
          ),
        );
      }

      // Movimento vertical com dois dedos vira roda do mouse. Com o joystick
      // ligado a rolagem acontece onde o cursor está, e não onde estão os
      // dedos — é lá que o usuário está olhando.
      const anterior = rolagemAnterior.current;
      if (anterior && Math.abs(distancia - distanciaInicial.current) < 26) {
        const dy = centro.y - anterior.y;
        if (Math.abs(dy) > 3) {
          const f = controle ? cursor.current : paraFracao(centro);
          if (f) sessao?.rolar(0, -dy * 2, f.x, f.y);
          rolagemAnterior.current = centro;
        }
      }
      return;
    }

    const partida = inicio.current;
    if (!partida) return;
    const percorrido = Math.hypot(e.clientX - partida.x, e.clientY - partida.y);
    if (!arrastando.current && percorrido < TOLERANCIA_CLIQUE) return;

    // Passou da tolerância: não é mais clique, é arrasto.
    cancelarToqueLongo();
    arrastando.current = true;

    // Com o controle ligado, arrastar move a JANELA de visualização, não o
    // mouse do computador. É o que permite ampliar para caçar um detalhe e
    // depois deslizar até ele sem tocar em nada do outro lado.
    if (controle) {
      setPan(
        arrumarPan(
          { x: panInicial.current.x + (e.clientX - partida.x), y: panInicial.current.y + (e.clientY - partida.y) },
          zoom,
        ),
      );
      return;
    }

    const f = paraFracao({ x: e.clientX, y: e.clientY });
    if (!f) return;
    if (!segurandoBotao.current) {
      segurandoBotao.current = true;
      const p = paraFracao(partida);
      if (p) {
        sessao?.moverMouse(p.x, p.y);
        sessao?.botaoMouse(0, true, p.x, p.y);
      }
    }
    cursor.current = f;
    sessao?.moverMouse(f.x, f.y);
  };

  const aoSubir = (e: React.PointerEvent): void => {
    const partida = inicio.current;
    const arrastou = arrastando.current;
    toques.current.delete(e.pointerId);
    cancelarToqueLongo();

    if (toques.current.size > 0) return;
    rolagemAnterior.current = null;
    inicio.current = null;
    arrastando.current = false;

    const f = paraFracao({ x: e.clientX, y: e.clientY });
    if (!f) {
      segurandoBotao.current = false;
      return;
    }

    if (segurandoBotao.current) {
      sessao?.botaoMouse(0, false, f.x, f.y);
      segurandoBotao.current = false;
      cursor.current = f;
      return;
    }

    // Com o joystick ligado o toque na imagem não clica: quem clica são os
    // botões do canto direito.
    if (controle || arrastou || !partida) return;

    // Toque curto e parado: clique esquerdo onde o dedo encostou.
    cursor.current = f;
    sessao?.moverMouse(f.x, f.y);
    sessao?.botaoMouse(0, true, f.x, f.y);
    sessao?.botaoMouse(0, false, f.x, f.y);
  };

  const reenquadrar = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const instavel = estado.conexao?.instavel === true;

  return (
    <div className={`visualizador ${instavel ? 'instavel' : ''}`}>
      {/* A imagem congela e nada mais responde: sem este aviso, o usuário fica
          olhando uma tela parada sem saber se o problema é o aplicativo, a
          rede do celular ou o computador do outro lado. */}
      {instavel && (
        <div className="reconectando">
          <span className="giro-pequeno" />
          <span>
            <strong>Reconectando…</strong> a conexão parou de responder. A sessão continua aberta.
          </span>
        </div>
      )}

      <div
        className="palco"
        ref={palcoRef}
        onPointerDown={aoDescer}
        onPointerMove={aoMover}
        onPointerUp={aoSubir}
        onPointerCancel={aoSubir}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          onLoadedMetadata={posicionarMarcador}
        />
        {/* O cursor remoto vem desenhado dentro do vídeo, mas chega atrasado e
            na taxa de quadros da imagem. O marcador é local e instantâneo: é
            ele que dá ao polegar a resposta imediata sem a qual o joystick
            pareceria emperrado. */}
        {controle && <div className="marcador-cursor" ref={marcadorRef} />}
      </div>

      {barra && (
        <div className="barra-sessao">
          <button className="bt" onClick={() => setBarra(false)} title="Esconder">
            ▾
          </button>
          <span className="nome">{estado.conexao?.meta?.hostName ?? 'Computador'}</span>
          {stats && (
            <span className="medidas">
              {stats.width}×{stats.height} · {stats.fps} qps · {stats.atraso} ms img
            </span>
          )}
          <span className="espaco" />
          <button className={`bt ${controle ? 'ativo' : ''}`} onClick={alternarControle}>
            {controle ? 'Controle ligado' : 'Ativar controle de mouse'}
          </button>
          <button className={`bt ${teclado ? 'ativo' : ''}`} onClick={() => setTeclado(!teclado)}>
            Teclado
          </button>
          {zoom > 1.01 && (
            <button className="bt" onClick={reenquadrar}>
              {zoom.toFixed(1)}× ✕
            </button>
          )}
          <button className="bt sair" onClick={() => controlador.desconectar()}>
            Encerrar
          </button>
        </div>
      )}

      {!barra && (
        <button className="mostrar-barra" onClick={() => setBarra(true)}>
          ▴
        </button>
      )}

      {/* O teclado ocupa a faixa de baixo, que é onde mora o controle. Os dois
          juntos brigariam pelo mesmo polegar e pelo mesmo espaço. */}
      {controle && sessao && !teclado && (
        <ControleMouse
          sessao={sessao}
          cursor={cursor}
          aoAndar={posicionarMarcador}
          onFechar={() => setControle(false)}
        />
      )}

      {teclado && sessao && <TecladoRemoto sessao={sessao} onFechar={() => setTeclado(false)} />}
    </div>
  );
}
