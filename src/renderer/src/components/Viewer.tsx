import { useCallback, useEffect, useRef, useState } from 'react';
import { formatId, formatBytes } from '../../../shared/protocol';
import { COMBOS } from '../../../shared/keymap';
import { pointerToFraction, wheelToTicks, type Fraction } from '../lib/geometry';
import { decidirBarra } from '../lib/barra';
import type { Controller, Outgoing, State } from '../lib/controller';
import type { Quality } from '../lib/session';
import type { TransferView } from '../lib/files';
import {
  IconMonitor, IconKeyboard, IconFiles, IconFullscreen, IconExitFullscreen,
  IconPower, IconGrip, IconX, IconArrowUp, IconArrowDown, IconFolder, IconLock, IconSend,
  IconMinus, IconShield, IconPlus, IconGamepad, IconEscape,
} from './icons';
import { NovaConexao } from './Modals';

/**
 * A tela do outro computador, em tamanho real.
 *
 * Todo evento de mouse vira uma fração da imagem (0..1) antes de ir para a
 * rede, e todo evento de teclado vira o `code` da tecla física. Nada de
 * pixels nem de caracteres: é o que faz a sessão continuar correta quando a
 * janela muda de tamanho ou quando os dois lados usam layouts diferentes.
 */

const ATALHOS_LOCAIS = {
  sair: (e: KeyboardEvent) => e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyX',
  telaCheia: (e: KeyboardEvent) => e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyF',
};

/** Versão curta das etapas de conexão, para caber dentro de uma aba. */
const TEXTO_FASE: Record<Outgoing['phase'], string> = {
  discando: 'Procurando o computador…',
  autenticando: 'Conferindo a senha…',
  'aguardando-autorizacao': 'Aguardando alguém permitir do outro lado…',
  negociando: 'Abrindo o caminho direto…',
  conectado: 'Conectado',
};

/**
 * As abas, uma por computador conectado.
 *
 * Cada aba é uma sessão inteira e independente: conexão própria, taxa de bits
 * própria, qualidade própria. Trocar de aba não desconecta nada — só muda qual
 * delas recebe o teclado e o mouse e aparece na tela. É por isso que dá para
 * deixar um computador copiando arquivos numa aba enquanto se trabalha noutra.
 */
function BarraDeAbas({
  abas,
  ativa,
  onEscolher,
  onFechar,
  onNova,
}: {
  abas: Outgoing[];
  ativa: string | null;
  onEscolher: (peerId: string) => void;
  onFechar: (peerId: string) => void;
  onNova: () => void;
}): React.JSX.Element {
  return (
    <div className="barra-abas" onPointerDown={(e) => e.stopPropagation()}>
      {abas.map((aba) => (
        <div key={aba.peerId} className={`aba ${aba.peerId === ativa ? 'ativa' : ''}`}>
          <button className="aba-abrir" onClick={() => onEscolher(aba.peerId)} title={formatId(aba.peerId)}>
            <span
              className={`aba-ponto ${
                aba.phase !== 'conectado' ? 'ligando' : aba.instavel ? 'instavel' : 'on'
              }`}
            />
            {/* O nome da máquina quando ele já chegou; o número enquanto não.
                Doze dígitos não distinguem nada numa fileira de abas. */}
            <span className="aba-nome">{aba.meta?.hostName ?? formatId(aba.peerId)}</span>
          </button>
          <button className="aba-fechar" title="Encerrar esta conexão" onClick={() => onFechar(aba.peerId)}>
            <IconX width={12} height={12} />
          </button>
        </div>
      ))}
      <button className="aba-nova" title="Conectar a mais um computador" onClick={onNova}>
        <IconPlus width={14} height={14} />
      </button>
    </div>
  );
}


