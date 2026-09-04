/**
 * Ajuste automático de qualidade — o que decide, a cada dois segundos, quanto
 * o anfitrião pode gastar de banda.
 *
 * POR QUE ISTO EXISTE, SE O WEBRTC JÁ CONTROLA CONGESTIONAMENTO
 *
 * O WebRTC estima sozinho quanto a rede aguenta, e faz isso bem. O que ele
 * não faz é escolher COMO gastar o que sobrou. Deixado por conta própria, o
 * codificador tende a empurrar o máximo que couber — e é justamente aí que
 * nasce o atraso.
 *
 * Quando o codificador manda mais do que o caminho escoa, os pacotes não se
 * perdem: eles ficam na fila dos roteadores no meio. A imagem continua
 * chegando inteira, só que atrasada, e o atraso cresce enquanto a fila cresce.
 * É o efeito conhecido como bufferbloat, e é a causa mais comum daquele
 * "delayzinho" em que o mouse anda meio segundo depois da mão.
 *
 * A resposta é contraintuitiva: **para ter menos atraso, gasta-se menos banda
 * do que se poderia**. Mirando um pouco abaixo do que a rede aguenta, a fila
 * fica vazia e a imagem chega quase junto do movimento.
 *
 * COMO ESCOLHE
 *
 * Três recursos, gastos nesta ordem de prioridade, porque é a ordem em que o
 * olho percebe a diferença numa área de trabalho remota:
 *
 *   1. TAXA DE BITS — primeiro a ceder; degrada só a nitidez de detalhes.
 *   2. QUADROS POR SEGUNDO — 60 quando a banda deixa (é o que dá a sensação
 *      de máquina local), 30 é confortável, 20 ainda é bom, 12 é usável.
 *   3. RESOLUÇÃO — a última a cair, porque texto borrado é o que mais
 *      atrapalha quem está trabalhando na máquina do outro.
 *
 * Descer é rápido e subir é lento, de propósito: uma rede que engasgou precisa
 * de alívio imediato, enquanto uma rede que melhorou não tem pressa. O
 * caminho inverso (subir rápido) produziria oscilação visível — a imagem
 * piorando e melhorando sem parar.
 */

/** Leitura de rede de um instante, tirada do getStats do WebRTC. */
export type Medida = {
  /** Estimativa da própria pilha WebRTC sobre quanto cabe, em bits/s. */
  bancaDisponivel: number | null;
  /** Ida e volta em ms, do par de candidatos em uso. */
  rtt: number;
  /** Fração de pacotes perdidos desde a última medida (0 a 1). */
  perda: number;
  /**
   * Por que o codificador está se segurando, se estiver.
   * 'bandwidth' = a rede não dá conta; 'cpu' = a máquina não dá conta.
   */
  limitacao: 'none' | 'bandwidth' | 'cpu' | 'other';
};

export type Ajuste = {
  maxBitrate: number;
  maxFramerate: number;
  /** 1 = resolução cheia; 2 = metade da largura e da altura. */
  scaleResolutionDownBy: number;
  /** Explicação curta para a tela, em português. */
  motivo: string;
};

/**
 * Limites do que faz sentido numa área de trabalho remota.
 *
 * O teto subiu de 12 para 20 Mb/s, e isso não briga com o combate à fila
 * explicado acima: quem manda continua sendo `bancaDisponivel * FOLGA`, ou
 * seja, o alvo só chega perto do teto em rede que comprovadamente aguenta.
 * O que o teto antigo fazia era desperdiçar folga real — numa fibra boa a
 * medição liberava mais do que 12, e o texto continuava com um resto de
 * borrão sem que houvesse atraso nenhum a evitar.
 */
export const TETO_BITRATE = 20_000_000;
export const PISO_BITRATE = 350_000;

/** Fração da banca estimada que de fato usamos. O resto é o que evita fila. */
const FOLGA = 0.85;

/**
 * Medidas ignoradas no começo, enquanto o estimador de banda do WebRTC sobe.
 *
 * A cada dois segundos, então são uns oito segundos de tolerância. Nesse
 * tempo a imagem fica em resolução cheia: é melhor arriscar alguns segundos
 * de possível engasgo do que abrir toda sessão borrada por precaução.
 */
const MEDIDAS_DE_AQUECIMENTO = 4;

/** Acima disto a rede está claramente sofrendo. */
const PERDA_RUIM = 0.03;
/** Ida e volta acima disto já é sentida como atraso pela mão. */
const RTT_RUIM = 220;

export class Adaptador {
  /** Nosso alvo atual, em bits/s. Começa otimista e se corrige em segundos. */
  private alvo = 4_000_000;
  /** Menor ida e volta já visto — a régua do que é "normal" nesta rede. */
  private rttBase = Infinity;
  /** Contagem de medidas boas seguidas, para não subir no primeiro respiro. */
  private boas = 0;
  /**
   * Medidas desde o início da sessão.
   *
   * O estimador de banda do WebRTC começa deliberadamente baixo e leva alguns
   * segundos para descobrir o que a rede aguenta. Obedecer a ele nesse período
   * fazia toda sessão abrir borrada e em câmera lenta, mesmo numa rede ótima,
   * para só melhorar depois — a pior primeira impressão possível.
   */
  private medidas = 0;
  /**
   * Média suavizada do alvo, usada só para decidir resolução e quadros.
   *
   * A taxa pode oscilar a cada leitura sem incomodar ninguém. Já trocar a
   * resolução da tela é visível e irrita: precisa de um sinal sustentado, não
   * de um solavanco.
   */
  private suave = 4_000_000;

