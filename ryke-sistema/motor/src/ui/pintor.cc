#include "ui/pintor.h"

#include "base/log.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11_1.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>

#include <algorithm>
#include <cstring>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3dcompiler.lib")

namespace ryke {
namespace {

bool Falhou(HRESULT hr, const char* onde, std::string* erro) {
  if (SUCCEEDED(hr)) return false;
  if (erro) *erro = std::string(onde) + ": " + TextoDoHResult(hr);
  return true;
}

template <class T>
void Soltar(T*& p) {
  if (p) {
    p->Release();
    p = nullptr;
  }
}

// Um triângulo que cobre a tela inteira, sem buffer de vértices.
//
// Três vértices, e não os quatro de um retângulo: com um triângulo só, a GPU
// percorre cada pixel uma vez. Um retângulo feito de dois triângulos processa
// a diagonal duas vezes. É pouco, mas é grátis.
const char kSombreadorVertice[] = R"(
struct Saida { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
cbuffer Ajuste : register(b0) { float2 escala; float2 sobra; };
Saida principal(uint id : SV_VertexID) {
  float2 t = float2((id << 1) & 2, id & 2);
  Saida s;
  float2 p = t * 2.0 - 1.0;
  s.pos = float4(p.x * escala.x, -p.y * escala.y, 0.0, 1.0);
  s.uv = t;
  return s;
}
)";

const char kSombreadorFragmento[] = R"(
Texture2D<float>  planoY  : register(t0);
Texture2D<float2> planoUV : register(t1);
SamplerState amostra : register(s0);

struct Entrada { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

float4 principal(Entrada e) : SV_TARGET {
  // BT.709, faixa reduzida — os MESMOS coeficientes de codec/cores.cc, ao
  // contrario. Trocar a familia aqui deixa a imagem lavada sem quebrar nada,
  // que e o defeito mais dificil de achar depois.
  float y  = planoY.Sample(amostra, e.uv);
  float2 uv = planoUV.Sample(amostra, e.uv);
  y = (y - 0.0627451) * 1.164383;
  float u = uv.x - 0.5;
  float v = uv.y - 0.5;
  float r = y + 1.792741 * v;
  float g = y - 0.213249 * u - 0.532909 * v;
  float b = y + 2.112402 * u;
  return float4(saturate(float3(r, g, b)), 1.0);
}
)";

struct Ajuste {
  float escala[2];
  float sobra[2];
};

bool Compilar(const char* fonte, const char* alvo, ID3DBlob** saida, std::string* erro) {
  ID3DBlob* reclamacao = nullptr;
  const HRESULT hr = D3DCompile(fonte, strlen(fonte), nullptr, nullptr, nullptr, "principal", alvo,
                                D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, saida, &reclamacao);
  if (FAILED(hr)) {
    if (erro) {
      *erro = "compilar sombreador falhou: ";
      if (reclamacao) erro->append(static_cast<const char*>(reclamacao->GetBufferPointer()));
      else erro->append(TextoDoHResult(hr));
    }
    if (reclamacao) reclamacao->Release();
    return false;
  }
  if (reclamacao) reclamacao->Release();
  return true;
}

}  // namespace

Pintor::~Pintor() { Parar(); }

void Pintor::SoltarAlvo() { Soltar(alvo_); }

void Pintor::Parar() {
  SoltarAlvo();
  Soltar(vista_y_);
  Soltar(vista_uv_);
  Soltar(textura_y_);
  Soltar(textura_uv_);
  Soltar(amostrador_);
  Soltar(constantes_);
  Soltar(fragmento_);
  Soltar(vertice_);
  Soltar(cadeia_);
  Soltar(contexto_);
  Soltar(dispositivo_);
  largura_quadro_ = altura_quadro_ = 0;
}

bool Pintor::Iniciar(HWND__* janela, std::string* erro) {
  Parar();
  janela_ = janela;

  const D3D_FEATURE_LEVEL niveis[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0,
                                      D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0};
  D3D_FEATURE_LEVEL obtido{};
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT, niveis, ARRAYSIZE(niveis),
                                 D3D11_SDK_VERSION, &dispositivo_, &obtido, &contexto_);
  if (FAILED(hr)) {
    // Sem placa (máquina virtual, sessão sem GPU): WARP desenha por software e
    // continua sendo muito melhor do que GDI.
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, niveis, ARRAYSIZE(niveis),
                           D3D11_SDK_VERSION, &dispositivo_, &obtido, &contexto_);
    if (Falhou(hr, "D3D11CreateDevice", erro)) return false;
    RY_AVISO("pintor: sem placa de video, desenhando por software (WARP)");
  }

  IDXGIDevice* dxgi = nullptr;
  IDXGIAdapter* adaptador = nullptr;
  IDXGIFactory2* fabrica = nullptr;
  if (Falhou(dispositivo_->QueryInterface(IID_PPV_ARGS(&dxgi)), "QueryInterface(IDXGIDevice)", erro))
    return false;
  dxgi->GetAdapter(&adaptador);
  adaptador->GetParent(IID_PPV_ARGS(&fabrica));

  RECT r{};
  GetClientRect(janela, &r);
  largura_janela_ = std::max<uint32_t>(1, r.right - r.left);
  altura_janela_ = std::max<uint32_t>(1, r.bottom - r.top);

  DXGI_SWAP_CHAIN_DESC1 desc{};
  desc.Width = largura_janela_;
  desc.Height = altura_janela_;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  desc.BufferCount = 2;
  // FLIP_DISCARD é o que tira uma cópia inteira do caminho. Com o modelo
  // antigo (BitBlt) o Windows copia o quadro para compor a área de trabalho;
  // com o flip ele apenas troca o ponteiro.
  desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
  desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;

  hr = fabrica->CreateSwapChainForHwnd(dispositivo_, janela, &desc, nullptr, nullptr, &cadeia_);
  // Alt+Enter do DXGI faz tela cheia por conta própria e briga com a nossa —
  // desligamos e cuidamos disso na janela.
  if (SUCCEEDED(hr)) fabrica->MakeWindowAssociation(janela, DXGI_MWA_NO_ALT_ENTER);
  Soltar(fabrica);
  Soltar(adaptador);
  Soltar(dxgi);
  if (Falhou(hr, "CreateSwapChainForHwnd", erro)) return false;

  ID3DBlob* bv = nullptr;
  ID3DBlob* bf = nullptr;
  if (!Compilar(kSombreadorVertice, "vs_4_0", &bv, erro)) return false;
  if (!Compilar(kSombreadorFragmento, "ps_4_0", &bf, erro)) {
    Soltar(bv);
    return false;
  }
  hr = dispositivo_->CreateVertexShader(bv->GetBufferPointer(), bv->GetBufferSize(), nullptr, &vertice_);
  if (SUCCEEDED(hr))
    hr = dispositivo_->CreatePixelShader(bf->GetBufferPointer(), bf->GetBufferSize(), nullptr, &fragmento_);
  Soltar(bv);
  Soltar(bf);
  if (Falhou(hr, "CreateShader", erro)) return false;

  D3D11_SAMPLER_DESC am{};
  am.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
  am.AddressU = am.AddressV = am.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
  am.MaxLOD = D3D11_FLOAT32_MAX;
  if (Falhou(dispositivo_->CreateSamplerState(&am, &amostrador_), "CreateSamplerState", erro)) return false;

  D3D11_BUFFER_DESC cb{};
  cb.ByteWidth = sizeof(Ajuste);
  cb.Usage = D3D11_USAGE_DYNAMIC;
  cb.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  cb.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
  if (Falhou(dispositivo_->CreateBuffer(&cb, nullptr, &constantes_), "CreateBuffer", erro)) return false;

  return GarantirAlvo(erro);
}

