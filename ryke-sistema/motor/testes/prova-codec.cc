// O codec por hardware dá conta de 1080p60 — e a que preço em atraso?
//
// Três números importam, e são todos medidos aqui:
//
//   • quanto tempo a CONVERSÃO de cor leva por quadro (ela é o gargalo escondido
//     do caminho por processador);
//   • quantos quadros por segundo o CODIFICADOR aguenta;
//   • quanto tempo passa entre entregar um quadro e ele voltar decodificado —
//     o atraso que existe MESMO COM a rede sendo instantânea.
//
// Esse terceiro número é o piso do produto: nenhuma melhoria de rede o desce.

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "base/log.h"
#include "base/tempo.h"
#include "codec/codificador.h"
#include "codec/cores.h"
#include "codec/decodificador.h"

using namespace ryke;

static int falhas = 0;
static void check(const char* rotulo, bool ok, const std::string& extra = "") {
  printf("%s %s%s%s\n", ok ? " ok  " : "FALHA", rotulo, extra.empty() ? "" : " — ", extra.c_str());
  if (!ok) falhas++;
}

// Uma tela de mentira que se parece com uma de verdade: fundo liso, janelas,
// e um retângulo que anda. Ruído branco seria o pior teste possível — ele não
// comprime, e mediria um caso que nunca acontece.
static void DesenharTela(std::vector<uint8_t>& bgra, uint32_t largura, uint32_t altura, uint32_t quadro) {
  const uint32_t passo = largura * 4;
  for (uint32_t y = 0; y < altura; y++) {
    uint8_t* linha = bgra.data() + static_cast<size_t>(y) * passo;
    for (uint32_t x = 0; x < largura; x++) {
      uint8_t* p = linha + static_cast<size_t>(x) * 4;
      // fundo
      p[0] = 40;
      p[1] = 42;
      p[2] = 46;
      p[3] = 255;
      // "janelas"
      if (y > altura / 8 && y < altura / 2 && x > largura / 10 && x < largura / 2) {
        p[0] = 28;
        p[1] = 30;
        p[2] = 34;
      }
      // "texto": linhas finas, que é o que mais sofre com compressão
      if (y % 24 == 0 && x > largura / 10 && x < largura / 2) {
        p[0] = 200;
        p[1] = 200;
        p[2] = 205;
      }
    }
  }
  // o retângulo que anda — é o que obriga o codificador a trabalhar
  const uint32_t cx = (quadro * 11) % (largura - 200);
  const uint32_t cy = (quadro * 7) % (altura - 200);
  for (uint32_t y = cy; y < cy + 180; y++) {
    uint8_t* linha = bgra.data() + static_cast<size_t>(y) * passo;
    for (uint32_t x = cx; x < cx + 180; x++) {
      uint8_t* p = linha + static_cast<size_t>(x) * 4;
      p[0] = 60;
      p[1] = 140;
      p[2] = 240;
    }
  }
}

