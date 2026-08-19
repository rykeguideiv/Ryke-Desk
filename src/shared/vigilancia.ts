/**
 * Quando uma sessão está morta, e o que fazer a respeito.
 *
 * O DEFEITO QUE ISTO CORRIGE
 *
 * Sessões longas congelavam depois de mais ou menos meia hora: a imagem
 * parava, teclado e mouse não chegavam mais, e o WebRTC continuava relatando
 * `connected`. Para quem estava usando, era pior do que uma queda limpa — a
 * janela seguia aberta, o ponteiro remoto sumia (ele é desenhado dentro do
 * vídeo, que estava parado) e nada respondia. Só a barra superior, que é
 * interface local, continuava funcionando.
 *
 * A causa de fundo é o caminho entre os dois computadores mudando por baixo
 * ao longo do tempo: a operadora troca o mapeamento do NAT, o Wi-Fi muda de
 * faixa, um equipamento da rede reinicia. O `connectionState` demora muito
 * para admitir isso — e às vezes nunca admite.
 *
 * TELA PARADA NÃO É SESSÃO MORTA
 *
 * A primeira versão disto tratava "quadros não avançam" como prova de
 * congelamento, e derrubava sessões perfeitamente vivas. O motivo é que a
 * captura de tela **não manda quadro quando nada muda**: ninguém mexeu no
 * mouse do outro lado, nenhuma janela se moveu, e o codificador simplesmente
 * não tem o que enviar. Uma pessoa lendo um documento por quarenta segundos
 * produzia exatamente a mesma leitura que um caminho de rede morto — e a
 * sessão se fechava sozinha, dizendo que não conseguiu restabelecer.
 *
 * A correção é perguntar ao outro lado. No pulso de volta, cada ponta informa
 * quantos quadros já mandou. Se a imagem parou aqui **e** o outro lado diz que
 * continua mandando, aí sim alguma coisa se perdeu no meio. Se os dois estão
 * parados, é só uma tela quieta — e uma tela quieta é o estado mais comum de
 * um computador.
 *
 * Quando o outro lado é uma versão antiga, que não informa nada, a imagem
 * deixa de valer como sinal. Não é perda: o defeito original derrubava o canal
 * de controle junto (teclado e mouse morriam), e o silêncio do pulso continua
 * pegando esse caso.
 *
 * POR QUE ESTA LÓGICA É PURA
 *
 * Um erro de calibragem aqui não quebra nada de forma visível: ele aparece
 * como "às vezes trava" ou "fica reconectando à toa", que é justamente o tipo
 * de problema impossível de reproduzir depois. Separada do WebRTC, a política
 * pode ser exercitada contra dezenas de cenários de tempo em milissegundos —
 * inclusive os que levariam meia hora para acontecer de verdade.
 */

/** Silêncio maior que isto no canal de controle é caminho morto, não lentidão. */
export const SILENCIO_FATAL_MS = 12_000;
/** Imagem parada por mais que isto, com a conexão jurando estar viva. */
export const CONGELAMENTO_MS = 10_000;
/** Tentativas de refazer o caminho antes de desistir e avisar de verdade. */
export const MAX_RECUPERACOES = 4;
/** Espera entre uma tentativa e a seguinte, para não repetir em rajada. */
export const INTERVALO_ENTRE_TENTATIVAS_MS = 8000;
/**
 * Tempo saudável que devolve as tentativas gastas.
 *
 * Sem isto, o orçamento de recuperações valia para a sessão inteira: quatro
 * soluços espalhados por um dia de trabalho — cada um resolvido na hora —
 * derrubavam a conexão no quinto. O orçamento é por incidente, não por vida.
 */
export const RESTABELECIDA_MS = 30_000;

export type Leitura = {
  agora: number;
  /** Quando chegou a última mensagem pelo canal de controle. */
  ultimaMensagem: number;
  /** Contagem de quadros de vídeo; parada pode ser congelamento — ou tela quieta. */
  quadros: number;
  /**
   * Quantos quadros o OUTRO lado diz ter mandado, pelo pulso de volta.
   *
   * `null` quando ele não informa (versão antiga). É o que separa "a imagem
   * travou" de "não há nada de novo para mandar".
   */
  quadrosDoOutro?: number | null;
  /** O que o WebRTC acha que está acontecendo — otimista demais, por isso é só um dos sinais. */
  conexao: 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
};

