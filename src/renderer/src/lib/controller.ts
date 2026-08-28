import { formatBytes, formatId, normalizeId, type ModoAcesso, type SignalPayload } from '../../../shared/protocol';
import { Signaling } from './signaling';
import { Session, type LiveStats, type Quality } from './session';
import { sourceFromDisk, sourceFromFile, type TransferView } from './files';
import type { Favorito, Papel, Settings } from '../../../shared/config';
import type { EstadoPonto } from '../../../shared/malha';
import { DIGITOS_NUMERO } from '../../../shared/encontro';
import { nomeCurto, proximaCorLivre } from '../../../shared/ponteiros';

/**
 * Cérebro da interface: mantém o estado inteiro do aplicativo e conduz as
 * duas máquinas de estado — a de quem recebe uma conexão (anfitrião) e a de
 * quem inicia uma (visitante).
 *
 * A interface React apenas lê `state` e chama métodos daqui. Nenhum componente
 * fala com WebRTC ou com o processo principal diretamente, o que mantém a
 * lógica de conexão testável e num lugar só.
 */

export type ConnectPhase =
  | 'discando'
  | 'autenticando'
  /** Esperando alguém clicar em "Permitir" do outro lado. */
  | 'aguardando-autorizacao'
  | 'negociando'
  | 'conectado';
export type ServerStatus = 'conectando' | 'online' | 'offline';

export type HostMeta = {
  width: number;
  height: number;
  hostName: string;
  displays: { id: number; label: string; primary: boolean }[];
  activeDisplay: number;
};

export type Outgoing = {
  peerId: string;
  /** 'senha' = entrou por conta própria; 'pedido' = alguém autorizou lá. */
  modo: ModoAcesso;
  phase: ConnectPhase;
  error: string | null;
  stats: LiveStats | null;
  meta: HostMeta | null;
  quality: Quality;
  blockingLocalInput: boolean;
  /**
   * A sessão parou de responder e está sendo refeita.
   *
   * Enquanto isto for verdade a tela mostra um aviso e devolve o cursor
   * visível — antes, a imagem congelava com o ponteiro escondido e não havia
   * como saber se o problema era o programa, a rede ou o outro computador.
   */
  instavel?: boolean;
};

export type Incoming = {
  peerId: string;
  /** 'pedindo' = esperando o dono deste PC aprovar na tela. */
  phase: 'pedindo' | 'ativa';
  /** Como o visitante chegou até aqui — muda o texto e o peso da decisão. */
  modo: ModoAcesso;
  stats: LiveStats | null;
};

export type Toast = { id: number; kind: 'ok' | 'erro' | 'info'; text: string };

export type State = {
  booted: boolean;
  /** Papel deste PC. Enquanto null, o App mostra a tela de boas-vindas. */
  papel: Papel;
  /** IP deste PC na rede — informativo, para diagnóstico. */
  ip: string | null;
  /** Mantido por compatibilidade da interface; a malha nunca fica sem endereço. */
  servidorConfigurado: boolean;
  /**
   * Situação de cada ponto de encontro.
   *
   * Está no estado, e não escondido, porque foi a falta disto que transformou
   * uma falha de conexão real em adivinhação: sem ver quais pontos cada lado
   * alcançou, não há como distinguir "o outro PC está desligado" de "as duas
   * redes liberam pontos diferentes".
   */
  pontos: EstadoPonto[];
  myId: string | null;
  /** Impressão digital deste computador, para conferir por telefone. */
  minhaImpressao: string | null;
  /**
   * Um número conhecido apareceu com outra identidade.
   *
   * Enquanto isto estiver preenchido a interface mostra o alerta e não deixa
   * conectar naquele número sem uma decisão explícita do usuário.
   */
  identidadeSuspeita: { numero: string; esperada: string; recebida: string } | null;
  /** Contagem regressiva da confirmação da qualidade alta. */
  confirmacaoQualidade: { segundos: number } | null;
  machineName: string;
  version: string;
  server: { status: ServerStatus; detail?: string };
  hasPassword: boolean;
  /** Senha trancada porque alguem esta controlando esta maquina agora. */
  senhaTravada: boolean;
  acceptingConnections: boolean;
  settings: Settings | null;
  /**
   * Todas as conexões de SAÍDA abertas — uma por aba, como no navegador.
   *
   * Era uma só, e conectar a um segundo computador exigia encerrar o primeiro.
   * Isso nunca foi limitação técnica: cada sessão já tinha a própria conexão,
   * a própria taxa de bits e o próprio canal de teclado. O que existia era uma
   * variável única guardando "a" sessão. Agora são várias, e a aba só decide
   * qual delas está na frente.
   */
  abas: Outgoing[];
  /** Número da aba em primeiro plano; as demais seguem vivas por trás. */
  abaAtiva: string | null;
  /**
   * A aba ativa, sempre derivada de `abas` + `abaAtiva`.
   *
   * Existe para a interface continuar lendo "a conexão atual" sem repetir a
   * busca em todo componente. Nunca é atribuída à mão — quem a mantém é
   * `setAbas`, e é isso que impede as duas representações de divergirem.
   */
  outgoing: Outgoing | null;
  incoming: Incoming | null;
  transfers: TransferView[];
  /** Arquivos atualmente copiados no Explorer deste PC. */
  clipboardFiles: string[];
  recent: string[];
  /**
   * Quem conectou A ESTE computador, do mais recente para o mais antigo.
   *
   * O espelho de `recent`: aquele guarda para quem eu fui; este, quem veio até
   * mim. Serve para o dono da máquina saber quem a acessou — informação que
   * antes se perdia assim que a sessão terminava.
   */
  recebidos: string[];
  /** Computadores guardados com nome próprio. */
  favoritos: Favorito[];
  /**
   * Números que já têm senha guardada neste computador.
   *
   * Só os números — as senhas ficam no processo principal, cifradas, e são
   * lidas uma a uma na hora de conectar. Assim um defeito na interface não
   * consegue vazar a lista inteira de uma vez.
   */
  comSenhaSalva: string[];
  toasts: Toast[];
};

const RECENT_KEY = 'ryke:recent';
/** Prazo até o outro computador dar qualquer sinal de vida. */
const KNOCK_TIMEOUT_MS = 25_000;
/** Prazo depois que a bola passou para uma pessoa clicar em "Permitir". */
const APROVACAO_TIMEOUT_MS = 75_000;
/** Quanto tempo o pedido fica na tela do anfitrião antes de se recusar sozinho. */
export const SEGUNDOS_PARA_APROVAR = 60;
/** Prazo para confirmar a qualidade alta antes de ela se desfazer sozinha. */
export const SEGUNDOS_PARA_CONFIRMAR_QUALIDADE = 20;

const MOTIVOS: Record<string, string> = {
  'senha-incorreta': 'Senha incorreta.',
  recusado: 'A pessoa no outro computador recusou o acesso.',
  ocupado: 'O outro computador já está em uma sessão.',
  'sem-senha': 'O outro computador ainda não definiu uma senha de acesso.',
  bloqueado: 'Muitas tentativas com senha errada. Aguarde para tentar de novo.',
  'sem-resposta': 'Ninguém respondeu ao pedido no outro computador.',
  'falha-captura': 'O outro computador não conseguiu iniciar a captura da tela.',
  'exige-senha': 'O outro computador só aceita conexões com senha.',
};

