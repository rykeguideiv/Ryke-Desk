#include "base/log.h"

#include "base/tempo.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstdarg>
#include <cstdio>
#include <share.h>
#include <mutex>

namespace ryke {
namespace {

std::mutex& Tranca() {
  static std::mutex m;
  return m;
}

FILE*& Arquivo() {
  static FILE* f = nullptr;
  return f;
}

Nivel& Minimo() {
  static Nivel n = Nivel::kInfo;
  return n;
}

uint64_t Inicio() {
  static const uint64_t t = AgoraUs();
  return t;
}

const char* Etiqueta(Nivel n) {
  switch (n) {
    case Nivel::kDetalhe:
      return "   ";
    case Nivel::kInfo:
      return "   ";
    case Nivel::kAviso:
      return " ! ";
    case Nivel::kErro:
      return " X ";
  }
  return "   ";
}

}  // namespace

void LogParaArquivo(const std::string& caminho) {
  std::lock_guard<std::mutex> g(Tranca());
  if (Arquivo()) fclose(Arquivo());
  Arquivo() = nullptr;
  // Compartilhando a LEITURA: quem quer mandar o registro precisa consegui-lo
  // com o programa ainda aberto. Com fopen comum o Windows tranca o arquivo, e
  // "copie o log" vira "feche o programa, copie o log, abra de novo e torca
  // para o defeito acontecer de novo".
  Arquivo() = _fsopen(caminho.c_str(), "w", _SH_DENYWR);
}

void LogNivelMinimo(Nivel nivel) { Minimo() = nivel; }

void LogEscrever(Nivel nivel, const char* formato, ...) {
  if (static_cast<int>(nivel) < static_cast<int>(Minimo())) return;

  char corpo[2048];
  va_list args;
  va_start(args, formato);
  vsnprintf(corpo, sizeof(corpo), formato, args);
  va_end(args);

  const double ms = static_cast<double>(AgoraUs() - Inicio()) / 1000.0;

  std::lock_guard<std::mutex> g(Tranca());
  fprintf(stdout, "%9.1f%s%s\n", ms, Etiqueta(nivel), corpo);
  fflush(stdout);
  if (Arquivo()) {
    fprintf(Arquivo(), "%9.1f%s%s\n", ms, Etiqueta(nivel), corpo);
    fflush(Arquivo());
  }
}

std::string TextoDoHResult(long hr) {
  char* texto = nullptr;
  const DWORD n = FormatMessageA(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr,
      static_cast<DWORD>(hr), 0, reinterpret_cast<char*>(&texto), 0, nullptr);

  char buf[512];
  if (n > 0 && texto) {
    // O Windows termina essas mensagens com CRLF; num registro de uma linha por
    // evento isso quebra o alinhamento de tudo que vem depois.
    std::string limpo(texto, n);
    while (!limpo.empty() && (limpo.back() == '\r' || limpo.back() == '\n' || limpo.back() == ' ')) limpo.pop_back();
    snprintf(buf, sizeof(buf), "0x%08lX (%s)", static_cast<unsigned long>(hr), limpo.c_str());
  } else {
    snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
  }
  if (texto) LocalFree(texto);
  return buf;
}

std::string TextoDoUltimoErro() { return TextoDoHResult(static_cast<long>(GetLastError())); }

}  // namespace ryke
