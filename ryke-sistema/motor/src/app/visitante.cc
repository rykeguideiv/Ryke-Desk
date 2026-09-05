// O lado que VÊ e CONTROLA.
//
//   rede → remonta o quadro → decodifica (GPU) → desenha (GPU)
//     ↑
//   mouse e teclado da janela ─── vira mensagem de entrada
//
// A regra que define a sensação de rapidez está no laço: nunca segurar um
// quadro esperando o relógio. Se dois quadros chegarem juntos, o segundo passa
// na frente e o primeiro é descartado — mostrar o antigo primeiro só serviria
// para atrasar o novo. Numa sessão remota o único quadro que importa é o mais
// recente.

#include "app/lados.h"

#include "base/log.h"
#include "base/tempo.h"
#include "codec/decodificador.h"
#include "entrada/protocolo-entrada.h"
#include "transporte/fio.h"
#include "ui/janela.h"
#include "ui/pintor.h"

#include <algorithm>
#include <cstring>
#include <deque>
#include <string>

namespace ryke {

int RodarVisitante(const Opcoes& op) {
  RelogioFino fino;

  Endereco alvo;
  std::string erro;
  if (!ResolverEndereco(op.alvo, &alvo, &erro)) {
    RY_ERRO("%s", erro.c_str());
    return 1;
  }

  Janela janela;
  if (!janela.Abrir("Ryke Sistema — conectando...", 1280, 760, &erro)) {
    RY_ERRO("janela: %s", erro.c_str());
    return 1;
  }

  Pintor pintor;
  if (!pintor.Iniciar(janela.AreaDeVideo(), &erro)) {
    RY_ERRO("pintor: %s", erro.c_str());
    return 1;
  }
  pintor.LimparTela();

  Decodificador decodificador;
  bool decodificador_pronto = false;

  Fio fio;
  if (!fio.Conectar(alvo, op.senha, &erro)) {
    RY_ERRO("rede: %s", erro.c_str());
    return 1;
  }
  fio.DefinirLimiteBps(op.bps_maximo);

  // O último quadro que chegou, esperando para ser desenhado. UM só: ver o
  // cabeçalho deste arquivo.
  QuadroRecebido pendente;
  bool tem_pendente = false;
  uint32_t descartados_por_atraso = 0;

  fio.ao_receber_quadro = [&](QuadroRecebido&& q) {
    if (tem_pendente) descartados_por_atraso++;
    pendente = std::move(q);
    tem_pendente = true;
  };
  fio.ao_cair = [&](const std::string& motivo) {
    janela.DefinirTextoDaBarra("sessao encerrada: " + motivo);
    RY_AVISO("%s", motivo.c_str());
  };

  // ── a entrada sai daqui ──
  auto mandar = [&](const void* p, size_t n) {
    if (fio.Conectado()) fio.EnviarEntrada(static_cast<const uint8_t*>(p), n);
  };

  janela.ao_mouse = [&](const EventoMouse& e) {
    if (e.roda_vertical || e.roda_horizontal) {
      MsgRoda m{};
      m.tipo = static_cast<uint8_t>(Entrada::kRoda);
      m.horizontal = static_cast<int16_t>(e.roda_horizontal);
      m.vertical = static_cast<int16_t>(e.roda_vertical);
      m.fx = static_cast<float>(e.fx);
      m.fy = static_cast<float>(e.fy);
      mandar(&m, sizeof(m));
      return;
    }
    if (e.botao >= 0) {
      MsgBotao m{};
      m.tipo = static_cast<uint8_t>(Entrada::kBotao);
      m.qual = static_cast<uint8_t>(e.botao);
      m.desce = e.desce ? 1 : 0;
      m.botoes = static_cast<uint8_t>(e.botoes);
      m.fx = static_cast<float>(e.fx);
      m.fy = static_cast<float>(e.fy);
      mandar(&m, sizeof(m));
      return;
    }
    MsgMover m{};
    m.tipo = static_cast<uint8_t>(Entrada::kMover);
    m.botoes = static_cast<uint8_t>(e.botoes);
    m.fx = static_cast<float>(e.fx);
    m.fy = static_cast<float>(e.fy);
    mandar(&m, sizeof(m));
  };

  janela.ao_tecla = [&](const EventoTecla& e) {
    MsgTecla m{};
    m.tipo = static_cast<uint8_t>(Entrada::kTecla);
    m.scan = e.scan;
    m.estendida = e.estendida ? 1 : 0;
    m.desce = e.desce ? 1 : 0;
    mandar(&m, sizeof(m));
  };

  janela.ao_perder_foco = [&] {
    MsgSoltarTudo m{};
    m.tipo = static_cast<uint8_t>(Entrada::kSoltarTudo);
    mandar(&m, sizeof(m));
  };

  janela.ao_fechar = [&] { fio.Encerrar(); };

  RY_INFO("visitante: procurando %s", alvo.Texto().c_str());

  uint64_t ultimo_relato = AgoraUs();
  uint32_t desenhados = 0;
  uint64_t soma_decodifica_us = 0;
  uint32_t decodificados = 0;
  bool avisou_conectado = false;
  uint32_t ciclos = 0;

  while (janela.Bombear()) {
    // 1 ms de espera no soquete: é o que deixa este laço não girar em falso
    // gastando processador, e é curto o bastante para não atrasar quadro.
    fio.Bombear(1);

    if (janela.Redimensionou()) {
      pintor.Redimensionar(janela.LarguraDoVideo(), janela.AlturaDoVideo());
    }

    if (fio.Conectado() && !avisou_conectado) {
      avisou_conectado = true;
      janela.DefinirTitulo("Ryke Sistema — " + alvo.Texto());
      RY_INFO("conectado");
    }
    if (!fio.Conectado() && avisou_conectado) break;

    if (tem_pendente) {
      QuadroRecebido q = std::move(pendente);
      tem_pendente = false;

      if (!decodificador_pronto) {
        // Só dá para começar num quadro-chave: sem ele o decodificador não tem
        // referência e produz aquela imagem esverdeada e rasgada.
        if (!q.chave) {
          fio.PedirQuadroChave();
          continue;
        }
        if (!decodificador.Iniciar(q.largura, q.altura, &erro)) {
          RY_ERRO("decodificador: %s", erro.c_str());
          break;
        }
        decodificador_pronto = true;
        janela.DefinirTamanhoDaImagem(q.largura, q.altura);
      }

      const uint64_t t0 = AgoraUs();
      std::vector<QuadroDecodificado> saiu;
      if (!decodificador.Decodificar(q.dados.data(), q.dados.size(), q.numero, &saiu, &erro)) {
        RY_AVISO("decodificar falhou (%s) — pedindo quadro-chave", erro.c_str());
        decodificador.Esquecer();
        fio.PedirQuadroChave();
        continue;
      }
      soma_decodifica_us += AgoraUs() - t0;
      decodificados++;

      // Se saiu mais de um, só o ÚLTIMO vai para a tela. Ver o cabeçalho.
      if (!saiu.empty()) {
        const QuadroDecodificado& d = saiu.back();
        janela.DefinirTamanhoDaImagem(d.largura, d.altura);
        if (!pintor.Desenhar(d.nv12.data(), d.largura, d.altura, &erro)) {
          RY_AVISO("desenhar: %s", erro.c_str());
        } else {
          desenhados++;
        }
      }
    }

    const uint64_t agora = AgoraUs();
    if (agora - ultimo_relato >= 1000000ull) {
      const double s = static_cast<double>(agora - ultimo_relato) / 1e6;
      const auto& m = fio.Medidas();
      char linha[512];
      snprintf(linha, sizeof(linha),
               "%.0f q/s · %u kb/s · rtt %.1f ms · perda %.1f%% · decodifica %.1f ms · "
               "quadros perdidos %u · atrasados descartados %u · %s",
               desenhados / s, m.kbps_entrada, m.rtt_us / 1000.0, m.perda_pct,
               decodificados ? soma_decodifica_us / 1000.0 / decodificados : 0.0, m.quadros_abandonados,
               descartados_por_atraso,
               decodificador.PorHardware() ? "decodificador por hardware" : "decodificador por software");
      janela.DefinirTextoDaBarra(linha);
      // E tambem no registro, a cada cinco segundos: a barra some quando a
      // janela fecha, e e justamente depois que fecha que alguem pergunta
      // "quantos quadros estava dando?".
      if (++ciclos % 5 == 0) RY_INFO("%s", linha);
      desenhados = 0;
      decodificados = 0;
      soma_decodifica_us = 0;
      ultimo_relato = agora;
    }
  }

  fio.Encerrar();
  RY_INFO("visitante encerrado");
  return 0;
}

}  // namespace ryke
