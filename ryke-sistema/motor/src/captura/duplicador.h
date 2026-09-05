// Captura de tela pela Desktop Duplication API (DXGI).
//
// POR QUE ISTO EXISTE EM C++, E NAO EM koffi
//
// O resto do Ryke Desk fala com o Windows por koffi, que chama funcoes C
// simples de DLL. A Desktop Duplication nao e assim: ela e COM sobre Direct3D
// 11 — interfaces com tabelas virtuais, texturas na GPU, contextos de
// dispositivo. Nada disso atravessa uma ponte FFI. Por isso este e o unico
// pedaco do projeto que precisa de compilador.
//
// O QUE ELA DA QUE A CAPTURA DO CHROMIUM NAO DA
//
// Uma coisa so, e e a que falta: capturar quando o processo roda como SISTEMA,
// inclusive na area de trabalho protegida do UAC. A captura do Chromium ja
// entrega 60 quadros por hardware no uso normal — o que ela nao faz e
// atravessar essa fronteira, porque o WebRTC recebe E_ACCESSDENIED de
// DuplicateOutput sem privilegio de Local System.
//
// COMO O QUADRO SAI DAQUI
//
// A GPU entrega a imagem numa textura que a CPU nao le. Para mandar o quadro
// ao JavaScript e preciso copia-la para uma textura de "estagio" — a unica que
// aceita leitura pela CPU — e de la para a memoria comum. Sao duas copias, e
// elas sao o preco de tirar o quadro da GPU. E por isso que este caminho NAO
// substitui a captura normal: ela mantem o quadro na GPU do inicio ao fim, e
// por isso e mais rapida. Este aqui e para o caso que o outro nao alcanca.

#pragma once

#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <cstdint>
#include <string>
#include <vector>

namespace ryke {

// O que aconteceu ao pedir o proximo quadro.
enum class Resultado {
  // Veio quadro novo, ja copiado para o destino.
  kQuadro,
  // O tempo acabou sem nada mudar na tela. Nao e erro: uma tela parada e o
  // estado mais comum de um computador, e o duplicador simplesmente nao tem o
  // que entregar.
  kSemNovidade,
  // Perdemos o duplicador. Acontece de verdade e com frequencia: a area de
  // trabalho trocou (o UAC entrou), a resolucao mudou, o driver reiniciou.
  // Quem chama deve recriar e seguir — nao e falha fatal.
  kPerdido,
  // Deu errado de um jeito que vale contar.
  kErro,
};

class Duplicador {
 public:
  Duplicador() = default;
  ~Duplicador();

  Duplicador(const Duplicador&) = delete;
  Duplicador& operator=(const Duplicador&) = delete;

  // Abre o duplicador do monitor indicado (0 = o primeiro).
  bool Iniciar(uint32_t indice_saida, std::string* erro);
  void Parar();
  bool Ativo() const { return duplicacao_ != nullptr; }

  // Espera ate `timeout_ms` por um quadro novo. Em caso de kQuadro, `destino`
  // recebe os pixels em BGRA (4 bytes por pixel, sem espacamento entre linhas).
  Resultado Proximo(uint32_t timeout_ms,
                    std::vector<uint8_t>* destino,
                    uint32_t* largura,
                    uint32_t* altura,
                    std::string* erro);

  uint32_t Largura() const { return largura_; }
  uint32_t Altura() const { return altura_; }

 private:
  // A textura de estagio precisa ter exatamente o tamanho do quadro. Ela e
  // criada uma vez e reaproveitada: criar uma textura por quadro seria o
  // suficiente para derrubar a taxa sozinho.
  bool GarantirEstagio(uint32_t largura, uint32_t altura, std::string* erro);

  Microsoft::WRL::ComPtr<ID3D11Device> dispositivo_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> contexto_;
  Microsoft::WRL::ComPtr<IDXGIOutputDuplication> duplicacao_;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> estagio_;

  uint32_t indice_saida_ = 0;
  uint32_t largura_ = 0;
  uint32_t altura_ = 0;
  // Verdadeiro entre AcquireNextFrame e ReleaseFrame. Esquecer de soltar o
  // quadro trava o duplicador no quadro seguinte, e o sintoma e "a imagem
  // congelou" — dificil de ligar a causa depois.
  bool quadro_preso_ = false;
};

}  // namespace ryke
