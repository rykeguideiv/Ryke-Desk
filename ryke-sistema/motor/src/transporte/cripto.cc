#include "transporte/cripto.h"

#include "base/log.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>

#include <cstring>

#pragma comment(lib, "bcrypt.lib")

#ifndef NT_SUCCESS
#define NT_SUCCESS(s) (((NTSTATUS)(s)) >= 0)
#endif

namespace ryke {
namespace {

bool Falhou(NTSTATUS s, const char* onde, std::string* erro) {
  if (NT_SUCCESS(s)) return false;
  if (erro) *erro = std::string(onde) + " falhou: " + TextoDoHResult(static_cast<long>(s));
  return true;
}

// O BLOB de chave pública ECDH do CNG: um cabeçalho de 8 bytes e depois X e Y.
struct BlobEcc {
  BCRYPT_ECCKEY_BLOB cabecalho;
  uint8_t xy[64];
};

}  // namespace

ParDeChaves::~ParDeChaves() {
  if (chave_) BCryptDestroyKey(static_cast<BCRYPT_KEY_HANDLE>(chave_));
}

bool ParDeChaves::Gerar(std::string* erro) {
  BCRYPT_ALG_HANDLE alg = nullptr;
  NTSTATUS s = BCryptOpenAlgorithmProvider(&alg, BCRYPT_ECDH_P256_ALGORITHM, nullptr, 0);
  if (Falhou(s, "BCryptOpenAlgorithmProvider(ECDH_P256)", erro)) return false;

  BCRYPT_KEY_HANDLE chave = nullptr;
  s = BCryptGenerateKeyPair(alg, &chave, 256, 0);
  if (Falhou(s, "BCryptGenerateKeyPair", erro)) {
    BCryptCloseAlgorithmProvider(alg, 0);
    return false;
  }
  s = BCryptFinalizeKeyPair(chave, 0);
  if (Falhou(s, "BCryptFinalizeKeyPair", erro)) {
    BCryptDestroyKey(chave);
    BCryptCloseAlgorithmProvider(alg, 0);
    return false;
  }

  BlobEcc blob{};
  ULONG escrito = 0;
  s = BCryptExportKey(chave, nullptr, BCRYPT_ECCPUBLIC_BLOB, reinterpret_cast<PUCHAR>(&blob), sizeof(blob),
                      &escrito, 0);
  BCryptCloseAlgorithmProvider(alg, 0);
  if (Falhou(s, "BCryptExportKey", erro)) {
    BCryptDestroyKey(chave);
    return false;
  }

  publica_.assign(blob.xy, blob.xy + 64);
  chave_ = chave;
  return true;
}

bool ParDeChaves::Combinar(const std::vector<uint8_t>& publica_do_outro,
                           std::vector<uint8_t>* segredo,
                           std::string* erro) const {
  if (!chave_) {
    if (erro) *erro = "par de chaves não foi gerado";
    return false;
  }
  if (publica_do_outro.size() != 64) {
    if (erro) *erro = "chave pública do outro lado com tamanho errado";
    return false;
  }

  BCRYPT_ALG_HANDLE alg = nullptr;
  NTSTATUS s = BCryptOpenAlgorithmProvider(&alg, BCRYPT_ECDH_P256_ALGORITHM, nullptr, 0);
  if (Falhou(s, "BCryptOpenAlgorithmProvider(ECDH_P256)", erro)) return false;

  BlobEcc blob{};
  blob.cabecalho.dwMagic = BCRYPT_ECDH_PUBLIC_P256_MAGIC;
  blob.cabecalho.cbKey = 32;
  memcpy(blob.xy, publica_do_outro.data(), 64);

  BCRYPT_KEY_HANDLE dele = nullptr;
  s = BCryptImportKeyPair(alg, nullptr, BCRYPT_ECCPUBLIC_BLOB, &dele, reinterpret_cast<PUCHAR>(&blob),
                          sizeof(blob), 0);
  BCryptCloseAlgorithmProvider(alg, 0);
  if (Falhou(s, "BCryptImportKeyPair", erro)) return false;

  BCRYPT_SECRET_HANDLE acordo = nullptr;
  s = BCryptSecretAgreement(static_cast<BCRYPT_KEY_HANDLE>(chave_), dele, &acordo, 0);
  if (Falhou(s, "BCryptSecretAgreement", erro)) {
    BCryptDestroyKey(dele);
    return false;
  }

  // Deriva com SHA-256 já aqui: o segredo cru do ECDH é uma coordenada de
  // curva, e usar coordenada crua como chave é um erro clássico (ela não tem
  // distribuição uniforme).
  BCryptBufferDesc params{};
  BCryptBuffer buf[1]{};
  buf[0].BufferType = KDF_HASH_ALGORITHM;
  buf[0].cbBuffer = static_cast<ULONG>((wcslen(BCRYPT_SHA256_ALGORITHM) + 1) * sizeof(wchar_t));
  buf[0].pvBuffer = const_cast<wchar_t*>(BCRYPT_SHA256_ALGORITHM);
  params.ulVersion = BCRYPTBUFFER_VERSION;
  params.cBuffers = 1;
  params.pBuffers = buf;

  ULONG tamanho = 0;
  s = BCryptDeriveKey(acordo, BCRYPT_KDF_HASH, &params, nullptr, 0, &tamanho, 0);
  if (Falhou(s, "BCryptDeriveKey(medida)", erro)) {
    BCryptDestroySecret(acordo);
    BCryptDestroyKey(dele);
    return false;
  }
  segredo->assign(tamanho, 0);
  s = BCryptDeriveKey(acordo, BCRYPT_KDF_HASH, &params, segredo->data(), tamanho, &tamanho, 0);
  segredo->resize(tamanho);

  BCryptDestroySecret(acordo);
  BCryptDestroyKey(dele);
  return !Falhou(s, "BCryptDeriveKey", erro);
}

namespace {

// HMAC-SHA256 sobre `dados` com `chave`.
bool Hmac(const std::vector<uint8_t>& chave, const std::vector<uint8_t>& dados,
          std::vector<uint8_t>* saida, std::string* erro) {
  BCRYPT_ALG_HANDLE alg = nullptr;
  NTSTATUS s = BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr,
                                           BCRYPT_ALG_HANDLE_HMAC_FLAG);
  if (Falhou(s, "BCryptOpenAlgorithmProvider(SHA256/HMAC)", erro)) return false;

