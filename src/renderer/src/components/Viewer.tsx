import { useCallback, useEffect, useRef, useState } from 'react';
import { formatId, formatBytes } from '../../../shared/protocol';
import { COMBOS } from '../../../shared/keymap';
import type { BotaoMouse } from '../../../shared/botoes';
import { mascaraDe } from '../../../shared/gesto-mouse';
import { pointerToFraction, wheelToTicks, type Fraction } from '../lib/geometry';
import {
  corDoPonteiro,
  cursorCssDaSeta,
  svgDaSeta,
  svgDoCursorSozinho,
  hotspotDaSeta,
  type Ponteiro,
  type TipoCursor,
} from '../../../shared/ponteiros';
import {
  ALCANCE_JANELADO,
  decidirBarra,
  FAIXA_COM_ABAS,
  FAIXA_JANELADO,
  FAIXA_JANELADO_COM_ABAS,
} from '../lib/barra';
import type { Controller, Outgoing, State } from '../lib/controller';
import type { LiveStats, Quality } from '../lib/session';
import type { TransferView } from '../lib/files';
import {
  IconMonitor, IconKeyboard, IconFiles, IconFullscreen, IconExitFullscreen, IconJanela,
  IconPower, IconGrip, IconX, IconArrowUp, IconArrowDown, IconFolder, IconLock, IconSend,
  IconMinus, IconShield, IconPlus, IconGamepad, IconEscape, IconSquare,
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

/**
 * A cor da seta do ANFITRIÃO: clara e neutra, sem entrar na paleta dos
 * visitantes. Ela muda de FORMA conforme o cursor de lá, mas não de cor — é a
 * ausência de cor que a identifica como "o dono da máquina".
 */
const COR_ANFITRIAO = {
  nome: '',
  fill: '#f2f6ff',
  stroke: '#1b2438',
  etiqueta: '#1b2438',
  texto: '#f2f6ff',
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
  const [maximizada, setMaximizada] = useState(true);
  /**
   * A sessão está numa janela solta, no meio da tela?
   *
   * Isto muda duas regras, e as duas por causa da mesma coisa: sem moldura e
   * sem encostar na borda do monitor, a janela perde os dois gestos que a
   * interface inteira assumia existir.
   *
   *   1. A barra deixa de se esconder. Ela abre quando o cursor ENCOSTA no
   *      topo, e encostar só é um gesto confiável quando o sistema prende o
   *      cursor na borda da tela — coisa que só acontece com a janela colada
   *      lá em cima. Numa janela solta é preciso acertar dois pixels com a
   *      mão, e errar significa ficar sem nenhum caminho para sair do modo.
   *
   *   2. Aparece uma faixa para arrastar. A janela não tem moldura: sem essa
   *      faixa não há por onde pegá-la para mudá-la de lugar.
   */
  const janelado = !fullscreen && !maximizada;
  const [showDrawer, setShowDrawer] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mostrarDiag, setMostrarDiag] = useState(false);
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
      // Teto alto de propósito. O movimento atravessa a aceleração de dois
      // Windows, e mesmo com a mira já não travando na borda há mouse de DPI
      // baixo que precisa de muito mais do que 10× para dar a volta completa
      // com um arrasto só.
      const novo = Math.min(25, Math.max(0.5, Math.round((s + delta) * 10) / 10));
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
  // O estado da janela vem do processo principal: maximizar pelo atalho do
  // Windows, restaurar com dois cliques na barra ou o botão Janela daqui
  // passam todos por lá, e a interface precisa acompanhar qualquer um deles.
  useEffect(() => {
    void window.ryke.window.state().then((s) => {
      setMaximizada(s.maximized);
      setFullscreen(s.fullscreen);
    });
    return window.ryke.window.onState((s) => {
      setMaximizada(s.maximized);
      setFullscreen(s.fullscreen);
    });
  }, []);

  useEffect(() => {
    const aoMudar = (): void => setTravado(document.pointerLockElement === videoRef.current);
    document.addEventListener('pointerlockchange', aoMudar);
    return () => document.removeEventListener('pointerlockchange', aoMudar);
  }, []);

  /**
   * Conta ao anfitrião que estamos jogando.
   *
   * Amarrado à trava do ponteiro, e não ao botão do Modo Gamer, porque é a
   * trava que define o estado real: com o modo ligado mas o ponteiro solto
   * (Alt+Tab, foco perdido) a pessoa está de volta ao computador dela, e a
   * seta precisa reaparecer do outro lado.
   *
   * Do lado de lá, isto apaga a seta virtual deste visitante — num jogo quem
   * desenha a mira é o jogo — e prende o ponteiro real no centro da tela, que
   * é o que impede a câmera de travar ao encostar na borda.
   */
  useEffect(() => {
    if (!session) return;
    session.sendGamer(travado);
    // Soltar ao desmontar: sair da aba com o modo ligado deixaria o anfitrião
    // achando que o jogo continua, sem seta e com o ponteiro preso no centro.
    return () => session.sendGamer(false);
  }, [session, travado]);

  useEffect(() => {
    if (!session) return;

    const soltarTudo = (): void => {
      for (const code of pressed.current) session.sendKey(code, false);
      pressed.current.clear();
      // E os BOTÕES do mouse também. Apertar o botão e sair da janela — Alt+Tab
      // no meio de um arrasto — nunca gerava o "soltar": o botão ficava
      // apertado na máquina da outra pessoa, e ela via tudo ser selecionado e
      // arrastado sem tocar em nada. É o mesmo motivo das teclas, e ficou de
      // fora quando isto foi escrito.
      for (const botao of segurando.current) session.sendMouseButton(botao, false, lastPoint.current.x, lastPoint.current.y);
      segurando.current.clear();
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

  // ── as setas ──
  //
  // Numa sessão com três pessoas há três setas na tela, e a regra que as
  // distingue é sempre a mesma:
  //
  //   • A SUA é o cursor do próprio Windows DESTA máquina, trocado por um
  //     desenho colorido com o seu nome embaixo. Vermelho para quem conectou
  //     primeiro, azul para o segundo, verde para o terceiro. Continua sendo o
  //     cursor do sistema, então continua instantâneo: quem o move é o
  //     Windows, não esta página, e nenhum quadro de atraso se interpõe entre
  //     a sua mão e o que você vê.
  //
  //   • A DO ANFITRIÃO é a branca, sem cor nenhuma — é justamente a ausência
  //     de cor que a identifica. Ela obedece só a quem está sentado lá, e a
  //     posição vem pelo canal rápido, lida do Windows de lá.
  //
  //   • AS DOS OUTROS VISITANTES são coloridas como a sua, com o nome de cada
  //     um, e chegam na mesma mensagem.
  //
  // A seta desenhada DENTRO do vídeo não serve para nada disso: chega com o
  // atraso da imagem, e ver o ponteiro responder meio segundo depois da mão
  // torna qualquer trabalho fino insuportável.
  const marcaRef = useRef<HTMLDivElement>(null);
  /**
   * "Aquele clique não chegou: ali é uma janela de administrador."
   *
   * Sai de cena sozinho. Um aviso que fica na tela vira sujeira; o que ele
   * precisa é aparecer no instante do clique, onde a pessoa clicou, e sumir.
   */
  const [avisoAdmin, setAvisoAdmin] = useState<{ x: number; y: number; id: number } | null>(null);
  const cursorRemoto = useRef<Fraction>({ x: 0.5, y: 0.5 });
  /**
   * A forma da seta do ANFITRIÃO (viga de texto, redimensionar, mãozinha…).
   *
   * No ref para `posicionarMarca` ler o hotspot sem re-render; no estado para o
   * desenho ser refeito quando — e só quando — a forma muda.
   */
  const hostTipo = useRef<TipoCursor>('default');
  const [hostTipoDesenho, setHostTipoDesenho] = useState<TipoCursor>('default');
  /** A forma da SUA seta, que troca o cursor do sistema (nítido, sem atraso). */
  const [minhaForma, setMinhaForma] = useState<TipoCursor>('default');
  /** Último ponto que ESTA máquina mandou — a régua para saber quem mexeu. */
  const lastPoint = useRef<Fraction>({ x: 0.5, y: 0.5 });

  /** Quem é você nesta sessão: a cor da sua seta e o nome escrito nela. */
  const [minhaCor, setMinhaCor] = useState<{ indice: number; nome: string } | null>(null);
  /**
   * A mesma cor, num ref.
   *
   * O ouvinte de `ponteiros` é registrado uma vez e capturaria o valor do
   * primeiro render para sempre. Um ref é lido no momento em que o pacote
   * chega, que é quando a informação precisa estar certa.
   */
  const minhaCorRef = useRef<number | null>(null);
  /** As setas dos DEMAIS visitantes. Estado, porque entram e saem devagar. */
  const [outrasSetas, setOutrasSetas] = useState<Ponteiro[]>([]);
  /** Onde cada uma está agora — fora do estado, porque muda 60 vezes por segundo. */
  const posicoesOutras = useRef(new Map<string, Fraction>());
  const refsOutras = useRef(new Map<string, HTMLDivElement>());

  /**
   * De fração da tela remota para pixel dentro desta janela.
   *
   * O vídeo é desenhado com `object-fit: contain`, então sobra faixa preta de
   * um dos lados e a imagem não ocupa o elemento inteiro. Sem descontar essa
   * faixa, toda seta apareceria deslocada — e o erro cresce quanto mais a
   * proporção da janela diferir da proporção da tela remota.
   */
  const ondeNaTela = useCallback((ponto: Fraction): { x: number; y: number } | null => {
    const video = videoRef.current;
    const palco = containerRef.current;
    if (!video || !palco) return null;
    const r = video.getBoundingClientRect();
    const { videoWidth, videoHeight } = video;
    if (!videoWidth || !videoHeight || r.width === 0) return null;
    const escala = Math.min(r.width / videoWidth, r.height / videoHeight);
    const largura = videoWidth * escala;
    const altura = videoHeight * escala;
    const p = palco.getBoundingClientRect();
    return {
      x: r.left + (r.width - largura) / 2 + ponto.x * largura - p.left,
      y: r.top + (r.height - altura) / 2 + ponto.y * altura - p.top,
    };
  }, []);

  const posicionarMarca = useCallback(() => {
    const marca = marcaRef.current;
    if (marca) {
      const onde = ondeNaTela(cursorRemoto.current);
      // Desconta o hotspot da forma atual, para o ponto ativo do desenho (a
      // ponta da seta, o centro da viga…) cair exatamente onde o cursor está.
      if (onde) {
        const h = hotspotDaSeta(hostTipo.current);
        marca.style.transform = `translate(${onde.x - h.x}px, ${onde.y - h.y}px)`;
      }
    }
    for (const [id, el] of refsOutras.current) {
      const ponto = posicoesOutras.current.get(id);
      if (!ponto) continue;
      const onde = ondeNaTela(ponto);
      if (onde) el.style.transform = `translate(${onde.x}px, ${onde.y}px)`;
    }
  }, [ondeNaTela]);

  useEffect(() => {
    if (!avisoAdmin) return;
    const relogio = window.setTimeout(() => setAvisoAdmin(null), 2600);
    return () => window.clearTimeout(relogio);
  }, [avisoAdmin]);

  useEffect(() => {
    if (!session) return;
    const soltas = [
      session.on('cursor', (ponto) => {
        cursorRemoto.current = ponto;
        const tipo = ponto.tipo ?? 'default';
        if (tipo !== hostTipo.current) {
          hostTipo.current = tipo;
          setHostTipoDesenho(tipo);
        }
        posicionarMarca();
      }),
      // O clique caiu numa janela elevada e o Windows o descartou. Sem este
      // aviso a sessão parece travada — foi o que acontecia ao clicar em
      // "Concluir" num instalador, que cobre a tela e nunca fecha.
      session.on('precisaAdmin', (ponto) => setAvisoAdmin({ ...ponto, id: Date.now() })),
      // A SUA seta: o anfitrião diz que forma o cursor teria onde você aponta.
      session.on('formaPropria', (tipo) => setMinhaForma(tipo)),
      session.on('cor', (cor) => {
        minhaCorRef.current = cor.indice;
        setMinhaCor(cor);
      }),
      session.on('ponteiros', (lista) => {
        // Cinto e suspensório: o anfitrião já tira a seta de cada um da lista
        // que manda para ele, mas se algum dia isso falhar o resultado é feio e
        // difícil de diagnosticar — duas setas da mesma cor quase sobrepostas,
        // a de verdade e o eco dela chegando pela rede um quadro atrás.
        //
        // A cor serve de assinatura porque ela é única entre os conectados:
        // `proximaCorLivre` nunca entrega a mesma cor a duas pessoas ao mesmo
        // tempo. Então "esta seta tem a minha cor" só pode significar "esta
        // seta sou eu".
        const minha = minhaCorRef.current;
        if (minha !== null) lista = lista.filter((p) => p.cor !== minha);

        for (const p of lista) posicoesOutras.current.set(p.id, { x: p.x, y: p.y });
        // A lista só vira estado quando MUDA de composição — alguém entrou,
        // alguém saiu, alguém trocou de nome. Redesenhar a árvore do React
        // vinte vezes por segundo para mover dois elementos seria pagar caro
        // por algo que uma linha de `transform` resolve.
        setOutrasSetas((antes) => {
          const igual =
            antes.length === lista.length &&
            antes.every(
              (a, i) =>
                a.id === lista[i].id &&
                a.cor === lista[i].cor &&
                a.nome === lista[i].nome &&
                a.tipo === lista[i].tipo,
            );
          if (igual) return antes;
          for (const id of [...posicoesOutras.current.keys()]) {
            if (!lista.some((p) => p.id === id)) posicoesOutras.current.delete(id);
          }
          return lista;
        });
        posicionarMarca();
      }),
    ];
    window.addEventListener('resize', posicionarMarca);
    return () => {
      for (const solta of soltas) solta();
      window.removeEventListener('resize', posicionarMarca);
    };
  }, [session, posicionarMarca]);

  /**
   * A sua seta, pintada no cursor do sistema.
   *
   * É uma variável CSS e não uma classe porque a cor só é conhecida quando o
   * anfitrião responde — e enquanto ele não responde, o CSS tem um vermelho de
   * partida, que é a cor de quem conecta sozinho (o caso mais comum de todos).
   */
  useEffect(() => {
    const palco = containerRef.current;
    if (!palco) return;
    if (!minhaCor) {
      palco.style.removeProperty('--seta-propria');
      return;
    }
    // Forma diferente da seta comum: usa o cursor NATIVO do sistema (viga de
    // texto, redimensionar, mãozinha) — nítido, com o hotspot certo e sem
    // atraso. Perde a cor por um instante, mas você sabe que é você, e a forma é
    // o que importa ali. Na seta comum, volta a ser a colorida com o seu nome.
    if (minhaForma && minhaForma !== 'default') {
      palco.style.setProperty('--seta-propria', minhaForma);
    } else {
      palco.style.setProperty('--seta-propria', cursorCssDaSeta(corDoPonteiro(minhaCor.indice), minhaCor.nome));
    }
  }, [minhaCor, minhaForma]);

  // Reposiciona quando a lista muda: um elemento recém-criado nasce em (0,0) e
  // ficaria no canto até o próximo pacote chegar.
  useEffect(() => {
    posicionarMarca();
  }, [outrasSetas, posicionarMarca]);

  // ── mouse ──
  const pendingMove = useRef<Fraction | null>(null);
  const rafId = useRef<number | null>(null);

  /** Deslocamento acumulado do Modo Gamer, somado entre quadros. */
  const pendingRel = useRef({ dx: 0, dy: 0 });
  /**
   * Quais botões esta mão está segurando agora.
   *
   * Vai carimbado em cada movimento. É o que permite ao anfitrião saber que
   * aquele movimento faz parte de um arrasto mesmo que o "apertar" ainda não
   * tenha chegado — ver shared/gesto-mouse.ts.
   */
  const segurando = useRef(new Set<BotaoMouse>());

  const flushMove = useCallback(() => {
    rafId.current = null;
    if (!session) return;
    // Relativo (Modo Gamer): manda a SOMA do quadro. Somar, e não substituir,
    // é o que preserva o movimento — cada quadro pode ter vários eventos, e
    // perder qualquer um deles faria a mira andar menos do que a mão.
    //
    // E manda em número INTEIRO, guardando o resto para o quadro seguinte.
    // Isto conserta uma perda silenciosa e grande: o SendInput do anfitrião
    // arredondava, e a fração era descartada a cada quadro. Num movimento
    // lento — mirar de precisão, justamente onde dói — o deslocamento por
    // quadro fica abaixo de 1, arredondava para ZERO, e a mira simplesmente
    // não saía do lugar por mais que a mão andasse. Acumulando o resto, sessenta
    // quadros de 0,4 px viram 24 px em vez de nada.
    const rel = pendingRel.current;
    const dx = Math.trunc(rel.dx);
    const dy = Math.trunc(rel.dy);
    if (dx !== 0 || dy !== 0) {
      session.sendMouseRel(dx, dy);
      rel.dx -= dx;
      rel.dy -= dy;
    }
    const point = pendingMove.current;
    pendingMove.current = null;
    if (point) session.sendMouseMove(point.x, point.y, mascaraDe(segurando.current));
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
    // Duas coisas mudam a geometria daqui, e as duas empurram a barra de menu
    // para baixo: a barra de abas (com duas ou mais conexões) e a faixa de
    // arrastar (no modo janela). A faixa que mantém a barra aberta precisa
    // alcançar os botões na posição nova, senão o cursor os perde no caminho.
    const comAbas = state.abas.length > 1;
    const faixa = janelado
      ? comAbas
        ? FAIXA_JANELADO_COM_ABAS
        : FAIXA_JANELADO
      : comAbas
        ? FAIXA_COM_ABAS
        : undefined;
    // E no modo janela o gesto que abre é passar pela faixa de arrastar, não
    // encostar em dois pixels — ver ALCANCE_JANELADO em lib/barra.ts.
    const alcance = janelado ? ALCANCE_JANELADO : undefined;
    setToolbarVisible((aberta) => decidirBarra(aberta, e.clientY, e.screenY, faixa, alcance));
  }, [state.abas.length, janelado]);

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
    if (!video || !session || e.button > 4) return;
    // Os laterais (3 = voltar, 4 = avançar) precisam ser barrados NESTA janela:
    // soltos, o Chromium os entende como navegação e sairia da tela da sessão.
    // Quem tem de voltar e avançar é o computador REMOTO, não o Ryke Desk.
    if (e.button >= 3) e.preventDefault();

    if (gamer) {
      // Fora da trava, o primeiro clique só serve para PRENDER o ponteiro — é
      // a exigência do navegador (pointer lock nasce de um gesto). Preso, o
      // clique vira tiro: aperta sem reposicionar, que o jogo mira sozinho.
      if (document.pointerLockElement !== video) {
        void video.requestPointerLock?.();
        return;
      }
      session.sendMouseRelButton(e.button as BotaoMouse, true);
      return;
    }

    // Captura o ponteiro para que arrastar até fora do vídeo continue valendo
    // (selecionar texto, mover janela remota até a borda).
    //
    // Pode recusar: o navegador exige que o pointerId ainda esteja ativo, e ele
    // deixa de estar quando o botão é solto entre o evento e esta linha. Deixar
    // a exceção subir aborta o handler antes do `sendMouseButton` logo abaixo —
    // ou seja, perde-se o CLIQUE por causa de um recurso de conforto. A captura
    // é opcional; o clique não é.
    try {
      video.setPointerCapture(e.pointerId);
    } catch {
      /* segue sem captura: arrastar para fora do vídeo é que deixa de valer */
    }
    const point = pointerToFraction(video, e.clientX, e.clientY) ?? lastPoint.current;
    lastPoint.current = point;
    // Anotado ANTES de enviar: o próximo movimento já sai carimbado como parte
    // do gesto, mesmo que este "apertar" ainda esteja na fila da rede.
    segurando.current.add(e.button as BotaoMouse);
    session.sendMouseButton(e.button as BotaoMouse, true, point.x, point.y);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLVideoElement>): void => {
    const video = videoRef.current;
    if (!video || !session || e.button > 4) return;
    // Os laterais (3 = voltar, 4 = avançar) precisam ser barrados NESTA janela:
    // soltos, o Chromium os entende como navegação e sairia da tela da sessão.
    // Quem tem de voltar e avançar é o computador REMOTO, não o Ryke Desk.
    if (e.button >= 3) e.preventDefault();

    if (gamer) {
      if (document.pointerLockElement === video) session.sendMouseRelButton(e.button as BotaoMouse, false);
      return;
    }

    if (video.hasPointerCapture(e.pointerId)) video.releasePointerCapture(e.pointerId);
    const point = pointerToFraction(video, e.clientX, e.clientY) ?? lastPoint.current;
    segurando.current.delete(e.button as BotaoMouse);
    session.sendMouseButton(e.button as BotaoMouse, false, point.x, point.y);
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
    if (e.dataTransfer.files.length === 0) return;
    // Precisa ser lido AGORA: o `dataTransfer` é esvaziado assim que o
    // manipulador retorna, e `sendDroppedFiles` é assíncrono (pergunta ao
    // disco o que é pasta e o que é arquivo).
    const arquivos = Array.from(e.dataTransfer.files);
    void controller.sendDroppedFiles(arquivos);
    setShowDrawer(true);
  };

  const emAndamento = state.transfers.filter((t) => t.state === 'ativo' || t.state === 'aguardando').length;

  return (
    <div
      ref={containerRef}
      className={`viewer ${dragging ? 'dragging' : ''} ${outgoing.instavel ? 'instavel' : ''} ${
        state.abas.length > 1 ? 'tem-abas' : ''
      } ${travado ? 'jogando' : ''} ${janelado ? 'janelado' : ''}`}
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

      {/* Painel de diagnóstico: abre pelo botão na barra, NÃO bloqueia a tela
          (pode fechar) e o texto é 100% selecionável e copiável — feito para você
          ler o que está acontecendo e colar aqui. Diz, sem rodeio, se o vídeo
          está indo pela placa (GPU) ou pelo processador. */}
      {mostrarDiag && <PainelDiagnostico outgoing={outgoing} onClose={() => setMostrarDiag(false)} />}

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

      {/* A seta do ANFITRIÃO: branca, sem cor, com o nome da máquina embaixo.
          É a única que não obedece a ninguém de fora — quem a move é a pessoa
          sentada lá. Fica sempre visível, porque agora o seu ponteiro e o dela
          são de fato independentes: não há mais o instante em que os dois
          estão no mesmo pixel por serem o mesmo ponteiro.
          A sua própria seta não está aqui: ela é o cursor do sistema, colorido
          e nomeado em styles.css / --seta-propria. */}
      <div className="seta-remota" ref={marcaRef} aria-hidden="true">
        <div
          className="seta-remota-glifo"
          dangerouslySetInnerHTML={{ __html: svgDoCursorSozinho(COR_ANFITRIAO, hostTipoDesenho) }}
        />
        <span>{outgoing.meta?.hostName ?? 'computador remoto'}</span>
      </div>

      {/* A marca de "não deu para clicar aqui". Fica exatamente sob o ponto
          clicado, porque é a única forma de a pessoa ligar o aviso ao botão que
          ela tentou apertar. */}
      {avisoAdmin &&
        (() => {
          const onde = ondeNaTela(avisoAdmin);
          if (!onde) return null;
          return (
            <div
              key={avisoAdmin.id}
              className="aviso-admin"
              style={{ transform: `translate(${onde.x}px, ${onde.y}px)` }}
              role="status"
            >
              <span className="aviso-admin-x" aria-hidden="true">
                ✕
              </span>
              <span>Esta janela exige o modo administrador</span>
            </div>
          );
        })()}

      {/* As setas das OUTRAS pessoas conectadas a este mesmo computador, cada
          uma na cor que o anfitrião lhe deu e com o nome dela embaixo. O SVG
          vem pronto do módulo compartilhado — o mesmo desenho que a camada do
          anfitrião usa, para as duas telas nunca discordarem sobre quem é quem. */}
      {outrasSetas.map((ponteiro) => (
        <div
          key={ponteiro.id}
          className="seta-visitante"
          aria-hidden="true"
          ref={(el) => {
            if (el) refsOutras.current.set(ponteiro.id, el);
            else refsOutras.current.delete(ponteiro.id);
          }}
          dangerouslySetInnerHTML={{ __html: svgDaSeta(corDoPonteiro(ponteiro.cor), ponteiro.nome, ponteiro.tipo) }}
        />
      ))}

      {/* A faixa de arrastar, só no modo janela.

          A janela não tem moldura — quem desenha a barra de título é a própria
          interface. Em tela cheia isso não faz falta, mas numa janela solta é
          a diferença entre poder pôr a sessão onde se quer e ficar preso com
          ela no meio da tela. Os botões ficam fora da área de arrasto: uma
          região `drag` engole o clique antes de ele virar clique. */}
      {janelado && !conectandoNestaAba && (
        <div className="barra-arrastar">
          <span className="barra-arrastar-nome">{outgoing.meta?.hostName ?? formatId(outgoing.peerId)}</span>
          <div className="barra-arrastar-botoes">
            <button
              onClick={() => window.ryke.window.minimize()}
              title="Minimizar"
              aria-label="Minimizar"
            >
              <IconMinus />
            </button>
            <button
              onClick={() => window.ryke.window.toggleMaximize()}
              title="Maximizar de volta"
              aria-label="Maximizar de volta"
            >
              <IconSquare />
            </button>
            <button
              onClick={() => {
                setFullscreen(true);
                window.ryke.window.fullscreen(true);
              }}
              title="Tela cheia (Ctrl+Alt+Shift+F)"
              aria-label="Tela cheia"
            >
              <IconFullscreen />
            </button>
          </div>
        </div>
      )}

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
        onJanela={() => {
          // O estado local precisa acompanhar: sem isto o botão de tela cheia
          // continuaria mostrando "sair da tela cheia" numa janela que já saiu.
          // O resto chega pelo evento `window:state` do processo principal, que
          // é quem sabe se o clique encolheu ou maximizou de volta.
          setFullscreen(false);
          window.ryke.window.janela();
        }}
        janelado={janelado}
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
        onDiagnostico={() => setMostrarDiag((v) => !v)}
        diagAberto={mostrarDiag}
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

/**
 * Nome curto da placa para caber na barra: tira as palavras de marca que só
 * ocupam espaço ("NVIDIA GeForce RTX 3060" → "RTX 3060"). O nome inteiro
 * continua no tooltip do chip, para quem quiser conferir o modelo exato.
 */
function nomeCurtoGpu(nome: string): string {
  const curto = nome
    .replace(/\b(NVIDIA|GeForce|AMD|Radeon|Intel|Corporation|\(R\)|\(TM\)|Graphics)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return curto || nome;
}

/**
 * Traduz os números da sessão numa frase: para ONDE está indo o atraso.
 *
 * A ordem das perguntas segue a probabilidade real da causa numa área de
 * trabalho remota — e cada uma corresponde a um atraso que NÃO melhora ao
 * baixar a qualidade, que é exatamente o sintoma relatado:
 *
 *   1. Conexão indireta (retransmitida): o vídeo dá uma volta por um servidor
 *      no meio. Atraso constante, alheio à qualidade. Quase sempre é o firewall
 *      do Windows barrando o caminho direto entre os dois PCs.
 *   2. Vídeo por software no anfitrião: o PROCESSADOR dele está codificando a
 *      tela em vez da placa de vídeo. Enche a fila de codificação — o clássico
 *      "digito e aparece dois segundos depois".
 *   3. Buffer/quadros: o resto, quando os dois acima estão bem.
 */
function diagnosticarSessao(
  stats: LiveStats | null,
  hostCapturaSoftware: boolean | undefined,
  hostCapturaMotivo: string | undefined,
): { tag: string; texto: string; motivo?: string; ok: boolean } | null {
  if (!stats || stats.width === 0) return null;
  if (stats.transport === 'retransmitido')
    return {
      tag: 'conexão indireta',
      texto:
        'A conexão está passando por um servidor no meio (retransmitida), em vez de ir direto entre os dois ' +
        'computadores — isso adiciona atraso constante. Libere o Ryke Desk no firewall do Windows nos dois PCs.',
      ok: false,
    };
  if (hostCapturaSoftware)
    return {
      tag: 'captura lenta',
      texto:
        'A captura de tela do computador controlado não conseguiu usar o caminho rápido do Windows e está numa ' +
        'rota reserva mais lenta. É isto que está segurando o vídeo — e é do lado de lá, não da rede.',
      // O motivo técnico real (a exceção que o Windows devolveu), sem palpite.
      motivo: hostCapturaMotivo,
      ok: false,
    };
  if (stats.atraso > 400)
    return {
      tag: 'buffer alto',
      texto: `A imagem está chegando com ${stats.atraso} ms de espera no buffer antes de aparecer.`,
      ok: false,
    };
  if (stats.fps > 0 && stats.fps < 10)
    return {
      tag: 'poucos quadros',
      texto: `A tela do PC controlado está atualizando a apenas ${stats.fps} quadros por segundo.`,
      ok: false,
    };
  return { tag: 'ok', texto: 'Conexão direta e fluida.', ok: true };
}

/**
 * Monta o texto completo do diagnóstico — feito para ser COPIADO e colado.
 *
 * Junta tudo o que importa para entender a lentidão num bloco só: se o vídeo vai
 * pela placa ou pelo processador, a rota de captura e o erro real dela, e os
 * números da rede. É o que o usuário cola aqui para a gente resolver com fato,
 * não com palpite.
 */
function montarTextoDiagnostico(outgoing: Outgoing): string {
  const s = outgoing.stats;
  const m = outgoing.meta;
  const g = m?.hostGpu;
  const capturaSoftware = m?.hostCapturaSoftware === true;
  // O que decide se o vídeo vai pela placa é a ROTA DE CAPTURA (getDisplayMedia =
  // hardware). O `getGPUFeatureStatus().video_encode` provou ser enganoso: reporta
  // "software" mesmo com o vídeo indo por hardware a 30 fps. Então o veredito
  // segue a captura, não aquele campo.
  const usandoGpu = !capturaSoftware;
  const linhas = [
    'Ryke Desk — diagnóstico da sessão',
    `PC controlado: ${m?.hostName ?? '?'}`,
    `Placa de vídeo (host): ${g?.nome ?? '(não informado)'}`,
    `Vídeo pela GPU: ${usandoGpu ? 'SIM (hardware)' : 'NÃO — indo pelo processador (software)'}`,
    g ? `  aceleração da placa: encode=${g.encode ? 'ligado' : 'desligado'} decode=${g.decode ? 'ligado' : 'desligado'}` : '',
    `Captura de tela: ${capturaSoftware ? 'ROTA LENTA por software (canvas)' : 'caminho rápido do Windows'}`,
    capturaSoftware && m?.hostCapturaMotivo ? `  erro da captura: ${m.hostCapturaMotivo}` : '',
    '',
    `Conexão: ${s?.transport ?? '?'} · ida-e-volta ${s?.rtt ?? '?'} ms`,
    `Vídeo: ${s?.width ?? '?'}x${s?.height ?? '?'} · ${s?.fps ?? '?'} quadros/s · ${((s?.kbps ?? 0) / 1000).toFixed(1)} Mb/s`,
    `Codec: ${s?.codec || '?'} · buffer da imagem: ${s?.atraso ?? '?'} ms · decode: ${s?.aceleracao || '?'}`,
    `Qualidade escolhida: ${outgoing.quality}`,
  ];
  return linhas.filter((l) => l !== '').join('\n');
}

/**
 * Painel de Diagnóstico — abre pelo botão da barra.
 *
 * Atende ao pedido: não bloqueia a tela (dá para fechar), diz em letras grandes
 * se o vídeo está indo pela PLACA ou pelo PROCESSADOR, e o texto fica num campo
 * selecionável (com botão Copiar) para colar aqui. Nada de adivinhação.
 */
function PainelDiagnostico({ outgoing, onClose }: { outgoing: Outgoing; onClose: () => void }): React.JSX.Element {
  const [copia, setCopia] = useState<'parado' | 'copiado' | 'falhou'>('parado');
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const texto = montarTextoDiagnostico(outgoing);
  const usandoGpu = outgoing.meta?.hostCapturaSoftware !== true;

  /**
   * Copiar por TRÊS caminhos, e nunca falhar calado.
   *
   * A versão anterior tinha um só caminho — mandar o texto ao processo
   * principal — e engolia qualquer erro num `catch` vazio. Quando não
   * funcionava, o botão simplesmente não fazia nada: nem copiava, nem dizia que
   * não tinha copiado. Um botão que falha em silêncio é pior do que um botão
   * que não existe, porque a pessoa fica tentando.
   *
   * Agora tentamos primeiro o caminho do próprio navegador (selecionar e
   * copiar), que não passa por IPC nenhum; depois a área de transferência do
   * sistema pelo processo principal; e o que acontecer fica na cara do botão.
   */
  const copiar = async (): Promise<void> => {
    const tentativas: Array<() => Promise<boolean>> = [
      // 1. Seleciona o texto e usa a cópia nativa do navegador.
      async () => {
        const area = areaRef.current;
        if (!area) return false;
        area.focus();
        area.select();
        return document.execCommand('copy');
      },
      // 2. A área de transferência do sistema, pelo processo principal.
      async () => {
        await window.ryke.clipboard.write(texto);
        return true;
      },
      // 3. A API do navegador, que exige contexto seguro e pode não existir.
      async () => {
        await navigator.clipboard?.writeText(texto);
        return true;
      },
    ];
    for (const tentar of tentativas) {
      try {
        if (await tentar()) {
          setCopia('copiado');
          window.setTimeout(() => setCopia('parado'), 1600);
          return;
        }
      } catch {
        /* tenta o próximo caminho */
      }
    }
    // Nenhum funcionou: dizer isso é o mínimo, e o arquivo de log continua lá.
    setCopia('falhou');
    window.setTimeout(() => setCopia('parado'), 4000);
  };
  return (
    <div className="diag-painel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="diag-cabecalho">
        <strong>Diagnóstico da conexão</strong>
        <button className="icon-btn" onClick={onClose} title="Fechar" aria-label="Fechar">
          <IconX width={12} height={12} />
        </button>
      </div>
      <div className={`diag-status ${usandoGpu ? 'bom' : 'ruim'}`}>
        {usandoGpu
          ? '✓ O vídeo está usando a placa de vídeo (GPU)'
          : '✗ O vídeo NÃO está usando a placa — está indo pelo processador'}
      </div>
      <textarea
        ref={areaRef}
        className="diag-texto"
        readOnly
        value={texto}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="diag-acoes">
        <button className="btn-diag" onClick={() => void copiar()}>
          {copia === 'copiado' ? '✓ Copiado!' : copia === 'falhou' ? '✗ Não consegui copiar' : 'Copiar tudo'}
        </button>
        {/* A saída que não depende da área de transferência: o relatório completo
            está sempre gravado em arquivo, e daqui dá para chegar nele. */}
        <button className="btn-diag" onClick={() => void window.ryke.diag.abrir()}>
          Abrir o arquivo de log
        </button>
        <span className="diag-dica">
          {copia === 'falhou'
            ? 'A área de transferência recusou. Use "Abrir o arquivo de log" e mande o arquivo.'
            : 'Copie e cole aqui no Claude — ou abra o arquivo de log, que tem o histórico completo.'}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────── barra de ferramentas ─────────────────────

function Toolbar({
  controller,
  state,
  visible,
  fullscreen,
  pendingTransfers,
  onToggleFullscreen,
  onJanela,
  janelado,
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
  onDiagnostico,
  diagAberto,
}: {
  controller: Controller;
  state: State;
  visible: boolean;
  fullscreen: boolean;
  pendingTransfers: number;
  onToggleFullscreen: () => void;
  onJanela: () => void;
  /** A sessão está numa janela solta? Muda o que o botão Janela faz e diz. */
  janelado: boolean;
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
  onDiagnostico: () => void;
  diagAberto: boolean;
}): React.JSX.Element {
  const [menu, setMenu] = useState<'monitor' | 'teclas' | 'qualidade' | null>(null);
  const outgoing = state.outgoing!;
  const stats = outgoing.stats;
  const displays = outgoing.meta?.displays ?? [];
  // Placa do PC controlado, mostrada ao lado da resolução (responde ao "está
  // usando a GPU?"). O detalhe completo mora no painel de Diagnóstico.
  const hostGpu = outgoing.meta?.hostGpu;
  // Há um problema de desempenho concreto agora? Serve só para pintar o botão de
  // Diagnóstico de vermelho, chamando atenção sem bloquear nada.
  const diag = diagnosticarSessao(stats, outgoing.meta?.hostCapturaSoftware, outgoing.meta?.hostCapturaMotivo);
  const temProblema = !!diag && !diag.ok;
  // Mantém a barra aberta enquanto o mouse está sobre ela, mesmo que ela quebre
  // em duas linhas: sem isto, descer para a segunda linha a fazia recolher.
  const [sobreBarra, setSobreBarra] = useState(false);
  // Estado do modo administrador do PC remoto, e o passo de confirmação (a troca
  // derruba a sessão, então nunca é num clique só).
  const hostElevado = outgoing.meta?.hostElevado === true;
  const [confirmAdmin, setConfirmAdmin] = useState(false);

  const toggle = (name: typeof menu) => () => setMenu((atual) => (atual === name ? null : name));

  return (
    <div
      className={`toolbar ${visible || menu || sobreBarra ? '' : 'hidden'}`}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={() => setSobreBarra(true)}
      onPointerLeave={() => setSobreBarra(false)}
    >
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
        onClick={() => controller.sendSas()}
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

      {/* O visualizador nasce ocupando o monitor inteiro. Este botão o devolve
          a um retângulo no meio da tela, com metade da largura e da altura —
          e a partir dali é o usuário quem decide o tamanho, arrastando as
          bordas. É o que permite olhar a tela remota ao lado de algo daqui. */}
      <button
        className={`tool ${janelado ? 'on' : ''}`}
        onClick={onJanela}
        data-dica={
          janelado
            ? 'Volta a ocupar a tela inteira.'
            : 'Encolhe para metade da tela. Depois é só arrastar as bordas para o tamanho que quiser.'
        }
      >
        {janelado ? <IconSquare /> : <IconJanela />}
        {janelado ? 'Maximizar' : 'Janela'}
      </button>

      <button
        className="tool"
        onClick={onToggleFullscreen}
        data-dica="Tela cheia (Ctrl+Alt+Shift+F). Sair da tela cheia usa o mesmo atalho."
      >
        {fullscreen ? <IconExitFullscreen /> : <IconFullscreen />}
      </button>

      {/* Botão de Diagnóstico: abre o painel que diz se o vídeo está pela placa
          (GPU) ou pelo processador, com o texto copiável. Fica vermelho quando há
          um problema concreto, mas nunca bloqueia a tela. */}
      <button
        className={`tool ${diagAberto ? 'on' : ''} ${temProblema ? 'tool-alerta' : ''}`}
        onClick={onDiagnostico}
        title="Diagnóstico: mostra se o vídeo está usando a placa de vídeo (GPU) e o motivo de qualquer lentidão. O texto é selecionável e copiável."
      >
        <IconShield />
        Diagnóstico
        {temProblema && <span className="tool-ponto" />}
      </button>

      {/* Modo administrador do PC REMOTO: para instalar programas ou mexer em
          janelas de admin lá.

          Isto JÁ NÃO reabre o anfitrião nem derruba a sessão. Quem eleva agora é
          um ajudante separado, que só injeta mouse e teclado — o aplicativo
          continua no nível normal, onde a captura funciona a 60 quadros. A
          confirmação fica porque é uma mudança de privilégio na máquina de outra
          pessoa, não porque custe desempenho. */}
      {confirmAdmin ? (
        <span className="modo-confirma-barra">
          <span>
            {hostElevado
              ? 'Desligar o modo administrador no PC remoto?'
              : 'Ligar o modo administrador no PC remoto? A sessão não cai.'}
          </span>
          <button
            className="tool on"
            onClick={() => {
              setConfirmAdmin(false);
              controller.trocarModoAdminRemoto(!hostElevado);
            }}
          >
            Sim
          </button>
          <button className="tool" onClick={() => setConfirmAdmin(false)}>
            Não
          </button>
        </span>
      ) : (
        <button
          className={`tool ${hostElevado ? 'tool-alerta' : ''}`}
          onClick={() => setConfirmAdmin(true)}
          title={
            hostElevado
              ? 'O PC remoto está em MODO ADMINISTRADOR: dá para clicar em janelas que pedem administrador. Clique para desligar.'
              : 'Coloca o PC remoto em modo administrador, para instalar programas e clicar em janelas de administrador. A imagem continua rápida e a sessão não cai.'
          }
        >
          <IconLock />
          {hostElevado ? 'Sair do admin' : 'Modo admin'}
        </button>
      )}

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
          {/* A PLACA DE VÍDEO em uso no PC controlado, ao lado da resolução — a
              resposta direta a "está usando a GPU mesmo?". O nome e o selo HW/SW
              vêm do próprio sistema do anfitrião (getGPUFeatureStatus), não de um
              stat do WebRTC que neste Electron volta vazio. HW = a placa codifica
              (rápido); SW vermelho = o processador codifica (a causa do atraso). */}
          {hostGpu && (
            <span
              className="stat-gpu"
              title={
                hostGpu.encode
                  ? `Placa de vídeo do PC controlado: ${hostGpu.nome}. Aceleração de vídeo por hardware ativa.`
                  : `Placa de vídeo do PC controlado: ${hostGpu.nome}. O Chromium não reportou aceleração de vídeo por hardware neste PC (é só um indicador; nem sempre significa problema).`
              }
            >
              {nomeCurtoGpu(hostGpu.nome)} · {hostGpu.encode ? 'HW' : 'SW'}
            </span>
          )}
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
          <span
            className={stats.transport === 'retransmitido' ? 'stat-alerta' : undefined}
            title={
              stats.transport === 'retransmitido'
                ? 'Conexão INDIRETA: o vídeo passa por um servidor no meio, o que adiciona atraso constante. Libere o app no firewall dos dois PCs para abrir o caminho direto.'
                : 'Conexão direta entre os dois computadores.'
            }
          >
            {stats.transport}
          </span>
          {stats.codec && (
            <span title="Codec de vídeo. H264 costuma ser por hardware (rápido); VP8/VP9 costuma ser por software (mais pesado).">
              {stats.codec}
            </span>
          )}
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
          Arraste arquivos <strong>ou pastas</strong> para esta janela
          <br />
          ou copie um arquivo no Explorador e clique no aviso que aparece
        </div>
        <button className="btn block" onClick={() => void controller.sendFileFromDialog()}>
          <IconSend />
          Escolher arquivo para enviar
        </button>
        <button className="btn block" onClick={() => void controller.sendFolderFromDialog()}>
          <IconFolder />
          Escolher pasta para enviar
        </button>
        <span className="hint">
          Sem limite de tamanho. Uma pasta vai inteira, com as subpastas, e chega montada do outro lado.
        </span>
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
