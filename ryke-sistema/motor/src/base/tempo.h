// Relógio e espera, do jeito que um programa de tempo real precisa.
//
// POR QUE NÃO std::chrono::system_clock
//
// O relógio do sistema anda para trás. Ele é acertado pela rede, pelo horário
// de verão, pelo usuário mexendo no painel — e um RTT medido em cima dele pode
// dar negativo. Tudo aqui usa o relógio MONOTÔNICO, que só avança.
//
// POR QUE NÃO Sleep()
//
// O `Sleep` do Windows tem granularidade de ~15,6 ms por padrão. Num programa
// que manda 60 quadros por segundo — um a cada 16,7 ms — dormir "1 ms" e
// acordar 16 ms depois destrói o ritmo. Quem precisa de precisão chama
// `timeBeginPeriod(1)` uma vez no início; é o que `RelogioFino` faz.

#pragma once

#include <cstdint>

namespace ryke {

// Microssegundos desde um ponto arbitrário no passado. Só cresce.
uint64_t AgoraUs();

// Milissegundos, para quando a precisão de micro não importa.
inline uint64_t AgoraMs() { return AgoraUs() / 1000; }

// Dorme sem estourar o prazo. Usa espera do sistema até faltar pouco e depois
// gira, porque o sistema não acorda ninguém com precisão de microssegundo.
void DormirUs(uint64_t us);

// Pede ao Windows a granularidade de 1 ms enquanto existir.
//
// É um recurso global do sistema: enquanto qualquer processo o segura, o
// escalonador inteiro fica mais fino (e a máquina gasta um pouco mais de
// energia). Por isso ele vive num objeto com escopo, e não num `timeBeginPeriod`
// solto que ninguém devolve.
class RelogioFino {
 public:
  RelogioFino();
  ~RelogioFino();
  RelogioFino(const RelogioFino&) = delete;
  RelogioFino& operator=(const RelogioFino&) = delete;

 private:
  bool ativo_ = false;
};

}  // namespace ryke