  saida->assign(32, 0);
  s = BCryptHash(alg, const_cast<PUCHAR>(chave.data()), static_cast<ULONG>(chave.size()),
                 const_cast<PUCHAR>(dados.data()), static_cast<ULONG>(dados.size()), saida->data(), 32);
  BCryptCloseAlgorithmProvider(alg, 0);
  return !Falhou(s, "BCryptHash", erro);
}

void Concatenar(std::vector<uint8_t>* destino, const std::vector<uint8_t>& parte) {
  destino->insert(destino->end(), parte.begin(), parte.end());
}

void Concatenar(std::vector<uint8_t>* destino, const std::string& parte) {
  destino->insert(destino->end(), parte.begin(), parte.end());
}

}  // namespace

bool DerivarSegredo(const std::vector<uint8_t>& segredo_ecdh,
                    const std::vector<uint8_t>& nonce_a,
                    const std::vector<uint8_t>& nonce_b,
                    const std::string& senha,
                    std::vector<uint8_t>* chave_ida,
                    std::vector<uint8_t>* chave_volta,
                    std::string* erro) {
  // HKDF, na forma simples: extrai e depois expande.
  //
  // O SAL leva os dois nonces E A SENHA. É a senha ali que transforma um ECDH
  // anônimo — que combina chave com quem quer que atenda — numa troca que só
  // fecha entre dois lados que já sabiam a mesma coisa. Quem estiver no meio do
  // caminho fecha o ECDH sem problema e mesmo assim deriva outra chave.
  std::vector<uint8_t> sal;
  Concatenar(&sal, nonce_a);
  Concatenar(&sal, nonce_b);
  Concatenar(&sal, std::string("ryke-sistema/v1/"));
  Concatenar(&sal, senha);

  std::vector<uint8_t> raiz;
  if (!Hmac(sal, segredo_ecdh, &raiz, erro)) return false;

  std::vector<uint8_t> rotulo_ida;
  Concatenar(&rotulo_ida, std::string("ida"));
  rotulo_ida.push_back(1);
  std::vector<uint8_t> rotulo_volta;
  Concatenar(&rotulo_volta, std::string("volta"));
  rotulo_volta.push_back(2);

  if (!Hmac(raiz, rotulo_ida, chave_ida, erro)) return false;
  if (!Hmac(raiz, rotulo_volta, chave_volta, erro)) return false;
  return true;
}

