// A conexão: um fio de ponta a ponta, sobre UDP, sem WebRTC.
//
// COMO SE USA
//
//   Fio fio;
//   fio.Servir(5900, "senha", &erro);        // no anfitrião
//   fio.Conectar({ip, 5900}, "senha", &erro); // no visitante
//   while (rodando) {
//     fio.Bombear(5);                         // trata o que chegou e o que atrasou
//     fio.EnviarQuadro(...);                  // no anfitrião
//     fio.EnviarEntrada(...);                 // no visitante
//   }
//
// UMA LINHA DE EXECUÇÃO SÓ, DE PROPÓSITO
//
// Não há trava nem fila entre linhas aqui dentro. Quem chama é dono do ritmo:
// chama `Bombear` no seu laço e pronto. É mais fácil de acertar do que um
// desenho com linhas de execução, e num programa cujo laço já roda 60 vezes por
// segundo não falta oportunidade de bombear.
//
// O QUE ELE GARANTE, E O QUE NÃO
//
// • Vídeo: melhor esforço COM segunda chance. Um pedaço que falta é pedido de
//   volta enquanto o quadro ainda vale; vencido o prazo, o quadro é abandonado e
//   pede-se um quadro-chave. Nunca trava esperando.
//
// • Entrada: entrega garantida e em ordem. Retransmite até ser confirmada.
//
// • Tudo cifrado com AES-256-GCM, chave por sessão e por sentido, e com
//   proteção contra repetição. Ver transporte/cripto.h.

#pragma once

#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "transporte/cripto.h"
#include "transporte/pacote.h"
#include "transporte/soquete.h"

namespace ryke {

struct QuadroRecebido {
  uint32_t numero = 0;
  bool chave = false;
  uint16_t largura = 0;
  uint16_t altura = 0;
  std::vector<uint8_t> dados;
  // Quanto tempo passou entre o primeiro pedaço chegar e o quadro fechar. É a
  // medida honesta do que a rede acrescentou de atraso a ESTE quadro.
  uint32_t montagem_us = 0;
};

struct Estatisticas {
  // Em MICROssegundos: numa rede local o ida-e-volta e menor do que um
  // milissegundo, e arredondar para zero esconde justamente a medida que este
  // projeto existe para melhorar.
  uint32_t rtt_us = 0;
  uint32_t rtt_min_us = 0;
  uint32_t rtt_ms = 0;
  uint32_t rtt_min_ms = 0;
  double perda_pct = 0;
  uint64_t bytes_enviados = 0;
  uint64_t bytes_recebidos = 0;
  uint32_t quadros_completos = 0;
  uint32_t quadros_abandonados = 0;
  uint32_t pedacos_pedidos = 0;
  uint32_t pedacos_reenviados = 0;
  uint32_t kbps_saida = 0;
  uint32_t kbps_entrada = 0;
};

class Fio {
 public:
  Fio() = default;
  ~Fio();
  Fio(const Fio&) = delete;
  Fio& operator=(const Fio&) = delete;

  // Chamados de dentro de `Bombear`.
  std::function<void(QuadroRecebido&&)> ao_receber_quadro;
  std::function<void(const uint8_t*, size_t)> ao_receber_entrada;
  std::function<void()> ao_pedir_chave;
  std::function<void(const std::string&)> ao_cair;

  bool Servir(uint16_t porta, const std::string& senha, std::string* erro);
  bool Conectar(const Endereco& destino, const std::string& senha, std::string* erro);
  void Encerrar();

  bool Conectado() const { return fase_ == Fase::kPronto; }
  uint16_t PortaLocal() const { return soquete_.PortaLocal(); }
  const Endereco& Parceiro() const { return parceiro_; }

  // Manda um quadro já codificado. Ele é partido em pedaços de MTU e enfileirado
  // — sair de fato é trabalho do `Bombear`, que respeita o ritmo da rede.
  bool EnviarQuadro(uint32_t numero, bool chave, uint16_t largura, uint16_t altura, const uint8_t* dados,
                    size_t tamanho);

  // Manda uma mensagem de entrada. Confiável e em ordem.
  bool EnviarEntrada(const uint8_t* dados, size_t tamanho);

  // Pede ao outro lado um quadro-chave (usado quando a decodificação se perde).
  bool PedirQuadroChave();

  // Trata o que chegou, reenvia o que atrasou, manda o que está na fila.
  // `prazo_ms` é quanto tempo ele pode ficar esperando por um datagrama.
  void Bombear(uint32_t prazo_ms);

  // Quanto o codificador deveria estar gastando agora, em bits por segundo.
  // Sobe devagar quando não há perda nem fila; desce rápido quando há.
  uint32_t OrcamentoBps() const { return orcamento_bps_; }
 void DefinirLimiteBps(uint32_t maximo) { limite_bps_ = maximo; }
  // De onde o orcamento parte. Comecar baixo demais estrangula os primeiros
  // segundos da sessao — que sao justamente os que o usuario usa para julgar
  // se o programa e rapido.
  void DefinirOrcamentoBps(uint32_t bps) { orcamento_bps_ = bps; }

