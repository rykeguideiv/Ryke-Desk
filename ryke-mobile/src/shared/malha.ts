/**
 * A malha de encontro — o que substituiu o servidor.
 *
 * O problema: dois computadores em pontas opostas do país, cada um atrás do
 * roteador da sua operadora, precisam trocar meia dúzia de mensagens para
 * montar a ligação direta. Nenhum dos dois consegue receber conexão de fora,
 * então alguém no meio precisa segurar o recado. A resposta usual é manter um
 * servidor. Isso custa dinheiro, exige cadastro e cria um dono: se ele cai,
 * cai todo mundo junto.
 *
 * A saída aqui é não ter servidor nenhum. Existem corretores MQTT públicos —
 * de fabricantes diferentes, em países diferentes — abertos há mais de uma
 * década para qualquer um publicar e assinar tópicos, sem cadastro. São
 * caixas de recado do mundo inteiro. O Ryke Desk usa **todos ao mesmo tempo**:
 *
 *   · o número do computador vira um tópico opaco (SHA-256 do número);
 *   · quem quer falar publica nesse tópico, cifrado, em todos os corretores;
 *   · quem escuta recebe a mesma mensagem três vezes e usa a primeira.
 *
 * Daí as três propriedades que interessam:
 *
 *   SEM CADASTRO — ninguém cria conta em lugar nenhum. O programa instala e
 *   funciona.
 *
 *   SEM DONO — não há servidor do Ryke Desk para pagar, manter ou derrubar.
 *   Os corretores não sabem que existe um Ryke Desk; para eles é tráfego opaco
 *   entre dois tópicos.
 *
 *   SEM PONTO ÚNICO DE FALHA — três operadores independentes teriam de sair do
 *   ar ao mesmo tempo. Quando um cai, os outros seguem e o usuário não vê nada.
 *
 * Duas honestidades sobre o desenho:
 *
 *   1. Os corretores veem bytes cifrados e tópicos opacos, mas veem que houve
 *      tráfego. Isso é metadado, e não some. O conteúdo — quem é, que tela,
 *      que senha — nunca sai daqui em claro (ver encontro.ts).
 *
 *   2. São serviços públicos de cortesia, sem contrato de disponibilidade.
 *      É exatamente por isso que são três, e por isso `corretoresExtras`
 *      existe: quem quiser um endereço próprio aponta e pronto.
 */
import { ClienteMqtt, type AbrirSoquete } from './mqtt';
import { ClienteNostr } from './nostr';
import {
  abrir,
  chaveDe,
  criarIdentidade,
  exportarIdentidade,
  importarIdentidade,
  novoIdMensagem,
  selar,
  sortearNumero,
  topicoDe,
  DIGITOS_NUMERO,
  type Identidade,
} from './encontro';
import type { IceServer, SignalPayload } from './protocol';

/**
 * Corretores públicos, de três organizações diferentes.
 *
 * A independência é o ponto: mesma empresa em três máquinas cairia junto numa
 * pane de conta ou de rede. EMQX (China/global), HiveMQ (Alemanha) e Eclipse
 * Mosquitto (Fundação Eclipse) não compartilham operação.
 */
export const CORRETORES_PADRAO = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker-cn.emqx.io:8084/mqtt',
];

/**
 * Pontos de encontro na porta 443 — o caminho para redes restritas.
 *
 * Os corretores MQTT acima atendem em portas incomuns (8084, 8884, 8081).
 * Rede de casa não liga para isso; rede de empresa quase sempre libera só 80
 * e 443 e barra o resto. Sem uma alternativa na 443, o programa não conectava
 * no trabalho — e falhava do pior jeito possível, porque os dois lados até
 * apareciam online, só que em pontos de encontro sem interseção.
 *
 * Relays Nostr falam WebSocket seguro na 443, a mesma porta de qualquer site:
 * para o firewall é tráfego HTTPS comum. São públicos, sem cadastro, de
 * operadores independentes, e têm eventos efêmeros — que o relay repassa a
 * quem está ouvindo e não guarda (ver `nostr.ts`).
 */
export const RELAYS_PADRAO = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
];

