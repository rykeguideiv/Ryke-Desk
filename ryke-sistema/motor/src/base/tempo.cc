#include "base/tempo.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <timeapi.h>

namespace ryke {
namespace {

// A frequência do contador não muda enquanto a máquina está ligada; perguntar
// uma vez e guardar evita uma chamada de sistema por medição — e medições
// acontecem milhares de vezes por segundo.
int64_t FrequenciaDoContador() {
  static const int64_t f = [] {
    LARGE_INTEGER li{};
    QueryPerformanceFrequency(&li);
    return li.QuadPart;
  }();
  return f;
}

}  // namespace

uint64_t AgoraUs() {
  LARGE_INTEGER agora{};
  QueryPerformanceCounter(&agora);
  const int64_t f = FrequenciaDoContador();
  if (f <= 0) return 0;
  // Multiplica ANTES de dividir, e em partes, para não estourar 64 bits nem
  // perder resolução: `agora.QuadPart * 1'000'000` transborda depois de umas
  // poucas horas de máquina ligada em frequências altas.
  const int64_t segundos = agora.QuadPart / f;
  const int64_t resto = agora.QuadPart % f;
  return static_cast<uint64_t>(segundos) * 1000000ull + static_cast<uint64_t>(resto * 1000000 / f);
}

void DormirUs(uint64_t us) {
  if (us == 0) return;
  const uint64_t alvo = AgoraUs() + us;
  // Até faltar 1,5 ms, entrega o processador ao sistema. Daí para a frente
  // apenas cede a vez, porque nenhuma espera do sistema acorda com precisão
  // melhor do que isso — e passar do prazo é pior do que gastar um instante.
  while (true) {
    const uint64_t agora = AgoraUs();
    if (agora >= alvo) return;
    const uint64_t falta = alvo - agora;
    if (falta > 1500) {
      Sleep(static_cast<DWORD>((falta - 1500) / 1000));
    } else {
      YieldProcessor();
      SwitchToThread();
    }
  }
}

RelogioFino::RelogioFino() { ativo_ = timeBeginPeriod(1) == TIMERR_NOERROR; }

RelogioFino::~RelogioFino() {
  if (ativo_) timeEndPeriod(1);
}

}  // namespace ryke
