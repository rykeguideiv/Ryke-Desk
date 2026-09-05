// O formato do fio: o que exatamente vai dentro de cada datagrama UDP.
//
// POR QUE UM PROTOCOLO PRÓPRIO, E NÃO WebRTC
//
// O WebRTC resolve um problema que não é o nosso. Ele foi desenhado para
// videoconferência na web: negociação SDP, ICE, DTLS, SRTP, um congestionamento
// afinado para voz e rosto falando, e um buffer de jitter que ESCONDE variação
// acrescentando atraso. Para acesso remoto, esconder atraso é justamente o
// contrário do que se quer: é melhor ver um quadro rasgado agora do que o
// quadro perfeito daqui a 80 ms, porque quem está do outro lado está mexendo o
// mouse e precisa da resposta.
//
// Também vem tudo junto: para usar o transporte é preciso arrastar o codec, o
// empacotador, o sinalizador e o resto — foi o que fez o Ryke Desk depender de
// um navegador inteiro, que por sua vez não captura tela quando elevado.
//
// Este protocolo faz cinco coisas e mais nada:
//
//   1. entrega quadros de vídeo partidos em pedaços de MTU;
//   2. pede de volta SÓ os pedaços que faltam, e só enquanto ainda vale a pena;
//   3. entrega a entrada (mouse/teclado) de forma confiável e em ordem;
//   4. mede ida e volta o tempo todo;
//   5. cifra tudo, com chave trocada no início.
//
// AS DUAS REGRAS QUE DEFINEM O RESTO
//
// • Vídeo é PERECÍVEL. Um pedaço que chega atrasado demais não vale nada — o
//   quadro seguinte já o tornou obsoleto. Por isso o vídeo nunca é retransmitido
//   "até conseguir": há um prazo, e vencido o prazo pede-se quadro-chave.
//
// • Entrada é SAGRADA. Um clique perdido é um clique que a pessoa deu e não
//   aconteceu; um "soltar" perdido deixa um botão preso na máquina alheia. A
//   entrada é retransmitida até ser confirmada, e entregue em ordem.
//
// LEIA JUNTO: shared/gesto-mouse.ts no aplicativo atual, que resolve o mesmo
// problema de ordem pelo lado de cima — este arquivo o resolve por baixo.

#pragma once

#include <cstdint>
#include <cstring>

namespace ryke {

// Um datagrama nunca passa disto. 1200 é conservador de propósito: cabe em
// praticamente qualquer caminho da internet sem fragmentação de IP, inclusive
// atrás de VPN e PPPoE, que costumam roubar 20 a 80 bytes do MTU.
inline constexpr uint32_t kMtuUtil = 1200;

inline constexpr uint8_t kVersao = 1;

enum class Tipo : uint8_t {
  kOla = 1,        // visitante → anfitrião: chave pública e nonce
  kOlaOk = 2,      // anfitrião → visitante: chave pública e nonce
  kVideo = 3,      // um pedaço de um quadro
  kEntrada = 4,    // mouse/teclado, confiável
  kEntradaOk = 5,  // confirmação cumulativa da entrada
  kFalta = 6,      // "me manda de novo estes pedaços"
  kPing = 7,
  kPong = 8,
  kChave = 9,      // "perdi o fio da meada, manda um quadro-chave"
  kTchau = 10,
};

#pragma pack(push, 1)

// O cabeçalho de todo datagrama. Vai EM CLARO, porque o outro lado precisa
// dele para decidir como decifrar — mas entra como dado autenticado do AES-GCM,
// então mexer nele invalida o pacote inteiro.
struct Cabecalho {
  uint8_t versao;
  uint8_t tipo;
  uint16_t reservado;
  uint32_t sessao;  // sorteado no início; separa sessões e descarta pacote velho
  uint64_t nonce;   // contador que nunca repete: é o nonce do AES-GCM e o anti-repetição
};
static_assert(sizeof(Cabecalho) == 16, "o cabeçalho tem tamanho fixo de propósito");

// Vem logo depois do cabeçalho num pacote de vídeo, já dentro da parte cifrada.
struct CabecalhoVideo {
  uint32_t quadro;      // número do quadro, só cresce
  uint32_t deslocamento;  // onde este pedaço começa dentro do quadro
  uint32_t tamanho_total; // tamanho do quadro inteiro, em bytes
  uint16_t pedaco;        // índice deste pedaço
  uint16_t pedacos;       // quantos pedaços o quadro tem
  uint16_t largura;
  uint16_t altura;
  uint8_t chave;          // 1 = quadro-chave (IDR): dá para começar a decodificar aqui
  uint8_t reservado[3];
};
static_assert(sizeof(CabecalhoVideo) == 24, "idem");

// Pedido de retransmissão. Vem seguido de `quantos` uint16 com os índices.
struct CabecalhoFalta {
  uint32_t quadro;
  uint16_t quantos;
  uint16_t reservado;
};

// Mensagem de entrada: numerada e confirmada.
struct CabecalhoEntrada {
  uint32_t sequencia;
};

struct CabecalhoPing {
  uint64_t carimbo_us;   // relógio de quem perguntou; volta igual no pong
  uint32_t quadros_vistos;
};

#pragma pack(pop)

// O maior corpo útil que cabe num pacote de vídeo, já descontados cabeçalho,
// selo do AES-GCM e o cabeçalho de vídeo.
inline constexpr uint32_t kSeloGcm = 16;
inline constexpr uint32_t kCorpoVideoMax =
    kMtuUtil - sizeof(Cabecalho) - kSeloGcm - sizeof(CabecalhoVideo);

}  // namespace ryke