/**
 * Servidores de descoberta de endereço (STUN). Públicos, sem cadastro.
 *
 * Eles respondem uma única pergunta: "com que endereço eu apareço para o
 * mundo?" — e é essa resposta que os dois lados trocam para furar o NAT. São
 * seis, de operadores independentes, todos verificados respondendo (ver
 * `test/internet.mjs`); a lista é longa de propósito, porque um deles fora do
 * ar ou bloqueado pela rede do usuário não pode custar a conexão.
 *
 * SOBRE RETRANSMISSÃO (TURN), E POR QUE NÃO HÁ NENHUMA AQUI
 *
 * Quando os dois lados estão atrás de NAT simétrico — o caso do CGNAT, comum
 * em operadoras brasileiras — não existe caminho direto, e a conexão só fecha
 * se um servidor no meio repassar o vídeo inteiro. Isso é TURN.
 *
 * Levantei os retransmissores públicos conhecidos e nenhum está de pé sem
 * cadastro: o Open Relay Project não responde mais, e os demais passaram a
 * exigir chave de API. Faz sentido: repassar vídeo é largura de banda paga,
 * ninguém sustenta isso de graça — ao contrário do STUN, que é um pacote
 * pequeno, e dos corretores de mensagem, que trocam alguns kilobytes.
 *
 * Preferi lista curta e verdadeira a lista comprida com endereços mortos:
 * cada TURN inoperante na lista atrasa a negociação, porque o navegador tenta
 * alocar em todos antes de desistir — a conexão demora mais para falhar e
 * também mais para dar certo.
 *
 * Quem cair nesse caso (a minoria) tem o campo de retransmissor nos Ajustes.
 */
export const ICE_PADRAO: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'stun:stun.nextcloud.com:443' },
  { urls: 'stun:stun.sipgate.net:3478' },
];

/**
 * O formato aceito para um número, usado para descartar os de versões
 * anteriores. Fica junto de DIGITOS_NUMERO para as duas coisas nunca
 * divergirem em silêncio.
 */
const FORMATO_NUMERO = new RegExp(`^[0-9]{${DIGITOS_NUMERO}}$`);

/** Quanto esperamos por respostas de presença antes de dar o número por livre. */
const ESPERA_PRESENCA_MS = 2500;

/**
 * O que a malha precisa de um ponto de encontro, seja ele qual for.
 *
 * MQTT e Nostr são protocolos sem nenhuma relação, mas o papel dos dois aqui
 * é o mesmo: assinar um tópico e publicar bytes nele. Reduzir os dois a esta
 * interface é o que deixa a malha misturar famílias — e é o que permite somar
 * uma terceira no futuro sem tocar em nada do resto.
 */
export type Transporte = {
  readonly nome: string;
  readonly conectado: boolean;
  conectar(): void;
  assinar(topico: string): void;
  publicar(topico: string, carga: Uint8Array<ArrayBuffer>): boolean;
  encerrar(): void;
};

/** Estado de cada ponto de encontro, para a tela de diagnóstico. */
export type EstadoPonto = { nome: string; familia: 'mqtt' | 'nostr'; conectado: boolean };

/** Mensagens internas da malha, que nunca chegam ao resto do programa. */
type Recado = (
  | { k: 'sinal'; p: SignalPayload }
  | { k: 'presenca-pergunta' }
  | { k: 'presenca-resposta' }
) & {
  /**
   * Distingue duas execuções físicas mesmo se uma imagem/clonagem do Windows
   * tiver copiado também a chave privada do Ryke Desk.
   */
  instancia?: string;
};

/** Onde guardamos número, chave privada e as impressões já conhecidas. */
export type Cofre = {
  ler(): Promise<{ numero: string | null; chavePrivada: string | null }>;
  gravar(numero: string, chavePrivada: string): Promise<void>;
  lerPinos(): Promise<Record<string, string>>;
  gravarPino(numero: string, impressao: string): Promise<void>;
};

export type EventosMalha = {
  status: (status: 'conectando' | 'online' | 'offline', detail?: string) => void;
  welcome: (payload: { id: string; token: string; iceServers: IceServer[]; impressao: string }) => void;
  signal: (from: string, data: SignalPayload) => void;
  peerOffline: (peerId: string) => void;
  serverError: (reason: string, detail?: string) => void;
  /**
   * A impressão digital de um número mudou desde a última vez.
   *
   * Ou a pessoa reinstalou o programa, ou alguém está se passando por ela.
   * A malha não decide qual — quem chama precisa perguntar ao usuário.
   */
  identidadeMudou: (numero: string, esperada: string, recebida: string) => void;
  /**
   * Outro computador respondeu pelo mesmo número.
   *
   * Praticamente impossível com doze dígitos, mas se acontecer o usuário
   * precisa saber — e decidir, porque trocar o número custa o contato de
   * quem já o tinha anotado.
   */
  numeroDuplicado: (numero: string) => void;
};

