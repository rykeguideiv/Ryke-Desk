// RykeCaptura — o demonstrador nativo da captura por Desktop Duplication.
//
// O QUE ISTO E, E O QUE NAO E
//
// NAO e o Ryke Desk, e nao acessa maquina nenhuma. E um programa de uma janela
// so que captura ESTA tela pela API do Windows e desenha o resultado, com a
// taxa de quadros no titulo. Ele existe para responder, com o olho e nao com
// um relatorio, a duas perguntas:
//
//   1. a captura nativa acompanha a tela de verdade, a 60 quadros?
//   2. ela continua funcionando quando o processo roda ELEVADO?
//
// A segunda e a que importa. A captura do Chromium, que o Ryke Desk usa hoje,
// simplesmente nao inicia num processo elevado (NotReadableError) e a imagem
// cai para 1 quadro por segundo. Por isso, abra este programa das duas formas
// — normal e "Executar como administrador" — e compare o numero no titulo.
//
// POR QUE O DESENHO E SEPARADO DA MEDIDA
//
// A primeira versao deste demo redesenhava a cada quadro capturado, e o
// numero no titulo caiu para ~32 q/s — enquanto a captura pura media 57,7.
// A diferenca nao era da captura: era o StretchDIBits escalando 1920x1080 no
// processador, sessenta vezes por segundo. O demo estava medindo o proprio
// desenho e chamando aquilo de taxa de captura.
//
// Agora o laco captura o mais rapido que da, mas so REDESENHA umas 30 vezes
// por segundo — o olho nao distingue mais que isso numa previa. O titulo mostra
// os dois numeros, porque esconder um deles seria dar a entender que a captura
// e mais lenta do que ela e.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <cstdio>
#include <string>
#include <vector>

#include "../src/duplicador.h"

namespace {

ryke::Duplicador g_duplicador;
std::vector<uint8_t> g_quadro;
uint32_t g_largura = 0;
uint32_t g_altura = 0;
std::string g_recado = "abrindo a captura...";

// Contagem de quadros da ultima janela de um segundo.
int g_contados = 0;
double g_taxa = 0.0;
int g_pintados = 0;
double g_taxaPintura = 0.0;
ULONGLONG g_marca = 0;
ULONGLONG g_ultimaPintura = 0;
int g_perdas = 0;

void Pintar(HWND janela, HDC dc) {
  RECT area;
  GetClientRect(janela, &area);

  if (g_quadro.empty() || g_largura == 0 || g_altura == 0) {
    FillRect(dc, &area, (HBRUSH)(COLOR_WINDOW + 1));
    TextOutA(dc, 12, 12, g_recado.c_str(), (int)g_recado.size());
    return;
  }

  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = (LONG)g_largura;
  // Altura NEGATIVA: a Desktop Duplication entrega a imagem de cima para
  // baixo, e o GDI espera de baixo para cima. Sem o sinal, a tela aparece de
  // cabeca para baixo — que e o classico "funcionou mas esta invertido".
  info.bmiHeader.biHeight = -(LONG)g_altura;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;

  SetStretchBltMode(dc, HALFTONE);
  StretchDIBits(dc, 0, 0, area.right, area.bottom, 0, 0, (int)g_largura, (int)g_altura,
                g_quadro.data(), &info, DIB_RGB_COLORS, SRCCOPY);
}

void AtualizarTitulo(HWND janela) {
  char titulo[220];
  const bool elevado = []() {
    HANDLE t = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &t)) return false;
    TOKEN_ELEVATION e{};
    DWORD tam = sizeof(e);
    const bool ok = GetTokenInformation(t, TokenElevation, &e, sizeof(e), &tam) && e.TokenIsElevated;
    CloseHandle(t);
    return ok;
  }();

  // Só ASCII: SetWindowTextA recebe bytes, e um traco longo em UTF-8 vira
  // "â€"" na barra de titulo.
  snprintf(titulo, sizeof(titulo),
           "RykeCaptura nativa | captura %.1f q/s | previa %.1f q/s | %ux%u | %s%s", g_taxa,
           g_taxaPintura, g_largura, g_altura, elevado ? "ELEVADO (administrador)" : "normal",
           g_perdas > 0 ? " | recriou a captura" : "");
  SetWindowTextA(janela, titulo);
}