bool Pintor::GarantirAlvo(std::string* erro) {
  if (alvo_) return true;
  ID3D11Texture2D* fundo = nullptr;
  if (Falhou(cadeia_->GetBuffer(0, IID_PPV_ARGS(&fundo)), "GetBuffer", erro)) return false;
  const HRESULT hr = dispositivo_->CreateRenderTargetView(fundo, nullptr, &alvo_);
  Soltar(fundo);
  return !Falhou(hr, "CreateRenderTargetView", erro);
}

void Pintor::Redimensionar(uint32_t largura, uint32_t altura) {
  if (!cadeia_ || largura == 0 || altura == 0) return;
  if (largura == largura_janela_ && altura == altura_janela_) return;
  largura_janela_ = largura;
  altura_janela_ = altura;
  // O alvo PRECISA ser solto antes: enquanto ele existir, os buffers da cadeia
  // estão presos e o ResizeBuffers falha em silêncio — e a janela fica com a
  // imagem esticada até alguém reiniciar o programa.
  SoltarAlvo();
  cadeia_->ResizeBuffers(0, largura, altura, DXGI_FORMAT_UNKNOWN, 0);
  std::string erro;
  GarantirAlvo(&erro);
}

bool Pintor::GarantirTexturas(uint32_t largura, uint32_t altura, std::string* erro) {
  if (textura_y_ && largura == largura_quadro_ && altura == altura_quadro_) return true;
  Soltar(vista_y_);
  Soltar(vista_uv_);
  Soltar(textura_y_);
  Soltar(textura_uv_);

  D3D11_TEXTURE2D_DESC d{};
  d.Width = largura;
  d.Height = altura;
  d.MipLevels = 1;
  d.ArraySize = 1;
  d.Format = DXGI_FORMAT_R8_UNORM;
  d.SampleDesc.Count = 1;
  d.Usage = D3D11_USAGE_DYNAMIC;
  d.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  d.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
  if (Falhou(dispositivo_->CreateTexture2D(&d, nullptr, &textura_y_), "CreateTexture2D(Y)", erro))
    return false;

  // O plano de cor tem metade da resolução em cada eixo, e os dois canais
  // intercalados — daí R8G8.
  d.Width = largura / 2;
  d.Height = altura / 2;
  d.Format = DXGI_FORMAT_R8G8_UNORM;
  if (Falhou(dispositivo_->CreateTexture2D(&d, nullptr, &textura_uv_), "CreateTexture2D(UV)", erro))
    return false;

  if (Falhou(dispositivo_->CreateShaderResourceView(textura_y_, nullptr, &vista_y_), "SRV(Y)", erro))
    return false;
  if (Falhou(dispositivo_->CreateShaderResourceView(textura_uv_, nullptr, &vista_uv_), "SRV(UV)", erro))
    return false;

  largura_quadro_ = largura;
  altura_quadro_ = altura;
  return true;
}