export type OpcoesMalha = {
  cofre: Cofre;
  abrir: AbrirSoquete;
  corretores?: string[];
  relays?: string[];
  iceServers?: IceServer[];
  /** Só nos testes: encurta as esperas para o relógio do teste. */
  esperaPresencaMs?: number;
};

export class Malha {
  private opcoes: OpcoesMalha;
  private clientes: Transporte[] = [];
  private familias = new Map<Transporte, 'mqtt' | 'nostr'>();
  private identidade: Identidade | null = null;
  private numero: string | null = null;

  /** Tópico → chave com que ele é lido e escrito. */
  private chaves = new Map<string, CryptoKey>();
  /**
   * Número → endereço na malha, já derivado.
   *
   * Derivar custa duas passagens de PBKDF2 de 210 mil voltas, algo como um
   * quinto de segundo. É caro de propósito (ver `encontro.ts`), e por isso
   * mesmo não pode ser refeito a cada mensagem enviada: sem este cache, uma
   * sessão ativa gastaria mais tempo derivando o mesmo endereço do que
   * conversando.
   */
  private enderecos = new Map<string, { topico: string; chave: CryptoKey }>();
  /** Número do outro lado → tópico onde a conversa dele acontece. */
  private rotas = new Map<string, string>();

  /** Mensagens já entregues, para descartar as cópias dos outros corretores. */
  private vistas = new Map<string, number>();
  private faxina: ReturnType<typeof setInterval> | null = null;

  /** Identificador desta execução; não é persistido nem identifica a pessoa. */
  private readonly instancia = novoIdMensagem();

  /** Quem respondeu presença, por número perguntado. */
  private presencas = new Map<string, { impressao: string; pk: string; instancia?: string }[]>();
  private pinos: Record<string, string> = {};

  /**
   * Duas filas, e não uma.
   *
   * Cada sentido precisa manter a própria ordem: sinais têm de sair na
   * sequência em que foram pedidos e chegar na sequência em que vieram. Mas
   * as duas não podem ser a mesma fila — a pergunta de presença espera pela
   * resposta, e se a resposta precisasse da fila que a pergunta está
   * segurando, ela só seria processada depois de o prazo ter vencido. A
   * espera bloquearia justamente aquilo que ela aguarda.
   */
  private filaSaida: Promise<void> = Promise.resolve();
  private filaEntrada: Promise<void> = Promise.resolve();
  private encerrada = false;
  private ligada = false;

  private ouvintes: { [K in keyof EventosMalha]: EventosMalha[K][] } = {
    status: [], welcome: [], signal: [], peerOffline: [], serverError: [], identidadeMudou: [],
    numeroDuplicado: [],
  };

  constructor(opcoes: OpcoesMalha) {
    this.opcoes = opcoes;
  }

  on<K extends keyof EventosMalha>(evento: K, fn: EventosMalha[K]): () => void {
    this.ouvintes[evento].push(fn);
    return () => {
      const lista = this.ouvintes[evento] as unknown[];
      const i = lista.indexOf(fn);
      if (i >= 0) lista.splice(i, 1);
    };
  }

  private emitir<K extends keyof EventosMalha>(evento: K, ...args: Parameters<EventosMalha[K]>): void {
    for (const fn of this.ouvintes[evento]) (fn as (...a: unknown[]) => void)(...args);
  }

  /** Online quando pelo menos um ponto responde. Um basta para conversar. */
  get connected(): boolean {
    return this.ligada && this.clientes.some((c) => c.conectado);
  }

  get impressao(): string | null {
    return this.identidade?.impressao ?? null;
  }

  connect(): void {
    if (this.encerrada || this.clientes.length > 0) return;
    this.emitir('status', 'conectando');
    this.filaSaida = this.filaSaida.then(() => this.iniciar()).catch((err) => {
      this.emitir('status', 'offline', String(err));
    });
  }

  // ─────────────────────────── Partida ───────────────────────────

