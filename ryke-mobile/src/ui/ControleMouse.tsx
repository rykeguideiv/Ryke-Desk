import { useEffect, useRef } from 'react';
import type { Sessao } from '../lib/sessao';
import { RAIO_BASE, passoCursor, vetorDoDedo, type Ponto } from '../lib/joystick';

/**
 * O joystick e os botões de mouse.
 *
 * COMO O CORPO SEGURA O CELULAR
 *
 * A disposição não é enfeite: o aparelho fica deitado, seguro pelas duas mãos,
 * e os dois polegares caem naturalmente nos cantos de baixo. Por isso a haste
 * fica na ESQUERDA e os botões na DIREITA — a mesma divisão de qualquer
 * controle de videogame, e a única que permite mover e clicar ao mesmo tempo.
 *
 * Mover e clicar ao mesmo tempo é o ponto todo. É o que permite ARRASTAR:
 * o polegar direito segura o botão esquerdo pressionado enquanto o esquerdo
 * conduz o cursor. Sem isso não se move uma janela, não se seleciona um texto,
 * não se arrasta um arquivo — e o acesso remoto vira só olhar.
 *
 * Por isso o botão esquerdo trabalha por PRESSIONAR e SOLTAR, e não por
 * clique: encostar e tirar o dedo dá um clique normal; encostar e segurar
 * mantém o botão preso do outro lado, até o dedo sair.
 *
 * Os quatro pequenos são atalhos que o dedo não alcança de outro jeito:
 * clique direito (o menu de contexto, sem o qual falta metade do Windows),
 * voltar página, copiar e colar.
 */

/**
 * Prende o dedo ao elemento, para que sair da borda dele não perca o gesto.
 *
 * Falha em casos legítimos — ponteiro que o navegador não reconhece mais —, e
 * uma exceção aqui abortaria o resto do tratamento e deixaria a haste presa
 * no lugar onde estava. Perder a captura é aceitável; perder o gesto não.
 */
const prender = (alvo: Element, id: number): void => {
  try {
    alvo.setPointerCapture?.(id);
  } catch {
    /* segue sem captura */
  }
};

/** Vibração curta. É o único retorno de que o comando saiu — a tela remota demora. */
const tremer = (ms: number): void => {
  if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(ms);
};