void Pintor::LimparTela() {
  if (!alvo_) return;
  const float preto[4] = {0.06f, 0.07f, 0.08f, 1.0f};
  contexto_->ClearRenderTargetView(alvo_, preto);
  if (cadeia_) cadeia_->Present(1, 0);
}

bool Pintor::Desenhar(const uint8_t* nv12, uint32_t largura, uint32_t altura, std::string* erro) {
  if (!dispositivo_ || !alvo_) {
    if (erro) *erro = "pintor nao iniciado";
    return false;
  }
  if (largura == 0 || altura == 0) return false;
  if (!GarantirTexturas(largura, altura, erro)) return false;

  const uint8_t* plano_y = nv12;
  const uint8_t* plano_uv = nv12 + static_cast<size_t>(largura) * altura;

  D3D11_MAPPED_SUBRESOURCE m{};
  if (SUCCEEDED(contexto_->Map(textura_y_, 0, D3D11_MAP_WRITE_DISCARD, 0, &m))) {
    // Linha a linha: a textura da GPU tem o próprio espaçamento entre linhas, e
    // quase nunca é igual à largura. Copiar o bloco inteiro de uma vez produz
    // aquela imagem "inclinada" clássica.
    for (uint32_t y = 0; y < altura; y++) {
      memcpy(static_cast<uint8_t*>(m.pData) + static_cast<size_t>(y) * m.RowPitch,
             plano_y + static_cast<size_t>(y) * largura, largura);
    }
    contexto_->Unmap(textura_y_, 0);
  }
  if (SUCCEEDED(contexto_->Map(textura_uv_, 0, D3D11_MAP_WRITE_DISCARD, 0, &m))) {
    for (uint32_t y = 0; y < altura / 2; y++) {
      memcpy(static_cast<uint8_t*>(m.pData) + static_cast<size_t>(y) * m.RowPitch,
             plano_uv + static_cast<size_t>(y) * largura, largura);
    }
    contexto_->Unmap(textura_uv_, 0);
  }

  // Proporção: a imagem cabe inteira, centralizada, com barras onde sobra.
  // Esticar seria mais simples e deixaria círculos ovais na tela do outro.
  const double prop_quadro = static_cast<double>(largura) / altura;
  const double prop_janela = static_cast<double>(largura_janela_) / altura_janela_;
  float ex = 1.0f, ey = 1.0f;
  if (prop_janela > prop_quadro) {
    ex = static_cast<float>(prop_quadro / prop_janela);
  } else {
    ey = static_cast<float>(prop_janela / prop_quadro);
  }

  if (SUCCEEDED(contexto_->Map(constantes_, 0, D3D11_MAP_WRITE_DISCARD, 0, &m))) {
    Ajuste a{};
    a.escala[0] = ex;
    a.escala[1] = ey;
    memcpy(m.pData, &a, sizeof(a));
    contexto_->Unmap(constantes_, 0);
  }

  D3D11_VIEWPORT vp{};
  vp.Width = static_cast<float>(largura_janela_);
  vp.Height = static_cast<float>(altura_janela_);
  vp.MaxDepth = 1.0f;
  contexto_->RSSetViewports(1, &vp);

  const float fundo[4] = {0.0f, 0.0f, 0.0f, 1.0f};
  contexto_->ClearRenderTargetView(alvo_, fundo);
  contexto_->OMSetRenderTargets(1, &alvo_, nullptr);
  contexto_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  contexto_->VSSetShader(vertice_, nullptr, 0);
  contexto_->VSSetConstantBuffers(0, 1, &constantes_);
  contexto_->PSSetShader(fragmento_, nullptr, 0);
  ID3D11ShaderResourceView* vistas[2] = {vista_y_, vista_uv_};
  contexto_->PSSetShaderResources(0, 2, vistas);
  contexto_->PSSetSamplers(0, 1, &amostrador_);
  contexto_->Draw(3, 0);

  // Present(0): sem esperar o monitor.
  //
  // Esperar sincroniza com os 60 Hz da tela e acrescenta até 16 ms de atraso ao
  // que já veio pela rede. Num vídeo isso é bom (evita rasgo); numa sessão
  // remota é meio quadro de atraso a mais em cima do ponteiro de alguém.
  const HRESULT hr = cadeia_->Present(0, 0);
  if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET) {
    if (erro) *erro = "a placa de video reiniciou";
    return false;
  }
  return true;
}

}  // namespace ryke