  private async iniciar(): Promise<void> {
    const guardado = await this.opcoes.cofre.ler();
    this.pinos = await this.opcoes.cofre.lerPinos();

    this.identidade = guardado.chavePrivada
      ? await importarIdentidade(guardado.chavePrivada).catch(() => criarIdentidade())
      : await criarIdentidade();

    this.abrirPontos();
    await this.esperarAlgumPonto();
    if (this.encerrada) return;

    this.numero = await this.definirNumero(guardado.numero);
    await this.opcoes.cofre.gravar(this.numero, await exportarIdentidade(this.identidade));

    this.faxina = setInterval(() => this.limparVistas(), 60_000);
    this.ligada = true;
    this.emitir('status', 'online');
    this.emitir('welcome', {
      id: this.numero,
      token: '',
      iceServers: this.opcoes.iceServers ?? ICE_PADRAO,
      impressao: this.identidade.impressao,
    });
  }

  /**
   * Abre TODOS os pontos de encontro, das duas famílias, ao mesmo tempo.
   *
   * Não há escolha nem preferência: dois computadores só se enxergam se
   * compartilharem pelo menos um ponto, e cada rede bloqueia um conjunto
   * diferente. Estar em todos os que a rede permite é o que maximiza a chance
   * de haver interseção com o outro lado.
   */
  private abrirPontos(): void {
    for (const url of this.opcoes.corretores ?? CORRETORES_PADRAO) this.abrirPonto(url, 'mqtt');
    for (const url of this.opcoes.relays ?? RELAYS_PADRAO) this.abrirPonto(url, 'nostr');
  }

  private abrirPonto(url: string, familia: 'mqtt' | 'nostr'): void {
    let espera = 1000;

    const aoConectar = (): void => {
      espera = 1000;
      for (const topico of this.chaves.keys()) transporte.assinar(topico);
      if (this.ligada) this.emitir('status', 'online');
    };
    const aoMensagem = (topico: string, carga: Uint8Array<ArrayBuffer>): void => {
      this.filaEntrada = this.filaEntrada.then(() => this.receber(topico, carga)).catch(() => {});
    };
    const aoFechar = (): void => {
      if (this.encerrada) return;
      if (this.ligada && !this.connected) {
        this.emitir('status', 'offline', 'nenhum ponto de encontro alcançável');
      }
      // Reabre com espera crescente. Um ponto fora do ar não pode virar laço
      // de reconexão, mas também não pode ser abandonado: ele pode ser o
      // único que a rede do usuário deixa passar.
      const atraso = espera;
      espera = Math.min(espera * 2, 30_000);
      setTimeout(() => {
        if (!this.encerrada) transporte.conectar();
      }, atraso);
    };

    const transporte: Transporte =
      familia === 'mqtt'
        ? new ClienteMqtt({
            url,
            abrir: this.opcoes.abrir,
            // Precisa ser único: o corretor derruba a conexão antiga quando
            // outra chega com o mesmo nome.
            clientId: `ryke-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-6)}`,
            aoConectar,
            aoMensagem,
            aoFechar,
          })
        : new ClienteNostr({ url, abrir: this.opcoes.abrir, aoConectar, aoMensagem, aoFechar });

    this.clientes.push(transporte);
    this.familias.set(transporte, familia);
    transporte.conectar();
  }

  /**
   * Situação de cada ponto de encontro.
   *
   * Existe por causa de uma falha real: quando a conexão não acontecia, não
   * havia como saber se o problema era a rede daqui, a rede de lá, ou o outro
   * computador estar desligado. Sem isto, diagnosticar virava adivinhação.
   */
  diagnostico(): EstadoPonto[] {
    return this.clientes.map((c) => ({
      nome: c.nome,
      familia: this.familias.get(c) ?? 'mqtt',
      conectado: c.conectado,
    }));
  }

  /** Basta um ponto de pé para começar; os outros entram quando puderem. */
  private esperarAlgumPonto(): Promise<void> {
    return new Promise((resolve) => {
      const limite = Date.now() + 25_000;
      const olhar = () => {
        if (this.encerrada || this.clientes.some((c) => c.conectado) || Date.now() > limite) {
          resolve();
          return;
        }
        setTimeout(olhar, 150);
      };
      olhar();
    });
  }

