// A porta de entrada do programa.
//
// Sem argumento nenhum, ele PERGUNTA — porque um executável que fecha na cara
// de quem deu dois cliques nele é um executável que ninguém testa. Com
// argumentos, roda direto, que é como o instalador e os testes o chamam.

#include "app/lados.h"

#include "base/log.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>

#include <cstdio>
#include <string>
#include <vector>

using namespace ryke;

namespace {

std::string DoWide(const wchar_t* w) {
  if (!w) return "";
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

// Abre um console e liga a saída padrão nele.
//
// Este é um programa de janela (SUBSYSTEM:WINDOWS): sem isto, todo `printf` e
// todo registro cai no vazio quando ele é chamado de um terminal — e o modo
// anfitrião, que não tem janela nenhuma, ficaria completamente mudo.
void GarantirConsole() {
  if (!AttachConsole(ATTACH_PARENT_PROCESS)) AllocConsole();
  FILE* f = nullptr;
  freopen_s(&f, "CONOUT$", "w", stdout);
  freopen_s(&f, "CONOUT$", "w", stderr);
  freopen_s(&f, "CONIN$", "r", stdin);
  SetConsoleOutputCP(CP_UTF8);
}

void Ajuda() {
  printf(
      "\n"
      "  Ryke Sistema — acesso remoto nativo (sem navegador, sem WebRTC)\n"
      "\n"
      "  Compartilhar esta tela:\n"
      "    ryke-sistema.exe --anfitriao --senha SUA-SENHA [--porta 5900] [--monitor 0]\n"
      "\n"
      "  Ver e controlar outra:\n"
      "    ryke-sistema.exe --visitante MAQUINA:5900 --senha SUA-SENHA\n"
      "\n"
      "  Outras opcoes:\n"
      "    --fps 60           quadros por segundo do codificador\n"
      "    --banda 8          megabits por segundo iniciais\n"
      "    --banda-max 40     teto de megabits por segundo\n"
      "    --log ARQUIVO      grava o registro tambem num arquivo\n"
      "    --detalhe          registro detalhado\n"
      "\n"
      "  Na janela do visitante: F11 alterna tela cheia.\n"
      "\n");
}

// Pergunta o que fazer, para quem abriu com dois cliques.
bool Perguntar(Opcoes* op) {
  printf(
      "\n"
      "  Ryke Sistema\n"
      "  ------------\n"
      "  1) Compartilhar ESTA tela (anfitriao)\n"
      "  2) Ver OUTRA tela (visitante)\n"
      "\n"
      "  Escolha [1/2]: ");
  fflush(stdout);

  char linha[256] = {};
  if (!fgets(linha, sizeof(linha), stdin)) return false;
  const bool anfitriao = linha[0] == '1';

  if (!anfitriao) {
    printf("  Endereco do outro computador (ex.: 192.168.0.10:5900): ");
    fflush(stdout);
    if (!fgets(linha, sizeof(linha), stdin)) return false;
    std::string alvo(linha);
    while (!alvo.empty() && (alvo.back() == '\n' || alvo.back() == '\r' || alvo.back() == ' ')) alvo.pop_back();
    if (alvo.empty()) return false;
    if (alvo.find(':') == std::string::npos) alvo += ":5900";
    op->alvo = alvo;
  }

  printf("  Senha da sessao: ");
  fflush(stdout);
  if (!fgets(linha, sizeof(linha), stdin)) return false;
  std::string senha(linha);
  while (!senha.empty() && (senha.back() == '\n' || senha.back() == '\r')) senha.pop_back();
  if (senha.empty()) {
    printf("\n  A senha nao pode ficar vazia: e ela que impede um estranho de entrar.\n\n");
    return false;
  }

  op->anfitriao = anfitriao;
  op->senha = senha;
  printf("\n");
  return true;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  int quantos = 0;
  LPWSTR* args = CommandLineToArgvW(GetCommandLineW(), &quantos);

  Opcoes op;
  bool pediu_ajuda = false;
  bool tem_modo = false;

  for (int i = 1; i < quantos; i++) {
    const std::string a = DoWide(args[i]);
    const auto proximo = [&](const char* padrao) -> std::string {
      if (i + 1 < quantos) return DoWide(args[++i]);
      return padrao;
    };
    if (a == "--anfitriao" || a == "-a") {
      op.anfitriao = true;
      tem_modo = true;
    } else if (a == "--visitante" || a == "-v") {
      op.anfitriao = false;
      op.alvo = proximo("");
      tem_modo = true;
    } else if (a == "--porta") {
      op.porta = static_cast<uint16_t>(atoi(proximo("5900").c_str()));
    } else if (a == "--senha" || a == "-s") {
      op.senha = proximo("");
    } else if (a == "--monitor") {
      op.monitor = static_cast<uint32_t>(atoi(proximo("0").c_str()));
    } else if (a == "--fps") {
      op.fps = static_cast<uint32_t>(atoi(proximo("60").c_str()));
    } else if (a == "--banda") {
      op.bps_inicial = static_cast<uint32_t>(atoi(proximo("8").c_str())) * 1000000u;
    } else if (a == "--banda-max") {
      op.bps_maximo = static_cast<uint32_t>(atoi(proximo("40").c_str())) * 1000000u;
    } else if (a == "--log") {
      op.arquivo_de_log = proximo("");
    } else if (a == "--detalhe") {
      op.console = true;
    } else if (a == "--ajuda" || a == "-h" || a == "/?") {
      pediu_ajuda = true;
    }
  }
  if (args) LocalFree(args);

  GarantirConsole();
  if (!op.arquivo_de_log.empty()) LogParaArquivo(op.arquivo_de_log);
  if (op.console) LogNivelMinimo(Nivel::kDetalhe);

  if (pediu_ajuda) {
    Ajuda();
    return 0;
  }

  if (!tem_modo) {
    if (!Perguntar(&op)) {
      Ajuda();
      printf("  Pressione Enter para fechar.");
      fflush(stdout);
      (void)getchar();
      return 1;
    }
  }

  if (op.senha.empty()) {
    printf("\n  Falta --senha. Sem ela, qualquer um que alcance esta porta entra.\n\n");
    return 1;
  }
  if (!op.anfitriao && op.alvo.empty()) {
    printf("\n  Falta o endereco do outro computador.\n\n");
    return 1;
  }

  const int codigo = op.anfitriao ? RodarAnfitriao(op) : RodarVisitante(op);

  if (!tem_modo) {
    printf("\n  Pressione Enter para fechar.");
    fflush(stdout);
    (void)getchar();
  }
  return codigo;
}
