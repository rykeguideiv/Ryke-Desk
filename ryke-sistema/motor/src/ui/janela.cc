#include "ui/janela.h"

#include "base/log.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>

#include <algorithm>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "user32.lib")

namespace ryke {
namespace {

constexpr wchar_t kClasse[] = L"RykeSistemaJanela";
constexpr wchar_t kClasseVideo[] = L"RykeSistemaVideo";
constexpr int kAlturaBarra = 26;

std::wstring ParaWide(const std::string& s) {
  if (s.empty()) return L"";
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring w(n > 0 ? n - 1 : 0, L'\0');
  if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
  return w;
}

}  // namespace

Janela::~Janela() { Fechar(); }

void Janela::Fechar() {
  if (janela_) DestroyWindow(reinterpret_cast<HWND>(janela_));
  janela_ = nullptr;
  video_ = nullptr;
  barra_ = nullptr;
}

int64_t __stdcall Janela::Procedimento(HWND__* h, uint32_t msg, uint64_t wp, int64_t lp) {
  HWND hwnd = reinterpret_cast<HWND>(h);
  Janela* eu = reinterpret_cast<Janela*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  if (msg == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCTW*>(lp);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
    return DefWindowProcW(hwnd, msg, wp, lp);
  }
  if (!eu) return DefWindowProcW(hwnd, msg, wp, lp);
  return eu->Tratar(h, msg, wp, lp);
}

uint32_t Janela::MascaraAtual(uint64_t wp) const {
  uint32_t m = 0;
  if (wp & MK_LBUTTON) m |= 1;
  if (wp & MK_MBUTTON) m |= 2;
  if (wp & MK_RBUTTON) m |= 4;
  if (wp & MK_XBUTTON1) m |= 8;
  if (wp & MK_XBUTTON2) m |= 16;
  return m;
}

bool Janela::PontoParaFracao(int x, int y, double* fx, double* fy) const {
  if (largura_video_ == 0 || altura_video_ == 0) return false;
  // Desconta as barras pretas: a imagem é desenhada centralizada e proporcional
  // (ver Pintor::Desenhar), e o mesmo cálculo precisa valer aqui — senão o
  // clique cai deslocado, e o deslocamento cresce com a diferença de proporção.
  const double prop_img = static_cast<double>(largura_imagem_) / altura_imagem_;
  const double prop_jan = static_cast<double>(largura_video_) / altura_video_;
  double larg = largura_video_, alt = altura_video_;
  if (prop_jan > prop_img) {
    larg = altura_video_ * prop_img;
  } else {
    alt = largura_video_ / prop_img;
  }
  const double ox = (largura_video_ - larg) / 2.0;
  const double oy = (altura_video_ - alt) / 2.0;
  const double px = (x - ox) / larg;
  const double py = (y - oy) / alt;
  // Fora da imagem (em cima da barra preta) não existe ponto correspondente.
  if (px < 0 || px > 1 || py < 0 || py > 1) return false;
  *fx = px;
  *fy = py;
  return true;
}

int64_t Janela::Tratar(HWND__* h, uint32_t msg, uint64_t wp, int64_t lp) {
  HWND hwnd = reinterpret_cast<HWND>(h);

  switch (msg) {
    case WM_SIZE:
      if (hwnd == reinterpret_cast<HWND>(janela_)) {
        Reposicionar();
        return 0;
      }
      break;

    case WM_CLOSE:
      if (hwnd == reinterpret_cast<HWND>(janela_)) {
        fechada_ = true;
        if (ao_fechar) ao_fechar();
        return 0;
      }
      break;

    case WM_DESTROY:
      if (hwnd == reinterpret_cast<HWND>(janela_)) {
        fechada_ = true;
        PostQuitMessage(0);
        return 0;
      }
      break;

    case WM_ERASEBKGND:
      return 1;  // o Direct3D pinta tudo; deixar o Windows apagar antes pisca

    case WM_KILLFOCUS:
      // Alt+Tab no meio de um arrasto: sem isto, o botão fica apertado na
      // máquina da outra pessoa. É o mesmo defeito que o aplicativo atual tinha
      // e que foi corrigido na versão 1.0.43 — aqui ele já nasce fechado.
      if (ao_perder_foco) ao_perder_foco();
      return 0;

    case WM_MOUSEMOVE:
    case WM_LBUTTONDOWN:
    case WM_LBUTTONUP:
    case WM_RBUTTONDOWN:
    case WM_RBUTTONUP:
    case WM_MBUTTONDOWN:
    case WM_MBUTTONUP:
    case WM_XBUTTONDOWN:
    case WM_XBUTTONUP: {
      if (hwnd != reinterpret_cast<HWND>(video_)) break;
      EventoMouse e;
      if (!PontoParaFracao(GET_X_LPARAM(lp), GET_Y_LPARAM(lp), &e.fx, &e.fy)) return 0;
      e.botoes = MascaraAtual(wp);
      switch (msg) {
        case WM_LBUTTONDOWN: e.botao = 0; e.desce = true; break;
        case WM_LBUTTONUP: e.botao = 0; e.desce = false; break;
        case WM_MBUTTONDOWN: e.botao = 1; e.desce = true; break;
        case WM_MBUTTONUP: e.botao = 1; e.desce = false; break;
        case WM_RBUTTONDOWN: e.botao = 2; e.desce = true; break;
        case WM_RBUTTONUP: e.botao = 2; e.desce = false; break;
        case WM_XBUTTONDOWN: e.botao = (GET_XBUTTON_WPARAM(wp) == XBUTTON1) ? 3 : 4; e.desce = true; break;
        case WM_XBUTTONUP: e.botao = (GET_XBUTTON_WPARAM(wp) == XBUTTON1) ? 3 : 4; e.desce = false; break;
        default: break;
      }
      // Segurar o ponteiro enquanto um botão está apertado: sem isto, arrastar
      // até fora da janela para de mandar movimento e o gesto morre pelo meio.
      if (e.botao >= 0) {
        if (e.desce) SetCapture(hwnd);
        else if (e.botoes == 0) ReleaseCapture();
        // A máscara do Windows ainda não reflete o botão que ACABOU de mudar.
        const uint32_t bit = 1u << e.botao;
        if (e.desce) e.botoes |= bit;
        else e.botoes &= ~bit;
      }
      if (ao_mouse) ao_mouse(e);
      return 0;
    }

    case WM_MOUSEWHEEL:
    case WM_MOUSEHWHEEL: {
      if (hwnd != reinterpret_cast<HWND>(video_)) break;
      // A roda chega com a posição em coordenadas de TELA, não da janela — é a
      // única mensagem de mouse assim, e esquecer disso faz a rolagem rolar a
      // janela errada do outro lado.
      POINT p{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
      ScreenToClient(hwnd, &p);
      EventoMouse e;
      if (!PontoParaFracao(p.x, p.y, &e.fx, &e.fy)) return 0;
      e.botoes = MascaraAtual(GET_KEYSTATE_WPARAM(wp));
      const int tiques = GET_WHEEL_DELTA_WPARAM(wp) / WHEEL_DELTA;
      if (msg == WM_MOUSEWHEEL) e.roda_vertical = tiques;
      else e.roda_horizontal = tiques;
      if (ao_mouse) ao_mouse(e);
      return 0;
    }

    case WM_KEYDOWN:
    case WM_KEYUP:
    case WM_SYSKEYDOWN:
    case WM_SYSKEYUP: {
      // F11 é nosso: alterna a tela cheia e não atravessa.
      if (msg == WM_KEYDOWN && wp == VK_F11) {
        AlternarTelaCheia();
        return 0;
      }
      EventoTecla e;
      e.scan = static_cast<uint16_t>((lp >> 16) & 0xFF);
      e.estendida = ((lp >> 24) & 1) != 0;
      e.desce = (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN);
      if (ao_tecla) ao_tecla(e);
      // Devolve 0 mesmo para as de sistema: assim Alt e F10 vão para o outro
      // lado em vez de abrirem o menu desta janela.
      return 0;
    }

    default:
      break;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

void Janela::Reposicionar() {
  if (!janela_) return;
  RECT r{};
  GetClientRect(reinterpret_cast<HWND>(janela_), &r);
  const int largura = r.right - r.left;
  const int altura = r.bottom - r.top;
  const int altura_barra = (barra_ && !tela_cheia_) ? kAlturaBarra : 0;

  if (barra_) {
    ShowWindow(reinterpret_cast<HWND>(barra_), tela_cheia_ ? SW_HIDE : SW_SHOW);
    MoveWindow(reinterpret_cast<HWND>(barra_), 0, altura - altura_barra, largura, altura_barra, TRUE);
  }
  if (video_) {
    MoveWindow(reinterpret_cast<HWND>(video_), 0, 0, largura, std::max(1, altura - altura_barra), TRUE);
    largura_video_ = static_cast<uint32_t>(largura);
    altura_video_ = static_cast<uint32_t>(std::max(1, altura - altura_barra));
    redimensionou_ = true;
  }
}

bool Janela::Abrir(const std::string& titulo, int largura, int altura, std::string* erro) {
  INITCOMMONCONTROLSEX icc{sizeof(icc), ICC_BAR_CLASSES};
  InitCommonControlsEx(&icc);

  HINSTANCE inst = GetModuleHandleW(nullptr);

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = reinterpret_cast<WNDPROC>(&Janela::Procedimento);
  wc.hInstance = inst;
  wc.lpszClassName = kClasse;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(RGB(16, 18, 20));
  RegisterClassExW(&wc);

  wc.lpszClassName = kClasseVideo;
  wc.hbrBackground = CreateSolidBrush(RGB(0, 0, 0));
  RegisterClassExW(&wc);

  const std::wstring t = ParaWide(titulo);
  janela_ = reinterpret_cast<HWND__*>(CreateWindowExW(0, kClasse, t.c_str(), WS_OVERLAPPEDWINDOW,
                                                      CW_USEDEFAULT, CW_USEDEFAULT, largura, altura,
                                                      nullptr, nullptr, inst, this));
  if (!janela_) {
    if (erro) *erro = "CreateWindow falhou: " + TextoDoUltimoErro();
    return false;
  }

  video_ = reinterpret_cast<HWND__*>(CreateWindowExW(0, kClasseVideo, L"", WS_CHILD | WS_VISIBLE, 0, 0, 10,
                                                     10, reinterpret_cast<HWND>(janela_), nullptr, inst,
                                                     this));
  barra_ = reinterpret_cast<HWND__*>(CreateWindowExW(0, L"STATIC", L" conectando...",
                                                     WS_CHILD | WS_VISIBLE | SS_LEFTNOWORDWRAP | SS_CENTERIMAGE,
                                                     0, 0, 10, kAlturaBarra,
                                                     reinterpret_cast<HWND>(janela_), nullptr, inst, nullptr));
  if (barra_) {
    // A fonte padrão de um controle criado assim é a bitmap dos anos noventa.
    HFONT fonte = CreateFontW(-12, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                              CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    SendMessageW(reinterpret_cast<HWND>(barra_), WM_SETFONT, reinterpret_cast<WPARAM>(fonte), TRUE);
  }

  ShowWindow(reinterpret_cast<HWND>(janela_), SW_SHOW);
  Reposicionar();
  SetFocus(reinterpret_cast<HWND>(video_));
  return true;
}

bool Janela::Bombear() {
  MSG msg;
  while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
    if (msg.message == WM_QUIT) {
      fechada_ = true;
      return false;
    }
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return !fechada_;
}

void Janela::DefinirTextoDaBarra(const std::string& texto) {
  if (!barra_) return;
  SetWindowTextW(reinterpret_cast<HWND>(barra_), ParaWide(" " + texto).c_str());
}

void Janela::DefinirTitulo(const std::string& texto) {
  if (!janela_) return;
  SetWindowTextW(reinterpret_cast<HWND>(janela_), ParaWide(texto).c_str());
}

void Janela::DefinirTamanhoDaImagem(uint32_t largura, uint32_t altura) {
  if (largura > 0 && altura > 0) {
    largura_imagem_ = largura;
    altura_imagem_ = altura;
  }
}

bool Janela::Redimensionou() {
  const bool r = redimensionou_;
  redimensionou_ = false;
  return r;
}

void Janela::AlternarTelaCheia() {
  if (!janela_) return;
  HWND hwnd = reinterpret_cast<HWND>(janela_);
  if (!tela_cheia_) {
    RECT r{};
    GetWindowRect(hwnd, &r);
    guardado_[0] = r.left;
    guardado_[1] = r.top;
    guardado_[2] = r.right;
    guardado_[3] = r.bottom;
    estilo_guardado_ = static_cast<uint32_t>(GetWindowLongW(hwnd, GWL_STYLE));

    MONITORINFO mi{sizeof(mi)};
    GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mi);
    SetWindowLongW(hwnd, GWL_STYLE, estilo_guardado_ & ~WS_OVERLAPPEDWINDOW);
    SetWindowPos(hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top,
                 mi.rcMonitor.right - mi.rcMonitor.left, mi.rcMonitor.bottom - mi.rcMonitor.top,
                 SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
    tela_cheia_ = true;
  } else {
    SetWindowLongW(hwnd, GWL_STYLE, estilo_guardado_);
    SetWindowPos(hwnd, nullptr, guardado_[0], guardado_[1], guardado_[2] - guardado_[0],
                 guardado_[3] - guardado_[1], SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
    tela_cheia_ = false;
  }
  Reposicionar();
}

}  // namespace ryke
