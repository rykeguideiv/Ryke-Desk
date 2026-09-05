// O transporte próprio entrega o que o WebRTC entregava?
//
// São duas promessas, e elas são opostas:
//
//   • VÍDEO é perecível. Perdeu um pedaço, pede de volta enquanto o quadro
//     ainda vale; vencido o prazo, abandona e pede quadro-chave. Nunca trava.
//   • ENTRADA é sagrada. Chega inteira e em ordem, mesmo com a rede perdendo
//     um pacote a cada cinco.
//
// A perda é PROVOCADA, não esperada: numa rede local o número é zero, e um
// transporte só exercitado com zero por cento de perda é um transporte que
// ninguém sabe se funciona. Foi assim que o arrasto quebrou no aplicativo.

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "base/log.h"
#include "base/tempo.h"
#include "transporte/fio.h"

using namespace ryke;

static int falhas = 0;
static void check(const char* rotulo, bool ok, const std::string& extra = "") {
  printf("%s %s%s%s\n", ok ? " ok  " : "FALHA", rotulo, extra.empty() ? "" : " — ", extra.c_str());
  if (!ok) falhas++;
}

// Um quadro de mentira, mas com conteúdo verificável: cada byte é função do
// número do quadro e da posição. Assim um pedaço trocado de lugar ou um byte
// perdido aparece — o que um "chegou o tamanho certo" não pegaria.
static std::vector<uint8_t> Fabricar(uint32_t numero, size_t tamanho) {
  std::vector<uint8_t> v(tamanho);
  uint32_t x = numero * 2654435761u + 1;
  for (size_t i = 0; i < tamanho; i++) {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    v[i] = static_cast<uint8_t>(x & 0xFF);
  }
  return v;
}

static bool Confere(uint32_t numero, const std::vector<uint8_t>& v) {
  const std::vector<uint8_t> esperado = Fabricar(numero, v.size());
  return esperado == v;
}

struct Resultado {
  uint32_t completos = 0;
  uint32_t corrompidos = 0;
  uint32_t abandonados = 0;
  uint32_t pedidos = 0;
  uint32_t reenviados = 0;
  uint32_t rtt_ms = 0;
};

// Sobe os dois lados, manda `quantos` quadros com `perda` de perda, e conta.
static Resultado Rodar(double perda, uint32_t quantos, size_t tamanho_quadro, uint32_t bps) {
  Resultado r;
  Fio anfitriao, visitante;
  std::string erro;

  if (!anfitriao.Servir(0, "senha-do-teste", &erro)) {
    check("o anfitriao subiu", false, erro);
    return r;
  }
  Endereco alvo;
  alvo.ipv4 = 0x7F000001;  // 127.0.0.1
  alvo.porta = anfitriao.PortaLocal();
  if (!visitante.Conectar(alvo, "senha-do-teste", &erro)) {
    check("o visitante conectou", false, erro);
    return r;
  }

  // Orçamento fixo e generoso: aqui queremos medir PERDA, não o controle de
  // ritmo. O ritmo tem prova própria.
  anfitriao.DefinirLimiteBps(bps);
  visitante.DefinirLimiteBps(bps);
  // Comeca com folga: aqui queremos medir PERDA, nao a subida do orcamento.
  anfitriao.DefinirOrcamentoBps(bps);
  visitante.DefinirOrcamentoBps(bps);

  uint32_t recebidos = 0;
  visitante.ao_receber_quadro = [&](QuadroRecebido&& q) {
    recebidos++;
    if (!Confere(q.numero, q.dados)) r.corrompidos++;
  };

  // aperto de mão
  const uint64_t limite_aperto = AgoraUs() + 3000000ull;
  while ((!anfitriao.Conectado() || !visitante.Conectado()) && AgoraUs() < limite_aperto) {
    anfitriao.Bombear(2);
    visitante.Bombear(2);
  }
  if (!anfitriao.Conectado() || !visitante.Conectado()) {
    check("o aperto de mao fechou", false, "nao fechou em 3 s");
    return r;
  }

  // Deixa o RTT ser medido antes de provocar a perda: o prazo de desistência
  // depende dele, e começar com RTT zero encurta o prazo artificialmente.
  const uint64_t aquece = AgoraUs() + 700000ull;
  while (AgoraUs() < aquece) {
    anfitriao.Bombear(2);
    visitante.Bombear(2);
  }

  anfitriao.PerdaDeTeste(perda);
  visitante.PerdaDeTeste(perda);

  for (uint32_t i = 1; i <= quantos; i++) {
    const std::vector<uint8_t> quadro = Fabricar(i, tamanho_quadro);
    anfitriao.EnviarQuadro(i, i == 1, 1920, 1080, quadro.data(), quadro.size());
    // Um quadro a cada ~16 ms, como 60 por segundo.
    const uint64_t ate = AgoraUs() + 16000;
    while (AgoraUs() < ate) {
      anfitriao.Bombear(1);
      visitante.Bombear(1);
    }
  }

  // Escoa o que ficou.
  const uint64_t fim = AgoraUs() + 2500000ull;
  while (AgoraUs() < fim) {
    anfitriao.Bombear(2);
    visitante.Bombear(2);
  }

  r.completos = recebidos;
  r.abandonados = visitante.Medidas().quadros_abandonados;
  r.pedidos = visitante.Medidas().pedacos_pedidos;
  r.reenviados = anfitriao.Medidas().pedacos_reenviados;
  r.rtt_ms = visitante.Medidas().rtt_ms;
  return r;
}

