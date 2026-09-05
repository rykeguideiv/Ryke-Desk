#include "transporte/soquete.h"

#include "base/log.h"

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <mstcpip.h>
#include <windows.h>

#include <cstdio>
#include <mutex>

#pragma comment(lib, "ws2_32.lib")

// Alguns SDKs só trazem isto por caminhos que variam de versão para versão. O
// valor é estável e documentado desde o Windows 2000; declarar aqui evita que a
// compilação dependa de qual SDK está instalado na máquina.
#ifndef SIO_UDP_CONNRESET
#define SIO_UDP_CONNRESET _WSAIOW(IOC_VENDOR, 12)
#endif

namespace ryke {
namespace {

// O Winsock exige inicialização por processo. Uma vez, e nunca desfeita: o
// processo inteiro depende dela, e desfazê-la em qualquer ponto derrubaria
// soquetes de outras partes do programa.
void GarantirWinsock() {
  static std::once_flag uma_vez;
  std::call_once(uma_vez, [] {
    WSADATA d{};
    WSAStartup(MAKEWORD(2, 2), &d);
  });
}

}  // namespace

std::string Endereco::Texto() const {
  char buf[32];
  snprintf(buf, sizeof(buf), "%u.%u.%u.%u:%u", (ipv4 >> 24) & 0xFF, (ipv4 >> 16) & 0xFF, (ipv4 >> 8) & 0xFF,
           ipv4 & 0xFF, porta);
  return buf;
}

bool ResolverEndereco(const std::string& texto, Endereco* saida, std::string* erro) {
  GarantirWinsock();
  const size_t dp = texto.rfind(':');
  if (dp == std::string::npos) {
    if (erro) *erro = "falta a porta em \"" + texto + "\" (use maquina:porta)";
    return false;
  }
  const std::string maquina = texto.substr(0, dp);
  const std::string porta = texto.substr(dp + 1);

  addrinfo dicas{};
  dicas.ai_family = AF_INET;
  dicas.ai_socktype = SOCK_DGRAM;
  addrinfo* r = nullptr;
  if (getaddrinfo(maquina.c_str(), porta.c_str(), &dicas, &r) != 0 || !r) {
    if (erro) *erro = "não consegui resolver \"" + texto + "\": " + TextoDoUltimoErro();
    return false;
  }
  const auto* sin = reinterpret_cast<sockaddr_in*>(r->ai_addr);
  saida->ipv4 = ntohl(sin->sin_addr.s_addr);
  saida->porta = ntohs(sin->sin_port);
  freeaddrinfo(r);
  return true;
}

Soquete::~Soquete() { Fechar(); }

bool Soquete::Aberto() const { return s_ != ~static_cast<uintptr_t>(0); }

bool Soquete::Abrir(uint16_t porta, std::string* erro) {
  GarantirWinsock();
  Fechar();

  SOCKET s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (s == INVALID_SOCKET) {
    if (erro) *erro = "socket() falhou: " + TextoDoUltimoErro();
    return false;
  }

  sockaddr_in end{};
  end.sin_family = AF_INET;
  end.sin_addr.s_addr = INADDR_ANY;
  end.sin_port = htons(porta);
  if (bind(s, reinterpret_cast<sockaddr*>(&end), sizeof(end)) == SOCKET_ERROR) {
    if (erro) *erro = "bind na porta " + std::to_string(porta) + " falhou: " + TextoDoUltimoErro();
    closesocket(s);
    return false;
  }

  int tam = sizeof(end);
  if (getsockname(s, reinterpret_cast<sockaddr*>(&end), &tam) == 0) porta_local_ = ntohs(end.sin_port);

  // Sem isto, um ICMP "porta inalcançável" vindo de um envio anterior faz o
  // PRÓXIMO recvfrom devolver WSAECONNRESET — num soquete UDP, que não tem
  // conexão. É um comportamento só do Windows e derruba o laço de recepção de
  // quem não sabe que ele existe.
  BOOL nova_conduta = FALSE;
  DWORD devolvido = 0;
  WSAIoctl(s, SIO_UDP_CONNRESET, &nova_conduta, sizeof(nova_conduta), nullptr, 0, &devolvido, nullptr,
           nullptr);

  s_ = static_cast<uintptr_t>(s);
  DefinirBufferDeRecepcao(4 * 1024 * 1024);
  DefinirBufferDeEnvio(4 * 1024 * 1024);
  return true;
}

void Soquete::Fechar() {
  if (Aberto()) closesocket(static_cast<SOCKET>(s_));
  s_ = ~static_cast<uintptr_t>(0);
  porta_local_ = 0;
}

bool Soquete::DefinirBufferDeRecepcao(int bytes) {
  if (!Aberto()) return false;
  return setsockopt(static_cast<SOCKET>(s_), SOL_SOCKET, SO_RCVBUF, reinterpret_cast<const char*>(&bytes),
                    sizeof(bytes)) == 0;
}

bool Soquete::DefinirBufferDeEnvio(int bytes) {
  if (!Aberto()) return false;
  return setsockopt(static_cast<SOCKET>(s_), SOL_SOCKET, SO_SNDBUF, reinterpret_cast<const char*>(&bytes),
                    sizeof(bytes)) == 0;
}

bool Soquete::Enviar(const Endereco& destino, const uint8_t* dados, size_t tamanho, std::string* erro) {
  if (!Aberto()) {
    if (erro) *erro = "soquete fechado";
    return false;
  }
  if (perda_de_teste_ > 0.0) {
    // Gerador xorshift próprio: precisa ser reprodutível e não pode depender do
    // estado global do rand(), que outra parte do programa pode ter mexido.
    semente_ ^= semente_ << 13;
    semente_ ^= semente_ >> 7;
    semente_ ^= semente_ << 17;
    const double sorte = static_cast<double>(semente_ >> 11) / 9007199254740992.0;
    if (sorte < perda_de_teste_) return true;  // "saiu" — e sumiu no caminho
  }

  sockaddr_in end{};
  end.sin_family = AF_INET;
  end.sin_addr.s_addr = htonl(destino.ipv4);
  end.sin_port = htons(destino.porta);
  const int n = sendto(static_cast<SOCKET>(s_), reinterpret_cast<const char*>(dados),
                       static_cast<int>(tamanho), 0, reinterpret_cast<sockaddr*>(&end), sizeof(end));
  if (n == SOCKET_ERROR) {
    const int e = WSAGetLastError();
    // Buffer de saída cheio não é falha: é a rede pedindo para ir mais devagar.
    // Quem chama trata isso como "não coube agora", nunca como "morreu".
    if (e == WSAEWOULDBLOCK) return false;
    if (erro) *erro = "sendto falhou: " + TextoDoHResult(e);
    return false;
  }
  return true;
}

int Soquete::Receber(std::vector<uint8_t>* buffer, Endereco* de, uint32_t prazo_ms, std::string* erro) {
  if (!Aberto()) {
    if (erro) *erro = "soquete fechado";
    return -1;
  }

  // O select roda SEMPRE, inclusive com prazo zero.
  //
  // Com prazo zero a tentacao e pular direto para o recvfrom — e foi o que este
  // codigo fazia. So que o soquete e bloqueante: sem dado nenhum na fila, o
  // recvfrom nao devolve "nada por enquanto", ele SIMPLESMENTE PARA. O programa
  // inteiro travava no primeiro laco que tentava so drenar o que ja tinha
  // chegado. Prazo zero significa "nao espere", nao "nao pergunte".
  {
    fd_set leitura;
    FD_ZERO(&leitura);
    FD_SET(static_cast<SOCKET>(s_), &leitura);
    timeval tv{};
    tv.tv_sec = static_cast<long>(prazo_ms / 1000);
    tv.tv_usec = static_cast<long>((prazo_ms % 1000) * 1000);
    const int pronto = select(0, &leitura, nullptr, nullptr, &tv);
    if (pronto == 0) return 0;
    if (pronto == SOCKET_ERROR) {
      if (erro) *erro = "select falhou: " + TextoDoUltimoErro();
      return -1;
    }
  }

  buffer->resize(2048);
  sockaddr_in origem{};
  int tam = sizeof(origem);
  const int n = recvfrom(static_cast<SOCKET>(s_), reinterpret_cast<char*>(buffer->data()),
                         static_cast<int>(buffer->size()), 0, reinterpret_cast<sockaddr*>(&origem), &tam);
  if (n == SOCKET_ERROR) {
    const int e = WSAGetLastError();
    if (e == WSAEWOULDBLOCK || e == WSAECONNRESET) return 0;
    if (erro) *erro = "recvfrom falhou: " + TextoDoHResult(e);
    return -1;
  }
  buffer->resize(static_cast<size_t>(n));
  if (de) {
    de->ipv4 = ntohl(origem.sin_addr.s_addr);
    de->porta = ntohs(origem.sin_port);
  }
  return n;
}

}  // namespace ryke