  /**
   * Escolhe o número deste computador.
   *
   * Sem servidor não há cartório de números, então cada máquina tira o seu e
   * pergunta em voz alta se já tem dono. Quem responde com outra impressão
   * digital está usando o mesmo número — sorteamos outro. É improvável, mas o
   * estrago seria grande: duas máquinas atendendo a mesma chamada.
   */
  /**
   * Preserva o número guardado enquanto ele pertencer somente a esta máquina.
   * Se outro computador estiver respondendo por ele, este que acabou de abrir
   * sorteia e grava outro. Manter dois donos tornaria cada conexão ambígua.
   */
  private async definirNumero(preferido: string | null): Promise<string> {
    const aproveitavel = preferido !== null && FORMATO_NUMERO.test(preferido) ? preferido : null;
    let candidato = aproveitavel ?? sortearNumero();

    for (let tentativa = 0; tentativa < 8; tentativa++) {
      this.numero = candidato;
      const topico = await this.assinarTopicoDe(candidato);
      const donos = await this.perguntarPresenca(candidato);
      const outros = donos.filter(
        (d) => d.pk !== this.identidade!.publicaBruta || d.instancia !== this.instancia,
      );
      if (outros.length === 0) return candidato;

      this.emitir('numeroDuplicado', candidato);
      this.rotas.clear();
      this.chaves.delete(topico);
      candidato = sortearNumero();
    }

    throw new Error('não foi possível reservar um número exclusivo para este computador');
  }

  /**
   * Sorteia um número novo, a pedido explícito do usuário.
   *
   * Quem faz isso perde o contato de quem já tinha o número antigo anotado —
   * por isso a interface pede confirmação antes de chamar.
   */
  async trocarNumero(): Promise<string> {
    if (!this.identidade) throw new Error('a malha ainda não iniciou');
    const antigo = this.numero;
    const novo = sortearNumero();
    this.numero = novo;
    this.rotas.clear();
    if (antigo) this.chaves.delete((await this.enderecoDe(antigo)).topico);
    await this.assinarTopicoDe(novo);
    await this.opcoes.cofre.gravar(novo, await exportarIdentidade(this.identidade));
    this.emitir('welcome', {
      id: novo,
      token: '',
      iceServers: this.opcoes.iceServers ?? ICE_PADRAO,
      impressao: this.identidade.impressao,
    });
    return novo;
  }

  private async enderecoDe(numero: string): Promise<{ topico: string; chave: CryptoKey }> {
    const pronto = this.enderecos.get(numero);
    if (pronto) return pronto;
    const [topico, chave] = await Promise.all([topicoDe(numero), chaveDe(numero)]);
    const par = { topico, chave };
    this.enderecos.set(numero, par);
    return par;
  }

  private async assinarTopicoDe(numero: string): Promise<string> {
    const { topico, chave } = await this.enderecoDe(numero);
    if (!this.chaves.has(topico)) {
      this.chaves.set(topico, chave);
      for (const c of this.clientes) c.assinar(topico);
      // O corretor precisa de um instante entre o SUBSCRIBE e a primeira
      // publicação, senão a resposta chega antes da assinatura valer.
      await new Promise((r) => setTimeout(r, 250));
    }
    return topico;
  }

  private async perguntarPresenca(
    alvo: string,
  ): Promise<{ impressao: string; pk: string; instancia?: string }[]> {
    this.presencas.set(alvo, []);
    await this.publicar((await this.enderecoDe(alvo)).topico, alvo, { k: 'presenca-pergunta' });
    await new Promise((r) => setTimeout(r, this.opcoes.esperaPresencaMs ?? ESPERA_PRESENCA_MS));
    const achados = this.presencas.get(alvo) ?? [];
    this.presencas.delete(alvo);
    return achados;
  }

  // ─────────────────────────── Recepção ───────────────────────────

  private async receber(topico: string, carga: Uint8Array<ArrayBuffer>): Promise<void> {
    const chave = this.chaves.get(topico);
    if (!chave || !this.identidade) return;

    const lido = await abrir<Recado>(chave, carga);
    if (!lido) return; // lixo, adulterado, vencido ou de outro número

    const { interior, impressao } = lido;
    const recado = interior.dados;
    if (!recado || typeof recado !== 'object') return;

    // A própria mensagem volta pelos corretores. A instância permite não
    // confundi-la com outro PC que tenha recebido uma cópia da mesma chave.
    if (
      interior.pk === this.identidade.publicaBruta
      && (!recado.instancia || recado.instancia === this.instancia)
    ) return;

    // Já veio por outro corretor.
    if (this.vistas.has(interior.msg)) return;
    this.vistas.set(interior.msg, Date.now());

    if (recado.k === 'presenca-pergunta') {
      if (interior.para !== this.numero) return;
      await this.publicar(topico, interior.de, { k: 'presenca-resposta' });
      return;
    }

    if (recado.k === 'presenca-resposta') {
      // A pergunta foi feita sobre o número de quem está respondendo — tanto
      // na reivindicação (perguntamos sobre o nosso) quanto na sondagem de um
      // alvo. Em ambos os casos `de` é o número procurado.
      this.presencas.get(interior.de)?.push({
        impressao,
        pk: interior.pk,
        instancia: recado.instancia,
      });
      return;
    }

    if (recado.k !== 'sinal') return;
    if (interior.para !== this.numero) return; // conversa de outra dupla

    // Fixação na primeira conexão. A partir daqui, aquele número tem de
    // continuar sendo aquela mesma máquina.
    const conhecida = this.pinos[interior.de];
    if (conhecida && conhecida !== impressao) {
      this.emitir('identidadeMudou', interior.de, conhecida, impressao);
      return;
    }
    if (!conhecida) {
      this.pinos[interior.de] = impressao;
      void this.opcoes.cofre.gravarPino(interior.de, impressao);
    }

    this.rotas.set(interior.de, topico);
    this.emitir('signal', interior.de, recado.p);
  }