export class Controller {
  private listeners = new Set<() => void>();
  private signaling: Signaling | null = null;
  private iceServers: RTCIceServer[] = [];
  /**
   * Corretores vindos do ambiente. Vazio em uso normal — os testes de ponta a
   * ponta usam isto para apontar a malha para corretores locais.
   */
  private corretores: string[] | null = null;
  private relays: string[] | null = null;
  private relogioDiagnostico: number | null = null;
  private relogioQualidade: number | null = null;
  private qualidadeAnterior: Quality = 'auto';
  /**
   * Sessões em que este computador é o anfitrião — uma por visitante.
   *
   * Era uma só, e a segunda pessoa que tentasse entrar levava "ocupado".
   * Isso nunca foi uma limitação técnica: a captura de tela é compartilhada
   * entre todas as sessões (ver `session.ts`), e cada visitante tem a própria
   * conexão, com a própria taxa de bits. O que mudou aqui foi só parar de
   * recusar.
   */
  private hostSessions = new Map<string, Session>();
  /**
   * A cor da seta de cada visitante — 0 = vermelho, 1 = azul, 2 = verde.
   *
   * Quem sai devolve a cor para a fila. Se o vermelho desconecta e outro
   * entra, o novo herda o vermelho: a promessa é "o primeiro é vermelho", e
   * não "o quarto a entrar desde que o programa abriu".
   */
  private coresDeVisitantes = new Map<string, number>();
  /** O nome que cada visitante deu à máquina dele — vira o rótulo da seta. */
  private nomesDeVisitantes = new Map<string, string>();
  /** Sessões em que ESTE computador é o visitante — uma por aba aberta. */
  private viewerSessions = new Map<string, Session>();
  /**
   * Senha digitada de cada número, guardada só até a autenticação terminar.
   *
   * Uma por número, e não uma só: com abas, duas conexões podem estar se
   * autenticando ao mesmo tempo, e uma variável única faria a segunda
   * sobrescrever a senha da primeira — que então falharia com "senha
   * incorreta" sem ninguém ter digitado nada de errado.
   */
  private pendingPasswords = new Map<string, string>();
  /** Senhas a gravar SE a conexão der certo, por número. Ver `connect`. */
  private senhasParaLembrar = new Map<string, string>();
  /** Anfitrião: nonce emitido para cada número que bateu à porta. */
  private pendingNonces = new Map<string, string>();
  /** Pedidos supervisionados aguardam em fila; nenhum recebe "ocupado". */
  private filaDeAprovacao: { peerId: string; modo: ModoAcesso }[] = [];
  /** Prazo de resposta de cada número que está discando agora. */
  private knockTimers = new Map<string, number>();
  private approvalTimer: number | null = null;
  private toastSeq = 1;
  private cleanup: (() => void)[] = [];
  private envioClipboard: { assinatura: string; promise: Promise<boolean> } | null = null;
  /** O mesmo arquivo continua colável quantas vezes o usuário quiser. */
  private clipboardPreparado: string | null = null;

  state: State = {
    booted: false,
    papel: null,
    ip: null,
    servidorConfigurado: true,
    pontos: [],
    myId: null,
    minhaImpressao: null,
    identidadeSuspeita: null,
    confirmacaoQualidade: null,
    machineName: 'PC',
    version: '',
    server: { status: 'conectando' },
    hasPassword: false,
    senhaTravada: false,
    acceptingConnections: true,
    settings: null,
    abas: [],
    abaAtiva: null,
    outgoing: null,
    incoming: null,
    transfers: [],
    clipboardFiles: [],
    recent: [],
    recebidos: [],
    favoritos: [],
    comSenhaSalva: [],
    toasts: [],
  };

  // ─────────────────── ligação com o React ────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): State => this.state;

