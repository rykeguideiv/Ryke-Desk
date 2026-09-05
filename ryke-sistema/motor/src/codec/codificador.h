// H.264 pela placa de vídeo, via Media Foundation.
//
// POR QUE NÃO x264, POR QUE NÃO O CODIFICADOR DO CHROMIUM
//
// O codificador por software gasta processador que a máquina do usuário está
// usando para trabalhar — e é ele que a pessoa está vendo pela sessão. Todo
// núcleo gasto comprimindo é um núcleo a menos para o que ela está fazendo. As
// placas de vídeo de hoje (NVENC da NVIDIA, Quick Sync da Intel, VCE da AMD)
// codificam 1080p60 sem tirar o processador do lugar, e o Windows expõe as três
// pela mesma porta: um MFT de hardware.
//
// O Chromium também usa esse caminho — quando consegue. O que ele não faz é
// funcionar quando o processo está elevado, e é o motivo de este projeto
// existir.
//
// O QUE "BAIXA LATÊNCIA" MUDA AQUI, E POR QUE É O AJUSTE MAIS IMPORTANTE
//
// Um codificador de vídeo comum trabalha com um punhado de quadros na mão: ele
// olha o futuro para comprimir melhor o presente (são os quadros B). Isso rende
// arquivo menor e ATRASO — o quadro só sai depois que os seguintes chegaram.
// Para assistir a um filme, ótimo. Para mexer um mouse, é o defeito inteiro.
//
// Então: `CODECAPI_AVLowLatencyMode` ligado, zero quadros B, e uma fila de
// referência de um quadro só. Custa alguns por cento de tamanho e devolve
// dezenas de milissegundos.

#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

struct IMFTransform;
struct IMFMediaEventGenerator;

namespace ryke {

struct PacoteCodificado {
  std::vector<uint8_t> dados;
  bool chave = false;
  uint64_t tempo_us = 0;
};

class Codificador {
 public:
  Codificador() = default;
  ~Codificador();
  Codificador(const Codificador&) = delete;
  Codificador& operator=(const Codificador&) = delete;

  bool Iniciar(uint32_t largura, uint32_t altura, uint32_t quadros_por_segundo, uint32_t bits_por_segundo,
               std::string* erro);
  void Parar();
  bool Ativo() const { return mft_ != nullptr; }

  // O nome do codificador que o Windows escolheu, e se ele é de hardware.
  const std::string& Nome() const { return nome_; }
  bool PorHardware() const { return por_hardware_; }

  // Muda o alvo de bits por segundo sem reiniciar. Chamado pelo controle de
  // ritmo do transporte a cada segundo.
  bool DefinirBitrate(uint32_t bits_por_segundo);

  // O próximo quadro sai como quadro-chave, custe o que custar. É a resposta ao
  // pedido do outro lado quando a decodificação dele se perdeu.
  void ForcarQuadroChave() { forcar_chave_ = true; }

  // Entrega um quadro em NV12 e recolhe o que sair. Pode sair nada (o
  // codificador ainda está enchendo a fila) ou mais de um pacote.
  bool Codificar(const uint8_t* nv12, size_t tamanho, uint64_t tempo_us,
                 std::vector<PacoteCodificado>* saida, std::string* erro);

 private:
  bool EscolherCodificador(std::string* erro);
  bool ConfigurarTipos(std::string* erro);
  bool ConfigurarParametros(std::string* erro);
  // Um ProcessOutput, e so um. Num MFT ASSINCRONO cada quadro pronto vem
  // anunciado por um evento METransformHaveOutput, e chamar ProcessOutput uma
  // segunda vez sem o evento correspondente devolve E_UNEXPECTED — foi o que
  // aconteceu: 180 quadros entraram e nenhum saiu, com "falha catastrofica"
  // no lugar de uma explicacao.
  // Devolve: 1 saiu algo, 0 nao ha nada agora, -1 erro.
  int RecolherUma(std::vector<PacoteCodificado>* saida, std::string* erro);
  // O laco do MFT SINCRONO, onde perguntar de novo e o jeito certo.
  bool RecolherSaida(std::vector<PacoteCodificado>* saida, std::string* erro);

  IMFTransform* mft_ = nullptr;
  IMFMediaEventGenerator* eventos_ = nullptr;  // só quando o MFT é assíncrono
  bool assincrono_ = false;
  bool por_hardware_ = false;
  std::string nome_;

  uint32_t largura_ = 0;
  uint32_t altura_ = 0;
  uint32_t fps_ = 60;
  uint32_t bps_ = 8000000;
  uint32_t fluxo_entrada_ = 0;
  uint32_t fluxo_saida_ = 0;
  bool forcar_chave_ = false;
  // Fora do quadro-chave a saída é um pedaço de fluxo H.264 sem cabeçalho: o
  // decodificador precisa do SPS/PPS antes do primeiro quadro. Guardamos e
  // grudamos em todo quadro-chave, para quem entrar no meio conseguir começar.
  std::vector<uint8_t> cabecalho_;
};

}  // namespace ryke