LRESULT CALLBACK Janela(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_PAINT: {
      PAINTSTRUCT ps;
      HDC dc = BeginPaint(h, &ps);
      Pintar(h, dc);
      EndPaint(h, &ps);
      return 0;
    }
    case WM_ERASEBKGND:
      return 1;  // evita o piscar entre um quadro e o outro
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcA(h, msg, wp, lp);
}

}  // namespace

int WINAPI WinMain(HINSTANCE instancia, HINSTANCE, LPSTR, int mostrar) {
  SetProcessDPIAware();

  WNDCLASSA classe{};
  classe.lpfnWndProc = Janela;
  classe.hInstance = instancia;
  classe.hCursor = LoadCursor(nullptr, IDC_ARROW);
  classe.lpszClassName = "RykeCapturaDemo";
  RegisterClassA(&classe);

  HWND janela = CreateWindowExA(0, "RykeCapturaDemo", "RykeCaptura nativa", WS_OVERLAPPEDWINDOW,
                                CW_USEDEFAULT, CW_USEDEFAULT, 980, 620, nullptr, nullptr, instancia, nullptr);
  if (!janela) return 1;
  ShowWindow(janela, mostrar);

  std::string erro;
  if (!g_duplicador.Iniciar(0, &erro)) {
    g_recado = "nao consegui abrir a captura: " + erro;
    InvalidateRect(janela, nullptr, TRUE);
  }

  g_marca = GetTickCount64();

  MSG msg{};
  bool rodando = true;
  while (rodando) {
    while (PeekMessageA(&msg, nullptr, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_QUIT) {
        rodando = false;
        break;
      }
      TranslateMessage(&msg);
      DispatchMessageA(&msg);
    }
    if (!rodando) break;

    if (g_duplicador.Ativo()) {
      uint32_t l = 0, a = 0;
      // Espera curta: o laco precisa continuar respondendo a janela. Um quadro
      // a 60 Hz dura ~16 ms, entao 8 ms mantem a medida honesta sem travar a
      // interface quando a tela esta parada.
      const ryke::Resultado r = g_duplicador.Proximo(8, &g_quadro, &l, &a, &erro);
      if (r == ryke::Resultado::kQuadro) {
        g_largura = l;
        g_altura = a;
        g_contados++;
        // Redesenha no maximo ~30 vezes por segundo. Capturar e desenhar sao
        // custos separados, e amarrar um ao outro faria o desenho ditar a taxa.
        const ULONGLONG t = GetTickCount64();
        if (t - g_ultimaPintura >= 33) {
          g_ultimaPintura = t;
          g_pintados++;
          InvalidateRect(janela, nullptr, FALSE);
        }
      } else if (r == ryke::Resultado::kPerdido) {
        // Acontece toda vez que a area de trabalho troca — o UAC entrando, por
        // exemplo. Nao e falha: reabre e segue.
        g_perdas++;
        g_duplicador.Parar();
        if (!g_duplicador.Iniciar(0, &erro)) g_recado = "perdi a captura: " + erro;
      } else if (r == ryke::Resultado::kErro) {
        g_recado = "erro na captura: " + erro;
        InvalidateRect(janela, nullptr, TRUE);
      }
    }

    const ULONGLONG agora = GetTickCount64();
    if (agora - g_marca >= 1000) {
      g_taxa = g_contados * 1000.0 / (double)(agora - g_marca);
      g_taxaPintura = g_pintados * 1000.0 / (double)(agora - g_marca);
      g_contados = 0;
      g_pintados = 0;
      g_marca = agora;
      AtualizarTitulo(janela);
    }
  }

  g_duplicador.Parar();
  return 0;
}
