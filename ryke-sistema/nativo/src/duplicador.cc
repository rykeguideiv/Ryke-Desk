#include "duplicador.h"

#include <sstream>

using Microsoft::WRL::ComPtr;

namespace ryke {
namespace {

std::string ComErro(const char* onde, HRESULT hr) {
  std::ostringstream os;
  os << onde << " falhou (HRESULT 0x" << std::hex << static_cast<unsigned>(hr) << ")";
  return os.str();
}

}  // namespace

Duplicador::~Duplicador() { Parar(); }

bool Duplicador::Iniciar(uint32_t indice_saida, std::string* erro) {
  Parar();
  indice_saida_ = indice_saida;

  // BGRA_SUPPORT porque e nesse formato que a Desktop Duplication entrega, e
  // pedir o mesmo formato evita uma conversao no meio do caminho.
  const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  const D3D_FEATURE_LEVEL niveis[] = {
      D3D_FEATURE_LEVEL_11_0,
      D3D_FEATURE_LEVEL_10_1,
      D3D_FEATURE_LEVEL_10_0,
  };
  D3D_FEATURE_LEVEL obtido{};
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, niveis,
                                 ARRAYSIZE(niveis), D3D11_SDK_VERSION, &dispositivo_, &obtido, &contexto_);
  if (FAILED(hr)) {
    *erro = ComErro("D3D11CreateDevice", hr);
    return false;
  }

  ComPtr<IDXGIDevice> dxgi_dispositivo;
  hr = dispositivo_.As(&dxgi_dispositivo);
  if (FAILED(hr)) {
    *erro = ComErro("ID3D11Device->IDXGIDevice", hr);
    return false;
  }

  ComPtr<IDXGIAdapter> adaptador;
  hr = dxgi_dispositivo->GetAdapter(&adaptador);
  if (FAILED(hr)) {
    *erro = ComErro("IDXGIDevice::GetAdapter", hr);
    return false;
  }

  ComPtr<IDXGIOutput> saida;
  hr = adaptador->EnumOutputs(indice_saida_, &saida);
  if (FAILED(hr)) {
    *erro = ComErro("IDXGIAdapter::EnumOutputs", hr);
    return false;
  }

  ComPtr<IDXGIOutput1> saida1;
  hr = saida.As(&saida1);
  if (FAILED(hr)) {
    *erro = ComErro("IDXGIOutput->IDXGIOutput1", hr);
    return false;
  }

  // O ponto exato onde a arquitetura toda se justifica: sem privilegio de
  // Local System, e com a area protegida do UAC na frente, esta chamada
  // devolve E_ACCESSDENIED. Rodando como SISTEMA, ela passa.
  hr = saida1->DuplicateOutput(dispositivo_.Get(), &duplicacao_);
  if (FAILED(hr)) {
    if (hr == E_ACCESSDENIED) {
      *erro =
          "DuplicateOutput negou acesso (E_ACCESSDENIED) — sem privilegio de "
          "SISTEMA nao se captura a area protegida";
    } else if (hr == DXGI_ERROR_UNSUPPORTED) {
      // Acontece em maquinas com placa hibrida quando o monitor esta ligado na
      // outra GPU. Nao e falta de privilegio.
      *erro = "DuplicateOutput nao e suportado nesta saida de video";
    } else {
      *erro = ComErro("IDXGIOutput1::DuplicateOutput", hr);
    }
    duplicacao_.Reset();
    return false;
  }

  DXGI_OUTDUPL_DESC desc{};
  duplicacao_->GetDesc(&desc);
  largura_ = desc.ModeDesc.Width;
  altura_ = desc.ModeDesc.Height;
  return true;
}

void Duplicador::Parar() {
  if (duplicacao_ && quadro_preso_) {
    duplicacao_->ReleaseFrame();
    quadro_preso_ = false;
  }
  estagio_.Reset();
  duplicacao_.Reset();
  contexto_.Reset();
  dispositivo_.Reset();
  largura_ = 0;
  altura_ = 0;
}

