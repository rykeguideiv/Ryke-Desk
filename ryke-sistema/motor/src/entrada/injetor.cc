#include "entrada/injetor.h"

#include "base/log.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <vector>

namespace ryke {
namespace {

// Marca os nossos eventos, para um dia conseguirmos ignorá-los se o programa
// passar a ler a entrada física com um gancho.
constexpr ULONG_PTR kAssinatura = 0x52594B45;  // "RYKE"

constexpr int kSmXVirtual = 76;
constexpr int kSmYVirtual = 77;
constexpr int kSmCxVirtual = 78;
constexpr int kSmCyVirtual = 79;

void Despachar(const std::vector<INPUT>& eventos) {
  if (eventos.empty()) return;
  SendInput(static_cast<UINT>(eventos.size()), const_cast<INPUT*>(eventos.data()), sizeof(INPUT));
}

INPUT Mouse(DWORD flags, LONG dx = 0, LONG dy = 0, DWORD dado = 0) {
  INPUT e{};
  e.type = INPUT_MOUSE;
  e.mi.dx = dx;
  e.mi.dy = dy;
  e.mi.mouseData = dado;
  e.mi.dwFlags = flags;
  e.mi.dwExtraInfo = kAssinatura;
  return e;
}

struct ParDeBotao {
  DWORD desce;
  DWORD sobe;
  DWORD dado;
};

ParDeBotao ParaBotao(Botao b) {
  switch (b) {
    case Botao::kEsquerdo:
      return {MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 0};
    case Botao::kMeio:
      return {MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 0};
    case Botao::kDireito:
      return {MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 0};
    case Botao::kVoltar:
      return {MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, XBUTTON1};
    case Botao::kAvancar:
      return {MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, XBUTTON2};
  }
  return {0, 0, 0};
}

}  // namespace

Tela TelaVirtual() {
  Tela t;
  t.esquerda = GetSystemMetrics(kSmXVirtual);
  t.topo = GetSystemMetrics(kSmYVirtual);
  t.largura = GetSystemMetrics(kSmCxVirtual);
  t.altura = GetSystemMetrics(kSmCyVirtual);
  return t;
}

void Injetor::MoverPara(double fx, double fy) {
  const Tela t = TelaVirtual();
  if (t.largura <= 1 || t.altura <= 1) return;
  fx = std::min(std::max(fx, 0.0), 1.0);
  fy = std::min(std::max(fy, 0.0), 1.0);

  // O modo absoluto do SendInput trabalha numa grade de 0..65535 que cobre
  // TODOS os monitores — daí o MOUSEEVENTF_VIRTUALDESK. Sem ele, a conta vale
  // só para o monitor principal, e num computador com dois monitores o
  // ponteiro cai no lugar errado por uma margem que cresce com a distância.
  const LONG nx = static_cast<LONG>(fx * 65535.0 + 0.5);
  const LONG ny = static_cast<LONG>(fy * 65535.0 + 0.5);
  Despachar({Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny)});
}

void Injetor::MoverRelativo(int32_t dx, int32_t dy) {
  if (dx == 0 && dy == 0) return;
  Despachar({Mouse(MOUSEEVENTF_MOVE, dx, dy)});
}

void Injetor::Botao(ryke::Botao qual, bool apertado) {
  const uint32_t bit = 1u << static_cast<uint32_t>(qual);
  // Não repete o que já está no estado pedido. Um "apertar" duplicado vira
  // duplo clique onde ninguém pediu; um "soltar" sem "apertar" antes abre o
  // menu de contexto sozinho — os dois já aconteceram no aplicativo atual.
  if (apertado == ((botoes_ & bit) != 0)) return;
  const ParDeBotao par = ParaBotao(qual);
  if (par.desce == 0) return;
  if (apertado) {
    botoes_ |= bit;
  } else {
    botoes_ &= ~bit;
  }
  Despachar({Mouse(apertado ? par.desce : par.sobe, 0, 0, par.dado)});
}

void Injetor::Roda(int32_t horizontal, int32_t vertical) {
  std::vector<INPUT> eventos;
  if (vertical != 0) eventos.push_back(Mouse(MOUSEEVENTF_WHEEL, 0, 0, static_cast<DWORD>(vertical * WHEEL_DELTA)));
  if (horizontal != 0)
    eventos.push_back(Mouse(MOUSEEVENTF_HWHEEL, 0, 0, static_cast<DWORD>(horizontal * WHEEL_DELTA)));
  Despachar(eventos);
}

void Injetor::Tecla(uint16_t scan_code, bool estendida, bool apertada) {
  const size_t indice = (estendida ? 256u : 0u) + (scan_code & 0xFF);
  if (indice >= 512) return;
  if (apertada == teclas_[indice]) {
    // Repetição de tecla é legítima (segurar uma letra), mas só para o que já
    // está apertado. Uma repetição de algo que nunca desceu é ruído da rede.
    if (!apertada) return;
  }
  teclas_[indice] = apertada;

  INPUT e{};
  e.type = INPUT_KEYBOARD;
  e.ki.wVk = 0;
  e.ki.wScan = scan_code;
  e.ki.dwFlags = KEYEVENTF_SCANCODE | (estendida ? KEYEVENTF_EXTENDEDKEY : 0) |
                 (apertada ? 0 : KEYEVENTF_KEYUP);
  e.ki.dwExtraInfo = kAssinatura;
  Despachar({e});
}

void Injetor::SoltarTudo() {
  std::vector<INPUT> eventos;
  for (uint32_t i = 0; i < 5; i++) {
    const uint32_t bit = 1u << i;
    if (!(botoes_ & bit)) continue;
    const ParDeBotao par = ParaBotao(static_cast<ryke::Botao>(i));
    eventos.push_back(Mouse(par.sobe, 0, 0, par.dado));
  }
  botoes_ = 0;

  for (size_t i = 0; i < 512; i++) {
    if (!teclas_[i]) continue;
    teclas_[i] = false;
    INPUT e{};
    e.type = INPUT_KEYBOARD;
    e.ki.wScan = static_cast<WORD>(i & 0xFF);
    e.ki.dwFlags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP | (i >= 256 ? KEYEVENTF_EXTENDEDKEY : 0);
    e.ki.dwExtraInfo = kAssinatura;
    eventos.push_back(e);
  }

  if (!eventos.empty()) RY_INFO("entrada: soltando %zu tecla(s)/botao(oes) presos", eventos.size());
  Despachar(eventos);
}

void Injetor::ConciliarBotoes(uint32_t mascara) {
  for (uint32_t i = 0; i < 5; i++) {
    const uint32_t bit = 1u << i;
    const bool deveria = (mascara & bit) != 0;
    const bool esta = (botoes_ & bit) != 0;
    if (deveria != esta) Botao(static_cast<ryke::Botao>(i), deveria);
  }
}

}  // namespace ryke