  private limparVistas(): void {
    const corte = Date.now() - 180_000;
    for (const [id, quando] of this.vistas) if (quando < corte) this.vistas.delete(id);
  }

  // ──────────────────────────── Envio ────────────────────────────

  /**
   * Publica em todos os corretores conectados.
   *
   * A mesma mensagem sai três vezes com o mesmo identificador; o outro lado
   * usa a primeira que chegar e descarta o resto. É o que troca a confirmação
   * de entrega de um corretor pela redundância de vários — e o que faz uma
   * queda no meio da conversa passar despercebida.
   */
  private async publicar(topico: string, para: string, dados: Recado): Promise<void> {
    const chave = this.chaves.get(topico);
    if (!chave || !this.identidade || !this.numero) return;
    const envelope = await selar<Recado>(chave, this.identidade, {
      de: this.numero,
      para,
      dados: { ...dados, instancia: this.instancia },
      msg: novoIdMensagem(),
    });
    let entregou = false;
    for (const c of this.clientes) entregou = c.publicar(topico, envelope) || entregou;
    if (!entregou) this.emitir('serverError', 'sem-corretor');
  }

  send(to: string, data: SignalPayload): void {
    this.filaSaida = this.filaSaida
      .then(async () => {
        if (!this.numero) return;
        const topico = this.rotas.get(to) ?? (await this.assinarTopicoDe(to));
        this.rotas.set(to, topico);
        await this.publicar(topico, to, { k: 'sinal', p: data });
      })
      .catch(() => {});
  }

  /** Pergunta se o número está ligado agora. Responde por `peerOffline`. */
  probe(to: string): void {
    this.filaSaida = this.filaSaida
      .then(async () => {
        if (!this.numero) return;
        await this.assinarTopicoDe(to);
        const achados = await this.perguntarPresenca(to);
        if (achados.length === 0) {
          this.emitir('peerOffline', to);
          return;
        }
        // Dois computadores diferentes atendendo pelo mesmo número. Raro ao
        // extremo com doze dígitos, mas se acontecer não dá para escolher um
        // no chute: seria conectar na máquina errada sem avisar ninguém.
        const distintos = new Set(achados.map((a) => `${a.pk}:${a.instancia ?? 'legado'}`));
        if (distintos.size > 1) this.emitir('serverError', 'numero-ambiguo');
      })
      .catch(() => {});
  }

  /**
   * Endereço próprio, para quem preferir não depender de corretor público.
   * Aceita `wss://...`; entra na roda junto com os demais.
   */
  setUrl(url: string): void {
    const limpo = url.trim();
    if (!/^wss?:\/\/.+/i.test(limpo)) return;
    const atuais = this.opcoes.corretores ?? CORRETORES_PADRAO;
    if (atuais.includes(limpo)) return;
    // Soma, não substitui: um corretor próprio é reforço, e tirar os públicos
    // deixaria o usuário sem saída se o dele estivesse fora do ar.
    this.opcoes.corretores = [...atuais, limpo];
    if (this.clientes.length > 0) this.abrirPonto(limpo, 'mqtt');
  }

  disconnect(): void {
    this.encerrada = true;
    this.ligada = false;
    if (this.faxina !== null) {
      clearInterval(this.faxina);
      this.faxina = null;
    }
    for (const c of this.clientes) c.encerrar();
    this.clientes = [];
    this.emitir('status', 'offline');
  }
}