export type Decisao = {
  acao: 'nada' | 'recuperar' | 'desistir';
  /** Explicação em português, que vai parar na tela do usuário. */
  motivo: string;
  /** A sessão está respondendo neste instante? */
  viva: boolean;
};

export class Vigilancia {
  private ultimoQuadro = -1;
  private ultimoAvanco = 0;
  private ultimoDoOutro = -1;
  private ultimoAvancoDoOutro = 0;
  private tentativas = 0;
  private ultimaTentativa = 0;
  private comecou = 0;

  /** Zera a contagem: a conexão voltou a ficar de pé por conta própria. */
  reiniciar(agora: number): void {
    this.comecou = agora;
    this.ultimoAvanco = agora;
    this.ultimoAvancoDoOutro = agora;
    this.tentativas = 0;
  }

  get recuperacoes(): number {
    return this.tentativas;
  }

  avaliar(l: Leitura): Decisao {
    if (this.comecou === 0) this.reiniciar(l.agora);

    // Quadros avançando é a prova mais forte de que está tudo bem: significa
    // que o vídeo atravessou a rede e foi decodificado agora.
    if (l.quadros > 0 && l.quadros !== this.ultimoQuadro) {
      this.ultimoQuadro = l.quadros;
      this.ultimoAvanco = l.agora;
    }

    // E o que o outro lado diz sobre o que ELE está mandando.
    const relato = l.quadrosDoOutro ?? null;
    if (relato !== null && relato !== this.ultimoDoOutro) {
      this.ultimoDoOutro = relato;
      this.ultimoAvancoDoOutro = l.agora;
    }

    if (l.conexao === 'closed' || l.conexao === 'failed') {
      return { acao: 'desistir', motivo: 'a conexão caiu', viva: false };
    }

    const silencio = l.agora - l.ultimaMensagem;
    const imagemParada = l.agora - this.ultimoAvanco;
    // Só vale como prova de defeito se o outro lado afirmar que continua
    // mandando. Sem essa afirmação, imagem parada é tela quieta.
    const outroMandando = relato !== null && l.agora - this.ultimoAvancoDoOutro <= CONGELAMENTO_MS;

    let problema: string | null = null;
    if (silencio > SILENCIO_FATAL_MS) {
      problema = `o outro computador parou de responder (${Math.round(silencio / 1000)}s)`;
    } else if (l.conexao === 'disconnected') {
      problema = 'o caminho entre os dois computadores caiu';
    } else if (imagemParada > CONGELAMENTO_MS && l.conexao === 'connected' && outroMandando) {
      // O retrato exato do congelamento relatado: conexão dizendo estar viva,
      // o outro lado mandando imagem, e nada chegando aqui.
      problema = 'a imagem parou de chegar';
    }

    if (!problema) {
      // Ficou bom por tempo suficiente: devolve as tentativas gastas, para que
      // um soluço de agora não conte contra um soluço daqui a três horas.
      if (this.tentativas > 0 && l.agora - this.ultimaTentativa >= RESTABELECIDA_MS) this.tentativas = 0;
      return { acao: 'nada', motivo: 'sessão saudável', viva: true };
    }

    // Uma tentativa por vez: refazer o caminho leva alguns segundos, e
    // disparar de novo no meio só atrapalharia a que está em curso.
    if (l.agora - this.ultimaTentativa < INTERVALO_ENTRE_TENTATIVAS_MS) {
      return { acao: 'nada', motivo: problema, viva: false };
    }

    if (this.tentativas >= MAX_RECUPERACOES) {
      return { acao: 'desistir', motivo: problema, viva: false };
    }

    this.tentativas++;
    this.ultimaTentativa = l.agora;
    return { acao: 'recuperar', motivo: problema, viva: false };
  }
}