Cifra::~Cifra() {
  if (chave_) BCryptDestroyKey(static_cast<BCRYPT_KEY_HANDLE>(chave_));
}

bool Cifra::Abrir(const std::vector<uint8_t>& chave, std::string* erro) {
  if (chave.size() != 32) {
    if (erro) *erro = "a chave AES precisa ter 32 bytes";
    return false;
  }
  BCRYPT_ALG_HANDLE alg = nullptr;
  NTSTATUS s = BCryptOpenAlgorithmProvider(&alg, BCRYPT_AES_ALGORITHM, nullptr, 0);
  if (Falhou(s, "BCryptOpenAlgorithmProvider(AES)", erro)) return false;

  s = BCryptSetProperty(alg, BCRYPT_CHAINING_MODE, reinterpret_cast<PUCHAR>(const_cast<wchar_t*>(BCRYPT_CHAIN_MODE_GCM)),
                        sizeof(BCRYPT_CHAIN_MODE_GCM), 0);
  if (Falhou(s, "BCryptSetProperty(GCM)", erro)) {
    BCryptCloseAlgorithmProvider(alg, 0);
    return false;
  }

  BCRYPT_KEY_HANDLE k = nullptr;
  s = BCryptGenerateSymmetricKey(alg, &k, nullptr, 0, const_cast<PUCHAR>(chave.data()),
                                 static_cast<ULONG>(chave.size()), 0);
  BCryptCloseAlgorithmProvider(alg, 0);
  if (Falhou(s, "BCryptGenerateSymmetricKey", erro)) return false;

  if (chave_) BCryptDestroyKey(static_cast<BCRYPT_KEY_HANDLE>(chave_));
  chave_ = k;
  return true;
}

namespace {

// O nonce de 12 bytes do GCM a partir do contador de 64 bits.
//
// Os 4 primeiros bytes ficam zerados de propósito: sobra espaço para, um dia,
// separar fluxos sem mudar o formato do fio.
void MontarNonce(uint64_t contador, uint8_t saida[12]) {
  memset(saida, 0, 12);
  for (int i = 0; i < 8; i++) saida[4 + i] = static_cast<uint8_t>((contador >> (8 * (7 - i))) & 0xFF);
}

}  // namespace

bool Cifra::Selar(uint64_t nonce, const uint8_t* cabecalho, size_t cabecalho_len, const uint8_t* claro,
                  size_t claro_len, std::vector<uint8_t>* saida, std::string* erro) const {
  if (!chave_) {
    if (erro) *erro = "cifra não aberta";
    return false;
  }
  uint8_t iv[12];
  MontarNonce(nonce, iv);

  BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info{};
  BCRYPT_INIT_AUTH_MODE_INFO(info);
  info.pbNonce = iv;
  info.cbNonce = sizeof(iv);
  info.pbAuthData = const_cast<PUCHAR>(cabecalho);
  info.cbAuthData = static_cast<ULONG>(cabecalho_len);

  const size_t antes = saida->size();
  saida->resize(antes + claro_len + 16);
  info.pbTag = saida->data() + antes + claro_len;
  info.cbTag = 16;

  ULONG escrito = 0;
  NTSTATUS s = BCryptEncrypt(static_cast<BCRYPT_KEY_HANDLE>(chave_), const_cast<PUCHAR>(claro),
                             static_cast<ULONG>(claro_len), &info, nullptr, 0, saida->data() + antes,
                             static_cast<ULONG>(claro_len), &escrito, 0);
  return !Falhou(s, "BCryptEncrypt", erro);
}

