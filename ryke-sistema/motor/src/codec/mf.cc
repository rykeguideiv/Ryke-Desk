#include "codec/mf.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mfapi.h>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "ole32.lib")

namespace ryke {
namespace {

struct Inicio {
  Inicio() {
    // COINIT_MULTITHREADED: o motor chama isto de mais de uma linha de execução
    // (a que captura e a que desenha), e o modelo de apartamento único obrigaria
    // a bombear mensagens em todas elas.
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    // MFSTARTUP_LITE não carrega a parte de rede do Media Foundation, que este
    // programa não usa: a rede aqui é nossa.
    ok = SUCCEEDED(MFStartup(MF_VERSION, MFSTARTUP_LITE));
  }
  bool ok = false;
};

}  // namespace

bool GarantirMediaFoundation() {
  static Inicio uma_vez;
  return uma_vez.ok;
}

}  // namespace ryke
