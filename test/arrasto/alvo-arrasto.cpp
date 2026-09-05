// Uma janela que serve de ALVO para provar se o arrasto injetado chega.
//
// Por que existe: o relato era "clico e arrasto e nada acontece". Todo o resto
// do caminho — navegador, canal de dados, IPC — pode ser inspecionado lendo
// código, mas o último passo (o Windows entregar os eventos a quem está
// embaixo do ponteiro) só se prova olhando do outro lado. Esta janela é o
// outro lado.
//
// Ela imita o caso do relato: uma DIVISÓRIA vertical, igual à do VS Code, que
// só se move se a sequência apertar-mover-soltar chegar inteira e na ordem.
// O número que importa é a posição final da divisória: se mudou, arrastou.
//
// Compilar:
//   cl /nologo /EHsc /std:c++17 /O2 alvo-arrasto.cpp /Fe:alvo-arrasto.exe \
//      /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <windowsx.h>
#include <cstdarg>
#include <cstdio>
#include <share.h>
#include <string>

namespace {

constexpr int LARGURA = 700;
constexpr int ALTURA = 500;
constexpr int DIVISORIA_INICIAL = 350;
constexpr int PEGA = 12;  // meia-largura da faixa que aceita o arrasto

int g_divisoria = DIVISORIA_INICIAL;
bool g_arrastando = false;
int g_nDown = 0;
int g_nMoveComBotao = 0;
int g_nMoveSemBotao = 0;
int g_nUp = 0;
int g_nCaptureLost = 0;
FILE* g_log = nullptr;

void registrar(const char* fmt, ...) {
  if (!g_log) return;
  va_list args;
  va_start(args, fmt);
  vfprintf(g_log, fmt, args);
  va_end(args);
  fputc('\n', g_log);
  fflush(g_log);
}

void pintar(HWND hwnd) {
  PAINTSTRUCT ps;
  HDC hdc = BeginPaint(hwnd, &ps);
  RECT r;
  GetClientRect(hwnd, &r);

  HBRUSH esq = CreateSolidBrush(RGB(30, 34, 40));
  HBRUSH dir = CreateSolidBrush(RGB(18, 20, 24));
  HBRUSH barra = CreateSolidBrush(g_arrastando ? RGB(80, 160, 255) : RGB(70, 74, 82));

  RECT re = {0, 0, g_divisoria - 3, r.bottom};
  RECT rd = {g_divisoria + 3, 0, r.right, r.bottom};
  RECT rb = {g_divisoria - 3, 0, g_divisoria + 3, r.bottom};
  FillRect(hdc, &re, esq);
  FillRect(hdc, &rd, dir);
  FillRect(hdc, &rb, barra);

  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, RGB(220, 220, 220));
  char texto[256];
  snprintf(texto, sizeof(texto), "divisoria = %d  (inicial %d)   down=%d  move+botao=%d  up=%d",
           g_divisoria, DIVISORIA_INICIAL, g_nDown, g_nMoveComBotao, g_nUp);
  RECT rt = {10, 10, r.right - 10, 40};
  DrawTextA(hdc, texto, -1, &rt, DT_LEFT | DT_TOP);

  DeleteObject(esq);
  DeleteObject(dir);
  DeleteObject(barra);
  EndPaint(hwnd, &ps);
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  const int x = GET_X_LPARAM(lp);
  const int y = GET_Y_LPARAM(lp);
  switch (msg) {
    case WM_LBUTTONDOWN:
      g_nDown++;
      registrar("DOWN x=%d y=%d naDivisoria=%d", x, y, abs(x - g_divisoria) <= PEGA ? 1 : 0);
      if (abs(x - g_divisoria) <= PEGA) {
        g_arrastando = true;
        SetCapture(hwnd);
      }
      InvalidateRect(hwnd, nullptr, FALSE);
      return 0;

    case WM_MOUSEMOVE:
      if (wp & MK_LBUTTON) {
        g_nMoveComBotao++;
        registrar("MOVE x=%d y=%d botao=1 arrastando=%d", x, y, g_arrastando ? 1 : 0);
        if (g_arrastando) {
          g_divisoria = x < 60 ? 60 : (x > LARGURA - 60 ? LARGURA - 60 : x);
          InvalidateRect(hwnd, nullptr, FALSE);
        }
      } else {
        g_nMoveSemBotao++;
        registrar("MOVE x=%d y=%d botao=0", x, y);
      }
      return 0;

    case WM_LBUTTONUP:
      g_nUp++;
      registrar("UP x=%d y=%d arrastando=%d", x, y, g_arrastando ? 1 : 0);
      if (g_arrastando) {
        g_arrastando = false;
        ReleaseCapture();
      }
      InvalidateRect(hwnd, nullptr, FALSE);
      return 0;

    case WM_CAPTURECHANGED:
      g_nCaptureLost++;
      registrar("CAPTURECHANGED (perdeu a captura)");
      g_arrastando = false;
      return 0;

    case WM_PAINT:
      pintar(hwnd);
      return 0;

    case WM_DESTROY:
      registrar("FIM divisoria=%d inicial=%d down=%d moveComBotao=%d moveSemBotao=%d up=%d capturePerdida=%d",
                g_divisoria, DIVISORIA_INICIAL, g_nDown, g_nMoveComBotao, g_nMoveSemBotao, g_nUp, g_nCaptureLost);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcA(hwnd, msg, wp, lp);
}

}  // namespace

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE, LPSTR cmdLine, int) {
  SetProcessDPIAware();

  std::string caminhoLog = (cmdLine && *cmdLine) ? cmdLine : "alvo-arrasto.log";
  if (caminhoLog.front() == '"') caminhoLog = caminhoLog.substr(1, caminhoLog.size() - 2);
  // Aberto com compartilhamento de leitura: quem mede precisa ler o registro
  // ENQUANTO a janela ainda existe. Com fopen comum o Windows tranca o arquivo
  // e o teste morre com EBUSY.
  g_log = _fsopen(caminhoLog.c_str(), "w", _SH_DENYWR);

  WNDCLASSA wc = {};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInst;
  wc.lpszClassName = "RykeAlvoArrasto";
  wc.hCursor = LoadCursor(nullptr, IDC_SIZEWE);
  wc.hbrBackground = nullptr;
  RegisterClassA(&wc);

  RECT r = {0, 0, LARGURA, ALTURA};
  AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
  const int lx = (GetSystemMetrics(SM_CXSCREEN) - (r.right - r.left)) / 2;
  const int ly = (GetSystemMetrics(SM_CYSCREEN) - (r.bottom - r.top)) / 2;

  HWND hwnd = CreateWindowExA(WS_EX_TOPMOST, "RykeAlvoArrasto", "ALVO-ARRASTO", WS_OVERLAPPEDWINDOW, lx, ly,
                              r.right - r.left, r.bottom - r.top, nullptr, nullptr, hInst, nullptr);
  if (!hwnd) return 1;

  registrar("PRONTO cliente=%dx%d divisoriaInicial=%d", LARGURA, ALTURA, DIVISORIA_INICIAL);
  ShowWindow(hwnd, SW_SHOW);
  SetForegroundWindow(hwnd);
  UpdateWindow(hwnd);

  MSG msg;
  while (GetMessage(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessage(&msg);
  }
  if (g_log) fclose(g_log);
  return 0;
}
