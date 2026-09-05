#include "codec/decodificador.h"

#include "base/log.h"
#include "codec/mf.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <codecapi.h>
#include <wrl/client.h>

#include <cstring>

using Microsoft::WRL::ComPtr;

namespace ryke {
namespace {

bool Falhou(HRESULT hr, const char* onde, std::string* erro) {
  if (SUCCEEDED(hr)) return false;
  if (erro) *erro = std::string(onde) + ": " + TextoDoHResult(hr);
  return true;
}

std::string DoWide(const wchar_t* w) {
  if (!w) return "";
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

}  // namespace

Decodificador::~Decodificador() { Parar(); }

void Decodificador::Parar() {
  if (mft_) {
    mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    mft_->Release();
    mft_ = nullptr;
  }
}

void Decodificador::Esquecer() {
  if (mft_) mft_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
}

bool Decodificador::Iniciar(uint32_t largura, uint32_t altura, std::string* erro) {
  Parar();
  // Sem isto, MFTEnumEx devolve zero decodificadores numa maquina que tem
  // varios — e a mensagem de erro culpa a maquina. Ver codec/mf.h.
  if (!GarantirMediaFoundation()) {
    if (erro) *erro = "o Media Foundation nao esta disponivel nesta edicao do Windows";
    return false;
  }
  largura_ = largura;
  altura_ = altura;

  MFT_REGISTER_TYPE_INFO entrada{};
  entrada.guidMajorType = MFMediaType_Video;
  entrada.guidSubtype = MFVideoFormat_H264;

  for (int tentativa = 0; tentativa < 2 && !mft_; tentativa++) {
    const UINT32 flags = MFT_ENUM_FLAG_SORTANDFILTER |
                         (tentativa == 0 ? MFT_ENUM_FLAG_HARDWARE : MFT_ENUM_FLAG_SYNCMFT);
    IMFActivate** ativos = nullptr;
    UINT32 quantos = 0;
    if (FAILED(MFTEnumEx(MFT_CATEGORY_VIDEO_DECODER, flags, &entrada, nullptr, &ativos, &quantos)) ||
        quantos == 0) {
      if (ativos) CoTaskMemFree(ativos);
      continue;
    }
    for (UINT32 i = 0; i < quantos && !mft_; i++) {
      IMFTransform* mft = nullptr;
      if (SUCCEEDED(ativos[i]->ActivateObject(IID_PPV_ARGS(&mft))) && mft) {
        wchar_t* nome = nullptr;
        UINT32 n = 0;
        ativos[i]->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &nome, &n);
        nome_ = DoWide(nome);
        if (nome) CoTaskMemFree(nome);
        por_hardware_ = (tentativa == 0);
        mft_ = mft;
      }
    }
    for (UINT32 i = 0; i < quantos; i++) ativos[i]->Release();
    CoTaskMemFree(ativos);
  }

  if (!mft_) {
    if (erro) *erro = "nenhum decodificador H.264 disponivel";
    return false;
  }

  ComPtr<IMFAttributes> atributos;
  if (SUCCEEDED(mft_->GetAttributes(&atributos)) && atributos) {
    // O ajuste que tira a fila do decodificador. Ver o cabeçalho.
    atributos->SetUINT32(MF_LOW_LATENCY, TRUE);
  }

  ComPtr<IMFMediaType> tipo_entrada;
  if (Falhou(MFCreateMediaType(&tipo_entrada), "MFCreateMediaType", erro)) return false;
  tipo_entrada->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  tipo_entrada->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
  MFSetAttributeSize(tipo_entrada.Get(), MF_MT_FRAME_SIZE, largura_, altura_);
  tipo_entrada->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  if (Falhou(mft_->SetInputType(fluxo_entrada_, tipo_entrada.Get(), 0), "SetInputType", erro)) {
    Parar();
    return false;
  }

  if (!AjustarTipoDeSaida(erro)) {
    Parar();
    return false;
  }

  mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
  mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
  RY_INFO("decodificador: %s (%s)", nome_.c_str(), por_hardware_ ? "hardware" : "software");
  return true;
}

bool Decodificador::AjustarTipoDeSaida(std::string* erro) {
  // Percorre o que o decodificador oferece e fica com NV12. Não dá para
  // simplesmente pedir: cada decodificador oferece uma lista diferente, e o
  // primeiro da lista costuma não ser o que queremos.
  for (DWORD i = 0;; i++) {
    ComPtr<IMFMediaType> tipo;
    const HRESULT hr = mft_->GetOutputAvailableType(fluxo_saida_, i, &tipo);
    if (hr == MF_E_NO_MORE_TYPES) break;
    if (FAILED(hr)) break;
    GUID sub{};
    if (FAILED(tipo->GetGUID(MF_MT_SUBTYPE, &sub))) continue;
    if (sub != MFVideoFormat_NV12) continue;
    if (SUCCEEDED(mft_->SetOutputType(fluxo_saida_, tipo.Get(), 0))) return true;
  }
  if (erro) *erro = "o decodificador nao oferece NV12";
  return false;
}

bool Decodificador::RecolherSaida(std::vector<QuadroDecodificado>* saida, std::string* erro) {
  while (true) {
    MFT_OUTPUT_STREAM_INFO info{};
    mft_->GetOutputStreamInfo(fluxo_saida_, &info);

    MFT_OUTPUT_DATA_BUFFER buf{};
    buf.dwStreamID = fluxo_saida_;
    ComPtr<IMFSample> amostra;
    ComPtr<IMFMediaBuffer> memoria;
    const bool eu_alocando =
        (info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) == 0;
    if (eu_alocando) {
      if (FAILED(MFCreateSample(&amostra))) return false;
      const DWORD tam = info.cbSize ? info.cbSize : (largura_ * altura_ * 3 / 2);
      if (FAILED(MFCreateMemoryBuffer(tam, &memoria))) return false;
      amostra->AddBuffer(memoria.Get());
      buf.pSample = amostra.Get();
    }

    DWORD estado = 0;
    const HRESULT hr = mft_->ProcessOutput(0, 1, &buf, &estado);
    if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) return true;
    if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
      // A resolução do fluxo mudou (ou o decodificador finalmente leu o SPS).
      // Aceitar o tipo novo é obrigatório, senão o fluxo trava aqui.
      if (buf.pEvents) buf.pEvents->Release();
      if (!AjustarTipoDeSaida(erro)) return false;
      continue;
    }
    if (Falhou(hr, "ProcessOutput", erro)) {
      if (buf.pEvents) buf.pEvents->Release();
      return false;
    }

    IMFSample* pronta = buf.pSample;
    if (pronta) {
      ComPtr<IMFMediaType> tipo;
      UINT32 w = largura_, h = altura_;
      if (SUCCEEDED(mft_->GetOutputCurrentType(fluxo_saida_, &tipo)) && tipo) {
        MFGetAttributeSize(tipo.Get(), MF_MT_FRAME_SIZE, &w, &h);
      }
      ComPtr<IMFMediaBuffer> junto;
      if (SUCCEEDED(pronta->ConvertToContiguousBuffer(&junto))) {
        BYTE* p = nullptr;
        DWORD comprimento = 0;
        if (SUCCEEDED(junto->Lock(&p, nullptr, &comprimento)) && comprimento > 0) {
          QuadroDecodificado q;
          q.largura = w;
          q.altura = h;
          LONGLONG t = 0;
          pronta->GetSampleTime(&t);
          q.tempo_us = static_cast<uint64_t>(t / 10);
          q.nv12.assign(p, p + comprimento);
          junto->Unlock();
          saida->push_back(std::move(q));
        }
      }
      if (!eu_alocando) pronta->Release();
    }
    if (buf.pEvents) buf.pEvents->Release();
  }
}

bool Decodificador::Decodificar(const uint8_t* h264, size_t tamanho, uint64_t tempo_us,
                                std::vector<QuadroDecodificado>* saida, std::string* erro) {
  if (!mft_) {
    if (erro) *erro = "decodificador parado";
    return false;
  }

  ComPtr<IMFMediaBuffer> memoria;
  if (Falhou(MFCreateMemoryBuffer(static_cast<DWORD>(tamanho), &memoria), "MFCreateMemoryBuffer", erro))
    return false;
  BYTE* destino = nullptr;
  if (Falhou(memoria->Lock(&destino, nullptr, nullptr), "Lock", erro)) return false;
  memcpy(destino, h264, tamanho);
  memoria->Unlock();
  memoria->SetCurrentLength(static_cast<DWORD>(tamanho));

  ComPtr<IMFSample> amostra;
  if (Falhou(MFCreateSample(&amostra), "MFCreateSample", erro)) return false;
  amostra->AddBuffer(memoria.Get());
  amostra->SetSampleTime(static_cast<LONGLONG>(tempo_us) * 10);

  const HRESULT hr = mft_->ProcessInput(fluxo_entrada_, amostra.Get(), 0);
  if (hr == MF_E_NOTACCEPTING) {
    if (!RecolherSaida(saida, erro)) return false;
    if (Falhou(mft_->ProcessInput(fluxo_entrada_, amostra.Get(), 0), "ProcessInput", erro)) return false;
  } else if (Falhou(hr, "ProcessInput", erro)) {
    return false;
  }
  return RecolherSaida(saida, erro);
}

}  // namespace ryke