  /** Só para os testes conferirem o estado interno. */
  get alvoAtual(): number {
    return this.alvo;
  }

  decidir(m: Medida): Ajuste {
    // A régua é a própria rede: 40 ms é ótimo numa ligação nacional e péssimo
    // dentro de um escritório. Comparar com o melhor já visto vale mais do que
    // comparar com um número fixo.
    if (m.rtt > 0) this.rttBase = Math.min(this.rttBase, m.rtt);
    const rttReferencia = Number.isFinite(this.rttBase) ? this.rttBase : m.rtt;
    const rttInchado = m.rtt > Math.max(rttReferencia * 1.8, rttReferencia + 60);

    let motivo = 'rede estável';

    if (m.perda > PERDA_RUIM) {
      // Perda é o sinal mais confiável de que passamos do ponto: cede rápido.
      this.alvo *= 0.65;
      this.boas = 0;
      motivo = 'perda de pacotes — reduzindo';
    } else if (rttInchado || m.rtt > RTT_RUIM) {
      // Fila crescendo no caminho. Ainda não há perda, mas o atraso já subiu:
      // é exatamente o momento de recuar, antes de a imagem começar a arrastar.
      this.alvo *= 0.8;
      this.boas = 0;
      motivo = 'atraso subindo — reduzindo para limpar a fila';
    } else if (m.limitacao === 'cpu') {
      // Não adianta mandar mais: quem não está dando conta é o computador.
      this.alvo *= 0.9;
      this.boas = 0;
      motivo = 'computador no limite — reduzindo';
    } else {
      this.boas++;
      // Três medidas boas seguidas (uns seis segundos) antes de arriscar mais.
      if (this.boas >= 3) {
        this.alvo *= 1.15;
        motivo = 'rede folgada — melhorando a qualidade';
      }
    }

    // A estimativa da própria pilha é o teto: passar dela é encher fila. Mas
    // só depois do aquecimento — antes disso ela ainda está subindo e nos
    // puxaria para baixo sem motivo.
    this.medidas++;
    const aquecido = this.medidas > MEDIDAS_DE_AQUECIMENTO;
    if (aquecido && m.bancaDisponivel && m.bancaDisponivel > 0) {
      this.alvo = Math.min(this.alvo, m.bancaDisponivel * FOLGA);
    }
    this.alvo = Math.max(PISO_BITRATE, Math.min(TETO_BITRATE, this.alvo));

    // Suavização assimétrica: acompanha a queda depressa (para não insistir
    // numa resolução que a rede não sustenta) e a subida com calma.
    const peso = this.alvo < this.suave ? 0.5 : 0.2;
    this.suave = this.suave * (1 - peso) + this.alvo * peso;

    return {
      maxBitrate: Math.round(this.alvo),
      // Resolução e quadros seguem a média, não o instante: são as mudanças
      // que o olho percebe, e piscar entre duas resoluções é pior do que
      // ficar na menor.
      maxFramerate: aquecido ? quadrosPara(this.suave) : 30,
      scaleResolutionDownBy: aquecido ? escalaPara(this.suave) : 1,
      motivo: aquecido ? motivo : 'medindo a rede…',
    };
  }
}

/**
 * Quantos quadros por segundo cabem nesta taxa.
 *
 * Abaixo de 1 Mb/s, insistir em 30 quadros só produz imagem borrada: o
 * codificador reparte pouca informação entre quadros demais. Menos quadros
 * bem formados são mais úteis do que muitos ruins.
 */
function quadrosPara(bitrate: number): number {
  if (bitrate < 700_000) return 12;
  if (bitrate < 1_500_000) return 20;
  if (bitrate < 3_000_000) return 26;
  if (bitrate < 5_000_000) return 30;
  // Com banda de sobra, 60. Este degrau faltava: o teto era 30 mesmo numa rede
  // que aguentava muito mais, e o resultado era exatamente o que se via no
  // diagnóstico — 30 quadros gastando 0,5 de 8 Mbps, com a GPU ociosa. Quem
  // compara com outros programas de acesso remoto sente essa diferença na hora,
  // porque 60 quadros é o que separa "funciona" de "parece a máquina local".
  return 60;
}

/**
 * Quanto encolher a imagem.
 *
 * A resolução é a última a cair porque texto borrado é o que mais atrapalha
 * quem está de fato trabalhando na máquina remota — pior do que imagem com
 * menos quadros.
 */
function escalaPara(bitrate: number): number {
  if (bitrate < 600_000) return 2;
  if (bitrate < 1_200_000) return 1.5;
  return 1;
}

export const _interno = { quadrosPara, escalaPara };
