/**
 * Tipos que os três lados precisam enxergar (processo principal, ponte e
 * interface).
 *
 * Ficam aqui, e não junto da implementação, porque o processo principal é
 * compilado com as bibliotecas do Node e a interface com as do navegador —
 * um não pode incluir os arquivos do outro sem arrastar o ambiente errado
 * junto.
 */

/**
 * Qualidade da imagem.
 *
 *   'auto'  — o programa mede a rede e decide sozinho. É o padrão, e o que
 *             serve para praticamente todo mundo.
 *   'baixa' — para internet fraca ou instável: pouca banda, movimento fluido.
 *   'media' — meio-termo fixo, sem o programa mexer.
 *   'alta'  — tudo o que a máquina e a rede derem. Sem freio.
 */
export type Quality = 'auto' | 'baixa' | 'media' | 'alta';

/** Nomes das versões anteriores, para não perder a preferência de quem atualiza. */
export const QUALIDADES_ANTIGAS: Record<string, Quality> = {
  fluido: 'baixa',
  nitido: 'alta',
};

/**
 * Um computador guardado com nome próprio.
 *
 * Doze dígitos ninguém decora. O favorito troca "481 922 730 155" por
 * "Notebook da Ana", que é como as pessoas de fato se referem às máquinas.
 *
 * A senha NÃO é guardada aqui, e isso é decisão, não esquecimento: um
 * favorito é um atalho para chegar até a máquina, não uma chave para entrar
 * nela. Guardar as duas coisas juntas faria de um único arquivo tudo que
 * alguém precisaria para assumir o computador do outro lado.
 */
export type Favorito = {
  numero: string;
  nome: string;
  /** Momento do último uso, em ms — os mais usados sobem na lista. */
  usadoEm: number;
};

/**
 * O papel que o usuário escolheu na primeira tela.
 *
 *   'receber'  — este PC vai receber conexão: liga o servidor embutido e fica
 *                à espera. É o computador que será acessado.
 *   'conectar' — este PC vai acessar outro: não liga servidor nenhum, só
 *                procura um já ligado na rede.
 *   null       — ainda não respondeu; a primeira tela cuida disso.
 */
export type Papel = 'receber' | 'conectar' | null;

export type Settings = {
  /** Resposta às duas perguntas iniciais. Enquanto null, mostramos a tela. */
  papel: Papel;
  /** URL do servidor de conexão. Trocar aqui ao migrar para a VPS. */
  serverUrl: string;
  /** Pasta onde os arquivos recebidos são gravados. */
  downloadDir: string;
  /**
   * Aceitar pedidos de acesso sem senha (modo supervisionado), que sempre
   * exigem alguém clicando em "Permitir" aqui. Desligue num computador que
   * fica sozinho: sem ninguém para aprovar, o pedido só serviria para
   * incomodar, e a senha passa a ser o único caminho.
   */
  allowSupervisedAccess: boolean;
  /**
   * Espelhar a área de transferência de texto entre os dois computadores.
   *
   * Ligado, copiar aqui e colar lá funciona sem pensar. Mas repare no que
   * isso significa numa sessão de suporte: TUDO o que você copiar enquanto
   * alguém estiver conectado vai para o computador dele — inclusive uma senha
   * copiada de um gerenciador. Desligue quando estiver sendo atendido por
   * alguém em quem não confia plenamente.
   */
  syncClipboard: boolean;
  /** Preferência inicial de qualidade de imagem. */
  quality: Quality;
  /** Deixar este computador disponível assim que o programa abrir. */
  hostOnLaunch: boolean;
  /** Bloquear teclado/mouse físicos do anfitrião durante a sessão (precisa de admin). */
  blockLocalInput: boolean;
  /**
   * Cada visitante com a própria seta, sem tomar o cursor do anfitrião.
   *
   * LIGADO (o padrão). Quem se conecta ganha um ponteiro virtual colorido —
   * vermelho para o primeiro, azul para o segundo, verde para o terceiro — com
   * o nome escrito embaixo. O cursor do Windows desta máquina continua sendo
   * de quem está sentado nela; ele só é emprestado no instante de um clique e
   * volta para o lugar logo depois. É o que permite duas pessoas trabalharem
   * na mesma tela sem disputar o mesmo ponteiro.
   *
   * DESLIGADO. O comportamento antigo: o mouse do visitante arrasta o cursor
   * real do anfitrião, como num controle remoto comum. Vale a pena desligar em
   * um caso concreto — programas que reagem ao mouse apenas PASSANDO por cima
   * (menus que abrem sozinhos, dicas de ferramenta) não percebem o ponteiro
   * virtual, porque para o Windows ele não existe.
   */
  setasIndependentes: boolean;
  /**
   * Deixar que quem se conectar dispare Ctrl+Alt+Del neste computador.
   *
   * Desligado por padrão porque ligá-lo mexe numa política do Windows
   * (`SoftwareSASGeneration`), e mexer em política de segurança da máquina é
   * decisão de quem é dono dela — não de quem está do outro lado.
   *
   * O que muda ao ligar, sem meias palavras: um programa elevado passa a poder
   * CHAMAR a tela de segurança do Windows. Ele não passa a poder imitá-la nem
   * a ler o que se digita nela — quem a desenha continua sendo o Winlogon, na
   * área de trabalho segura, fora do alcance de qualquer programa. Desligar
   * devolve a política ao estado anterior.
   */
  permitirSasRemoto: boolean;
  /** Nome exibido a quem se conectar. */
  displayName: string;
  /**
   * Retransmissor próprio (TURN), para o caso em que os dois lados estão
   * atrás de NAT simétrico e não existe caminho direto possível.
   *
   * Vazio é o normal: a esmagadora maioria das conexões fecha direto, com o
   * STUN embutido. Este campo só entra em cena quando a rede das duas pontas
   * impede qualquer caminho — e aí não há como o programa se virar sozinho,
   * porque repassar vídeo custa banda que alguém precisa pagar.
   *
   * Formato: turn:host:porta (ou turns: para TLS).
   */
  turnUrl: string;
  turnUser: string;
  turnPass: string;
};

/** Custo do scrypt usado no desafio de senha. */
export type ScryptParams = { N: number; r: number; p: number; keylen: number };