bool Cifra::Abrir(uint64_t nonce, const uint8_t* cabecalho, size_t cabecalho_len, const uint8_t* cifrado,
                  size_t cifrado_len, std::vector<uint8_t>* saida, std::string* erro) const {
  if (!chave_) {
    if (erro) *erro = "cifra não aberta";
    return false;
  }
  if (cifrado_len < 16) {
    if (erro) *erro = "pacote menor do que o selo";
    return false;
  }
  const size_t corpo = cifrado_len - 16;

  uint8_t iv[12];
  MontarNonce(nonce, iv);

  BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info{};
  BCRYPT_INIT_AUTH_MODE_INFO(info);
  info.pbNonce = iv;
  info.cbNonce = sizeof(iv);
  info.pbAuthData = const_cast<PUCHAR>(cabecalho);
  info.cbAuthData = static_cast<ULONG>(cabecalho_len);
  info.pbTag = const_cast<PUCHAR>(cifrado + corpo);
  info.cbTag = 16;

  saida->resize(corpo);
  ULONG escrito = 0;
  NTSTATUS s = BCryptDecrypt(static_cast<BCRYPT_KEY_HANDLE>(chave_), const_cast<PUCHAR>(cifrado),
                             static_cast<ULONG>(corpo), &info, nullptr, 0, saida->data(),
                             static_cast<ULONG>(corpo), &escrito, 0);
  if (!NT_SUCCESS(s)) {
    // Não é um erro a registrar aos gritos: pacote corrompido na rede cai aqui,
    // e num link ruim isso acontece o tempo todo. Quem chama decide.
    if (erro) *erro = "selo não confere";
    saida->clear();
    return false;
  }
  saida->resize(escrito);
  return true;
}

bool Sortear(uint8_t* destino, size_t quantos) {
  return NT_SUCCESS(BCryptGenRandom(nullptr, destino, static_cast<ULONG>(quantos),
                                    BCRYPT_USE_SYSTEM_PREFERRED_RNG));
}

std::vector<uint8_t> Sortear(size_t quantos) {
  std::vector<uint8_t> v(quantos);
  Sortear(v.data(), quantos);
  return v;
}

bool AntiRepeticao::Aceitar(uint64_t nonce) {
  if (!comecou_) {
    comecou_ = true;
    maior_ = nonce;
    memset(vistos_, 0, sizeof(vistos_));
    vistos_[0] |= 1ull;
    return true;
  }

  if (nonce > maior_) {
    const uint64_t salto = nonce - maior_;
    if (salto >= kJanela) {
      memset(vistos_, 0, sizeof(vistos_));
    } else {
      // Desloca a janela `salto` posições. Feito bit a bit por simplicidade:
      // o salto típico é 1, e nesse caso o laço roda uma vez.
      for (uint64_t i = 0; i < salto; i++) {
        uint64_t carrega = 0;
        for (int p = 0; p < kJanela / 64; p++) {
          const uint64_t novo = vistos_[p] >> 63;
          vistos_[p] = (vistos_[p] << 1) | carrega;
          carrega = novo;
        }
      }
    }
    maior_ = nonce;
    vistos_[0] |= 1ull;
    return true;
  }

  const uint64_t atras = maior_ - nonce;
  if (atras >= kJanela) return false;  // velho demais para termos como saber
  const int palavra = static_cast<int>(atras / 64);
  const uint64_t bit = 1ull << (atras % 64);
  if (vistos_[palavra] & bit) return false;  // repetido
  vistos_[palavra] |= bit;
  return true;
}

}  // namespace ryke
