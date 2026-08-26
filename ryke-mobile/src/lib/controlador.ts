/**
 * Cérebro do aplicativo: mantém o estado e conduz a máquina de estados de
 * quem inicia uma conexão.
 *
 * Só existe um papel aqui, o de visitante — o celular acessa um PC e nunca é
 * acessado. A metade "anfitrião" do desktop (captura de tela, injeção de
 * teclado, aprovação de pedidos, senha guardada) simplesmente não existe
 * neste projeto, e essa ausência é o que torna o aplicativo pequeno e seguro.
 */
import { Malha } from '../shared/malha';
import { normalizeId, type ModoAcesso, type SignalPayload } from '../shared/protocol';
import { Sessao, ICE_MOVEL, type Estatisticas, type MetaAnfitriao } from './sessao';
import {
  cofreDoAndroid,
  esquecerPino,
  esquecerSenha,
  lerFavoritos,
  lerRecentes,
  marcarRecente,
  marcarUso,
  numerosComSenha,
  salvarSenha,
  senhaGuardada,
  type Favorito,
} from './cofre';
import { derivarVerificador, provaPara, chaveDeSessao, deHex, type ScryptParams } from './auth';

export type Fase =
  | 'discando'
  | 'autenticando'
  /** Esperando alguém clicar em "Permitir" na tela do PC. */
  | 'aguardando-autorizacao'
  | 'negociando'
  | 'conectado';

export type Aviso = { id: number; tipo: 'ok' | 'erro' | 'info'; texto: string };

export type Estado = {
  pronto: boolean;
  /** Situação da malha de encontro. */
  rede: 'conectando' | 'online' | 'offline';
  /** Quantos pontos de encontro este aparelho alcançou. */
  pontos: { nome: string; familia: 'mqtt' | 'nostr'; conectado: boolean }[];
  meuNumero: string | null;
  favoritos: Favorito[];
  /** Os últimos computadores acessados, para virarem favoritos com um toque. */
  recentes: string[];
  /** Quais números têm senha guardada. Só os números — nunca as senhas. */
  comSenhaSalva: string[];
  conexao: {
    peerId: string;
    modo: ModoAcesso;
    fase: Fase;
    stats: Estatisticas | null;
    meta: MetaAnfitriao | null;
    /** A sessão parou de responder e está sendo refeita. */
    instavel?: boolean;
  } | null;
  /** Um número conhecido apareceu com outra identidade. */
  identidadeSuspeita: { numero: string; esperada: string; recebida: string } | null;
  avisos: Aviso[];
};

const PRAZO_RESPOSTA_MS = 25_000;
const PRAZO_AUTORIZACAO_MS = 75_000;

const MOTIVOS: Record<string, string> = {
  'senha-incorreta': 'Senha incorreta.',
  recusado: 'A pessoa no computador recusou o acesso.',
  ocupado: 'O computador já está em outra sessão.',
  'sem-senha': 'O computador ainda não definiu uma senha de acesso.',
  bloqueado: 'Muitas tentativas com senha errada. Aguarde para tentar de novo.',
  'sem-resposta': 'Ninguém respondeu ao pedido no computador.',
  'exige-senha': 'Este computador só aceita conexões com senha.',
};

export class Controlador {
  private ouvintes = new Set<() => void>();
  private malha: Malha | null = null;
  private sessao: Sessao | null = null;
  /** Senha digitada, viva só até a autenticação terminar. */
  private senhaPendente = '';
  /** Senha a guardar — só se a pessoa marcou a caixinha E o acesso funcionar. */
  private senhaParaLembrar: string | null = null;
  private relogioResposta: number | null = null;
  private relogioDiagnostico: number | null = null;
  private sequenciaAviso = 1;

  estado: Estado = {
    pronto: false,
    rede: 'conectando',
    pontos: [],
    meuNumero: null,
    favoritos: [],
    recentes: [],
    comSenhaSalva: [],
    conexao: null,
    identidadeSuspeita: null,
    avisos: [],
  };

  assinar = (fn: () => void): (() => void) => {
    this.ouvintes.add(fn);
    return () => this.ouvintes.delete(fn);
  };

  instantaneo = (): Estado => this.estado;

  private set(patch: Partial<Estado>): void {
    this.estado = { ...this.estado, ...patch };
    for (const fn of this.ouvintes) fn();
  }

  private patchConexao(patch: Partial<NonNullable<Estado['conexao']>>): void {
    if (!this.estado.conexao) return;
    this.set({ conexao: { ...this.estado.conexao, ...patch } });
  }

  aviso(tipo: Aviso['tipo'], texto: string): void {
    const id = this.sequenciaAviso++;
    this.set({ avisos: [...this.estado.avisos, { id, tipo, texto }] });
    window.setTimeout(() => {
      this.set({ avisos: this.estado.avisos.filter((a) => a.id !== id) });
    }, 6000);
  }

  // ────────────────────────── início ──────────────────────────

