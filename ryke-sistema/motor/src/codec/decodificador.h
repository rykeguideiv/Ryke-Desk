// H.264 de volta para pixels, pela placa de vídeo.
//
// O caminho inverso do codificador, e com um detalhe que decide a latência: o
// decodificador também tem fila. Um decodificador comum segura alguns quadros
// para lidar com reordenação (os quadros B). Como o nosso codificador não
// produz quadros B, aqui a fila pode ser zero — e é ela que sobra de atraso
// depois que a rede já foi resolvida.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct IMFTransform;

namespace ryke {

struct QuadroDecodificado {
  std::vector<uint8_t> nv12;
  uint32_t largura = 0;
  uint32_t altura = 0;
  uint64_t tempo_us = 0;
};

class Decodificador {
 public:
  Decodificador() = default;
  ~Decodificador();
  Decodificador(const Decodificador&) = delete;
  Decodificador& operator=(const Decodificador&) = delete;

  bool Iniciar(uint32_t largura, uint32_t altura, std::string* erro);
  void Parar();
  bool Ativo() const { return mft_ != nullptr; }

  const std::string& Nome() const { return nome_; }
  bool PorHardware() const { return por_hardware_; }

  // Joga fora o que estiver na fila. Usado quando um quadro foi abandonado pela
  // rede: seguir decodificando com referência furada produz aquela imagem
  // esverdeada e rasgada que fica na tela até o próximo quadro-chave.
  void Esquecer();

  bool Decodificar(const uint8_t* h264, size_t tamanho, uint64_t tempo_us,
                   std::vector<QuadroDecodificado>* saida, std::string* erro);

 private:
  bool RecolherSaida(std::vector<QuadroDecodificado>* saida, std::string* erro);
  bool AjustarTipoDeSaida(std::string* erro);

  IMFTransform* mft_ = nullptr;
  bool por_hardware_ = false;
  std::string nome_;
  uint32_t largura_ = 0;
  uint32_t altura_ = 0;
  uint32_t fluxo_entrada_ = 0;
  uint32_t fluxo_saida_ = 0;
};

}  // namespace ryke