export function Viewer({ controller, state }: { controller: Controller; state: State }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  /**
   * Captura total do teclado.
   *
   * Ligada por padrão, porque é o que a pessoa espera ao controlar outro
   * computador: apertar Ctrl+Shift+Esc tem de abrir o Gerenciador de Tarefas
   * DE LÁ. Desligável porque, com ela ligada, este computador fica sem
   * atalhos enquanto a janela estiver na frente.
   */
  const [capturaTotal, setCapturaTotal] = useState(true);
  const [capturaDisponivel, setCapturaDisponivel] = useState(true);
  const [novaConexao, setNovaConexao] = useState(false);
  /**
   * Modo Gamer: mouse relativo (mira 360°) com o ponteiro travado.
   *
   * Ligado, um clique na tela trava o ponteiro (pointer lock) e o movimento
   * passa a ir como DESLOCAMENTO, não posição — é o que deixa a câmera girar
   * sem parar na borda. `travado` diz se o ponteiro está preso agora.
   */
  const [gamer, setGamer] = useState(false);
  const [travado, setTravado] = useState(false);
  /** Diálogo que ensina o atalho de saída antes de ligar o Modo Gamer. */
  const [confirmandoGamer, setConfirmandoGamer] = useState(false);
  /**
   * Sensibilidade da mira no Modo Gamer.
   *
   * Multiplica o deslocamento do mouse antes de mandá-lo ao jogo. Existe porque
   * o movimento atravessa a aceleração do mouse dos DOIS Windows (o seu e o do
   * anfitrião), e o resultado chegava fraco — era preciso arrastar três vezes
   * mais para dar um giro de 360°. Ajustável porque o valor certo depende do
   * DPI do mouse, da sensibilidade do jogo e da resolução; guardado no aparelho.
   */
  const [sensGamer, setSensGamer] = useState<number>(() => {
    const v = Number(localStorage.getItem('ryke:gamer-sens'));
    return Number.isFinite(v) && v > 0 ? v : 3;
  });
  const ajustarSens = useCallback((delta: number) => {
    setSensGamer((s) => {
      const novo = Math.min(10, Math.max(0.5, Math.round((s + delta) * 10) / 10));
      localStorage.setItem('ryke:gamer-sens', String(novo));
      return novo;
    });
  }, []);
  /** Esc puro minimiza? Desligável para o Esc chegar ao jogo (Desativar Esc). */
  const [escMinimiza, setEscMinimiza] = useState(true);
  /** Número que acabou de conectar e ainda não foi nomeado (prompt aberto). */
  const [nomeando, setNomeando] = useState<string | null>(null);
  const [nomeTmp, setNomeTmp] = useState('');
  /** Números para os quais já perguntamos o nome — não insistir a cada troca. */
  const jaPerguntou = useRef<Set<string>>(new Set());

  const session = controller.viewer;
  const outgoing = state.outgoing!;

  /**
   * Enquanto um campo de texto NOSSO está na tela, o gancho de teclado do
   * sistema precisa ficar desligado — senão ele engole as teclas antes de
   * chegarem ao campo, e a pessoa "não consegue digitar". Antes isso dependia
   * de um evento de foco assíncrono, e a defasagem do IPC comia as primeiras
   * teclas: era o "às vezes não deixa digitar". Aqui a pausa é determinística —
   * a captura desliga junto com a abertura do modal ou do prompt de nome.
   */
  const pausarCaptura = novaConexao || nomeando !== null || confirmandoGamer;
  /**
   * A aba da frente ainda está discando?
   *
   * Acontece ao abrir uma segunda conexão sem largar a primeira: a aba nova
   * nasce na frente e passa alguns segundos negociando. Nesse intervalo não
   * há vídeo para mostrar, mas as outras abas seguem conectadas atrás — então
   * a janela continua sendo o visualizador, e quem espera é só esta aba.
   */
  const conectandoNestaAba = outgoing.phase !== 'conectado';


  // ── vídeo ──
  //
  // O elemento é recriado a cada troca de aba (o `key` no JSX), então reatar o
  // fluxo guardado na sessão é o que faz a imagem voltar na hora ao alternar.
  // A conexão em si nunca é desfeita: ela vive na sessão, não neste elemento.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !session) return;
    if (session.remoteStream) video.srcObject = session.remoteStream;
    return session.on('stream', (stream) => {
      video.srcObject = stream;
    });
  }, [session]);

  // ── teclado ──
  //
  // Capturamos na fase de captura da janela e cancelamos o evento: sem isso o
  // Chromium trataria Ctrl+W, Ctrl+R e F5 como atalhos desta janela em vez de
  // repassá-los ao computador remoto.
  const pressed = useRef(new Set<string>());

  /**
   * Esc: sai da frente sem encerrar a sessão.
   *
   * Tira da tela cheia, se estiver, e minimiza a janela — a conexão continua
   * de pé, esperando na barra de tarefas. É o reflexo de todo mundo: em cima
   * da tela de outro computador, Esc é "me tira daqui".
   *
   * O preço é que Esc deixa de atravessar. Para mandá-lo de propósito ao outro
   * computador existe o botão **Esc** no menu *Teclas* da barra.
   */
  const sairDaSessao = useCallback(() => {
    if (!session) return;
    // Solta o que estiver pressionado antes de sumir: com a janela minimizada
    // o "levantar" da tecla nunca chegaria, e o outro computador ficaria com
    // um Ctrl ou um Alt preso para sempre.
    for (const code of pressed.current) session.sendKey(code, false);
    pressed.current.clear();
    if (fullscreen) {
      setFullscreen(false);
      window.ryke.window.fullscreen(false);
    }
    window.ryke.window.minimize();
  }, [session, fullscreen]);

  /**
   * O botão Modo Gamer.
   *
   * Ligar passa antes pelo diálogo que ensina o atalho de saída — com o
   * ponteiro preso não dá para clicar no botão de novo, então a pessoa PRECISA
   * saber o Ctrl+G antes de entrar. Desligar é direto (quando ainda dá para
   * clicar, ou seja, ponteiro solto).
   */
  const alternarGamer = useCallback(() => {
    if (gamer) {
      if (document.pointerLockElement) document.exitPointerLock();
      setGamer(false);
      return;
    }
    setConfirmandoGamer(true);
  }, [gamer]);

  /** Confirmou que leu o atalho: agora sim liga o modo. */
  const confirmarGamer = useCallback(() => {
    setConfirmandoGamer(false);
    setGamer(true);
  }, []);

  const sairDoGamer = useCallback(() => {
    if (document.pointerLockElement) document.exitPointerLock();
    setGamer(false);
  }, []);

  /**
   * Liga/desliga "Esc minimiza".
   *
   * Precisa avisar também o gancho do processo principal: com a captura total
   * ligada, é ele quem vê o Esc primeiro, e sem esse aviso o Esc continuaria
   * minimizando antes de a janela ter chance de mandá-lo ao jogo.
   */
  const alternarEsc = useCallback(() => {
    setEscMinimiza((on) => {
      const novo = !on;
      window.ryke.teclado.escMinimiza(novo);
      return novo;
    });
  }, []);

  // Acompanha o estado real da trava do ponteiro: Alt+Tab, foco perdido ou a
  // saída pelo próprio sistema soltam a trava por fora, e a interface precisa
  // refletir isso (mostrar o aviso "clique para jogar").
  useEffect(() => {
    const aoMudar = (): void => setTravado(document.pointerLockElement === videoRef.current);
    document.addEventListener('pointerlockchange', aoMudar);
    return () => document.removeEventListener('pointerlockchange', aoMudar);
  }, []);

  useEffect(() => {
    if (!session) return;

    const soltarTudo = (): void => {
      for (const code of pressed.current) session.sendKey(code, false);
      pressed.current.clear();
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      // Esc minimiza — a não ser que "Desativar Esc" esteja ligado, quando ele
      // vira uma tecla comum e segue para o jogo como qualquer outra.
      if (e.code === 'Escape' && escMinimiza && !isTypingLocally(e.target)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        sairDaSessao();
        return;
      }
      // Saída do Modo Gamer: Ctrl+G, e SÓ com o modo ligado — fora dele,
      // Ctrl+G segue normalmente para o computador remoto.
      if (gamer && e.ctrlKey && e.code === 'KeyG') {
        e.preventDefault();
        sairDoGamer();
        return;
      }
      // Deixa passar o que é digitado num campo da nossa própria interface.
      if (isTypingLocally(e.target)) return;

      // Para arquivo, Ctrl+V precisa esperar os bytes chegarem e o clipboard
      // remoto oferecer CF_HDROP. Depois executa a combinação no Explorer.
      if (e.code === 'KeyV' && temControle(pressed.current)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        for (const code of pressed.current) session.sendKey(code, false);
        pressed.current.clear();
        void controller.prepararColagemDeArquivo().then(() => {
          session.sendCombo(['ControlLeft', 'KeyV']);
        });
        return;
      }

      if (ATALHOS_LOCAIS.sair(e)) {
        e.preventDefault();
        soltarTudo();
        controller.disconnect();
        return;
      }
      if (ATALHOS_LOCAIS.telaCheia(e)) {
        e.preventDefault();
        setFullscreen((on) => {
          window.ryke.window.fullscreen(!on);
          return !on;
        });
        return;
      }

      e.preventDefault();
      pressed.current.add(e.code);
      session.sendKey(e.code, true, e.repeat);
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (isTypingLocally(e.target)) return;
      e.preventDefault();
      // Nunca soltar do outro lado uma tecla que nunca foi pressionada lá.
      // É o que acontece com o Esc que saiu da tela cheia: o "desce" ficou
      // aqui, e só o "sobe" chegaria — deixando o Windows remoto confuso.
      if (!pressed.current.delete(e.code)) return;
      session.sendKey(e.code, false);
    };

    // Alt+Tab é tratado pelo Windows antes de chegar até nós: quando a janela
    // perde o foco, o "keyup" nunca chega e a tecla ficaria presa lá.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', soltarTudo);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', soltarTudo);
      soltarTudo();
    };
  }, [session, controller, fullscreen, sairDaSessao, sairDoGamer, escMinimiza, gamer]);

  // ── teclado, o resto dele ──
  //
  // O trecho acima só pega o que o navegador enxerga, e o Windows come as
  // combinações mais úteis antes disso: Ctrl+Shift+Esc, Ctrl+Esc, a tecla
  // Windows, Alt+Tab. Elas chegam por aqui, de um gancho instalado no processo
  // principal, e seguem o mesmo caminho de sempre a partir do `code`.
  useEffect(() => {
    if (!session) return;
    let vivo = true;

    const capturaLigada = capturaTotal && !pausarCaptura;
    void window.ryke.teclado.capturar(capturaLigada).then((deu) => {
      if (vivo) setCapturaDisponivel(deu);
    });

    const parar = window.ryke.teclado.onEvento((evento) => {
      // Se o foco está num campo NOSSO, nenhuma tecla vira comando remoto. É a
      // segunda linha de defesa contra o gancho: mesmo que uma tecla escape na
      // fresta de tempo até a captura desligar, ela não vaza para o outro lado.
      if (evento.tipo !== 'soltar' && isTypingLocally(document.activeElement)) return;
      if (evento.tipo === 'soltar') {
        for (const code of pressed.current) session.sendKey(code, false);
        pressed.current.clear();
        return;
      }
      if (evento.tipo === 'acao') {
        if (evento.qual === 'sair') controller.disconnect();
        if (evento.qual === 'minimizar') sairDaSessao();
        if (evento.qual === 'telaCheia') {
          setFullscreen((on) => {
            window.ryke.window.fullscreen(!on);
            return !on;
          });
        }
        return;
      }
      if (evento.pressionada && evento.code === 'KeyV' && temControle(pressed.current)) {
        for (const code of pressed.current) session.sendKey(code, false);
        pressed.current.clear();
        void controller.prepararColagemDeArquivo().then(() => session.sendCombo(['ControlLeft', 'KeyV']));
        return;
      }
      // Mesmo trato do teclado comum. Com a captura total ligada esta é a
      // única chance de tratar o Esc — o gancho engole a tecla antes de a
      // janela vê-la. Com "Desativar Esc", ele deixa de minimizar e segue
      // para o outro lado como uma tecla qualquer (cai no envio lá embaixo).
      if (evento.code === 'Escape' && escMinimiza) {
        if (evento.pressionada) sairDaSessao();
        return;
      }

      // Saída do Modo Gamer: Ctrl+G, só com o modo ligado. Com a captura total
      // o gancho é a única chance de ver essa tecla — a janela nunca a recebe.
      if (gamer && evento.pressionada && evento.code === 'KeyG' && temControle(pressed.current)) {
        sairDoGamer();
        return;
      }

      if (evento.pressionada) pressed.current.add(evento.code);
      else pressed.current.delete(evento.code);
      session.sendKey(evento.code, evento.pressionada);
    });

    return () => {
      vivo = false;
      parar();
      void window.ryke.teclado.capturar(false);
    };
  }, [session, controller, capturaTotal, pausarCaptura, fullscreen, sairDaSessao, sairDoGamer, escMinimiza, gamer]);

  /**
   * Digitar num campo da própria interface (nome de arquivo, busca) enquanto o
   * teclado está todo capturado seria impossível: cada tecla iria para o outro
   * computador. Enquanto o foco estiver num campo daqui, a captura descansa.
   */
  useEffect(() => {
    if (!session || !capturaTotal || pausarCaptura) return;
    // Sempre pelo elemento que está com o foco AGORA: no `focusout`, o alvo do
    // evento é quem está saindo, e usá-lo desligaria a captura justamente
    // quando o campo é abandonado.
    const reavaliar = (): void => {
      void window.ryke.teclado.capturar(!isTypingLocally(document.activeElement));
    };
    const aoSair = (): void => {
      window.setTimeout(reavaliar, 0);
    };
    document.addEventListener('focusin', reavaliar);
    document.addEventListener('focusout', aoSair);
    return () => {
      document.removeEventListener('focusin', reavaliar);
      document.removeEventListener('focusout', aoSair);
    };
  }, [session, capturaTotal, pausarCaptura]);

  // ── as duas setas ──
  //
  // A SUA é o cursor do próprio Windows desta máquina, pintado de vermelho por
  // um cursor personalizado no CSS. Continua instantâneo — quem o desenha é o
  // sistema, não a página — e a cor é o que deixa claro, à primeira vista,
  // qual das duas obedece à sua mão.
  //
  // A DELES é esta marca: a posição real do ponteiro de lá, que o anfitrião
  // informa pelo canal rápido, no desenho claro e padrão. A seta que vem
  // dentro do vídeo não serve para nada disso, porque chega com o atraso da
  // imagem.
  //
  // As duas andam de forma independente, mas há um detalhe físico que a
  // interface precisa respeitar: o computador remoto tem UM ponteiro só, e
  // enquanto você o dirige a posição que volta de lá é a sua própria. Nesse
  // caso mostramos apenas a sua. A marca deles reaparece assim que as duas
  // posições se descolam — o instante exato em que a pessoa que está lá pegou
  // o mouse dela e passou a mexer por conta própria.
  const marcaRef = useRef<HTMLDivElement>(null);
  const cursorRemoto = useRef<Fraction>({ x: 0.5, y: 0.5 });
  /** Último ponto que ESTA máquina mandou — a régua para saber quem mexeu. */
  const lastPoint = useRef<Fraction>({ x: 0.5, y: 0.5 });

  const posicionarMarca = useCallback(() => {
    const marca = marcaRef.current;
    const video = videoRef.current;
    const palco = containerRef.current;
    if (!marca || !video || !palco) return;
    const r = video.getBoundingClientRect();
    const { videoWidth, videoHeight } = video;
    if (!videoWidth || !videoHeight || r.width === 0) return;
    const escala = Math.min(r.width / videoWidth, r.height / videoHeight);
    const largura = videoWidth * escala;
    const altura = videoHeight * escala;
    const esquerda = r.left + (r.width - largura) / 2;
    const topo = r.top + (r.height - altura) / 2;
    const p = palco.getBoundingClientRect();
    const x = esquerda + cursorRemoto.current.x * largura - p.left;
    const y = topo + cursorRemoto.current.y * altura - p.top;
    marca.style.transform = `translate(${x}px, ${y}px)`;
  }, []);

  useEffect(() => {
    if (!session) return;
    const solta = session.on('cursor', (ponto) => {
      cursorRemoto.current = ponto;
      // Perto o bastante do último ponto que ESTA máquina mandou significa que
      // o ponteiro de lá está apenas obedecendo a você. A folga é generosa de
      // propósito: o anfitrião arredonda a fração em quatro casas e o Windows
      // encaixa o ponteiro no pixel, então "o mesmo lugar" nunca bate exato.
      const meu = lastPoint.current;
      const juntos = Math.abs(ponto.x - meu.x) < 0.012 && Math.abs(ponto.y - meu.y) < 0.012;
      marcaRef.current?.classList.toggle('propria', juntos);
      posicionarMarca();
    });
    window.addEventListener('resize', posicionarMarca);
    return () => {
      solta();
      window.removeEventListener('resize', posicionarMarca);
    };
  }, [session, posicionarMarca]);

  // ── mouse ──
  const pendingMove = useRef<Fraction | null>(null);
  const rafId = useRef<number | null>(null);

  /** Deslocamento acumulado do Modo Gamer, somado entre quadros. */
  const pendingRel = useRef({ dx: 0, dy: 0 });

  const flushMove = useCallback(() => {
    rafId.current = null;
    if (!session) return;
    // Relativo (Modo Gamer): manda a SOMA do quadro. Somar, e não substituir,
    // é o que preserva o movimento — cada quadro pode ter vários eventos, e
    // perder qualquer um deles faria a mira andar menos do que a mão.
    const rel = pendingRel.current;
    if (rel.dx !== 0 || rel.dy !== 0) {
      session.sendMouseRel(rel.dx, rel.dy);
      pendingRel.current = { dx: 0, dy: 0 };
    }
    const point = pendingMove.current;
    pendingMove.current = null;
    if (point) session.sendMouseMove(point.x, point.y);
  }, [session]);

  /**
   * Revela a barra de menu ao encostar no topo — no CONTAINER, não no vídeo.
   *
   * Com duas ou mais abas, a barra de abas cobre a faixa do topo (é ela que
   * fica ali). Se a detecção morasse no vídeo, encostar no topo cairia sobre a
   * barra de abas, o vídeo nunca veria o movimento e a barra de menu não abriria
   * — o que dava a impressão de que ela só funcionava na primeira aba. No
   * container o evento chega por bubbling venha de onde vier: vídeo, barra de
   * abas ou a própria barra de menu. A regra em si vive em lib/barra.ts.
   */
  const revelarBarra = useCallback((e: React.PointerEvent): void => {
    setToolbarVisible((aberta) => decidirBarra(aberta, e.clientY, e.screenY));
  }, []);

  /** O ponteiro está travado no vídeo agora? (Modo Gamer em jogo.) */
  const jogando = (video: HTMLVideoElement): boolean =>
    gamer && document.pointerLockElement === video;

  const onPointerMove = (e: React.PointerEvent<HTMLVideoElement>): void => {
    const video = videoRef.current;
    if (!video || !session) return;

    // Modo Gamer travado: manda deslocamento, não posição, multiplicado pela
    // sensibilidade. Não escala mais pela resolução: para MIRA o que importa é
    // o movimento físico do mouse virar giro, independente do tamanho da
    // janela — e a aceleração dos dois Windows já mexe demais no caminho.
    if (jogando(video)) {
      pendingRel.current.dx += e.movementX * sensGamer;
      pendingRel.current.dy += e.movementY * sensGamer;
      if (rafId.current === null) rafId.current = requestAnimationFrame(flushMove);
      return;
    }

    const point = pointerToFraction(video, e.clientX, e.clientY);
    if (!point) return;
    lastPoint.current = point;
    // Um pacote por quadro: a 60 Hz o mouse já parece instantâneo, e mandar
    // um por evento entupiria o canal de controle.
    pendingMove.current = point;
    if (rafId.current === null) rafId.current = requestAnimationFrame(flushMove);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLVideoElement>): void => {
    const video = videoRef.current;
    if (!video || !session || e.button > 2) return;

    if (gamer) {
      // Fora da trava, o primeiro clique só serve para PRENDER o ponteiro — é
      // a exigência do navegador (pointer lock nasce de um gesto). Preso, o
      // clique vira tiro: aperta sem reposicionar, que o jogo mira sozinho.
      if (document.pointerLockElement !== video) {
        void video.requestPointerLock?.();
        return;
      }
      session.sendMouseRelButton(e.button as 0 | 1 | 2, true);
      return;
    }

    // Captura o ponteiro para que arrastar até fora do vídeo continue valendo
    // (selecionar texto, mover janela remota até a borda).
    video.setPointerCapture(e.pointerId);
    const point = pointerToFraction(video, e.clientX, e.clientY) ?? lastPoint.current;
    lastPoint.current = point;
    session.sendMouseButton(e.button as 0 | 1 | 2, true, point.x, point.y);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLVideoElement>): void => {
    const video = videoRef.current;
    if (!video || !session || e.button > 2) return;

    if (gamer) {
      if (document.pointerLockElement === video) session.sendMouseRelButton(e.button as 0 | 1 | 2, false);
      return;
    }

    if (video.hasPointerCapture(e.pointerId)) video.releasePointerCapture(e.pointerId);
    const point = pointerToFraction(video, e.clientX, e.clientY) ?? lastPoint.current;
    session.sendMouseButton(e.button as 0 | 1 | 2, false, point.x, point.y);
  };

  // A roda precisa de listener não-passivo para podermos cancelar o zoom
  // padrão do Chromium com Ctrl+roda.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !session) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const { dx, dy } = wheelToTicks(e);
      const point = pointerToFraction(video, e.clientX, e.clientY) ?? lastPoint.current;
      session.sendWheel(dx, dy, point.x, point.y);
    };
    video.addEventListener('wheel', onWheel, { passive: false });
    return () => video.removeEventListener('wheel', onWheel);
  }, [session]);

  // ── nomear a conexão assim que ela conecta ──
  //
  // Logo que uma conexão nova fica de pé, oferecemos guardá-la com um nome. É
  // opcional e some com um clique; quem não quiser é só dispensar. Não insiste:
  // uma vez perguntado (ou já salvo), o número não volta a pedir.
  useEffect(() => {
    const aba = state.abas.find((a) => a.peerId === state.abaAtiva);
    if (!aba || aba.phase !== 'conectado') return;
    if (jaPerguntou.current.has(aba.peerId)) return;
    jaPerguntou.current.add(aba.peerId);
    if (state.favoritos.some((f) => f.numero === aba.peerId)) return;
    setNomeTmp('');
    setNomeando(aba.peerId);
  }, [state.abaAtiva, state.abas, state.favoritos]);

  const salvarNome = useCallback(() => {
    if (nomeando && nomeTmp.trim()) void controller.salvarFavorito(nomeando, nomeTmp);
    setNomeando(null);
    setNomeTmp('');
  }, [controller, nomeando, nomeTmp]);

  // ── arrastar e soltar arquivos ──
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      controller.sendDroppedFiles(e.dataTransfer.files);
      setShowDrawer(true);
    }
  };

  const emAndamento = state.transfers.filter((t) => t.state === 'ativo' || t.state === 'aguardando').length;

  return (
    <div
      ref={containerRef}
      className={`viewer ${dragging ? 'dragging' : ''} ${outgoing.instavel ? 'instavel' : ''} ${
        state.abas.length > 1 ? 'tem-abas' : ''
      }`}
      onPointerMove={revelarBarra}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {/* A barra de abas só aparece quando há mais de uma conexão. Com uma
          só, ela seria uma faixa ocupando altura da tela remota para não
          informar nada — e altura é exatamente o que falta aqui. */}
      {state.abas.length > 1 && (
        <BarraDeAbas
          abas={state.abas}
          ativa={state.abaAtiva}
          onEscolher={(peerId) => controller.selecionarAba(peerId)}
          onFechar={(peerId) => controller.disconnect(peerId)}
          onNova={() => setNovaConexao(true)}
        />
      )}

      {novaConexao && (
        <NovaConexao controller={controller} state={state} onClose={() => setNovaConexao(false)} />
      )}

      {confirmandoGamer && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setConfirmandoGamer(false)}>
          <div className="modal" style={{ maxWidth: 440 }}>
            <h2>
              <IconGamepad /> Modo Gamer
            </h2>
            <p>
              O mouse vai virar a mira <strong>360°</strong>, sem parar na borda da tela. Para isso, o cursor fica
              <strong> preso à tela e some</strong> enquanto você joga.
            </p>
            <p className="atalho-saida">
              Para SAIR do Modo Gamer, aperte <b>Ctrl + G</b>.
            </p>
            <p className="hint">
              Guarde esse atalho: com o cursor preso, não dá para clicar no botão para desligar. Enquanto o modo
              estiver ligado, o Ctrl+G não chega ao jogo — fica reservado para a saída.
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmandoGamer(false)}>
                Cancelar
              </button>
              <button className="btn primary" onClick={confirmarGamer} autoFocus>
                OK, entendi o Ctrl+G
              </button>
            </div>
          </div>
        </div>
      )}

      {nomeando && (
        <div className="nomear-conexao" onPointerDown={(e) => e.stopPropagation()}>
          <div className="nomear-cartao">
            <strong>Salvar esta conexão?</strong>
            <span className="hint">
              Dê um nome para reconhecê-la depois — ela aparece por ele em vez do número
              {' '}({formatId(nomeando)}).
            </span>
            <input
              className="input"
              autoFocus
              value={nomeTmp}
              onChange={(e) => setNomeTmp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') salvarNome();
              }}
              placeholder="Ex.: Servidor da loja"
              maxLength={40}
            />
            <div className="nomear-acoes">
              <button className="btn ghost sm" onClick={() => { setNomeando(null); setNomeTmp(''); }}>
                Agora não
              </button>
              <button className="btn primary sm" disabled={!nomeTmp.trim()} onClick={salvarNome}>
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* O `key` recria o elemento a cada troca de aba: sem ele, o React
          reaproveitaria o mesmo <video> e o fluxo anterior continuaria
          pintado até o novo chegar, mostrando por um instante a tela do
          computador errado. */}
      <video
        key={outgoing.peerId}
        ref={videoRef}
        className={conectandoNestaAba ? 'apagado' : ''}
        autoPlay
        playsInline
        muted={false}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        onDragStart={(e) => e.preventDefault()}
        onLoadedMetadata={posicionarMarca}
      />

      {/* Modo Gamer ligado, mas o ponteiro ainda solto: o navegador só trava
          num clique, então avisamos o que fazer. Some assim que trava. */}
      {gamer && !travado && !conectandoNestaAba && (
        <div className="gamer-aviso" onPointerDown={() => videoRef.current?.requestPointerLock?.()}>
          <strong>Modo Gamer ligado</strong>
          <span>Clique na tela para jogar — a mira gira 360°. O cursor fica preso e some.</span>
          <div className="gamer-sens" onPointerDown={(e) => e.stopPropagation()}>
            <span>Sensibilidade da mira</span>
            <div className="gamer-sens-ctrl">
              <button onClick={() => ajustarSens(-0.5)} aria-label="Diminuir sensibilidade">−</button>
              <b>{sensGamer.toFixed(1)}×</b>
              <button onClick={() => ajustarSens(0.5)} aria-label="Aumentar sensibilidade">+</button>
            </div>
            <span className="hint">Precisa arrastar muito para virar? Aumente. Girou rápido demais? Diminua.</span>
          </div>
          <span className="gamer-saida">Para sair a qualquer momento: <b>Ctrl+G</b> · Esc {escMinimiza ? 'minimiza' : 'vai para o jogo'}</span>
        </div>
      )}

      {/* Lembrete permanente enquanto o ponteiro está preso: com o cursor
          sumido, este é o único jeito de saber como sair sem decorar o atalho.
          Discreto, num canto, para não atrapalhar o jogo. */}
      {gamer && travado && (
        <div className="gamer-preso">
          🎮 Modo Gamer — <b>Ctrl+G</b> para sair
        </div>
      )}

      {/* Discagem da aba nova, por dentro do visualizador. A tela cheia de
          "conectando" só faz sentido na primeira conexão, quando não há nada
          atrás; aqui atrás existem sessões em uso. */}
      {conectandoNestaAba && (
        <div className="aba-discando">
          <div className="aba-discando-cartao">
            <span className="spinner" />
            <strong>{formatId(outgoing.peerId)}</strong>
            <span>{TEXTO_FASE[outgoing.phase]}</span>
            <button className="btn ghost sm" onClick={() => controller.disconnect(outgoing.peerId)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* A seta do outro computador, no desenho claro e padrão — a vermelha é
          a sua, e vem do cursor do sistema (ver styles.css). Nasce escondida:
          só aparece quando a posição de lá se descola da que você comanda, ou
          seja, quando a pessoa que está lá pega o mouse dela. */}
      <div className="seta-remota propria" ref={marcaRef} aria-hidden="true">
        <svg width="16" height="23" viewBox="0 0 16 23">
          <path
            d="M1.6 1.2 L1.6 17 L5.4 13.4 L8 19.9 L10.7 18.8 L8.1 12.5 L13.2 12.5 Z"
            fill="#f2f6ff"
            stroke="#1b2438"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        <span>{outgoing.meta?.hostName ?? 'computador remoto'}</span>
      </div>

      <Toolbar
        controller={controller}
        state={state}
        visible={toolbarVisible}
        fullscreen={fullscreen}
        pendingTransfers={emAndamento}
        onToggleFullscreen={() => {
          const next = !fullscreen;
          setFullscreen(next);
          window.ryke.window.fullscreen(next);
        }}
        onMinimize={sairDaSessao}
        onToggleDrawer={() => setShowDrawer((v) => !v)}
        onNovaConexao={() => setNovaConexao(true)}
        capturaTotal={capturaTotal}
        capturaDisponivel={capturaDisponivel}
        onToggleCaptura={() => setCapturaTotal((v) => !v)}
        gamer={gamer}
        onToggleGamer={alternarGamer}
        escMinimiza={escMinimiza}
        onToggleEsc={alternarEsc}
      />

      {showDrawer && (
        <TransferDrawer controller={controller} transfers={state.transfers} onClose={() => setShowDrawer(false)} />
      )}

      {outgoing.stats === null && (
        <div style={{ position: 'absolute', bottom: 16, left: 16, fontSize: 12, color: 'var(--text-faint)' }}>
          Recebendo a imagem de {formatId(outgoing.peerId)}…
        </div>
      )}
    </div>
  );
}