  async iniciar(): Promise<void> {
    const [favoritos, recentes, comSenhaSalva] = await Promise.all([
      lerFavoritos(),
      lerRecentes(),
      numerosComSenha(),
    ]);
    this.set({ favoritos, recentes, comSenhaSalva, pronto: true });

    this.malha = new Malha({
      cofre: cofreDoAndroid,
      // O WebSocket do WebView cumpre o contrato de `Soquete`; o tipo do DOM
      // traz sobrecargas demais para casar estruturalmente.
      abrir: (url, protocolos) => new WebSocket(url, protocolos) as never,
    });

    this.malha.on('status', (status) => this.set({ rede: status }));
    this.malha.on('welcome', ({ id }) => this.set({ meuNumero: id }));
    this.malha.on('signal', (de, dados) => void this.aoSinal(de, dados));
    this.malha.on('identidadeMudou', (numero, esperada, recebida) => {
      this.falhar('A identidade deste número mudou.');
      this.set({ identidadeSuspeita: { numero, esperada, recebida } });
    });
    this.malha.on('serverError', (motivo) => {
      if (motivo === 'sem-corretor') this.aviso('erro', 'Sem conexão com a internet no momento.');
      if (motivo === 'numero-ambiguo') {
        this.aviso('erro', 'Dois computadores responderam por este número. Peça para reabrirem o Ryke Desk.');
      }
    });

    this.malha.connect();

    this.relogioDiagnostico = window.setInterval(() => {
      const pontos = this.malha?.diagnostico() ?? [];
      const antes = this.estado.pontos;
      const mudou =
        antes.length !== pontos.length || pontos.some((p, i) => antes[i]?.conectado !== p.conectado);
      if (mudou) this.set({ pontos });
    }, 2000);
  }

  // ──────────────────────── conectar ────────────────────────

  /**
   * Bate à porta de um PC.
   *
   * Sem senha, o pedido aparece na tela de lá e alguém precisa permitir —
   * é o modo de suporte, em que a pessoa vê tudo acontecendo. Com senha,
   * entra direto, sem depender de ninguém do outro lado.
   */
  async conectar(numeroBruto: string, senha: string, lembrarSenha = false): Promise<void> {
    const peerId = normalizeId(numeroBruto);
    if (!peerId) {
      this.aviso('erro', 'O número precisa ter 12 dígitos.');
      return;
    }
    if (peerId === this.estado.meuNumero) {
      this.aviso('erro', 'Este é o número deste próprio aparelho.');
      return;
    }
    if (this.estado.conexao) return;

    const modo: ModoAcesso = senha.length > 0 ? 'senha' : 'pedido';
    this.senhaPendente = senha;
    // Só é gravada depois de o computador aceitar. Guardar agora deixaria uma
    // senha errada salva para sempre, e a pessoa culparia o aplicativo.
    this.senhaParaLembrar = lembrarSenha && senha.length > 0 ? senha : null;
    this.set({ conexao: { peerId, modo, fase: 'discando', stats: null, meta: null } });

    if (!this.malha?.connected) {
      const entrou = await this.esperarRede(20_000);
      if (!entrou) {
        this.falhar(
          this.estado.pontos.length > 0
            ? 'A rede deste aparelho está bloqueando os pontos de encontro.'
            : 'Este aparelho não está conseguindo sair para a internet.',
        );
        return;
      }
    }

    this.malha?.send(peerId, { t: 'knock', app: 'ryke-desk', name: 'Celular', modo });
    this.armarPrazo(PRAZO_RESPOSTA_MS, 'O computador não respondeu. Confira se ele está ligado e com o Ryke Desk aberto.');
  }

  private esperarRede(prazo: number): Promise<boolean> {
    return new Promise((resolve) => {
      const limite = Date.now() + prazo;
      const olhar = (): void => {
        if (this.malha?.connected) return resolve(true);
        if (Date.now() > limite) return resolve(false);
        window.setTimeout(olhar, 250);
      };
      olhar();
    });
  }

  private armarPrazo(prazo: number, mensagem: string): void {
    this.limparPrazo();
    this.relogioResposta = window.setTimeout(() => {
      if (this.estado.conexao && this.estado.conexao.fase !== 'conectado') this.falhar(mensagem);
    }, prazo);
  }

  private limparPrazo(): void {
    if (this.relogioResposta !== null) clearTimeout(this.relogioResposta);
    this.relogioResposta = null;
  }

  private falhar(mensagem: string): void {
    this.limparPrazo();
    this.senhaPendente = '';
    this.sessao?.encerrar(mensagem);
    this.sessao = null;
    this.set({ conexao: null });
    this.aviso('erro', mensagem);
  }

  // ───────────────────── roteamento de sinais ─────────────────────