bool Duplicador::GarantirEstagio(uint32_t largura, uint32_t altura, std::string* erro) {
  if (estagio_) {
    D3D11_TEXTURE2D_DESC atual{};
    estagio_->GetDesc(&atual);
    if (atual.Width == largura && atual.Height == altura) return true;
    estagio_.Reset();
  }

  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = largura;
  desc.Height = altura;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  // STAGING + CPU_ACCESS_READ e a unica combinacao que a CPU consegue ler.
  desc.Usage = D3D11_USAGE_STAGING;
  desc.BindFlags = 0;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  desc.MiscFlags = 0;

  HRESULT hr = dispositivo_->CreateTexture2D(&desc, nullptr, &estagio_);
  if (FAILED(hr)) {
    *erro = ComErro("CreateTexture2D (estagio)", hr);
    return false;
  }
  return true;
}

Resultado Duplicador::Proximo(uint32_t timeout_ms,
                              std::vector<uint8_t>* destino,
                              uint32_t* largura,
                              uint32_t* altura,
                              std::string* erro) {
  if (!duplicacao_) {
    *erro = "o duplicador nao esta aberto";
    return Resultado::kErro;
  }

  // Sobrou quadro presa da chamada anterior? Solta antes de pedir o proximo:
  // AcquireNextFrame recusa enquanto houver um quadro nao devolvido.
  if (quadro_preso_) {
    duplicacao_->ReleaseFrame();
    quadro_preso_ = false;
  }

  DXGI_OUTDUPL_FRAME_INFO info{};
  ComPtr<IDXGIResource> recurso;
  HRESULT hr = duplicacao_->AcquireNextFrame(timeout_ms, &info, &recurso);

  if (hr == DXGI_ERROR_WAIT_TIMEOUT) return Resultado::kSemNovidade;
  if (hr == DXGI_ERROR_ACCESS_LOST) return Resultado::kPerdido;
  if (FAILED(hr)) {
    *erro = ComErro("AcquireNextFrame", hr);
    return Resultado::kErro;
  }
  quadro_preso_ = true;

  // LastPresentTime zerado significa que so o cursor mudou de lugar; a imagem
  // e a mesma. Tratamos como "sem novidade" para nao gastar duas copias de
  // tela inteira a cada tremida do mouse.
  if (info.LastPresentTime.QuadPart == 0) {
    duplicacao_->ReleaseFrame();
    quadro_preso_ = false;
    return Resultado::kSemNovidade;
  }

  ComPtr<ID3D11Texture2D> textura;
  hr = recurso.As(&textura);
  if (FAILED(hr)) {
    *erro = ComErro("IDXGIResource->ID3D11Texture2D", hr);
    return Resultado::kErro;
  }

  D3D11_TEXTURE2D_DESC desc{};
  textura->GetDesc(&desc);
  if (!GarantirEstagio(desc.Width, desc.Height, erro)) return Resultado::kErro;

  contexto_->CopyResource(estagio_.Get(), textura.Get());

  D3D11_MAPPED_SUBRESOURCE mapa{};
  hr = contexto_->Map(estagio_.Get(), 0, D3D11_MAP_READ, 0, &mapa);
  if (FAILED(hr)) {
    *erro = ComErro("ID3D11DeviceContext::Map", hr);
    return Resultado::kErro;
  }

  const uint32_t bytes_por_linha = desc.Width * 4;
  destino->resize(static_cast<size_t>(bytes_por_linha) * desc.Height);

  // RowPitch quase nunca e igual a largura*4: a GPU alinha as linhas. Copiar o
  // bloco inteiro de uma vez sairia com a imagem enviesada — o classico
  // "a tela aparece torta" — entao copiamos linha a linha.
  const uint8_t* origem = static_cast<const uint8_t*>(mapa.pData);
  uint8_t* alvo = destino->data();
  for (uint32_t y = 0; y < desc.Height; ++y) {
    memcpy(alvo + static_cast<size_t>(y) * bytes_por_linha,
           origem + static_cast<size_t>(y) * mapa.RowPitch, bytes_por_linha);
  }

  contexto_->Unmap(estagio_.Get(), 0);
  duplicacao_->ReleaseFrame();
  quadro_preso_ = false;

  largura_ = desc.Width;
  altura_ = desc.Height;
  *largura = desc.Width;
  *altura = desc.Height;
  return Resultado::kQuadro;
}

}  // namespace ryke
