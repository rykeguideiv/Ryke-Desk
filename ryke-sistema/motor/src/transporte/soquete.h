// UDP, com o mínimo de cerimônia.
//
// Um envelope fino em volta do Winsock: abrir, mandar, receber com prazo,
// fechar. Existe para o resto do transporte não ficar salpicado de WSAStartup e
// sockaddr_in — e para o teste conseguir trocar isto por um cano de mentira que
// perde pacotes de propósito, que é como se prova recuperação de perda sem
// depender da sorte da rede.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ryke {

struct Endereco {
  uint32_t ipv4 = 0;  // ordem do host
  uint16_t porta = 0;

  bool operator==(const Endereco& o) const { return ipv4 == o.ipv4 && porta == o.porta; }
  bool operator!=(const Endereco& o) const { return !(*this == o); }
  std::string Texto() const;
  bool Vazio() const { return ipv4 == 0 && porta == 0; }
};

// "1.2.3.4:5900" → Endereco. Aceita nome de máquina também.
bool ResolverEndereco(const std::string& texto, Endereco* saida, std::string* erro);

class Soquete {
 public:
  Soquete() = default;
  ~Soquete();
  Soquete(const Soquete&) = delete;
  Soquete& operator=(const Soquete&) = delete;

  // porta 0 = o sistema escolhe uma livre.
  bool Abrir(uint16_t porta, std::string* erro);
  void Fechar();
  bool Aberto() const;

  uint16_t PortaLocal() const { return porta_local_; }

  bool Enviar(const Endereco& destino, const uint8_t* dados, size_t tamanho, std::string* erro);

  // Espera até `prazo_ms` por um datagrama. Devolve:
  //   >0  bytes recebidos (em `buffer`, com `de` preenchido)
  //    0  o prazo acabou sem nada
  //   -1  erro (em `erro`)
  int Receber(std::vector<uint8_t>* buffer, Endereco* de, uint32_t prazo_ms, std::string* erro);

  // Quantos bytes o sistema guarda enquanto não lemos. Um buffer pequeno é a
  // causa clássica de "perde pacote em rajada mesmo na rede local": a rajada de
  // um quadro-chave chega toda de uma vez e o sistema descarta o que não coube.
  bool DefinirBufferDeRecepcao(int bytes);
  bool DefinirBufferDeEnvio(int bytes);

  // SÓ PARA TESTE: joga fora, na saída, esta fração dos datagramas.
  //
  // Existe porque recuperação de perda não se prova esperando a rede falhar na
  // hora do teste. Numa rede local o número é zero, e um transporte que só foi
  // exercitado com zero por cento de perda é um transporte que ninguém sabe se
  // funciona — foi exatamente assim que o arrasto quebrou no aplicativo atual.
  //
  // Em produção fica em 0 e o `if` some no desvio previsto do processador.
  void DefinirPerdaDeTeste(double fracao) { perda_de_teste_ = fracao; }

 private:
  uintptr_t s_ = ~static_cast<uintptr_t>(0);  // INVALID_SOCKET
  uint16_t porta_local_ = 0;
  double perda_de_teste_ = 0.0;
  uint64_t semente_ = 0x9E3779B97F4A7C15ull;
};

}  // namespace ryke
