// Desenha o quadro NV12 na janela, pela GPU.
//
// POR QUE NÃO GDI (StretchDIBits), QUE SERIA MUITO MAIS CURTO
//
// O demo antigo deste projeto usava GDI e media 32 quadros por segundo — e a
// captura, medida em separado, entregava 57. O gargalo era o desenho: mandar
// 1920x1080 pixels pela CPU para a tela, a cada quadro, é mais caro do que
// capturar. Foi a primeira medição a mostrar que "está lento" quase nunca é
// onde parece.
//
// Aqui a GPU faz o trabalho dela: os dois planos do NV12 sobem como texturas, e
// um sombreador de fragmento converte para RGB no momento de pintar. A CPU só
// copia os bytes uma vez.
//
// O SOMBREADOR TAMBÉM CONSERTA UM ERRO COMUM
//
// A conversão de volta usa os mesmos coeficientes BT.709 de faixa reduzida que
// `codec/cores.cc` usou na ida. Misturar (converter com BT.601 e voltar com
// BT.709, ou esquecer a faixa reduzida) não quebra nada — só deixa a imagem
// levemente lavada ou escura, que é o tipo de defeito que ninguém consegue
// nomear e todo mundo sente.

#pragma once

#include <cstdint>
#include <string>

struct ID3D11Device;
struct ID3D11DeviceContext;
struct IDXGISwapChain1;
struct ID3D11RenderTargetView;
struct ID3D11Texture2D;
struct ID3D11ShaderResourceView;
struct ID3D11VertexShader;
struct ID3D11PixelShader;
struct ID3D11SamplerState;
struct ID3D11Buffer;
struct HWND__;

namespace ryke {

class Pintor {
 public:
  Pintor() = default;
  ~Pintor();
  Pintor(const Pintor&) = delete;
  Pintor& operator=(const Pintor&) = delete;

  bool Iniciar(HWND__* janela, std::string* erro);
  void Parar();
  bool Ativo() const { return dispositivo_ != nullptr; }

  // A janela mudou de tamanho.
  void Redimensionar(uint32_t largura, uint32_t altura);

  // Sobe um quadro NV12 e o desenha, mantendo a proporção (barras pretas nas
  // sobras). `passo` é o número de bytes entre linhas do plano de brilho.
  bool Desenhar(const uint8_t* nv12, uint32_t largura, uint32_t altura, std::string* erro);

  // Pinta só o fundo — usado enquanto nenhum quadro chegou ainda.
  void LimparTela();

 private:
  bool GarantirTexturas(uint32_t largura, uint32_t altura, std::string* erro);
  bool GarantirAlvo(std::string* erro);
  void SoltarAlvo();

  ID3D11Device* dispositivo_ = nullptr;
  ID3D11DeviceContext* contexto_ = nullptr;
  IDXGISwapChain1* cadeia_ = nullptr;
  ID3D11RenderTargetView* alvo_ = nullptr;
  ID3D11Texture2D* textura_y_ = nullptr;
  ID3D11Texture2D* textura_uv_ = nullptr;
  ID3D11ShaderResourceView* vista_y_ = nullptr;
  ID3D11ShaderResourceView* vista_uv_ = nullptr;
  ID3D11VertexShader* vertice_ = nullptr;
  ID3D11PixelShader* fragmento_ = nullptr;
  ID3D11SamplerState* amostrador_ = nullptr;
  ID3D11Buffer* constantes_ = nullptr;

  HWND__* janela_ = nullptr;
  uint32_t largura_quadro_ = 0;
  uint32_t altura_quadro_ = 0;
  uint32_t largura_janela_ = 0;
  uint32_t altura_janela_ = 0;
};

}  // namespace ryke
