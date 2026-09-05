// Cifra do fio: ECDH P-256 para combinar a chave, AES-256-GCM para cada pacote.
//
// POR QUE ESCREVER ISTO EM VEZ DE MANDAR EM CLARO
//
// Um protocolo de acesso remoto carrega a tela e o teclado de alguém. Em claro,
// qualquer máquina no caminho lê a senha que a pessoa digita. Não existe versão
// "de teste" aceitável disso: quem escreve o transporte sem cifra hoje entrega
// amanhã, porque funciona.
//
// POR QUE CNG (bcrypt.dll), E NÃO OpenSSL
//
// É o que já está no Windows: nada para compilar, nada para atualizar, e as
// implementações são as mesmas que o sistema usa para TLS. Trazer OpenSSL só
// para isto acrescentaria 3 MB e uma esteira de atualizações de segurança que
// alguém tem de acompanhar para sempre.
//
// O QUE ISTO NÃO É
//
// Não é autenticação. ECDH sem assinatura combina uma chave secreta com QUEM
// estiver do outro lado — inclusive alguém no meio do caminho. O `Fio` fecha
// esse buraco com um segredo combinado fora da rede (a senha da sessão), que
// entra na derivação da chave: sem a senha certa, a chave sai diferente e o
// primeiro pacote não abre. Ver `DerivarSegredo`.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ryke {

// Um par efêmero de chaves ECDH P-256, sorteado por sessão.
class ParDeChaves {
 public:
  ParDeChaves() = default;
  ~ParDeChaves();
  ParDeChaves(const ParDeChaves&) = delete;
  ParDeChaves& operator=(const ParDeChaves&) = delete;

  bool Gerar(std::string* erro);

  // A parte pública, no formato bruto de 64 bytes (X || Y).
  const std::vector<uint8_t>& Publica() const { return publica_; }

  // Combina com a pública do outro lado e devolve o segredo compartilhado.
  bool Combinar(const std::vector<uint8_t>& publica_do_outro,
                std::vector<uint8_t>* segredo,
                std::string* erro) const;

 private:
  void* chave_ = nullptr;  // BCRYPT_KEY_HANDLE
  std::vector<uint8_t> publica_;
};

// Deriva as duas chaves de sessão (uma por sentido) a partir do segredo ECDH,
// dos dois nonces e da SENHA combinada fora da rede.
//
// Duas chaves, e não uma: usar a mesma chave nos dois sentidos com um contador
// de nonce por lado faria os dois lados repetirem o par (chave, nonce) — e num
// modo GCM repetir esse par é o erro que revela o texto claro. Cada sentido tem
// a sua.
bool DerivarSegredo(const std::vector<uint8_t>& segredo_ecdh,
                    const std::vector<uint8_t>& nonce_a,
                    const std::vector<uint8_t>& nonce_b,
                    const std::string& senha,
                    std::vector<uint8_t>* chave_ida,
                    std::vector<uint8_t>* chave_volta,
                    std::string* erro);

// AES-256-GCM num sentido só.
class Cifra {
 public:
  Cifra() = default;
  ~Cifra();
  Cifra(const Cifra&) = delete;
  Cifra& operator=(const Cifra&) = delete;

  bool Abrir(const std::vector<uint8_t>& chave, std::string* erro);
  bool Pronta() const { return chave_ != nullptr; }

  // Cifra `claro` e acrescenta o selo de 16 bytes ao fim de `saida`.
  // `cabecalho` entra como dado autenticado: não é cifrado, mas mexer nele
  // invalida o pacote.
  bool Selar(uint64_t nonce, const uint8_t* cabecalho, size_t cabecalho_len,
             const uint8_t* claro, size_t claro_len, std::vector<uint8_t>* saida,
             std::string* erro) const;

  // Confere o selo e decifra. Devolve false se qualquer bit tiver mudado.
  bool Abrir(uint64_t nonce, const uint8_t* cabecalho, size_t cabecalho_len,
             const uint8_t* cifrado, size_t cifrado_len, std::vector<uint8_t>* saida,
             std::string* erro) const;

 private:
  void* chave_ = nullptr;  // BCRYPT_KEY_HANDLE
};

// Bytes aleatórios de verdade (o gerador do sistema).
bool Sortear(uint8_t* destino, size_t quantos);
std::vector<uint8_t> Sortear(size_t quantos);

/**
 * Guarda os nonces já vistos e recusa repetição.
 *
 * Sem isto, quem grava um pacote pode reenviá-lo depois — e um pacote de
 * ENTRADA reenviado é um clique que acontece de novo, na hora que o atacante
 * escolher. A janela é deslizante: aceita fora de ordem (o UDP entrega assim),
 * mas nunca duas vezes o mesmo.
 */
class AntiRepeticao {
 public:
  // false = já vimos este, ou é velho demais para provar que não vimos.
  bool Aceitar(uint64_t nonce);

 private:
  static constexpr int kJanela = 1024;
  uint64_t maior_ = 0;
  bool comecou_ = false;
  // Bitmap dos `kJanela` nonces terminando em `maior_`.
  uint64_t vistos_[kJanela / 64] = {};
};

}  // namespace ryke
