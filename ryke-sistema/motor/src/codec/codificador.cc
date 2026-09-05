#include "codec/codificador.h"

#include "base/log.h"
#include "codec/mf.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <codecapi.h>
// ICodecAPI mora aqui, e nao em codecapi.h — la ficam so os GUIDs.
#include <icodecapi.h>
#include <wrl/client.h>

#include <cstring>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "ole32.lib")

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

// Escreve um parâmetro do ICodecAPI, tolerando que o codificador não o conheça.
//
// Cada fabricante suporta um subconjunto diferente, e um parâmetro recusado
// quase nunca é motivo para desistir — só significa que aquele detalhe fica no
// padrão do fabricante. Desistir aqui deixaria o programa sem codificador em
// máquinas perfeitamente boas.
void TentarParametro(ComPtr<IMFTransform>& mft, const GUID& qual, VARIANT valor, const char* nome) {
  ComPtr<ICodecAPI> api;
  if (FAILED(mft.As(&api))) return;
  const HRESULT hr = api->SetValue(&qual, &valor);
  if (FAILED(hr)) RY_DETALHE("codificador: %s nao aceito (%s)", nome, TextoDoHResult(hr).c_str());
}

VARIANT VarU32(uint32_t v) {
  VARIANT x;
  VariantInit(&x);
  x.vt = VT_UI4;
  x.ulVal = v;
  return x;
}

VARIANT VarBool(bool v) {
  VARIANT x;
  VariantInit(&x);
  x.vt = VT_BOOL;
  x.boolVal = v ? VARIANT_TRUE : VARIANT_FALSE;
  return x;
}

}  // namespace

Codificador::~Codificador() { Parar(); }

void Codificador::Parar() {
  if (mft_) {
    mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    mft_->Release();
    mft_ = nullptr;
  }
  if (eventos_) {
    eventos_->Release();
    eventos_ = nullptr;
  }
  cabecalho_.clear();
}

bool Codificador::EscolherCodificador(std::string* erro) {
  MFT_REGISTER_TYPE_INFO saida{};
  saida.guidMajorType = MFMediaType_Video;
  saida.guidSubtype = MFVideoFormat_H264;

  // Hardware PRIMEIRO. Se não houver nenhum, cai para software — melhor uma
  // sessão que gasta processador do que sessão nenhuma, e há máquinas (virtuais,
  // servidores) que simplesmente não têm codificador na placa.
  for (int tentativa = 0; tentativa < 2; tentativa++) {
    const UINT32 flags = MFT_ENUM_FLAG_SORTANDFILTER |
                         (tentativa == 0 ? MFT_ENUM_FLAG_HARDWARE : MFT_ENUM_FLAG_SYNCMFT) |
                         MFT_ENUM_FLAG_ASYNCMFT;
    IMFActivate** ativos = nullptr;
    UINT32 quantos = 0;
    const HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags, nullptr, &saida, &ativos, &quantos);
    if (FAILED(hr) || quantos == 0) {
      if (ativos) CoTaskMemFree(ativos);
      continue;
    }

    for (UINT32 i = 0; i < quantos; i++) {
      IMFTransform* mft = nullptr;
      if (SUCCEEDED(ativos[i]->ActivateObject(IID_PPV_ARGS(&mft))) && mft) {
        wchar_t* nome = nullptr;
        UINT32 n = 0;
        ativos[i]->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &nome, &n);
        nome_ = DoWide(nome);
        if (nome) CoTaskMemFree(nome);
        por_hardware_ = (tentativa == 0);
        mft_ = mft;
        break;
      }
    }
    for (UINT32 i = 0; i < quantos; i++) ativos[i]->Release();
    CoTaskMemFree(ativos);
    if (mft_) return true;
  }

  if (erro) *erro = "nenhum codificador H.264 disponivel nesta maquina";
  return false;
}

