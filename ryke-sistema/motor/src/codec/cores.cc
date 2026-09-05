#include "codec/cores.h"

#include <algorithm>
#include <thread>
#include <vector>

namespace ryke {
namespace {

unsigned g_linhas_de_trabalho = 0;  // 0 = decide sozinho

// BT.709, faixa reduzida (16..235) — é o que praticamente todo decodificador
// espera de um H.264 de 1080p. Usar BT.601 aqui, ou faixa cheia, é a causa
// clássica de "a imagem chega meio lavada" ou "meio escura demais".
//
// Os coeficientes viraram inteiros de 16 bits: multiplicar e deslocar é muito
// mais rápido do que ponto flutuante, e para 8 bits de saída a precisão sobra.
constexpr int kDesloc = 16;
constexpr int kYr = static_cast<int>(0.1826 * (1 << kDesloc));
constexpr int kYg = static_cast<int>(0.6142 * (1 << kDesloc));
constexpr int kYb = static_cast<int>(0.0620 * (1 << kDesloc));
constexpr int kUr = static_cast<int>(-0.1006 * (1 << kDesloc));
constexpr int kUg = static_cast<int>(-0.3386 * (1 << kDesloc));
constexpr int kUb = static_cast<int>(0.4392 * (1 << kDesloc));
constexpr int kVr = static_cast<int>(0.4392 * (1 << kDesloc));
constexpr int kVg = static_cast<int>(-0.3989 * (1 << kDesloc));
constexpr int kVb = static_cast<int>(-0.0403 * (1 << kDesloc));

inline uint8_t Limitar(int v) { return static_cast<uint8_t>(v < 0 ? 0 : (v > 255 ? 255 : v)); }

// Converte uma faixa de linhas. `y0` precisa ser par.
void Faixa(const uint8_t* bgra, uint32_t passo, uint32_t largura, uint32_t altura, uint8_t* nv12,
           uint32_t y0, uint32_t y1) {
  uint8_t* plano_y = nv12;
  uint8_t* plano_uv = nv12 + static_cast<size_t>(largura) * altura;

  for (uint32_t y = y0; y < y1; y += 2) {
    const uint8_t* linha0 = bgra + static_cast<size_t>(y) * passo;
    const uint8_t* linha1 = (y + 1 < altura) ? linha0 + passo : linha0;
    uint8_t* saida_y0 = plano_y + static_cast<size_t>(y) * largura;
    uint8_t* saida_y1 = saida_y0 + largura;
    uint8_t* saida_uv = plano_uv + static_cast<size_t>(y / 2) * largura;

    for (uint32_t x = 0; x < largura; x += 2) {
      const uint8_t* p[4] = {
          linha0 + static_cast<size_t>(x) * 4,
          linha0 + static_cast<size_t>(std::min(x + 1, largura - 1)) * 4,
          linha1 + static_cast<size_t>(x) * 4,
          linha1 + static_cast<size_t>(std::min(x + 1, largura - 1)) * 4,
      };

      int soma_r = 0, soma_g = 0, soma_b = 0;
      uint8_t brilho[4];
      for (int i = 0; i < 4; i++) {
        const int b = p[i][0], g = p[i][1], r = p[i][2];
        brilho[i] = Limitar(16 + ((kYr * r + kYg * g + kYb * b) >> kDesloc));
        soma_r += r;
        soma_g += g;
        soma_b += b;
      }
      saida_y0[x] = brilho[0];
      if (x + 1 < largura) saida_y0[x + 1] = brilho[1];
      if (y + 1 < altura) {
        saida_y1[x] = brilho[2];
        if (x + 1 < largura) saida_y1[x + 1] = brilho[3];
      }

      // A cor é a MÉDIA dos quatro pixels, e não a do primeiro. Pegar só um
      // ponto do quadrado faz aparecer serrilhado colorido em texto e em
      // bordas finas — que é a metade da tela num computador de trabalho.
      const int r = soma_r / 4, g = soma_g / 4, b = soma_b / 4;
      saida_uv[x] = Limitar(128 + ((kUr * r + kUg * g + kUb * b) >> kDesloc));
      if (x + 1 < largura) saida_uv[x + 1] = Limitar(128 + ((kVr * r + kVg * g + kVb * b) >> kDesloc));
    }
  }
}

}  // namespace

void DefinirLinhasDeTrabalho(unsigned quantas) { g_linhas_de_trabalho = quantas; }

void BgraParaNv12(const uint8_t* bgra, uint32_t passo_bgra, uint32_t largura, uint32_t altura,
                  uint8_t* nv12) {
  Faixa(bgra, passo_bgra, largura, altura, nv12, 0, altura);
}

void BgraParaNv12Paralelo(const uint8_t* bgra, uint32_t passo_bgra, uint32_t largura, uint32_t altura,
                          uint8_t* nv12) {
  unsigned n = g_linhas_de_trabalho;
  if (n == 0) {
    n = std::thread::hardware_concurrency();
    if (n == 0) n = 4;
    // Deixa um núcleo de folga: nesta máquina também rodam a captura, o
    // codificador e o resto do programa. Tomar tudo faz o total piorar.
    if (n > 2) n -= 1;
    n = std::min<unsigned>(n, 16);
  }
  if (n <= 1 || altura < 64) {
    BgraParaNv12(bgra, passo_bgra, largura, altura, nv12);
    return;
  }

  // Cada faixa começa numa linha PAR: o plano de cor junta as linhas duas a
  // duas, e uma faixa que começasse em linha ímpar escreveria por cima da
  // vizinha.
  const uint32_t por_faixa = ((altura / n) + 1) & ~1u;
  std::vector<std::thread> equipe;
  equipe.reserve(n);
  for (uint32_t y0 = 0; y0 < altura; y0 += por_faixa) {
    const uint32_t y1 = std::min(y0 + por_faixa, altura);
    equipe.emplace_back([=] { Faixa(bgra, passo_bgra, largura, altura, nv12, y0, y1); });
  }
  for (auto& t : equipe) t.join();
}

}  // namespace ryke