  private set(patch: Partial<State>): void {
    // Objeto novo a cada mudança: é assim que useSyncExternalStore percebe.
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ─────────────────────────── abas ────────────────────────────
  //
  // Um lugar só decide `abas`, `abaAtiva` e `outgoing` ao mesmo tempo. Se cada
  // chamada atualizasse os três por conta própria, mais cedo ou mais tarde
  // apareceria um estado em que a aba ativa não existe mais na lista — e a
  // tela mostraria o vídeo de uma sessão já encerrada.

  private setAbas(abas: Outgoing[], preferida?: string | null): void {
    const desejada = preferida !== undefined ? preferida : this.state.abaAtiva;
    // Aba ativa que sumiu (a sessão caiu, o usuário fechou) cede o lugar à
    // última da lista, em vez de deixar a tela sem nada apesar de haver
    // conexões abertas.
    const ativa = abas.some((a) => a.peerId === desejada)
      ? desejada!
      : (abas[abas.length - 1]?.peerId ?? null);
    this.set({
      abas,
      abaAtiva: ativa,
      outgoing: abas.find((a) => a.peerId === ativa) ?? null,
    });
  }

  private patchAba(peerId: string, patch: Partial<Outgoing>): void {
    if (!this.state.abas.some((a) => a.peerId === peerId)) return;
    this.setAbas(this.state.abas.map((a) => (a.peerId === peerId ? { ...a, ...patch } : a)));
  }

  private removerAba(peerId: string): void {
    this.setAbas(this.state.abas.filter((a) => a.peerId !== peerId));
  }

  /** Traz uma aba para a frente. As outras continuam conectadas por trás. */
  selecionarAba(peerId: string): void {
    if (!this.state.abas.some((a) => a.peerId === peerId)) return;
    this.setAbas(this.state.abas, peerId);
  }

  /** A sessão de uma aba específica, para o visualizador desenhar o vídeo. */
  sessaoDaAba(peerId: string): Session | null {
    return this.viewerSessions.get(peerId) ?? null;
  }

  /**
   * Quantas conexões de saída existem agora.
   *
   * Usado para decidir o que é "a última": modo visualizador e bloqueio de
   * suspensão pertencem à janela inteira, não a uma aba, e desligá-los ao
   * fechar a primeira derrubaria o enquadramento das demais.
   */
  get quantasAbas(): number {
    return this.state.abas.length;
  }

  // ────────────────────────── início ──────────────────────────

  async boot(): Promise<void> {
    const [info, settings, password, papelStatus, favoritos, comSenhaSalva] = await Promise.all([
      window.ryke.app.info(),
      window.ryke.settings.get(),
      window.ryke.password.status(),
      window.ryke.role.status(),
      window.ryke.favorites.list(),
      window.ryke.senhas.lista(),
    ]);

    this.corretores = papelStatus.corretores;
    this.relays = papelStatus.relays;
    this.set({
      machineName: info.machineName,
      version: info.version,
      settings,
      papel: settings.papel,
      ip: papelStatus.ip,
      servidorConfigurado: papelStatus.configurado,
      hasPassword: password.defined,
      senhaTravada: password.travada === true,
      acceptingConnections: settings.hostOnLaunch,
      recent: loadRecent(),
      recebidos: loadRecebidos(),
      favoritos,
      comSenhaSalva,
      booted: true,
    });

    if (!info.abi.ok) {
      this.toast('erro', 'Este Windows respondeu de forma inesperada à injeção de teclado. O controle remoto pode não funcionar.');
    }

    this.cleanup.push(
      window.ryke.clipboard.onFiles((paths) => {
        // Duas instâncias podem rodar no mesmo Windows (suporte local e
        // testes). Nesse caso elas compartilham o clipboard: o caminho que o
        // destinatário acabou de publicar não pode voltar como um novo envio.
        const veioDoOutroLado = this.active?.engine?.views.some(
          (view) => view.direction === 'enviando' && paths.includes(view.path ?? ''),
        );
        if (veioDoOutroLado) return;
        this.set({ clipboardFiles: paths });
        // Copiar no Explorer já é a ordem de envio. Não exige aviso,
        // clique ou uma área intermediária na interface.
        if (this.viewer) void this.transferirArquivosCopiados(paths);
      }),
      // Quem manda na trava da senha é o processo principal — a interface só
      // reflete, porque ela é justamente o que fica sob o comando de quem está
      // conectado.
      window.ryke.session.onSenhaTravada((travada) => this.set({ senhaTravada: travada })),
      // A posição do cursor daqui vai para todos os visitantes: é o que
      // permite a cada um deles desenhar a seta desta máquina no lugar certo,
      // em vez de depender da seta que vem atrasada dentro do vídeo.
      window.ryke.session.onCursor((ponto) => {
        for (const sessao of this.hostSessions.values()) sessao.sendCursor(ponto.x, ponto.y);
      }),
      // E as setas dos visitantes vão para todos os visitantes, MENOS para o
      // dono de cada uma. A própria seta cada um desenha com o cursor do
      // sistema, que não tem atraso; recebê-la de volta pela rede empilharia
      // duas setas andando com um quadro de diferença uma da outra.
      window.ryke.ponteiros.onIndisponivel(() => {
        this.toast(
          'info',
          'Este Windows não deixou esconder a camada das setas da gravação de tela, então ela foi desligada — você não verá as setas de quem se conectar. O controle e as setas do outro lado continuam funcionando normalmente.',
        );
      }),
      window.ryke.ponteiros.onEstado((lista) => {
        for (const [peerId, sessao] of this.hostSessions) {
          sessao.sendPonteiros(lista.filter((ponteiro) => ponteiro.id !== peerId));
        }
      }),
    );

    // Entra na malha sempre, assim que abre.
    //
    // Havia aqui duas perguntas obrigatórias — "este PC vai receber?" e "você
    // vai conectar?" — que decidiam quando entrar. Elas faziam sentido quando
    // um dos lados hospedava um servidor. Sem servidor, os dois papéis fazem
    // exatamente a mesma coisa, e perguntar só atrasava: o número precisa
    // estar na tela para ser passado adiante, e o campo de conectar precisa
    // estar ali para ser usado. Os dois, sempre, desde a primeira tela.
    this.iniciarSinalizacao(settings.serverUrl);
  }

  /**
   * Volta à tela das duas perguntas.
   *
   * Encerra o que estiver em andamento. O número Ryke e a identidade desta
   * máquina são preservados (ficam no disco), então voltar e reescolher
   * devolve o mesmo número — o que importa, porque quem já anotou esse número
   * continua conseguindo chegar aqui.
   */
  async voltarParaEscolha(): Promise<void> {
    for (const sessao of this.viewerSessions.values()) sessao.close('troca de modo');
    this.viewerSessions.clear();
    this.endHostSession('troca de modo');
    for (const peerId of [...this.knockTimers.keys()]) this.clearKnockTimeout(peerId);
    this.clearApprovalTimeout();

    await window.ryke.role.reset();
    this.setAbas([], null);
    this.set({ papel: null, incoming: null, myId: null, server: { status: 'conectando' } });
  }

  /** Entra na malha de encontro (ou soma um corretor próprio, se houver). */
  private iniciarSinalizacao(serverUrl: string): void {
    if (this.signaling) {
      this.signaling.setUrl(serverUrl);
      return;
    }
    this.signaling = new Signaling(serverUrl, this.corretores, this.relays);
    // A situação de cada ponto muda sozinha (queda, reconexão). Sem uma
    // atualização periódica, a tela de diagnóstico mostraria uma foto velha
    // — justamente quando alguém está tentando entender por que não conecta.
    this.relogioDiagnostico = window.setInterval(() => {
      const pontos = this.signaling?.diagnostico() ?? [];
      const antes = this.state.pontos;
      const mudou =
        antes.length !== pontos.length ||
        pontos.some((p, i) => antes[i]?.conectado !== p.conectado);
      if (mudou) this.set({ pontos });
    }, 2000);
    this.signaling.on('status', (status, detail) => this.set({ server: { status, detail } }));
    this.signaling.on('welcome', ({ id, iceServers }) => {
      this.iceServers = [...iceServers, ...this.retransmissorProprio()];
      // O número e a chave já foram gravados pela própria malha, que é quem
      // sorteia e reivindica. Aqui só refletimos na tela.
      this.set({ myId: id, minhaImpressao: this.signaling?.impressao ?? null });
    });
    this.signaling.on('signal', (from, data) => void this.onSignal(from, data));
    this.signaling.on('peerOffline', (peerId) => this.onPeerOffline(peerId));
    this.signaling.on('serverError', (reason, detail) => {
      if (reason === 'sem-corretor') {
        this.toast('erro', 'Sem conexão com a internet no momento.');
      } else if (reason === 'numero-ambiguo') {
        this.toast(
          'erro',
          'Dois computadores diferentes responderam por este número. Não dá para saber qual é o certo — ' +
            'peça para o outro lado reabrir o Ryke Desk, que ele sorteia outro número.',
        );
      } else {
        this.toast('erro', detail ?? reason);
      }
    });
    /**
     * O número continua o mesmo, mas o computador por trás dele não é o de
     * antes.
     *
     * Quase sempre isso é inocente — a pessoa formatou a máquina ou
     * reinstalou o programa. Mas é exatamente o que se veria se alguém
     * estivesse tentando ocupar o lugar dela. O programa não tem como
     * distinguir, então recusa a mensagem e joga a decisão para quem sabe:
     * o usuário confirma pelo telefone e manda esquecer a identidade antiga.
     */
    this.signaling.on('numeroDuplicado', (numero) => {
      this.toast(
        'info',
        `O número ${numero} já pertence a outro computador. Um número novo está sendo gerado e salvo neste PC.`,
      );
    });
    this.signaling.on('identidadeMudou', (numero, esperada, recebida) => {
      // Só a aba daquele número cai; as outras conexões não têm nada com isso.
      this.failOutgoing(numero, 'A identidade deste número mudou.');
      this.set({
        identidadeSuspeita: { numero, esperada, recebida },
      });
    });
    this.signaling.connect();
  }

  /**
   * Aplica a resposta das duas perguntas iniciais.
   *
   * Os dois papéis fazem a mesma coisa por baixo — entrar na malha — porque
   * não há servidor para um lado hospedar e o outro procurar. A escolha muda
   * só o que a tela destaca: o número para passar adiante, ou o campo para
   * digitar o número de alguém.
   */
  async escolherPapel(papel: Exclude<Papel, null>): Promise<void> {
    const resultado = await window.ryke.role.apply(papel);
    const settings = await window.ryke.settings.get();
    const status = await window.ryke.role.status();
    this.set({ papel, settings, ip: status.ip, servidorConfigurado: status.configurado });

    this.iniciarSinalizacao(resultado.serverUrl);

    this.toast(
      'ok',
      papel === 'receber'
        ? 'Pronto. Este computador pode ser acessado de qualquer lugar — basta passarem o número e a senha.'
        : 'Pronto. Digite o número do computador que você quer acessar.',
    );
  }

  /**
   * Retransmissor configurado pelo usuário, se houver.
   *
   * Só faz diferença quando os dois lados estão atrás de NAT simétrico e não
   * existe caminho direto. Vem por último na lista: o navegador prefere o
   * caminho direto e só cai no relay se não houver outro jeito — que é o que
   * queremos, já que a banda desse relay é paga por quem o configurou.
   */
  private retransmissorProprio(): RTCIceServer[] {
    const s = this.state.settings;
    const url = s?.turnUrl?.trim();
    if (!url || !/^turns?:/i.test(url)) return [];
    return [{ urls: url, username: s?.turnUser || undefined, credential: s?.turnPass || undefined }];
  }

  // ────────────────────────── favoritos ──────────────────────────

  /**
   * Guarda um computador com nome próprio, ou renomeia o que já existe.
   *
   * O número é a identidade do favorito; o nome é só rótulo, e por isso pode
   * mudar sem consequência. Salvar de novo o mesmo número renomeia em vez de
   * duplicar — duas linhas com o mesmo número e nomes diferentes seriam um
   * convite ao engano na hora de escolher.
   */
  async salvarFavorito(numero: string, nome: string): Promise<void> {
    const id = normalizeId(numero);
    if (!id) {
      this.toast('erro', `O número precisa ter ${DIGITOS_NUMERO} dígitos.`);
      return;
    }
    if (!nome.trim()) {
      this.toast('erro', 'Dê um nome para reconhecer este computador.');
      return;
    }
    const favoritos = await window.ryke.favorites.save(id, nome);
    this.set({ favoritos });
    this.toast('ok', `“${nome.trim()}” salvo nos favoritos.`);
  }

  /**
   * Sorteia um número novo para este computador.
   *
   * Quem faz isso perde o contato de todo mundo que já tinha o número antigo
   * anotado — por isso a interface confirma antes de chamar, e por isso o
   * número nunca muda sozinho.
   */
  async trocarNumero(): Promise<void> {
    const encerrar = this.hostSessions.size > 0 || this.viewerSessions.size > 0;
    if (encerrar) {
      this.toast('erro', 'Encerre as sessões abertas antes de trocar a numeração.');
      return;
    }
    try {
      const novo = await this.signaling?.trocarNumero();
      if (novo) {
        this.set({ myId: novo });
        this.toast('ok', `Numeração trocada. Avise seus contatos: ${novo}.`);
      }
    } catch (err) {
      this.toast('erro', err instanceof Error ? err.message : String(err));
    }
  }

  /** Senha guardada deste número, para preencher o campo sozinha. */
  async senhaGuardada(numero: string): Promise<string | null> {
    if (!this.state.comSenhaSalva.includes(numero)) return null;
    return window.ryke.senhas.ler(numero);
  }

  async esquecerSenha(numero: string): Promise<void> {
    await window.ryke.senhas.esquecer(numero);
    this.set({ comSenhaSalva: await window.ryke.senhas.lista() });
    this.toast('info', 'Senha esquecida.');
  }

  async removerFavorito(numero: string): Promise<void> {
    const favoritos = await window.ryke.favorites.remove(numero);
    this.set({ favoritos });
  }

  /**
   * Aceita a nova identidade de um número e libera a conexão.
   *
   * Só deve ser usado depois de confirmar por fora — telefone, mensagem — que
   * a pessoa realmente reinstalou o programa. É o único ponto do software em
   * que o usuário assume um risco no lugar do programa, então a interface
   * precisa deixar isso explícito.
   */
  async confiarNovaIdentidade(): Promise<void> {
    const suspeita = this.state.identidadeSuspeita;
    if (!suspeita) return;
    await window.ryke.identity.unpin(suspeita.numero);
    this.set({ identidadeSuspeita: null });
    this.toast('info', `Identidade antiga esquecida. Tente conectar novamente em ${suspeita.numero}.`);
  }

  descartarAvisoDeIdentidade(): void {
    this.set({ identidadeSuspeita: null });
  }

  dispose(): void {
    if (this.relogioDiagnostico !== null) clearInterval(this.relogioDiagnostico);
    if (this.relogioQualidade !== null) clearInterval(this.relogioQualidade);
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    for (const sessao of this.hostSessions.values()) sessao.close('aplicativo encerrado');
    for (const sessao of this.viewerSessions.values()) sessao.close('aplicativo encerrado');
    this.signaling?.disconnect();
  }

  // ──────────────────── roteamento de sinais ──────────────────

  private async onSignal(from: string, data: SignalPayload): Promise<void> {
    // Se já existe uma sessão com este número, ela é a dona da mensagem.
    const visitante = this.viewerSessions.get(from);
    if (visitante && isRtcPayload(data)) {
      return visitante.handleSignal(data);
    }
    const anfitria = this.hostSessions.get(from);
    if (anfitria && isRtcPayload(data)) {
      return anfitria.handleSignal(data);
    }

    // Máquina de estados do visitante, na aba correspondente a este número.
    const aba = this.state.abas.find((a) => a.peerId === from);
    if (aba) {
      switch (data.t) {
        case 'challenge':
          return this.answerChallenge(from, data);
        case 'aguardando':
          // Uma tentativa que saiu com senha nunca depende de clique humano.
          // Versões antigas do anfitrião podiam rebaixá-la para acesso
          // supervisionado; aceitar esse sinal deixava a tela mentir e acabava
          // em "ninguém respondeu". Interrompemos com diagnóstico imediato.
          if (aba.modo === 'senha') {
            return this.failOutgoing(
              from,
              'O computador remoto está usando uma versão antiga do Ryke Desk ou não tem uma senha de acesso definida. Atualize o Ryke Desk e defina a senha nele.',
            );
          }
          // A decisão saiu do software e foi para uma pessoa; o relógio muda.
          this.patchAba(from, { phase: 'aguardando-autorizacao' });
          this.armKnockTimeout(from, APROVACAO_TIMEOUT_MS, 'Ninguém respondeu ao pedido no outro computador.');
          return;
        case 'accepted':
          return this.onAccepted(from);
        case 'denied':
          return this.onDenied(from, data.reason, data.retryAfter, data.detail);
        case 'bye':
          return this.failOutgoing(from, data.reason ?? 'O outro computador encerrou a conexão.');
      }
    }

    // Máquina de estados do anfitrião.
    switch (data.t) {
      case 'knock':
        // O nome da máquina do visitante vira o rótulo embaixo da seta dele.
        if (data.name) this.nomesDeVisitantes.set(from, data.name);
        return this.onKnock(from, data.modo ?? 'senha');
      case 'proof':
        return this.onProof(from, data.proof);
      case 'bye':
        // Uma despedida afeta somente quem a enviou. Encerrar todas aqui
        // derrubava os demais visitantes de uma sessão simultânea.
        if (this.state.incoming?.peerId === from && this.state.incoming.phase === 'pedindo') {
          this.clearApprovalTimeout();
          this.set({ incoming: null });
          this.mostrarProximoPedido();
        }
        this.filaDeAprovacao = this.filaDeAprovacao.filter((pedido) => pedido.peerId !== from);
        return;
    }
  }

  private onPeerOffline(peerId: string): void {
    if (this.state.abas.some((a) => a.peerId === peerId)) {
      this.failOutgoing(peerId, 'Número não encontrado. Verifique se o Ryke Desk está aberto no outro computador.');
    }
  }

  // ───────────────── visitante: iniciar conexão ───────────────

  /**
   * @param password vazio significa "pedir autorização": ninguém precisa
   *   saber senha alguma, mas alguém tem de estar do outro lado para permitir.
   */
  async connect(rawId: string, password: string, lembrarSenha = false): Promise<void> {
    const peerId = normalizeId(rawId);
    if (!peerId) {
      this.toast('erro', `O número precisa ter ${DIGITOS_NUMERO} dígitos.`);
      return;
    }
    if (peerId === this.state.myId) {
      this.toast('erro', 'Este é o número deste próprio computador.');
      return;
    }
    // Duas abas para o mesmo computador não fazem sentido: seriam duas telas
    // idênticas disputando o mesmo teclado. Em vez de recusar em silêncio,
    // trazemos para a frente a que já existe — que é o que a pessoa queria.
    if (this.state.abas.some((a) => a.peerId === peerId)) {
      this.selecionarAba(peerId);
      this.toast('info', `Você já está conectado a ${peerId}. Trouxemos essa aba para a frente.`);
      return;
    }

    const modo: ModoAcesso = password.length > 0 ? 'senha' : 'pedido';
    const nova: Outgoing = {
      peerId,
      modo,
      phase: 'discando',
      error: null,
      stats: null,
      meta: null,
      quality: this.state.settings?.quality ?? 'auto',
      blockingLocalInput: false,
    };
    // A aba nasce já na frente: quem acabou de mandar conectar quer ver esta.
    this.setAbas([...this.state.abas, nova], peerId);

    // Entrar na malha leva alguns segundos (achar um ponto de encontro,
    // reivindicar o número). Quem abre o programa e já digita o número do
    // outro cai bem nessa janela — e recusar ali seria pedir para tentar de
    // novo sem motivo. Esperamos, mostrando que está discando.
    if (!this.signaling?.connected) {
      const entrou = await this.esperarMalha(20_000);
      if (!entrou) {
        this.failOutgoing(
          peerId,
          this.state.pontos.length > 0
            ? 'A rede deste computador está bloqueando todos os pontos de encontro. Veja os Ajustes.'
            : 'Este computador não está conseguindo sair para a internet.',
        );
        return;
      }
      // A aba pode ter sido fechada enquanto esperávamos a malha subir.
      if (!this.state.abas.some((a) => a.peerId === peerId)) return;
    }

    this.pendingPasswords.set(peerId, password);
    // Guardada só depois de a senha ser aceita: gravar antes deixaria uma
    // senha errada salva, e o usuário passaria a falhar sempre sem entender.
    if (lembrarSenha && password.length > 0) this.senhasParaLembrar.set(peerId, password);

    this.signaling?.send(peerId, { t: 'knock', app: 'ryke-desk', name: this.state.machineName, modo });
    this.armKnockTimeout(peerId, KNOCK_TIMEOUT_MS, this.explicarSilencio());
  }

  /**
   * Por que ninguém respondeu.
   *
   * A mensagem antiga era "o outro computador não respondeu a tempo", o que
   * é verdade e não ajuda em nada: sobram três causas muito diferentes e o
   * usuário não tem como escolher entre elas. Aqui o que sabemos da nossa
   * própria situação de rede é usado para apontar a mais provável.
   */
  private explicarSilencio(): string {
    const vivos = this.state.pontos.filter((p) => p.conectado);
    if (vivos.length === 0) {
      return 'Este computador perdeu a conexão com a internet.';
    }
    if (!vivos.some((p) => p.familia === 'nostr')) {
      return (
        'Ninguém respondeu. A rede deste computador está bloqueando os pontos de encontro da porta 443, ' +
        'então só há como falar com quem estiver numa rede parecida. Veja "Pontos de encontro" nos Ajustes.'
      );
    }
    return (
      'Ninguém respondeu neste número. Confira se o outro computador está ligado, com o Ryke Desk aberto, ' +
      'e se o número está certo.'
    );
  }

  /** Aguarda a malha ficar online. `false` se o prazo estourar. */
  private esperarMalha(prazo: number): Promise<boolean> {
    return new Promise((resolve) => {
      const limite = Date.now() + prazo;
      const olhar = (): void => {
        if (this.signaling?.connected) return resolve(true);
        if (Date.now() > limite) return resolve(false);
        window.setTimeout(olhar, 250);
      };
      olhar();
    });
  }

  private armKnockTimeout(peerId: string, prazo: number, mensagem: string): void {
    this.clearKnockTimeout(peerId);
    const id = window.setTimeout(() => {
      this.knockTimers.delete(peerId);
      const aba = this.state.abas.find((a) => a.peerId === peerId);
      if (aba && aba.phase !== 'conectado') this.failOutgoing(peerId, mensagem);
    }, prazo);
    this.knockTimers.set(peerId, id);
  }

  private clearKnockTimeout(peerId: string): void {
    const id = this.knockTimers.get(peerId);
    if (id !== undefined) clearTimeout(id);
    this.knockTimers.delete(peerId);
  }

  private async answerChallenge(from: string, data: Extract<SignalPayload, { t: 'challenge' }>): Promise<void> {
    this.patchAba(from, { phase: 'autenticando' });
    // scrypt roda no processo principal: pesado de propósito, não pode
    // congelar a interface.
    const senha = this.pendingPasswords.get(from) ?? '';
    const proof = await window.ryke.auth.prove(from, senha, data.salt, data.nonce, data.scrypt);
    this.signaling?.send(from, { t: 'proof', proof });
  }

  private onDenied(peerId: string, reason: string, retryAfter?: number, detail?: string): void {
    const base = MOTIVOS[reason] ?? 'Conexão recusada.';
    const extra = retryAfter ? ` Tente novamente em ${retryAfter}s.` : '';
    const diagnostico = detail ? ` Detalhe: ${detail}` : '';
    this.failOutgoing(peerId, base + extra + diagnostico);
  }

  private async onAccepted(from: string): Promise<void> {
    this.clearKnockTimeout(from);
    this.pendingPasswords.delete(from);
    this.patchAba(from, { phase: 'negociando' });

    const session = new Session('visitante', from, this.signaling!, this.iceServers);
    this.viewerSessions.set(from, session);

    session.on('ready', () => {
      this.patchAba(from, { phase: 'conectado' });
      // Modo visualizador e bloqueio de suspensão pertencem à JANELA, não a
      // esta aba: ligá-los de novo a cada conexão é inofensivo, mas desligá-
      // los ao fechar uma aba qualquer estragaria as outras (ver 'closed').
      window.ryke.window.viewerMode(true);
      window.ryke.session.setActive(true);
      rememberRecent(from);
      this.set({ recent: loadRecent() });
      const senha = this.senhasParaLembrar.get(from);
      if (senha) {
        this.senhasParaLembrar.delete(from);
        void window.ryke.senhas.salvar(from, senha).then(async () => {
          this.set({ comSenhaSalva: await window.ryke.senhas.lista() });
          this.toast('ok', 'Senha guardada para este computador.');
        });
      }
      // Sessão que deu certo faz o favorito subir na lista sem ninguém
      // precisar arrastar nada.
      void window.ryke.favorites.touch(from);
      const aba = this.state.abas.find((a) => a.peerId === from);
      void session.applyQuality(aba?.quality ?? 'auto');
    });
    session.on('stats', (stats) => this.patchAba(from, { stats }));
    session.on('meta', (meta) => this.patchAba(from, { meta }));
    session.on('installer', (result) => {
      if (result.canceled) return;
      this.toast(result.ok ? 'ok' : 'erro', result.message);
    });
    // A interface precisa saber: sem isto, uma sessão adoecida ficava com a
    // tela congelada e o cursor escondido, sem nada explicando o que houve.
    session.on('saude', (viva) => this.patchAba(from, { instavel: !viva }));
    session.on('transfers', () => this.refreshTransfers());
    session.on('closed', (reason) => {
      this.viewerSessions.delete(from);
      this.removerAba(from);
      // Só a ÚLTIMA aba devolve a janela ao estado normal. Antes isto era
      // incondicional, e com abas teria o efeito de tirar da tela cheia e
      // liberar a suspensão no meio das conexões que continuam abertas.
      if (this.viewerSessions.size === 0 && this.state.abas.length === 0) {
        window.ryke.window.viewerMode(false);
        window.ryke.session.setActive(false);
      }
      this.toast('info', `Sessão com ${formatId(from)} encerrada — ${reason}`);
    });
  }

  private failOutgoing(peerId: string, message: string): void {
    this.clearKnockTimeout(peerId);
    this.pendingPasswords.delete(peerId);
    this.senhasParaLembrar.delete(peerId);
    this.viewerSessions.get(peerId)?.close(message);
    this.viewerSessions.delete(peerId);
    this.removerAba(peerId);
    if (this.viewerSessions.size === 0 && this.state.abas.length === 0) {
      window.ryke.window.viewerMode(false);
      window.ryke.session.setActive(false);
    }
    this.toast('erro', message);
  }

  /** Fecha uma aba. Sem número, fecha a que está na frente. */
  disconnect(peerId?: string): void {
    const alvo = peerId ?? this.state.abaAtiva;
    if (!alvo) return;
    this.clearKnockTimeout(alvo);
    this.pendingPasswords.delete(alvo);
    this.senhasParaLembrar.delete(alvo);
    const sessao = this.viewerSessions.get(alvo);
    this.viewerSessions.delete(alvo);
    this.removerAba(alvo);
    // Fechar a sessão dispara 'closed', que já não encontra a aba nem a
    // sessão — daí a ordem: tiramos do mapa antes, e o evento vira um aviso
    // inofensivo em vez de uma segunda remoção.
    sessao?.close('encerrada por você');
    if (this.viewerSessions.size === 0 && this.state.abas.length === 0) {
      window.ryke.window.viewerMode(false);
      window.ryke.session.setActive(false);
    }
  }

  // ───────────────── anfitrião: receber conexão ───────────────

  private async onKnock(from: string, modo: ModoAcesso): Promise<void> {
    if (!this.state.acceptingConnections) {
      this.signaling?.send(from, { t: 'denied', reason: 'recusado' });
      return;
    }
    // Já existe uma sessão com este número?
    //
    // Se ela está VIVA, este knock é repetido — a mesma conexão batendo de
    // novo por um caminho que demorou, ou uma retentativa — e derrubar uma
    // sessão boa por causa disso era exatamente o "substituída por uma nova
    // conexão do mesmo número" que aparecia no meio de uma sessão que estava
    // funcionando. Nesse caso, ignoramos o knock: quem já entrou continua.
    //
    // Só quando a sessão antiga está morta (o visitante caiu e volta agora) é
    // que a substituímos de fato — aí, sim, é uma conexão nova de verdade.
    const anterior = this.hostSessions.get(from);
    if (anterior) {
      if (anterior.sessaoViva) return;
      anterior.close('substituída por uma nova conexão do mesmo número');
    }

    // ── acesso supervisionado: sem senha, decide quem está aqui ──
    if (modo === 'pedido') {
      if (this.state.settings?.allowSupervisedAccess === false) {
        this.signaling?.send(from, { t: 'denied', reason: 'exige-senha' });
        return;
      }
      return this.pedirAutorizacao(from, 'pedido');
    }

    // ── acesso por senha: não supervisionado ──
    const result = await window.ryke.auth.challenge(from);
    if (result.locked) {
      this.signaling?.send(from, { t: 'denied', reason: 'bloqueado', retryAfter: result.locked });
      this.toast('erro', `Tentativas repetidas de senha vindas do número ${from}. Acesso barrado por ${result.locked}s.`);
      return;
    }
    if (result.noPassword || !result.challenge) {
      // O visitante informou uma senha, portanto não podemos transformar a
      // tentativa silenciosamente em pedido supervisionado. Se esta máquina
      // não definiu uma senha, a resposta correta é explicar isso.
      this.signaling?.send(from, { t: 'denied', reason: 'sem-senha' });
      return;
    }
    this.pendingNonces.set(from, result.challenge.nonce);
    this.signaling?.send(from, { t: 'challenge', ...result.challenge, hostName: this.state.machineName });
  }

  /**
   * Coloca o pedido na tela e devolve a decisão a uma pessoa.
   *
   * O aviso 'aguardando' é enviado antes de tudo: sem ele o visitante ficaria
   * vendo "conectando..." sem saber que a bola está com outra pessoa.
   */
  private pedirAutorizacao(from: string, modo: ModoAcesso): void {
    this.signaling?.send(from, { t: 'aguardando', hostName: this.state.machineName });
    if (this.state.incoming?.phase === 'pedindo') {
      const jaEspera =
        this.state.incoming.peerId === from || this.filaDeAprovacao.some((pedido) => pedido.peerId === from);
      if (!jaEspera) this.filaDeAprovacao.push({ peerId: from, modo });
      return;
    }
    this.exibirPedido(from, modo);
  }

  private exibirPedido(from: string, modo: ModoAcesso): void {
    this.set({ incoming: { peerId: from, phase: 'pedindo', modo, stats: null } });

    // Se ninguém estiver por perto, o pedido morre sozinho em vez de deixar
    // o outro lado esperando para sempre.
    this.clearApprovalTimeout();
    this.approvalTimer = window.setTimeout(() => {
      if (this.state.incoming?.peerId === from && this.state.incoming.phase === 'pedindo') {
        this.signaling?.send(from, { t: 'denied', reason: 'sem-resposta' });
        this.set({ incoming: null });
        this.mostrarProximoPedido();
      }
    }, SEGUNDOS_PARA_APROVAR * 1000);
  }

  private mostrarProximoPedido(): void {
    if (this.state.incoming?.phase === 'pedindo') return;
    const proximo = this.filaDeAprovacao.shift();
    if (proximo) this.exibirPedido(proximo.peerId, proximo.modo);
  }

  private clearApprovalTimeout(): void {
    if (this.approvalTimer !== null) clearTimeout(this.approvalTimer);
    this.approvalTimer = null;
  }

  private async onProof(from: string, proof: string): Promise<void> {
    const nonce = this.pendingNonces.get(from);
    // Sem desafio pendente não há o que verificar — provavelmente é uma prova
    // atrasada de uma tentativa anterior, ou alguém pulando etapas.
    if (!nonce) {
      this.signaling?.send(from, { t: 'denied', reason: 'recusado' });
      return;
    }
    this.pendingNonces.delete(from);

    const verdict = await window.ryke.auth.verify(from, nonce, proof);
    if (!verdict.ok) {
      const reason = verdict.reason === 'sem-senha' ? 'sem-senha' : verdict.locked ? 'bloqueado' : 'senha-incorreta';
      this.signaling?.send(from, { t: 'denied', reason, retryAfter: verdict.locked });
      this.toast('erro', `Tentativa de acesso do número ${from} com senha incorreta.`);
      return;
    }

    // Senha conferida: este é, por definição, o acesso não supervisionado.
    // A aprovação na tela existe exclusivamente para o modo sem senha.
    void this.startHostSession(from, 'senha');
  }

  // ─────────────────── controle da sessão ativa ───────────────

  setAcceptingConnections(on: boolean): void {
    this.set({ acceptingConnections: on });
    if (!on && this.hostSessions.size > 0) this.endHostSession('conexões desativadas no anfitrião');
  }

  approveIncoming(): void {
    if (this.state.incoming?.phase !== 'pedindo') return;
    const { peerId, modo } = this.state.incoming;
    this.clearApprovalTimeout();
    void this.startHostSession(peerId, modo);
    // startHostSession registra a nova sessão antes da primeira espera;
    // portanto já podemos apresentar o próximo pedido sem sobrepor janelas.
    this.mostrarProximoPedido();
  }

  denyIncoming(): void {
    const peerId = this.state.incoming?.peerId;
    if (!peerId) return;
    this.clearApprovalTimeout();
    this.signaling?.send(peerId, { t: 'denied', reason: 'recusado' });
    this.set({ incoming: null });
    this.mostrarProximoPedido();
  }

  private async startHostSession(peerId: string, modo: ModoAcesso = 'senha'): Promise<void> {
    this.set({ incoming: { peerId, phase: 'ativa', modo, stats: null } });

    const session = new Session('anfitriao', peerId, this.signaling!, this.iceServers);
    this.hostSessions.set(peerId, session);

    // A seta deste visitante: a primeira cor livre e um nome que caiba embaixo
    // dela. O processo principal já pode desenhá-la — ela nasce no meio da
    // tela e o primeiro movimento a leva para o lugar certo.
    const cor = proximaCorLivre(this.coresDeVisitantes.values());
    this.coresDeVisitantes.set(peerId, cor);
    const nomeDaSeta = this.nomeDaSeta(peerId);
    window.ryke.ponteiros.entrar(peerId, nomeDaSeta, cor);

    session.on('stats', (stats) => {
      if (this.state.incoming?.peerId === peerId && this.state.incoming.phase === 'ativa') {
        this.set({ incoming: { ...this.state.incoming, stats } });
      }
    });
    session.on('transfers', () => this.refreshTransfers());
    session.on('ready', () => {
      window.ryke.session.setActive(true);
      // "A sua seta é a vermelha, e o nome nela é este." Vai pelo canal
      // confiável: uma cor perdida deixaria dois visitantes vermelhos.
      session.sendCor(cor, nomeDaSeta);
      // Enquanto alguém comanda esta máquina, a senha fica trancada: quem está
      // do outro lado poderia abrir este programa aqui dentro e trocá-la.
      window.ryke.session.visitantes(this.hostSessions.size);
      // Registra quem entrou, para o dono saber depois quem o acessou.
      rememberRecebido(peerId);
      this.set({ recebidos: loadRecebidos() });
      this.toast('ok', `Sessão iniciada com o número ${peerId}.`);
    });
    session.on('saude', (viva, motivo) => {
      if (!viva) this.toast('info', `Reconectando com ${peerId} — ${motivo}`);
    });
    session.on('closed', (reason) => {
      this.hostSessions.delete(peerId);
      // A seta some da tela do anfitrião e a cor volta para a fila.
      this.coresDeVisitantes.delete(peerId);
      window.ryke.ponteiros.sair(peerId);
      // O bloqueio de suspensão só sai quando o ÚLTIMO visitante vai embora:
      // com várias sessões, desligá-lo na primeira que fecha deixaria a tela
      // do anfitrião apagar no meio das outras.
      if (this.hostSessions.size === 0) window.ryke.session.setActive(false);
      window.ryke.session.visitantes(this.hostSessions.size);
      if (this.state.incoming?.peerId === peerId) {
        const outra = [...this.hostSessions.keys()][0];
        this.set({
          incoming: outra ? { peerId: outra, phase: 'ativa', modo: 'senha', stats: null } : null,
        });
      }
      this.toast('info', `Sessão com ${peerId} encerrada — ${reason}`);
    });

    try {
      // Captura antes de aceitar. Assim uma falha de driver vira uma resposta
      // clara ao pedido, e não "aceitou" seguido imediatamente de "sessão
      // encerrada". A oferta fica para depois porque o visitante só cria sua
      // sessão ao receber `accepted`.
      await session.prepareAsHost(this.state.settings?.quality ?? 'auto');
      this.signaling?.send(peerId, { t: 'accepted' });
      await session.offerAsHost();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.toast('erro', `Não foi possível capturar a tela: ${detail}`);
      this.signaling?.send(peerId, { t: 'denied', reason: 'falha-captura', detail: detail.slice(0, 1400) });
      session.close('falha ao capturar a tela', false);
    }
  }

  /**
   * O nome que vai escrito, em letra pequena, embaixo da seta deste visitante.
   *
   * Três setas coloridas sem nome são três enigmas — é por isso que o rótulo
   * não é opcional. E o que serve de nome é o NOME DO COMPUTADOR: "Notebook da
   * Ana" diz de quem é a seta; "481 922 730 155" não diz nada a ninguém no meio
   * de uma sessão.
   *
   * A ordem vai da informação mais confiável para a mais útil:
   *
   *   1. O apelido que o DONO desta máquina salvou nos favoritos. É o único
   *      que não vem de fora, então vem primeiro.
   *   2. O nome que a máquina do visitante se deu (o `name` do knock) — na
   *      prática o nome do Windows dele, que é o que a pessoa reconhece.
   *   3. O número, quando não há nem uma coisa nem outra.
   *
   * SOBRE O ITEM 2, com todas as letras: aquele texto é escolhido por quem
   * está do outro lado, e portanto pode mentir — alguém pode se chamar
   * "Suporte Microsoft". Ele está aqui mesmo assim porque este rótulo aparece
   * DENTRO de uma sessão que o dono da máquina já autorizou, e a decisão que
   * importa acontece antes, na tela de permissão — que mostra o número, não o
   * nome, e traz o aviso sobre o golpe do falso suporte. Confiar no nome para
   * decorar uma seta é diferente de confiar nele para abrir a porta.
   */
  private nomeDaSeta(peerId: string): string {
    const favorito = this.state.favoritos.find((f) => f.numero === peerId)?.nome;
    return nomeCurto(favorito || this.nomesDeVisitantes.get(peerId) || formatId(peerId));
  }

  /** A cor da seta de um visitante conectado agora, ou null se não há. */
  corDoVisitante(peerId: string): number | null {
    return this.coresDeVisitantes.get(peerId) ?? null;
  }

  /** Encerra TODAS as sessões em que este computador é o anfitrião. */
  endHostSession(reason: string): void {
    for (const sessao of this.hostSessions.values()) sessao.close(reason);
    for (const peerId of this.hostSessions.keys()) window.ryke.ponteiros.sair(peerId);
    this.coresDeVisitantes.clear();
    this.hostSessions.clear();
    this.filaDeAprovacao = [];
    this.clearApprovalTimeout();
    this.set({ incoming: null });
  }

  /** Quantos visitantes estão conectados a este computador agora. */
  get visitantesConectados(): number {
    return this.hostSessions.size;
  }

  // ───────────────────── ações da interface ───────────────────

  async setPassword(password: string | null): Promise<void> {
    try {
      const status = await window.ryke.password.set(password);
      this.set({ hasPassword: status.defined });
      this.toast('ok', status.defined ? 'Senha de acesso definida.' : 'Senha removida — ninguém consegue mais entrar.');
    } catch (err) {
      this.toast('erro', err instanceof Error ? err.message : String(err));
    }
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const settings = await window.ryke.settings.save(patch);
    this.set({ settings });
    if (patch.serverUrl) this.signaling?.setUrl(patch.serverUrl);
  }

  /**
   * Troca a qualidade da imagem.
   *
   * "Alta" recebe um tratamento diferente das demais, e por um motivo
   * concreto: ela é a única que pode piorar a sessão em vez de melhorar. Numa
   * rede que não sustenta, ela enche a fila do caminho, a imagem passa a
   * chegar segundos atrasada — e aí o usuário não consegue nem clicar para
   * desfazer, porque cada clique também demora a chegar.
   *
   * A saída é a mesma que o Windows usa ao trocar a resolução do monitor:
   * aplica, pergunta, e desfaz sozinho se ninguém confirmar. Quem ficou preso
   * numa imagem inutilizável só precisa esperar — o programa volta atrás.
   */
  setQuality(quality: Quality): void {
    this.cancelarConfirmacaoDeQualidade();

    const anterior = this.state.outgoing?.quality ?? 'auto';
    this.aplicarQualidade(quality);

    if (quality !== 'alta' || anterior === 'alta') return;

    this.qualidadeAnterior = anterior;
    this.set({ confirmacaoQualidade: { segundos: SEGUNDOS_PARA_CONFIRMAR_QUALIDADE } });
    this.relogioQualidade = window.setInterval(() => {
      const restante = (this.state.confirmacaoQualidade?.segundos ?? 0) - 1;
      if (restante > 0) {
        this.set({ confirmacaoQualidade: { segundos: restante } });
        return;
      }
      // Ninguém confirmou. Ou a pessoa se distraiu, ou — o caso que importa —
      // a sessão ficou lenta demais para ela conseguir responder.
      this.cancelarConfirmacaoDeQualidade();
      this.aplicarQualidade(this.qualidadeAnterior);
      this.toast('info', 'Qualidade alta desfeita automaticamente: ninguém confirmou em 20 segundos.');
    }, 1000);
  }

  /** O usuário clicou em OK: a qualidade alta fica. */
  confirmarQualidade(): void {
    this.cancelarConfirmacaoDeQualidade();
    void this.updateSettings({ quality: 'alta' });
    this.toast('ok', 'Qualidade alta mantida.');
  }

  /** O usuário desistiu antes do prazo. */
  desfazerQualidade(): void {
    this.cancelarConfirmacaoDeQualidade();
    this.aplicarQualidade(this.qualidadeAnterior);
  }

  /**
   * A qualidade é escolhida POR ABA.
   *
   * Cada conexão tem a própria rede e o próprio computador do outro lado:
   * forçar uma escolha comum faria a máquina na fibra ficar refém da que está
   * num 4G ruim. Por isso só a aba da frente é afetada.
   */
  private aplicarQualidade(quality: Quality): void {
    const alvo = this.state.abaAtiva;
    if (!alvo) return;
    this.patchAba(alvo, { quality });
    void this.viewerSessions.get(alvo)?.applyQuality(quality);
    // A preferência de "alta" só é gravada depois de confirmada: seria ruim
    // reabrir o programa já preso numa qualidade que nem chegou a funcionar.
    if (quality !== 'alta') void this.updateSettings({ quality });
  }

  private cancelarConfirmacaoDeQualidade(): void {
    if (this.relogioQualidade !== null) {
      clearInterval(this.relogioQualidade);
      this.relogioQualidade = null;
    }
    if (this.state.confirmacaoQualidade) this.set({ confirmacaoQualidade: null });
  }

  selectDisplay(id: number): void {
    this.viewer?.selectDisplay(id);
  }

  runRemoteInstaller(): void {
    this.viewer?.runInstaller();
  }

  toggleBlockLocalInput(): void {
    const alvo = this.state.abaAtiva;
    if (!alvo) return;
    const next = !this.state.outgoing?.blockingLocalInput;
    this.viewerSessions.get(alvo)?.setBlockLocalInput(next);
    this.patchAba(alvo, { blockingLocalInput: next });
  }

  get active(): Session | null {
    return this.viewer ?? [...this.hostSessions.values()][0] ?? null;
  }

  /** A sessão da aba que está na frente — a que recebe teclado e mouse. */
  get viewer(): Session | null {
    const ativa = this.state.abaAtiva;
    return ativa ? (this.viewerSessions.get(ativa) ?? null) : null;
  }

  sendCombo(codes: string[]): void {
    this.viewer?.sendCombo(codes);
  }

  /**
   * Ctrl+Alt+Del no computador remoto.
   *
   * Separado de `sendCombo` porque não é injeção de tecla: vai pela API
   * SendSAS do outro lado, que pode recusar. A resposta vira aviso na tela —
   * o defeito que isto corrige era um botão que falhava em silêncio.
   */
  sendSas(): void {
    const sessao = this.viewer;
    if (!sessao) return;
    const solta = sessao.on('sas', (r) => {
      solta();
      this.toast(r.ok ? 'ok' : 'erro', r.motivo);
    });
    sessao.sendSas();
  }

  /** Arquivos arrastados para dentro da janela. */
  /**
   * Arrastado para a janela: pode ser arquivo ou PASTA.
   *
   * A distinção não é visível no `FileList` — uma pasta arrastada aparece como
   * um `File` de tamanho zero, e tentar lê-lo devolve erro. Era isso que fazia
   * arrastar uma pasta terminar num arquivo vazio com o nome dela. Perguntamos
   * ao disco o que cada coisa é, e a pasta vira a árvore inteira.
   */
  async sendDroppedFiles(files: FileList | File[]): Promise<void> {
    const session = this.active;
    if (!session) {
      this.toast('erro', 'Conecte-se a um computador antes de enviar arquivos.');
      return;
    }

    for (const file of Array.from(files)) {
      const caminho = window.ryke.files.caminhoDe(file);
      if (caminho && (await window.ryke.files.isFolder(caminho))) {
        await this.enviarArvore(await window.ryke.files.listFolder(caminho));
        continue;
      }
      // Sem caminho em disco (colagem, arquivo gerado), os bytes já estão aqui.
      if (caminho) {
        const handle = await window.ryke.files.open(caminho);
        session.sendFile(sourceFromDisk(handle));
      } else {
        session.sendFile(sourceFromFile(file));
      }
    }
  }

  async sendFileFromDialog(): Promise<void> {
    const session = this.active;
    if (!session) return;
    const handle = await window.ryke.files.pick();
    if (handle) session.sendFile(sourceFromDisk(handle));
  }

  /**
   * Envia uma PASTA inteira, com a árvore de subpastas.
   *
   * O protocolo transporta arquivos, um de cada vez — então "enviar uma pasta"
   * é enfileirar todos os arquivos dela, cada um carregando o próprio caminho
   * relativo. Quem recebe recria a árvore a partir desses caminhos.
   *
   * A fila do motor já serializa: os arquivos saem um após o outro, e o
   * controle de fluxo do canal continua valendo para cada um. Enfileirar dez
   * mil não consome dez mil vezes mais memória — o que fica na memória é dez
   * mil descritores de poucas dezenas de bytes, não dez mil arquivos.
   */
  async sendFolderFromDialog(): Promise<void> {
    const session = this.active;
    if (!session) return;
    const arquivos = await window.ryke.files.pickFolder();
    if (!arquivos) return;
    await this.enviarArvore(arquivos);
  }

  /** O trecho comum entre escolher uma pasta e arrastá-la para a janela. */
  private async enviarArvore(arquivos: { path: string; relPath: string; size: number }[]): Promise<void> {
    const session = this.active;
    if (!session) return;
    if (arquivos.length === 0) {
      this.toast('info', 'A pasta está vazia — não há nada para enviar.');
      return;
    }

    const total = arquivos.reduce((soma, a) => soma + a.size, 0);
    this.toast('info', `Enviando ${arquivos.length} ${arquivos.length === 1 ? 'arquivo' : 'arquivos'} (${formatBytes(total)}).`);

    for (const arquivo of arquivos) {
      // `openForSend` abre um descritor de arquivo por vez. Abrir dez mil de
      // uma vez esbarraria no limite do sistema operacional; abrimos na hora
      // de cada envio, e o motor fecha ao terminar.
      try {
        const handle = await window.ryke.files.open(arquivo.path);
        session.sendFile(sourceFromDisk({ ...handle, relPath: arquivo.relPath }));
      } catch (err) {
        this.toast('erro', `Não foi possível abrir ${arquivo.relPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Envia o arquivo que o usuário copiou no Explorador deste PC. */
  async sendClipboardFile(): Promise<void> {
    if (this.state.clipboardFiles.length) await this.transferirArquivosCopiados(this.state.clipboardFiles);
  }

  /**
   * Faz Ctrl+C local -> clipboard remoto. Chamadas repetidas compartilham a
   * mesma transferência, inclusive o Ctrl+V dado imediatamente após copiar.
   */
  private transferirArquivosCopiados(paths: string[]): Promise<boolean> {
    const assinatura = paths.join('\u0000');
    if (!assinatura) return Promise.resolve(false);
    if (this.clipboardPreparado === assinatura) return Promise.resolve(true);
    if (this.envioClipboard?.assinatura === assinatura) return this.envioClipboard.promise;
    // O atalho Ctrl+C local -> Ctrl+V remoto pertence a quem está vendo e
    // controlando a outra tela. O anfitrião ainda pode enviar pelo seletor ou
    // por arrastar, mas não disputa o mesmo clipboard automaticamente.
    const session = this.viewer;
    if (!session) return Promise.resolve(false);

    const promise = (async (): Promise<boolean> => {
      try {
        const lote = crypto.randomUUID();
        this.set({ clipboardFiles: [] });
        const resultados: boolean[] = [];
        for (let index = 0; index < paths.length; index++) {
          const handle = await window.ryke.files.open(paths[index]);
          resultados.push(await session.sendFile(sourceFromDisk(handle), { id: lote, index, total: paths.length }));
        }
        const pronto = resultados.every(Boolean);
        if (pronto) this.clipboardPreparado = assinatura;
        return pronto;
      } catch (err) {
        this.toast('erro', err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        if (this.envioClipboard?.assinatura === assinatura) this.envioClipboard = null;
      }
    })();
    this.envioClipboard = { assinatura, promise };
    return promise;
  }

  /** Aguarda o arquivo ficar colável no remoto; false significa clipboard de texto. */
  async prepararColagemDeArquivo(): Promise<boolean> {
    const paths = await window.ryke.clipboard.files();
    const atuais = paths.length ? paths : this.state.clipboardFiles;
    return atuais.length ? this.transferirArquivosCopiados(atuais) : false;
  }

  dismissClipboardFile(): void {
    this.set({ clipboardFiles: [] });
  }

  cancelTransfer(id: string): void {
    this.active?.engine?.cancel(id);
    this.refreshTransfers();
  }

  private refreshTransfers(): void {
    this.set({ transfers: [...(this.active?.engine?.views ?? [])] });
  }

  toast(kind: Toast['kind'], text: string): void {
    const toast: Toast = { id: this.toastSeq++, kind, text };
    this.set({ toasts: [...this.state.toasts, toast] });
    window.setTimeout(() => {
      this.set({ toasts: this.state.toasts.filter((t) => t.id !== toast.id) });
    }, kind === 'erro' ? 8000 : 4500);
  }

  dismissToast(id: number): void {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }
}

function isRtcPayload(data: SignalPayload): data is Extract<SignalPayload, { t: 'offer' | 'answer' | 'ice' | 'bye' }> {
  return data.t === 'offer' || data.t === 'answer' || data.t === 'ice' || data.t === 'bye';
}

function loadRecent(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function rememberRecent(peerId: string): void {
  const list = [peerId, ...loadRecent().filter((v) => v !== peerId)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

const RECEBIDOS_KEY = 'ryke:recebidos';

function loadRecebidos(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECEBIDOS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function rememberRecebido(peerId: string): void {
  const list = [peerId, ...loadRecebidos().filter((v) => v !== peerId)].slice(0, 8);
  localStorage.setItem(RECEBIDOS_KEY, JSON.stringify(list));
}