bool Codificador::ConfigurarTipos(std::string* erro) {
  ComPtr<IMFTransform> mft(mft_);

  // Um MFT assíncrono precisa ser destravado ANTES de qualquer configuração —
  // sem isto ele recusa os tipos com um erro que não diz o motivo.
  ComPtr<IMFAttributes> atributos;
  if (SUCCEEDED(mft->GetAttributes(&atributos)) && atributos) {
    UINT32 e_assincrono = 0;
    atributos->GetUINT32(MF_TRANSFORM_ASYNC, &e_assincrono);
    assincrono_ = e_assincrono != 0;
    if (assincrono_) atributos->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE);
    // Deixa o codificador entregar quadros de baixa latência quando ele souber.
    atributos->SetUINT32(MF_LOW_LATENCY, TRUE);
  }

  DWORD entradas = 0, saidas = 0;
  if (Falhou(mft->GetStreamCount(&entradas, &saidas), "GetStreamCount", erro)) return false;
  DWORD id_entrada = 0, id_saida = 0;
  if (FAILED(mft->GetStreamIDs(1, &id_entrada, 1, &id_saida))) {
    id_entrada = 0;
    id_saida = 0;
  }
  fluxo_entrada_ = id_entrada;
  fluxo_saida_ = id_saida;

  // A SAÍDA vem primeiro. É contraintuitivo e é obrigatório: o codificador só
  // sabe quais entradas aceita depois de saber o que precisa produzir.
  ComPtr<IMFMediaType> tipo_saida;
  if (Falhou(MFCreateMediaType(&tipo_saida), "MFCreateMediaType(saida)", erro)) return false;
  tipo_saida->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  tipo_saida->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
  tipo_saida->SetUINT32(MF_MT_AVG_BITRATE, bps_);
  MFSetAttributeSize(tipo_saida.Get(), MF_MT_FRAME_SIZE, largura_, altura_);
  MFSetAttributeRatio(tipo_saida.Get(), MF_MT_FRAME_RATE, fps_, 1);
  MFSetAttributeRatio(tipo_saida.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  tipo_saida->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  // O perfil Main basta e é o mais bem aceito. O High rende uns poucos por
  // cento e há decodificadores por hardware que o recusam — trocar compatível
  // por 3% de tamanho é mau negócio num programa que precisa rodar em tudo.
  tipo_saida->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main);
  if (Falhou(mft->SetOutputType(fluxo_saida_, tipo_saida.Get(), 0), "SetOutputType", erro)) return false;

  ComPtr<IMFMediaType> tipo_entrada;
  if (Falhou(MFCreateMediaType(&tipo_entrada), "MFCreateMediaType(entrada)", erro)) return false;
  tipo_entrada->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  tipo_entrada->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  MFSetAttributeSize(tipo_entrada.Get(), MF_MT_FRAME_SIZE, largura_, altura_);
  MFSetAttributeRatio(tipo_entrada.Get(), MF_MT_FRAME_RATE, fps_, 1);
  MFSetAttributeRatio(tipo_entrada.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  tipo_entrada->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  if (Falhou(mft->SetInputType(fluxo_entrada_, tipo_entrada.Get(), 0), "SetInputType", erro)) return false;

  return true;
}

bool Codificador::ConfigurarParametros(std::string*) {
  ComPtr<IMFTransform> mft(mft_);

  // ESTE é o ajuste que define o produto. Ver o cabeçalho do .h.
  TentarParametro(mft, CODECAPI_AVLowLatencyMode, VarBool(true), "AVLowLatencyMode");
  // Taxa constante: numa sessão remota o que não pode variar é o ATRASO, e
  // taxa variável troca atraso por qualidade exatamente nas horas erradas —
  // quando a tela muda muito, que é quando a pessoa está trabalhando.
  TentarParametro(mft, CODECAPI_AVEncCommonRateControlMode,
                  VarU32(eAVEncCommonRateControlMode_CBR), "RateControlMode");
  TentarParametro(mft, CODECAPI_AVEncCommonMeanBitRate, VarU32(bps_), "MeanBitRate");
  // Zero quadros B: um quadro B só sai depois do quadro seguinte existir.
  TentarParametro(mft, CODECAPI_AVEncMPVDefaultBPictureCount, VarU32(0), "BPictureCount");
  // Uma referência só: mais referências rendem pouco e custam memória e atraso.
  TentarParametro(mft, CODECAPI_AVEncVideoEncodeQP, VarU32(26), "EncodeQP");
  TentarParametro(mft, CODECAPI_AVEncCommonQualityVsSpeed, VarU32(33), "QualityVsSpeed");
  // Intervalo de quadro-chave LONGO de propósito: quadro-chave é caro (dez a
  // vinte vezes um quadro comum) e, com retransmissão no transporte, ele deixa
  // de ser a única forma de se recuperar de uma perda. Quando fizer falta, o
  // outro lado pede — e aí ele sai na hora.
  TentarParametro(mft, CODECAPI_AVEncMPVGOPSize, VarU32(fps_ * 10), "GOPSize");
  return true;
}

