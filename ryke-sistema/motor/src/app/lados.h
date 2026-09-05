// As opções da linha de comando e as duas pontas do programa.

#pragma once

#include <cstdint>
#include <string>

namespace ryke {

struct Opcoes {
  bool anfitriao = false;
  std::string alvo;   // "maquina:porta", só no visitante
  uint16_t porta = 5900;
  std::string senha;
  uint32_t monitor = 0;
  uint32_t fps = 60;
  uint32_t bps_inicial = 8000000;
  uint32_t bps_maximo = 40000000;
  bool console = false;
  std::string arquivo_de_log;
};

int RodarAnfitriao(const Opcoes& op);
int RodarVisitante(const Opcoes& op);

}  // namespace ryke