export function ControleMouse({
  sessao,
  cursor,
  aoAndar,
  onFechar,
}: {
  sessao: Sessao;
  /**
   * A posição do cursor, partilhada com o visualizador.
   *
   * É uma referência, e não estado do React: ela muda a cada quadro de
   * animação, e transformar isso em renderização redesenharia a árvore inteira
   * sessenta vezes por segundo para mexer um círculo de 26 pixels.
   */
  cursor: React.RefObject<Ponto>;
  /** Avisa o visualizador para reposicionar o marcador. */
  aoAndar: () => void;
  onFechar: () => void;
}): React.JSX.Element {
  const baseRef = useRef<HTMLDivElement>(null);
  const hasteRef = useRef<HTMLDivElement>(null);

  const dedo = useRef<number | null>(null);
  const centro = useRef<Ponto>({ x: 0, y: 0 });
  /** Raio real da base e curso da haste, medidos no toque — variam com a tela. */
  const raio = useRef(RAIO_BASE);
  const curso = useRef(RAIO_BASE * 0.56);
  const vetor = useRef<Ponto>({ x: 0, y: 0 });
  const quadro = useRef<number | null>(null);
  const instante = useRef(0);
  /** Botões pressionados agora — para não deixar nenhum preso ao sair. */
  const presos = useRef(new Set<0 | 1 | 2>());

  // ─────────────────────────── a haste ───────────────────────────

  const desenharHaste = (): void => {
    const haste = hasteRef.current;
    if (!haste) return;
    haste.style.transform = `translate(${vetor.current.x * curso.current}px, ${vetor.current.y * curso.current}px)`;
  };

  const girar = (agora: number): void => {
    const dt = instante.current > 0 ? agora - instante.current : 16;
    instante.current = agora;
    const antes = cursor.current;
    const depois = passoCursor(antes, vetor.current, dt);
    if (depois.x !== antes.x || depois.y !== antes.y) {
      cursor.current = depois;
      sessao.moverMouse(depois.x, depois.y);
      aoAndar();
    }
    quadro.current = requestAnimationFrame(girar);
  };

  const comecarAGirar = (): void => {
    if (quadro.current !== null) return;
    instante.current = 0;
    quadro.current = requestAnimationFrame(girar);
  };

  const pararDeGirar = (): void => {
    if (quadro.current === null) return;
    cancelAnimationFrame(quadro.current);
    quadro.current = null;
  };

  const aoPegarHaste = (e: React.PointerEvent): void => {
    // Um dedo por vez na haste. O segundo é ignorado — e, num teste ou com o
    // aparelho na mesa, o cursor do sistema passeando por cima da janela
    // também gera eventos de ponteiro que não podem ser confundidos com o dedo.
    if (dedo.current !== null) return;
    e.preventDefault();
    const base = baseRef.current;
    if (!base) return;
    const r = base.getBoundingClientRect();
    centro.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    // Chegar à borda da base é velocidade máxima, em qualquer tamanho de tela.
    // E a haste anda só até encostar por dentro, para não sair da base.
    raio.current = Math.max(24, r.width / 2);
    const h = hasteRef.current?.getBoundingClientRect();
    curso.current = Math.max(10, r.width / 2 - (h?.width ?? 58) / 2);
    dedo.current = e.pointerId;
    prender(e.currentTarget as Element, e.pointerId);
    vetor.current = vetorDoDedo(e.clientX - centro.current.x, e.clientY - centro.current.y, raio.current);
    desenharHaste();
    comecarAGirar();
  };

  const aoConduzir = (e: React.PointerEvent): void => {
    if (dedo.current !== e.pointerId) return;
    e.preventDefault();
    vetor.current = vetorDoDedo(e.clientX - centro.current.x, e.clientY - centro.current.y, raio.current);
    desenharHaste();
  };

  const aoLargarHaste = (e: React.PointerEvent): void => {
    if (dedo.current !== e.pointerId) return;
    dedo.current = null;
    vetor.current = { x: 0, y: 0 };
    desenharHaste();
    pararDeGirar();
  };

  // ─────────────────────────── os botões ───────────────────────────

  const pressionar = (botao: 0 | 2) => (e: React.PointerEvent) => {
    e.preventDefault();
    prender(e.currentTarget as Element, e.pointerId);
    const c = cursor.current;
    // Move antes de clicar: o anfitrião injeta o clique na posição que receber,
    // e um clique um pixel fora do lugar acerta o botão errado.
    sessao.moverMouse(c.x, c.y);
    sessao.botaoMouse(botao, true, c.x, c.y);
    presos.current.add(botao);
    tremer(11);
  };

  const soltar = (botao: 0 | 2) => (e: React.PointerEvent) => {
    e.preventDefault();
    if (!presos.current.delete(botao)) return;
    const c = cursor.current;
    sessao.botaoMouse(botao, false, c.x, c.y);
  };

  const atalho = (codes: string[]) => (): void => {
    sessao.combinacao(codes);
    tremer(8);
  };

  // Sair com um botão pressionado deixaria o Windows do outro lado com o mouse
  // preso — arrastando tudo por onde o cursor passasse, sem ninguém para soltar.
  useEffect(() => {
    return () => {
      pararDeGirar();
      const c = cursor.current;
      for (const botao of presos.current) sessao.botaoMouse(botao as 0 | 2, false, c.x, c.y);
      presos.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="controle-mouse">
      <div className="lado-haste">
        <div
          className="joystick"
          ref={baseRef}
          onPointerDown={aoPegarHaste}
          onPointerMove={aoConduzir}
          onPointerUp={aoLargarHaste}
          onPointerCancel={aoLargarHaste}
        >
          <span className="anel" />
          <div className="haste" ref={hasteRef} />
        </div>
        <button className="fechar-controle" onClick={onFechar} title="Esconder o controle">
          ✕ controle
        </button>
      </div>

      <div className="lado-botoes">
        <div className="fila">
          <button className="bm" onClick={atalho(['ControlLeft', 'KeyC'])} title="Ctrl+C">
            Copiar
          </button>
          <button className="bm" onClick={atalho(['ControlLeft', 'KeyV'])} title="Ctrl+V">
            Colar
          </button>
        </div>
        <div className="fila">
          {/* Voltar página vai como Alt+← , e não como o quarto botão do mouse:
              o atalho funciona em navegador, no Explorer e nas janelas de
              configuração; o botão lateral depende do aplicativo escutá-lo. */}
          <button className="bm" onClick={atalho(['AltLeft', 'ArrowLeft'])} title="Alt+← — voltar página">
            ◀ Voltar
          </button>
          <button
            className="bm direito"
            onPointerDown={pressionar(2)}
            onPointerUp={soltar(2)}
            onPointerCancel={soltar(2)}
            title="Clique direito — menu de contexto"
          >
            Direito
          </button>
        </div>
        <button
          className="bm esquerdo"
          onPointerDown={pressionar(0)}
          onPointerUp={soltar(0)}
          onPointerCancel={soltar(0)}
          title="Clique esquerdo — segure para arrastar"
        >
          Esquerdo
          <small>segure para arrastar</small>
        </button>
      </div>
    </div>
  );
}
