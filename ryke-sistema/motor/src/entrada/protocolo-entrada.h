// O que o visitante manda ao anfitrião quando mexe no mouse ou no teclado.
//
// Bytes crus, e não JSON: cada movimento de mouse é uma mensagem, sessenta por
// segundo, e cada uma passa por cifra e por um datagrama. Dezoito bytes contra
// uns oitenta de JSON não é economia de banda — é uma mensagem que cabe folgada
// no mesmo pacote e um `memcpy` no lugar de um analisador de texto.
//
// A MÁSCARA DE BOTÕES VAI EM TODO MOVIMENTO
//
// É a lição que o aplicativo atual aprendeu quebrando: sem ela, um movimento
// que chega antes do "apertar" é indistinguível de um movimento solto, e o
// anfitrião o descarta — o arrasto vira um clique parado. Com ela, qualquer
// movimento basta para reconstruir o gesto. Ver src/shared/gesto-mouse.ts.

#pragma once

#include <cstdint>

namespace ryke {

enum class Entrada : uint8_t {
  kMover = 1,     // posição absoluta, em fração da tela
  kBotao = 2,     // apertar/soltar
  kRoda = 3,
  kTecla = 4,
  kSoltarTudo = 5,  // a janela do visitante perdeu o foco
};

#pragma pack(push, 1)

struct MsgMover {
  uint8_t tipo;      // Entrada::kMover
  uint8_t botoes;    // máscara do que está apertado agora
  uint16_t reservado;
  float fx;
  float fy;
};

struct MsgBotao {
  uint8_t tipo;   // Entrada::kBotao
  uint8_t qual;   // 0 esquerdo · 1 meio · 2 direito · 3 voltar · 4 avançar
  uint8_t desce;  // 1 apertar, 0 soltar
  uint8_t botoes; // a máscara DEPOIS desta mudança
  float fx;
  float fy;
};

struct MsgRoda {
  uint8_t tipo;  // Entrada::kRoda
  uint8_t reservado[3];
  int16_t horizontal;
  int16_t vertical;
  float fx;
  float fy;
};

struct MsgTecla {
  uint8_t tipo;       // Entrada::kTecla
  uint8_t estendida;  // as teclas do bloco de setas, Ctrl direito, etc.
  uint8_t desce;
  uint8_t reservado;
  uint16_t scan;      // POSIÇÃO física da tecla, não o caractere. Ver injetor.h
  uint16_t reservado2;
};

struct MsgSoltarTudo {
  uint8_t tipo;  // Entrada::kSoltarTudo
  uint8_t reservado[3];
};

#pragma pack(pop)

}  // namespace ryke