  const Estatisticas& Medidas() const { return est_; }

  // SÓ PARA TESTE: perde de propósito esta fração dos datagramas que saem.
  // Ver Soquete::DefinirPerdaDeTeste.
  void PerdaDeTeste(double fracao) { soquete_.DefinirPerdaDeTeste(fracao); }

 private:
  enum class Fase { kParado, kEsperandoOla, kEsperandoOlaOk, kPronto };

  struct PedacoNaFila {
    std::vector<uint8_t> datagrama;
    uint32_t quadro = 0;
    uint16_t pedaco = 0;
  };

  struct QuadroEmMontagem {
    uint32_t numero = 0;
    bool chave = false;
    uint16_t largura = 0;
    uint16_t altura = 0;
    uint32_t tamanho_total = 0;
    uint16_t pedacos = 0;
    uint16_t recebidos = 0;
    std::vector<bool> chegou;
    std::vector<uint8_t> dados;
    uint64_t primeiro_us = 0;
    uint64_t ultimo_pedaco_us = 0;
    uint64_t ultimo_pedido_us = 0;
  };

  struct EntradaPendente {
    uint32_t sequencia = 0;
    std::vector<uint8_t> corpo;
    uint64_t enviado_us = 0;
    uint32_t tentativas = 0;
  };

  bool AbrirSoquete(uint16_t porta, std::string* erro);
  bool MandarCru(Tipo tipo, const uint8_t* corpo, size_t tamanho);
  bool MandarCifrado(Tipo tipo, const uint8_t* corpo, size_t tamanho);
  void Tratar(const uint8_t* dados, size_t tamanho, const Endereco& de);
  void TratarClaro(const Cabecalho& cab, const uint8_t* corpo, size_t tamanho, const Endereco& de);
  void TratarCifrado(const Cabecalho& cab, const std::vector<uint8_t>& corpo);
  void TratarVideo(const std::vector<uint8_t>& corpo);
  void TratarFalta(const std::vector<uint8_t>& corpo);
  void TratarEntrada(const std::vector<uint8_t>& corpo);
  void TratarEntradaOk(const std::vector<uint8_t>& corpo);
  bool FecharAperto(const std::vector<uint8_t>& publica_do_outro, const std::vector<uint8_t>& nonce_deles,
                    bool sou_anfitriao);
  void MandarOla();
  void EscoarFila(uint64_t agora_us);
  void CuidarDaMontagem(uint64_t agora_us);
  void CuidarDaEntrada(uint64_t agora_us);
  void Pulsar(uint64_t agora_us);
  void AtualizarOrcamento(uint64_t agora_us);
  void Guardar(const PedacoNaFila& p);
  void CairPor(const std::string& motivo);

  Soquete soquete_;
  Endereco parceiro_;
  Fase fase_ = Fase::kParado;
  bool sou_anfitriao_ = false;
  std::string senha_;

  ParDeChaves par_;
  std::vector<uint8_t> meu_nonce_;
  Cifra cifra_saida_;
  Cifra cifra_entrada_;
  AntiRepeticao anti_repeticao_;
  uint32_t sessao_ = 0;
  uint64_t proximo_nonce_ = 1;

  // ── saída de vídeo ──
  std::deque<PedacoNaFila> fila_;
  // Os últimos pedaços enviados, para atender um pedido de retransmissão.
  // Guardar mais do que isto é desperdício: um pedaço velho já não interessa a
  // ninguém, porque o quadro dele já foi abandonado do outro lado.
  std::map<uint64_t, std::vector<uint8_t>> guardados_;
  std::deque<uint64_t> ordem_guardados_;
  size_t bytes_guardados_ = 0;
  uint64_t ultimo_envio_us_ = 0;
  double credito_bytes_ = 0;

  // ── entrada de vídeo ──
  std::map<uint32_t, QuadroEmMontagem> montando_;
  uint32_t maior_quadro_visto_ = 0;
  uint32_t ultimo_entregue_ = 0;

  // ── entrada (mouse/teclado) ──
  std::deque<EntradaPendente> entrada_pendente_;
  uint32_t proxima_seq_entrada_ = 1;
  uint32_t ultima_entrada_recebida_ = 0;
  std::map<uint32_t, std::vector<uint8_t>> entrada_fora_de_ordem_;

  // ── medidas ──
  Estatisticas est_;
  uint64_t ultimo_ping_us_ = 0;
  uint64_t ultima_janela_us_ = 0;
  uint64_t bytes_na_janela_saida_ = 0;
  uint64_t bytes_na_janela_entrada_ = 0;
  uint64_t ultimo_pacote_recebido_us_ = 0;
  uint32_t orcamento_bps_ = 8000000;
  uint32_t limite_bps_ = 40000000;
  uint32_t perdas_na_janela_ = 0;
  uint32_t pedacos_na_janela_ = 0;
  uint64_t inicio_aperto_us_ = 0;
  uint32_t tentativas_ola_ = 0;
};

}  // namespace ryke