int main() {
  RelogioFino fino;
  LogNivelMinimo(Nivel::kAviso);

  printf("\n== o fio de ponta a ponta, sem WebRTC ==\n\n");

  {
    // 1. Rede limpa. Aqui nada pode se perder: se falhar, o problema é do
    // transporte, não da rede.
    const Resultado r = Rodar(0.0, 120, 40000, 80000000);
    check("rede limpa: os 120 quadros chegam", r.completos == 120,
          "chegaram " + std::to_string(r.completos));
    check("e chegam byte a byte identicos", r.corrompidos == 0,
          std::to_string(r.corrompidos) + " corrompidos");
    check("sem nenhum abandono", r.abandonados == 0, std::to_string(r.abandonados));
  }

  {
    // 2. Cinco por cento de perda — um link ruim de verdade. Sem pedido de
    // retransmissão, um quadro de 40 KB (34 pedaços) teria ~82% de chance de
    // perder ao menos um pedaço, ou seja, quase NENHUM quadro chegaria.
    const Resultado r = Rodar(0.05, 120, 40000, 80000000);
    const double taxa = 100.0 * r.completos / 120.0;
    printf("      (5%% de perda: %u completos, %u abandonados, %u pedidos, %u reenviados, rtt %u ms)\n",
           r.completos, r.abandonados, r.pedidos, r.reenviados, r.rtt_ms);
    check("5% de perda: pedidos de retransmissao acontecem", r.pedidos > 0);
    check("e o outro lado os atende", r.reenviados > 0);
    check("a maioria esmagadora dos quadros chega mesmo assim", taxa >= 85.0,
          std::to_string(static_cast<int>(taxa)) + "% dos quadros");
    check("e o que chega esta intacto", r.corrompidos == 0, std::to_string(r.corrompidos) + " corrompidos");
  }

  {
    // 3. Vinte por cento de perda: aqui o certo NÃO é entregar tudo. É não
    // travar, abandonar o que não dá e continuar entregando.
    const Resultado r = Rodar(0.20, 120, 40000, 80000000);
    printf("      (20%% de perda: %u completos, %u abandonados)\n", r.completos, r.abandonados);
    check("20% de perda: o fio nao trava, continua entregando", r.completos > 10,
          std::to_string(r.completos) + " completos");
    check("e o que chega continua intacto", r.corrompidos == 0);
  }

  printf("\n== a entrada nao pode se perder ==\n\n");
  {
    Fio anfitriao, visitante;
    std::string erro;
    anfitriao.Servir(0, "s", &erro);
    Endereco alvo{0x7F000001, anfitriao.PortaLocal()};
    visitante.Conectar(alvo, "s", &erro);

    std::vector<uint32_t> chegaram;
    bool fora_de_ordem = false;
    anfitriao.ao_receber_entrada = [&](const uint8_t* d, size_t n) {
      if (n != sizeof(uint32_t)) return;
      uint32_t v = 0;
      memcpy(&v, d, sizeof(v));
      if (!chegaram.empty() && v != chegaram.back() + 1) fora_de_ordem = true;
      chegaram.push_back(v);
    };

    const uint64_t limite = AgoraUs() + 3000000ull;
    while ((!anfitriao.Conectado() || !visitante.Conectado()) && AgoraUs() < limite) {
      anfitriao.Bombear(2);
      visitante.Bombear(2);
    }
    check("o aperto de mao fechou", anfitriao.Conectado() && visitante.Conectado());

    const uint64_t aquece = AgoraUs() + 500000ull;
    while (AgoraUs() < aquece) {
      anfitriao.Bombear(2);
      visitante.Bombear(2);
    }

    // Um pacote a cada cinco no lixo, nos DOIS sentidos — inclusive as
    // confirmações, que é o caso que faz um protocolo mal feito reenviar para
    // sempre ou entregar em duplicata.
    anfitriao.PerdaDeTeste(0.20);
    visitante.PerdaDeTeste(0.20);

    const uint32_t quantas = 200;
    for (uint32_t i = 1; i <= quantas; i++) {
      visitante.EnviarEntrada(reinterpret_cast<const uint8_t*>(&i), sizeof(i));
      const uint64_t ate = AgoraUs() + 3000;
      while (AgoraUs() < ate) {
        anfitriao.Bombear(1);
        visitante.Bombear(1);
      }
    }
    const uint64_t fim = AgoraUs() + 4000000ull;
    while (AgoraUs() < fim && chegaram.size() < quantas) {
      anfitriao.Bombear(2);
      visitante.Bombear(2);
    }

    check("com 20% de perda, TODAS as 200 mensagens de entrada chegam", chegaram.size() == quantas,
          "chegaram " + std::to_string(chegaram.size()));
    check("e chegam na ordem exata em que foram feitas", !fora_de_ordem);
    bool duplicada = false;
    for (size_t i = 1; i < chegaram.size(); i++) {
      if (chegaram[i] == chegaram[i - 1]) duplicada = true;
    }
    check("e nenhuma chega duas vezes (um clique nao vira dois)", !duplicada);
  }

  printf("\n== a senha errada nao conecta ==\n\n");
  {
    Fio anfitriao, visitante;
    std::string erro;
    anfitriao.Servir(0, "a-senha-certa", &erro);
    Endereco alvo{0x7F000001, anfitriao.PortaLocal()};
    visitante.Conectar(alvo, "outra-senha", &erro);

    uint32_t entradas = 0;
    anfitriao.ao_receber_entrada = [&](const uint8_t*, size_t) { entradas++; };

    const uint64_t limite = AgoraUs() + 2000000ull;
    while (AgoraUs() < limite) {
      anfitriao.Bombear(2);
      visitante.Bombear(2);
      const uint32_t v = 1;
      visitante.EnviarEntrada(reinterpret_cast<const uint8_t*>(&v), sizeof(v));
    }
    // Os dois lados até "fecham" o ECDH — ele é anônimo. O que não acontece é
    // um pacote sequer atravessar, porque as chaves saíram diferentes.
    check("com a senha errada, nenhuma entrada atravessa", entradas == 0,
          std::to_string(entradas) + " atravessaram");
  }

  printf("\n%s\n\n", falhas == 0 ? "TUDO OK" : (std::to_string(falhas) + " FALHA(S)").c_str());
  return falhas == 0 ? 0 : 1;
}