  private async aoSinal(de: string, dados: SignalPayload): Promise<void> {
    if (this.sessao?.peerId === de && (dados.t === 'offer' || dados.t === 'ice' || dados.t === 'bye')) {
      return this.sessao.tratarSinal(dados);
    }
    if (this.estado.conexao?.peerId !== de) return;

    switch (dados.t) {
      case 'challenge':
        return this.responderDesafio(de, dados);
      case 'aguardando':
        // A decisão saiu do software e foi para uma pessoa; o relógio muda.
        this.patchConexao({ fase: 'aguardando-autorizacao' });
        this.armarPrazo(PRAZO_AUTORIZACAO_MS, 'Ninguém respondeu ao pedido no computador.');
        return;
      case 'accepted':
        this.patchConexao({ fase: 'negociando' });
        this.abrirSessao(de);
        return;
      case 'denied':
        this.falhar(MOTIVOS[dados.reason] ?? 'Acesso recusado.');
        return;
    }
  }

  private async responderDesafio(
    de: string,
    desafio: { salt: string; nonce: string; scrypt: ScryptParams },
  ): Promise<void> {
    this.patchConexao({ fase: 'autenticando' });
    // scrypt é pesado de propósito (é o que torna a senha cara de adivinhar).
    // Num celular modesto leva um instante — daí a fase visível na tela.
    const verificador = derivarVerificador(this.senhaPendente, deHex(desafio.salt), desafio.scrypt);
    const nonce = deHex(desafio.nonce);
    this.chaveDaSessao = chaveDeSessao(verificador, nonce);
    this.senhaPendente = '';
    this.malha?.send(de, { t: 'proof', proof: provaPara(verificador, nonce) });
  }

  private chaveDaSessao: Uint8Array | null = null;

  private abrirSessao(de: string): void {
    if (!this.malha) return;
    const sessao = new Sessao(de, this.malha, ICE_MOVEL, this.chaveDaSessao);
    this.sessao = sessao;

    sessao.on('pronta', () => {
      this.limparPrazo();
      this.patchConexao({ fase: 'conectado' });
      void marcarUso(de);
      void lerFavoritos().then((favoritos) => this.set({ favoritos }));
      // Entrou em "recentes" só agora, com a sessão de pé: número que não
      // conecta não merece ocupar espaço na tela inicial.
      void marcarRecente(de).then((recentes) => this.set({ recentes }));

      const guardar = this.senhaParaLembrar;
      this.senhaParaLembrar = null;
      if (guardar) {
        void salvarSenha(de, guardar)
          .then(() => numerosComSenha())
          .then((comSenhaSalva) => {
            this.set({ comSenhaSalva });
            this.aviso('ok', 'Senha guardada para este computador.');
          });
      }
    });
    sessao.on('saude', (viva) => this.patchConexao({ instavel: !viva }));
    sessao.on('stats', (stats) => this.patchConexao({ stats }));
    // Ctrl+Alt+Del pode ser recusado pela política do Windows do outro lado.
    sessao.on('sas', (r) => this.aviso(r.ok ? 'ok' : 'erro', r.motivo));
    sessao.on('meta', (meta) => this.patchConexao({ meta }));
    sessao.on('encerrada', (motivo) => {
      if (this.sessao !== sessao) return;
      this.sessao = null;
      this.chaveDaSessao = null;
      this.set({ conexao: null });
      this.aviso('info', motivo);
    });
  }

  // ──────────────────────── durante a sessão ────────────────────────

  get sessaoAtiva(): Sessao | null {
    return this.sessao;
  }

  desconectar(): void {
    this.sessao?.encerrar('encerrado no celular');
    this.sessao = null;
    this.chaveDaSessao = null;
    this.limparPrazo();
    this.set({ conexao: null });
  }

  async recarregarFavoritos(): Promise<void> {
    this.set({ favoritos: await lerFavoritos() });
  }

  async recarregarRecentes(): Promise<void> {
    this.set({ recentes: await lerRecentes() });
  }

  /** A senha guardada deste número, para preencher o campo sozinha. */
  async senhaGuardada(numero: string): Promise<string | null> {
    if (!this.estado.comSenhaSalva.includes(numero)) return null;
    return senhaGuardada(numero);
  }

  async esquecerSenha(numero: string): Promise<void> {
    await esquecerSenha(numero);
    this.set({ comSenhaSalva: await numerosComSenha() });
  }

  /** Aceita a nova identidade de um número, depois de confirmada por fora. */
  async confiarNovaIdentidade(): Promise<void> {
    const suspeita = this.estado.identidadeSuspeita;
    if (!suspeita) return;
    await esquecerPino(suspeita.numero);
    this.set({ identidadeSuspeita: null });
    this.aviso('info', 'Identidade antiga esquecida. Tente conectar novamente.');
  }

  descartarAvisoDeIdentidade(): void {
    this.set({ identidadeSuspeita: null });
  }

  encerrar(): void {
    if (this.relogioDiagnostico !== null) clearInterval(this.relogioDiagnostico);
    this.limparPrazo();
    this.sessao?.encerrar('aplicativo encerrado');
    this.malha?.disconnect();
  }
}