bool Codificador::Iniciar(uint32_t largura, uint32_t altura, uint32_t fps, uint32_t bps,
                          std::string* erro) {
  Parar();
  if (!GarantirMediaFoundation()) {
    if (erro) *erro = "MFStartup falhou";
    return false;
  }
  largura_ = largura;
  altura_ = altura;
  fps_ = fps ? fps : 60;
  bps_ = bps ? bps : 8000000;

  if (!EscolherCodificador(erro)) return false;
  if (!ConfigurarTipos(erro)) {
    Parar();
    return false;
  }
  ConfigurarParametros(erro);

  if (assincrono_) {
    if (FAILED(mft_->QueryInterface(IID_PPV_ARGS(&eventos_)))) {
      if (erro) *erro = "o codificador e assincrono mas nao entrega eventos";
      Parar();
      return false;
    }
  }

  mft_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
  mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
  mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

  RY_INFO("codificador: %s (%s) %ux%u @%u, %u kb/s", nome_.c_str(),
          por_hardware_ ? "hardware" : "software", largura_, altura_, fps_, bps_ / 1000);
  return true;
}

bool Codificador::DefinirBitrate(uint32_t bps) {
  if (!mft_ || bps == 0) return false;
  if (bps == bps_) return true;
  bps_ = bps;
  ComPtr<IMFTransform> mft(mft_);
  TentarParametro(mft, CODECAPI_AVEncCommonMeanBitRate, VarU32(bps_), "MeanBitRate");
  return true;
}

int Codificador::RecolherUma(std::vector<PacoteCodificado>* saida, std::string* erro) {
  MFT_OUTPUT_STREAM_INFO info{};
  mft_->GetOutputStreamInfo(fluxo_saida_, &info);

  MFT_OUTPUT_DATA_BUFFER buf{};
  buf.dwStreamID = fluxo_saida_;

  ComPtr<IMFSample> amostra;
  ComPtr<IMFMediaBuffer> memoria;
  const bool eu_alocando =
      (info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) == 0;
  if (eu_alocando) {
    if (FAILED(MFCreateSample(&amostra))) return -1;
    if (FAILED(MFCreateMemoryBuffer(info.cbSize ? info.cbSize : (1u << 20), &memoria))) return -1;
    amostra->AddBuffer(memoria.Get());
    buf.pSample = amostra.Get();
  }

  DWORD estado = 0;
  const HRESULT hr = mft_->ProcessOutput(0, 1, &buf, &estado);
  if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
    if (buf.pEvents) buf.pEvents->Release();
    return 0;
  }
  if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
    // O codificador mudou o formato de saída por conta própria. Aceitar o novo
    // tipo e seguir é obrigatório: recusar trava o fluxo para sempre.
    ComPtr<IMFMediaType> novo_tipo;
    if (SUCCEEDED(mft_->GetOutputAvailableType(fluxo_saida_, 0, &novo_tipo))) {
      mft_->SetOutputType(fluxo_saida_, novo_tipo.Get(), 0);
    }
    if (buf.pEvents) buf.pEvents->Release();
    return 0;
  }
  if (Falhou(hr, "ProcessOutput", erro)) {
    if (buf.pEvents) buf.pEvents->Release();
    return -1;
  }

  int quantos = 0;
  IMFSample* pronta = buf.pSample;
  if (pronta) {
    ComPtr<IMFMediaBuffer> junto;
    if (SUCCEEDED(pronta->ConvertToContiguousBuffer(&junto))) {
      BYTE* p = nullptr;
      DWORD comprimento = 0;
      if (SUCCEEDED(junto->Lock(&p, nullptr, &comprimento)) && comprimento > 0) {
        PacoteCodificado pc;
        UINT32 e_chave = 0;
        pronta->GetUINT32(MFSampleExtension_CleanPoint, &e_chave);
        pc.chave = e_chave != 0;
        LONGLONG tempo = 0;
        pronta->GetSampleTime(&tempo);
        pc.tempo_us = static_cast<uint64_t>(tempo / 10);  // 100ns → us

        if (pc.chave) {
          // Todo quadro-chave sai com SPS/PPS na frente. Sem isso, quem entrar
          // no meio da sessão — ou quem se perdeu e pediu chave — não consegue
          // começar a decodificar.
          pc.dados.insert(pc.dados.end(), cabecalho_.begin(), cabecalho_.end());
        }
        pc.dados.insert(pc.dados.end(), p, p + comprimento);
        junto->Unlock();
        saida->push_back(std::move(pc));
        quantos = 1;
      }
    }
    if (!eu_alocando) pronta->Release();
  }
  if (buf.pEvents) buf.pEvents->Release();
  return quantos;
}

