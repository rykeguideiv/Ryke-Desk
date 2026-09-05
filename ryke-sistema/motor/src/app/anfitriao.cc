// O lado que COMPARTILHA a tela.
//
// O laço inteiro do produto cabe numa página, e é de propósito:
//
//   captura (GPU) → converte cor → codifica (GPU) → parte em pedaços → rede
//                                                        ↑
//                              entrada que chega ─────────┘ injeta no Windows
//
// O que não está aqui é tão importante quanto o que está: não há navegador, não
// há WebRTC, não há servidor de sinalização. São três bibliotecas do próprio
// Windows (DXGI, Media Foundation, Winsock) e o código deste projeto.

#include "app/lados.h"

#include "base/log.h"
#include "base/tempo.h"
#include "captura/duplicador.h"
#include "codec/codificador.h"
#include "codec/cores.h"
#include "entrada/injetor.h"
#include "entrada/protocolo-entrada.h"
#include "transporte/fio.h"

#include <algorithm>
#include <cstring>
#include <vector>

namespace ryke {
namespace {

// Trata uma mensagem de entrada vinda do visitante.
void AplicarEntrada(Injetor& injetor, const uint8_t* dados, size_t tamanho) {
  if (tamanho < 1) return;
  switch (static_cast<Entrada>(dados[0])) {
    case Entrada::kMover: {
      if (tamanho < sizeof(MsgMover)) return;
      MsgMover m{};
      memcpy(&m, dados, sizeof(m));
      // Conciliar ANTES de mover: se o "apertar" se perdeu na rede, é este
      // movimento que o reconstrói — e ele precisa acontecer no ponto novo, não
      // no antigo. Mesma regra do aplicativo atual (shared/gesto-mouse.ts).
      injetor.MoverPara(m.fx, m.fy);
      injetor.ConciliarBotoes(m.botoes);
      return;
    }
    case Entrada::kBotao: {
      if (tamanho < sizeof(MsgBotao)) return;
      MsgBotao m{};
      memcpy(&m, dados, sizeof(m));
      injetor.MoverPara(m.fx, m.fy);
      injetor.Botao(static_cast<Botao>(m.qual), m.desce != 0);
      return;
    }
    case Entrada::kRoda: {
      if (tamanho < sizeof(MsgRoda)) return;
      MsgRoda m{};
      memcpy(&m, dados, sizeof(m));
      injetor.MoverPara(m.fx, m.fy);
      injetor.Roda(m.horizontal, m.vertical);
      return;
    }
    case Entrada::kTecla: {
      if (tamanho < sizeof(MsgTecla)) return;
      MsgTecla m{};
      memcpy(&m, dados, sizeof(m));
      injetor.Tecla(m.scan, m.estendida != 0, m.desce != 0);
      return;
    }
    case Entrada::kSoltarTudo:
      injetor.SoltarTudo();
      return;
  }
}

}  // namespace

int RodarAnfitriao(const Opcoes& op) {
  RelogioFino fino;

  Duplicador duplicador;
  std::string erro;
  if (!duplicador.Iniciar(op.monitor, &erro)) {
    RY_ERRO("captura: %s", erro.c_str());
    return 1;
  }
  const uint32_t L = duplicador.Largura();
  const uint32_t A = duplicador.Altura();
  RY_INFO("captura: monitor %u, %ux%u", op.monitor, L, A);

  Codificador codificador;
  if (!codificador.Iniciar(L, A, op.fps, op.bps_inicial, &erro)) {
    RY_ERRO("codificador: %s", erro.c_str());
    return 1;
  }

  Injetor injetor;
  Fio fio;
  if (!fio.Servir(op.porta, op.senha, &erro)) {
    RY_ERRO("rede: %s", erro.c_str());
    return 1;
  }
  fio.DefinirLimiteBps(op.bps_maximo);
  fio.DefinirOrcamentoBps(op.bps_inicial);

  fio.ao_receber_entrada = [&](const uint8_t* d, size_t n) { AplicarEntrada(injetor, d, n); };
  fio.ao_pedir_chave = [&] {
    RY_DETALHE("o visitante pediu quadro-chave");
    codificador.ForcarQuadroChave();
  };
  fio.ao_cair = [&](const std::string& motivo) {
    RY_AVISO("sessao encerrada: %s", motivo.c_str());
    // Um botão preso na máquina de quem compartilhou a tela é o pior estrago
    // possível. Soltar aqui, sem exceção, em qualquer caminho de saída.
    injetor.SoltarTudo();
  };

  RY_INFO("anfitriao pronto na porta %u — esperando visitante", fio.PortaLocal());

  std::vector<uint8_t> bgra;
  std::vector<uint8_t> nv12(TamanhoNv12(L, A));
  std::vector<PacoteCodificado> saiu;

  uint32_t numero = 1;
  uint64_t ultimo_relato = AgoraUs();
  uint32_t quadros_no_segundo = 0;
  uint64_t soma_captura_us = 0, soma_cor_us = 0, soma_codec_us = 0;
  bool ja_conectou = false;

  while (true) {
    fio.Bombear(0);
    if (!fio.Conectado()) {
      if (ja_conectou) break;
      DormirUs(2000);
      continue;
    }
    if (!ja_conectou) {
      ja_conectou = true;
      codificador.ForcarQuadroChave();
      RY_INFO("visitante conectado de %s", fio.Parceiro().Texto().c_str());
    }

    // 1. capturar
    const uint64_t t0 = AgoraUs();
    uint32_t lg = 0, at = 0;
    const Resultado r = duplicador.Proximo(4, &bgra, &lg, &at, &erro);
    if (r == Resultado::kPerdido) {
      // Acontece de verdade: o UAC entrou, a resolução mudou, o driver
      // reiniciou. Recriar e seguir — não é falha fatal.
      RY_AVISO("captura perdida, recriando");
      duplicador.Parar();
      if (!duplicador.Iniciar(op.monitor, &erro)) DormirUs(200000);
      continue;
    }
    if (r == Resultado::kErro) {
      RY_ERRO("captura: %s", erro.c_str());
      DormirUs(50000);
      continue;
    }
    if (r == Resultado::kSemNovidade) {
      // Tela parada não gera quadro, e é o estado mais comum de um computador.
      // Não mandar nada é o certo: o outro lado já tem esta imagem.
      continue;
    }
    const uint64_t t1 = AgoraUs();

    // 2. converter
    BgraParaNv12Paralelo(bgra.data(), lg * 4, lg, at, nv12.data());
    const uint64_t t2 = AgoraUs();

    // 3. codificar, no ritmo que a rede está aguentando
    codificador.DefinirBitrate(fio.OrcamentoBps());
    saiu.clear();
    if (!codificador.Codificar(nv12.data(), nv12.size(), AgoraUs(), &saiu, &erro)) {
      RY_ERRO("codificar: %s", erro.c_str());
      continue;
    }
    const uint64_t t3 = AgoraUs();

    // 4. mandar
    for (auto& p : saiu) {
      fio.EnviarQuadro(numero++, p.chave, static_cast<uint16_t>(lg), static_cast<uint16_t>(at),
                       p.dados.data(), p.dados.size());
    }

    quadros_no_segundo++;
    soma_captura_us += t1 - t0;
    soma_cor_us += t2 - t1;
    soma_codec_us += t3 - t2;

    const uint64_t agora = AgoraUs();
    if (agora - ultimo_relato >= 2000000ull) {
      const double s = static_cast<double>(agora - ultimo_relato) / 1e6;
      const auto& m = fio.Medidas();
      RY_INFO(
          "%.0f q/s · saida %u kb/s · rtt %.1f ms · perda %.1f%% · orcamento %u kb/s | "
          "captura %.1f ms · cor %.1f ms · codec %.1f ms",
          quadros_no_segundo / s, m.kbps_saida, m.rtt_us / 1000.0, m.perda_pct, fio.OrcamentoBps() / 1000,
          quadros_no_segundo ? soma_captura_us / 1000.0 / quadros_no_segundo : 0.0,
          quadros_no_segundo ? soma_cor_us / 1000.0 / quadros_no_segundo : 0.0,
          quadros_no_segundo ? soma_codec_us / 1000.0 / quadros_no_segundo : 0.0);
      quadros_no_segundo = 0;
      soma_captura_us = soma_cor_us = soma_codec_us = 0;
      ultimo_relato = agora;
    }
  }

  injetor.SoltarTudo();
  RY_INFO("anfitriao encerrado");
  return 0;
}

}  // namespace ryke