function temControle(pressionadas: Set<string>): boolean {
  return pressionadas.has('ControlLeft') || pressionadas.has('ControlRight');
}

/** Campos da própria interface do Ryke Desk não devem virar tecla remota. */
function isTypingLocally(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

// ─────────────────────── barra de ferramentas ─────────────────────

function Toolbar({
  controller,
  state,
  visible,
  fullscreen,
  pendingTransfers,
  onToggleFullscreen,
  onMinimize,
  onToggleDrawer,
  onNovaConexao,
  capturaTotal,
  capturaDisponivel,
  onToggleCaptura,
  gamer,
  onToggleGamer,
  escMinimiza,
  onToggleEsc,
}: {
  controller: Controller;
  state: State;
  visible: boolean;
  fullscreen: boolean;
  pendingTransfers: number;
  onToggleFullscreen: () => void;
  onMinimize: () => void;
  onToggleDrawer: () => void;
  onNovaConexao: () => void;
  capturaTotal: boolean;
  capturaDisponivel: boolean;
  onToggleCaptura: () => void;
  gamer: boolean;
  onToggleGamer: () => void;
  escMinimiza: boolean;
  onToggleEsc: () => void;
}): React.JSX.Element {
  const [menu, setMenu] = useState<'monitor' | 'teclas' | 'qualidade' | null>(null);
  const outgoing = state.outgoing!;
  const stats = outgoing.stats;
  const displays = outgoing.meta?.displays ?? [];

  const toggle = (name: typeof menu) => () => setMenu((atual) => (atual === name ? null : name));

  return (
    <div className={`toolbar ${visible || menu ? '' : 'hidden'}`} onPointerDown={(e) => e.stopPropagation()}>
      <span className="grip">
        <IconGrip />
      </span>

      <span className="tool" style={{ cursor: 'default' }}>
        {outgoing.meta?.hostName ?? formatId(outgoing.peerId)}
      </span>

      {/* Com uma aba só, a barra de abas fica escondida — e este vira o único
          caminho para abrir a segunda. Sem ele, o recurso existiria mas
          ninguém chegaria nele partindo de uma conexão em andamento. */}
      <button className="tool" onClick={onNovaConexao} data-dica="Conecta a mais um computador numa nova aba, sem encerrar esta.">
        <IconPlus />
        Nova aba
      </button>

      <span className="tool-sep" />

      <div className="tool-menu">
        <button className={`tool ${menu === 'monitor' ? 'on' : ''}`} onClick={toggle('monitor')}>
          <IconMonitor />
          Telas
        </button>
        {menu === 'monitor' && (
          <div className="menu">
            <div className="menu-label">Tela exibida</div>
            {displays.length === 0 && <div className="menu-item">Atualizando telas…</div>}
            {displays.map((display) => (
              <button
                key={display.id}
                className={`menu-item ${display.id === outgoing.meta?.activeDisplay ? 'active' : ''}`}
                onClick={() => {
                  controller.selectDisplay(display.id);
                  setMenu(null);
                }}
              >
                {display.label}
                {display.primary && <small>principal</small>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="tool-menu">
        <button className={`tool ${menu === 'teclas' ? 'on' : ''}`} onClick={toggle('teclas')}>
          <IconKeyboard />
          Teclas
        </button>
        {menu === 'teclas' && (
          <div className="menu">
            <div className="menu-label">Enviar combinação</div>
            {COMBOS.map((combo) => (
              <button
                key={combo.label}
                className="menu-item"
                onClick={() => {
                  controller.sendCombo(combo.codes);
                  setMenu(null);
                }}
              >
                {combo.label}
                <small>{combo.hint}</small>
              </button>
            ))}
            <div className="menu-label">Atalhos desta janela</div>
            <div className="menu-item" style={{ pointerEvents: 'none' }}>
              Ctrl+Alt+Shift+X <small>encerrar</small>
            </div>
            <div className="menu-item" style={{ pointerEvents: 'none' }}>
              Ctrl+Alt+Shift+F <small>tela cheia</small>
            </div>
          </div>
        )}
      </div>

      <div className="tool-menu">
        <button className={`tool ${menu === 'qualidade' ? 'on' : ''}`} onClick={toggle('qualidade')}>
          <IconMonitor />
          Imagem
        </button>
        {menu === 'qualidade' && (
          <div className="menu">
            <div className="menu-label">Qualidade da imagem</div>
            {(
              [
                ['auto', 'Automática', 'Mede a rede e ajusta sozinha — recomendado'],
                ['alta', 'Alta', 'O máximo que a rede e a máquina derem'],
                ['media', 'Média', 'Meio-termo fixo, sem ajuste automático'],
                ['baixa', 'Baixa', 'Para internet fraca: leve e sem travar'],
              ] as [Quality, string, string][]
            ).map(([valor, titulo, descricao]) => (
              <button
                key={valor}
                className={`menu-item ${outgoing.quality === valor ? 'active' : ''}`}
                onClick={() => {
                  controller.setQuality(valor);
                  setMenu(null);
                }}
              >
                {titulo}
                <small>{descricao}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        className="tool"
        onClick={() => controller.sendCombo(['ControlLeft', 'AltLeft', 'Delete'])}
        data-dica="Manda Ctrl+Alt+Del para o computador remoto. A tecla física do seu teclado nunca chega lá — o Windows reserva essa combinação para o computador em uso, por isso ela precisa vir daqui."
      >
        <IconShield />
        Ctrl+Alt+Del
      </button>

      <button className={`tool ${pendingTransfers > 0 ? 'on' : ''}`} onClick={onToggleDrawer}>
        <IconFiles />
        Arquivos
        {pendingTransfers > 0 && <span className="badge">{pendingTransfers}</span>}
      </button>

      <button
        className="tool"
        onClick={() => controller.runRemoteInstaller()}
        data-dica="Escolhe um arquivo .exe ou .msi no computador remoto e o inicia como administrador, sem a conexão parar na tela protegida do UAC."
      >
        <IconShield />
        Instalar
      </button>

      {/* Ícone sozinho não explica nada: as duas chaves abaixo mexem em coisas
          sérias — uma tranca o teclado de quem está no outro computador, a
          outra tira os atalhos deste aqui. Ambas dizem o que fazem ao passar o
          mouse, e o rótulo mostra em qual estado estão. */}
      <button
        className={`tool ${outgoing.blockingLocalInput ? 'on' : ''}`}
        onClick={() => controller.toggleBlockLocalInput()}
        data-dica={
          outgoing.blockingLocalInput
            ? 'O teclado e o mouse FÍSICOS do outro computador estão travados: quem estiver sentado lá não consegue interferir. Clique para liberar.'
            : 'Trava o teclado e o mouse físicos do outro computador, para que ninguém sentado lá atrapalhe o que você está fazendo.'
        }
      >
        <IconLock />
        {outgoing.blockingLocalInput ? 'Travado' : 'Travar lá'}
      </button>

      <button
        className={`tool ${capturaTotal && capturaDisponivel ? 'on' : ''}`}
        onClick={onToggleCaptura}
        data-dica={
          !capturaDisponivel
            ? 'O Windows não permitiu instalar a captura total neste computador. As teclas comuns continuam indo; Ctrl+Shift+Esc e a tecla Windows ficam agindo aqui.'
            : capturaTotal
              ? 'Ligada: Ctrl+Shift+Esc, a tecla Windows e Alt+Tab agem no computador REMOTO. Este computador fica sem esses atalhos enquanto a janela estiver na frente. Ctrl+Alt+Shift+X continua encerrando a sessão.'
              : 'Desligada: Ctrl+Shift+Esc e a tecla Windows agem NESTE computador. Ligue para mandar todas as teclas para o outro lado.'
        }
      >
        <IconKeyboard />
        {!capturaDisponivel ? 'Teclas: parcial' : capturaTotal ? 'Teclas: todas lá' : 'Teclas: só as comuns'}
      </button>

      <button
        className={`tool ${gamer ? 'on' : ''}`}
        onClick={onToggleGamer}
        data-dica={
          gamer
            ? 'Modo Gamer ligado: o mouse gira a mira 360° sem travar na borda. Clique na tela para prender o ponteiro; o cursor SOME enquanto joga. Para sair, aperte Ctrl+G (o cursor não alcança este botão com o ponteiro preso). Jogos com anticheat podem recusar o controle.'
            : 'Liga o controle de jogo: o mouse vira o personagem 360°, sem parar na borda. ATENÇÃO: o cursor fica PRESO à tela e some — para desligar use o atalho Ctrl+G, não dá para clicar aqui. É o que faz jogos de tiro funcionarem pelo acesso remoto.'
        }
      >
        <IconGamepad />
        {gamer ? 'Gamer: ligado' : 'Modo Gamer'}
      </button>

      <button
        className={`tool ${!escMinimiza ? 'on' : ''}`}
        onClick={onToggleEsc}
        data-dica={
          escMinimiza
            ? 'O Esc hoje minimiza a sessão. Clique para DESATIVAR: o Esc passa a ir para o jogo/programa remoto (abrir menu, pausar) em vez de minimizar.'
            : 'Esc desativado: ele vai para o outro computador. Para minimizar, use este botão para reativar, ou Ctrl+Alt+Shift+X para encerrar.'
        }
      >
        <IconEscape />
        {escMinimiza ? 'Desativar Esc' : 'Esc: vai pro jogo'}
      </button>

      <button
        className="tool"
        onClick={onToggleFullscreen}
        data-dica="Tela cheia (Ctrl+Alt+Shift+F). Sair da tela cheia usa o mesmo atalho."
      >
        {fullscreen ? <IconExitFullscreen /> : <IconFullscreen />}
      </button>

      <span className="tool-sep" />

      <button
        className="tool"
        onClick={onMinimize}
        title="Minimizar o Ryke Desk"
        aria-label="Minimizar o Ryke Desk"
      >
        <IconMinus />
        Minimizar
      </button>

      {stats && (
        <span className="tool-stats">
          <span>
            <b>{stats.width}×{stats.height}</b>
          </span>
          <span>
            <b>{stats.fps}</b> qps
          </span>
          <span title="Ida e volta até o outro computador">
            <b>{stats.rtt}</b> ms
          </span>
          {stats.atraso > 0 && (
            <span title="Atraso da imagem: o tempo entre o quadro sair de lá e aparecer aqui">
              <b>{stats.atraso}</b> ms img
            </span>
          )}
          <span>
            <b>{(stats.kbps / 1000).toFixed(1)}</b> Mb/s
          </span>
          <span>{stats.transport}</span>
        </span>
      )}

      {/* Sessão adoecida: a imagem congela e o ponteiro remoto some junto com
          ela. Sem este aviso — e sem devolver o cursor local, escondido por
          CSS — a tela fica morta e o usuário não tem como saber o que houve. */}
      {outgoing.instavel && (
        <div className="reconectando">
          <span className="giro-pequeno" />
          <span>
            <strong>Reconectando…</strong> a conexão parou de responder e está sendo refeita. A sessão continua
            aberta — não é preciso fazer nada.
          </span>
        </div>
      )}

      {state.confirmacaoQualidade && (
        <div className="confirma-qualidade">
          <div className="confirma-texto">
            <strong>A qualidade alta está funcionando?</strong>
            <span>
              Se a imagem travou ou ficou atrasada, não clique em nada — em{' '}
              <b>{state.confirmacaoQualidade.segundos}s</b> a qualidade anterior volta sozinha.
            </span>
          </div>
          <button className="btn sm" onClick={() => controller.desfazerQualidade()}>
            Desfazer agora
          </button>
          <button className="btn sm primary" onClick={() => controller.confirmarQualidade()}>
            OK, manter
          </button>
        </div>
      )}

      <button className="tool exit" onClick={() => controller.disconnect()} title="Encerrar (Ctrl+Alt+Shift+X)">
        <IconPower />
        Encerrar
      </button>
    </div>
  );
}

// ───────────────────── painel de transferências ───────────────────

function TransferDrawer({
  controller,
  transfers,
  onClose,
}: {
  controller: Controller;
  transfers: TransferView[];
  onClose: () => void;
}): React.JSX.Element {
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <h3>Arquivos</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar painel">
          <IconX />
        </button>
      </div>

      <div className="drawer-body">
        {transfers.length === 0 ? (
          <div className="empty">
            Nenhum arquivo ainda.
            <br />
            Arraste um arquivo para cima da tela remota, ou use o botão abaixo.
          </div>
        ) : (
          transfers.map((transfer) => (
            <TransferRow key={transfer.id} transfer={transfer} onCancel={() => controller.cancelTransfer(transfer.id)} />
          ))
        )}
      </div>

      <div className="drawer-foot">
        <div className="dropzone">
          Arraste arquivos para esta janela
          <br />
          ou copie um arquivo no Explorador e clique no aviso que aparece
        </div>
        <button className="btn block" onClick={() => void controller.sendFileFromDialog()}>
          <IconSend />
          Escolher arquivo para enviar
        </button>
        <span className="hint">Limite de 500 MB por arquivo.</span>
      </div>
    </aside>
  );
}

function TransferRow({ transfer, onCancel }: { transfer: TransferView; onCancel: () => void }): React.JSX.Element {
  const pct = transfer.size > 0 ? Math.min(100, (transfer.transferred / transfer.size) * 100) : 0;
  const concluido = transfer.state === 'concluido';
  const falhou = transfer.state === 'erro' || transfer.state === 'recusado' || transfer.state === 'cancelado';
  const ativo = transfer.state === 'ativo' || transfer.state === 'aguardando';

  return (
    <div className="transfer">
      <div className="transfer-top">
        <span className="arrow">{transfer.direction === 'enviando' ? <IconArrowUp /> : <IconArrowDown />}</span>
        <span className="transfer-name" title={transfer.name}>
          {transfer.name}
        </span>
        {ativo && (
          <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={onCancel} title="Cancelar">
            <IconX />
          </button>
        )}
        {concluido && transfer.path && (
          <button
            className="icon-btn"
            style={{ width: 24, height: 24 }}
            onClick={() => void window.ryke.files.reveal(transfer.path!)}
            title="Mostrar na pasta"
          >
            <IconFolder />
          </button>
        )}
      </div>

      <div className="progress">
        <div className={`progress-fill ${concluido ? 'done' : falhou ? 'bad' : ''}`} style={{ width: `${concluido ? 100 : pct}%` }} />
      </div>

      <div className="transfer-meta">
        <span>
          {concluido
            ? `Concluído · ${formatBytes(transfer.size)}`
            : falhou
              ? (transfer.message ?? estadoLegivel(transfer.state))
              : `${formatBytes(transfer.transferred)} de ${formatBytes(transfer.size)}`}
        </span>
        {ativo && transfer.rate > 0 && <span>{formatBytes(transfer.rate)}/s</span>}
      </div>
    </div>
  );
}

function estadoLegivel(state: TransferView['state']): string {
  switch (state) {
    case 'recusado':
      return 'Recusado pelo outro computador';
    case 'cancelado':
      return 'Cancelado';
    case 'erro':
      return 'Falhou';
    default:
      return '';
  }
}