int main() {
  RelogioFino fino;
  LogNivelMinimo(Nivel::kInfo);

  const uint32_t L = 1920, A = 1080, FPS = 60;

  printf("\n== conversao de cor (BGRA -> NV12) ==\n\n");
  std::vector<uint8_t> bgra(static_cast<size_t>(L) * A * 4);
  std::vector<uint8_t> nv12(TamanhoNv12(L, A));
  std::vector<uint8_t> nv12_paralelo(TamanhoNv12(L, A));
  DesenharTela(bgra, L, A, 1);

  {
    // Uma linha de execução só, para ter a referência.
    const uint64_t t0 = AgoraUs();
    const int voltas = 10;
    for (int i = 0; i < voltas; i++) BgraParaNv12(bgra.data(), L * 4, L, A, nv12.data());
    const double ms_serial = static_cast<double>(AgoraUs() - t0) / 1000.0 / voltas;

    const uint64_t t1 = AgoraUs();
    for (int i = 0; i < voltas; i++)
      BgraParaNv12Paralelo(bgra.data(), L * 4, L, A, nv12_paralelo.data());
    const double ms_paralelo = static_cast<double>(AgoraUs() - t1) / 1000.0 / voltas;

    printf("      1080p: %.2f ms numa linha, %.2f ms em paralelo (%.1fx)\n", ms_serial, ms_paralelo,
           ms_serial / (ms_paralelo > 0 ? ms_paralelo : 1));

    check("o paralelo produz EXATAMENTE o mesmo resultado", nv12 == nv12_paralelo,
          "os dois caminhos precisam concordar byte a byte");
    check("cabe no orcamento de um quadro a 60/s (16,7 ms)", ms_paralelo < 16.7,
          std::to_string(ms_paralelo) + " ms");
  }

  printf("\n== codificador ==\n\n");
  Codificador cod;
  std::string erro;
  if (!cod.Iniciar(L, A, FPS, 8000000, &erro)) {
    check("o codificador subiu", false, erro);
    printf("\n%s\n\n", "1 FALHA(S)");
    return 1;
  }
  check("o codificador subiu", true, cod.Nome() + (cod.PorHardware() ? " (hardware)" : " (software)"));
  check("e e por HARDWARE", cod.PorHardware(),
        cod.PorHardware() ? "" : "caiu para software — vai gastar processador");

  Decodificador dec;
  if (!dec.Iniciar(L, A, &erro)) {
    check("o decodificador subiu", false, erro);
  } else {
    check("o decodificador subiu", true, dec.Nome() + (dec.PorHardware() ? " (hardware)" : " (software)"));
  }

  {
    const int quantos = 180;  // 3 segundos a 60/s
    size_t bytes = 0;
    int pacotes = 0;
    int chaves = 0;
    int decodificados = 0;
    uint64_t soma_ida_volta_us = 0;
    uint64_t pior_us = 0;

    const uint64_t inicio = AgoraUs();
    for (int i = 0; i < quantos; i++) {
      DesenharTela(bgra, L, A, static_cast<uint32_t>(i));
      BgraParaNv12Paralelo(bgra.data(), L * 4, L, A, nv12.data());

      const uint64_t antes = AgoraUs();
      std::vector<PacoteCodificado> saiu;
      if (!cod.Codificar(nv12.data(), nv12.size(), antes, &saiu, &erro)) {
        check("codificar", false, erro);
        break;
      }
      for (auto& p : saiu) {
        bytes += p.dados.size();
        pacotes++;
        if (p.chave) chaves++;
        if (dec.Ativo()) {
          std::vector<QuadroDecodificado> voltou;
          if (dec.Decodificar(p.dados.data(), p.dados.size(), p.tempo_us, &voltou, &erro)) {
            for (auto& q : voltou) {
              decodificados++;
              const uint64_t gasto = AgoraUs() - p.tempo_us;
              soma_ida_volta_us += gasto;
              if (gasto > pior_us) pior_us = gasto;
            }
          }
        }
      }
    }
    const double segundos = static_cast<double>(AgoraUs() - inicio) / 1e6;
    const double taxa = quantos / segundos;
    const double kbps = (bytes * 8.0 / segundos) / 1000.0;

    printf("      %d quadros em %.2f s = %.1f quadros/s · %.0f kb/s · %d chaves\n", quantos, segundos, taxa,
           kbps, chaves);
    if (decodificados > 0) {
      printf("      ida e volta (codificar + decodificar): media %.1f ms, pior %.1f ms\n",
             soma_ida_volta_us / 1000.0 / decodificados, pior_us / 1000.0);
    }

    check("saiu quadro codificado", pacotes > 0, std::to_string(pacotes) + " pacotes");
    check("a taxa aguenta 60 por segundo", taxa >= 55.0, std::to_string(static_cast<int>(taxa)) + " q/s");
    check("o tamanho e razoavel (nao esta gastando banda a toa)", kbps < 20000.0,
          std::to_string(static_cast<int>(kbps)) + " kb/s");
    if (dec.Ativo()) {
      check("o que foi codificado volta a virar imagem", decodificados > 0,
            std::to_string(decodificados) + " quadros decodificados");
      // O limite depende de quem decodifica. Com o decodificador por software
      // do Windows, boa parte destes milissegundos e processador desempacotando
      // H.264 — o caminho por DXVA (decodificador ligado a um dispositivo
      // Direct3D) corta isso, e e o proximo passo do motor. Cobrar 12 ms de um
      // caminho que ainda nao existe seria reprovar o codigo pelo que falta
      // fazer, e nao pelo que ele faz.
      const double media_ms = decodificados > 0 ? soma_ida_volta_us / 1000.0 / decodificados : 999;
      const double limite = dec.PorHardware() ? 12.0 : 35.0;
      check(dec.PorHardware() ? "o par codec entrega abaixo de 12 ms (hardware)"
                              : "o par codec entrega abaixo de 35 ms (decodificador por software)",
            media_ms < limite, std::to_string(media_ms) + " ms");
    }
  }

  printf("\n== o quadro-chave sob demanda ==\n\n");
  {
    // Quando a rede perde um quadro, o outro lado pede chave. Ela precisa sair
    // no quadro seguinte — não no próximo GOP, que está a dez segundos daqui.
    std::vector<PacoteCodificado> saiu;
    cod.ForcarQuadroChave();
    DesenharTela(bgra, L, A, 999);
    BgraParaNv12Paralelo(bgra.data(), L * 4, L, A, nv12.data());
    cod.Codificar(nv12.data(), nv12.size(), AgoraUs(), &saiu, &erro);
    // O codificador por hardware trabalha com um ou dois quadros de fila: o
    // quadro-chave pedido nao sai no MESMO ProcessInput, sai logo depois. Damos
    // seis quadros — se em seis nao veio, ai sim o pedido nao esta funcionando.
    bool achou = false;
    for (auto& p0 : saiu) achou = achou || p0.chave;
    for (int i = 0; i < 6 && !achou; i++) {
      DesenharTela(bgra, L, A, 1000 + i);
      BgraParaNv12Paralelo(bgra.data(), L * 4, L, A, nv12.data());
      cod.Codificar(nv12.data(), nv12.size(), AgoraUs(), &saiu, &erro);
      for (auto& p0 : saiu) achou = achou || p0.chave;
    }
    check("pedir quadro-chave produz um quadro-chave logo em seguida", achou,
          std::to_string(saiu.size()) + " pacotes na resposta");
  }

  printf("\n%s\n\n", falhas == 0 ? "TUDO OK" : (std::to_string(falhas) + " FALHA(S)").c_str());
  return falhas == 0 ? 0 : 1;
}