bool Codificador::RecolherSaida(std::vector<PacoteCodificado>* saida, std::string* erro) {
  // Só para o MFT síncrono: ali perguntar até ouvir "preciso de mais entrada"
  // é o protocolo. No assíncrono quem manda é o evento — ver RecolherUma.
  for (int guarda = 0; guarda < 64; guarda++) {
    const int r = RecolherUma(saida, erro);
    if (r < 0) return false;
    if (r == 0) return true;
  }
  return true;
}

bool Codificador::Codificar(const uint8_t* nv12, size_t tamanho, uint64_t tempo_us,
                            std::vector<PacoteCodificado>* saida, std::string* erro) {
  if (!mft_) {
    if (erro) *erro = "codificador parado";
    return false;
  }

  // Guarda o SPS/PPS na primeira oportunidade. Ele vive no tipo de saída, e só
  // existe depois de o codificador ter aceitado a configuração.
  if (cabecalho_.empty()) {
    ComPtr<IMFMediaType> tipo;
    if (SUCCEEDED(mft_->GetOutputCurrentType(fluxo_saida_, &tipo)) && tipo) {
      UINT32 n = 0;
      if (SUCCEEDED(tipo->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &n)) && n > 0) {
        cabecalho_.resize(n);
        tipo->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, cabecalho_.data(), n, &n);
      }
    }
  }

  ComPtr<IMFMediaBuffer> memoria;
  if (Falhou(MFCreateMemoryBuffer(static_cast<DWORD>(tamanho), &memoria), "MFCreateMemoryBuffer", erro))
    return false;
  BYTE* destino = nullptr;
  if (Falhou(memoria->Lock(&destino, nullptr, nullptr), "Lock", erro)) return false;
  memcpy(destino, nv12, tamanho);
  memoria->Unlock();
  memoria->SetCurrentLength(static_cast<DWORD>(tamanho));

  ComPtr<IMFSample> amostra;
  if (Falhou(MFCreateSample(&amostra), "MFCreateSample", erro)) return false;
  amostra->AddBuffer(memoria.Get());
  amostra->SetSampleTime(static_cast<LONGLONG>(tempo_us) * 10);
  amostra->SetSampleDuration(10000000LL / fps_);
  if (forcar_chave_) {
    amostra->SetUINT32(MFSampleExtension_CleanPoint, TRUE);
    ComPtr<IMFTransform> mft(mft_);
    TentarParametro(mft, CODECAPI_AVEncVideoForceKeyFrame, VarU32(1), "ForceKeyFrame");
    forcar_chave_ = false;
  }

  if (assincrono_) {
    // MFT assíncrono: ele avisa quando quer entrada e quando tem saída. Sem
    // respeitar isso, o ProcessInput devolve E_NOTACCEPTING e o quadro some.
    bool entregue = false;
    for (int voltas = 0; voltas < 64 && eventos_; voltas++) {
      ComPtr<IMFMediaEvent> evento;
      const HRESULT hr = eventos_->GetEvent(entregue ? MF_EVENT_FLAG_NO_WAIT : 0, &evento);
      if (hr == MF_E_NO_EVENTS_AVAILABLE) break;
      if (FAILED(hr)) break;
      MediaEventType tipo = MEUnknown;
      evento->GetType(&tipo);
      if (tipo == METransformNeedInput && !entregue) {
        if (Falhou(mft_->ProcessInput(fluxo_entrada_, amostra.Get(), 0), "ProcessInput", erro))
          return false;
        entregue = true;
      } else if (tipo == METransformHaveOutput) {
        // UMA vez por evento. Ver RecolherUma.
        if (RecolherUma(saida, erro) < 0) return false;
      }
    }
    return true;
  }

  const HRESULT hr = mft_->ProcessInput(fluxo_entrada_, amostra.Get(), 0);
  if (hr == MF_E_NOTACCEPTING) {
    // Ele ainda não digeriu o anterior: recolhe e tenta de novo uma vez.
    if (!RecolherSaida(saida, erro)) return false;
    if (Falhou(mft_->ProcessInput(fluxo_entrada_, amostra.Get(), 0), "ProcessInput", erro)) return false;
  } else if (Falhou(hr, "ProcessInput", erro)) {
    return false;
  }
  return RecolherSaida(saida, erro);
}

}  // namespace ryke
