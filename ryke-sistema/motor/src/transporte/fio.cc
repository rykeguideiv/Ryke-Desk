#include "transporte/fio.h"

#include "base/log.h"
#include "base/tempo.h"

#include <algorithm>
#include <cstring>

namespace ryke {
namespace {

// Quanto tempo um quadro incompleto ainda vale a pena. Passado isso, insistir
// só atrasa o que vem depois: o quadro seguinte já o tornou obsoleto.
uint32_t PrazoDoQuadroUs(uint32_t rtt_ms) { return (rtt_ms * 2 + 40) * 1000; }

// Espaço entre dois pedidos de retransmissão do mesmo quadro. Menos do que meio
// RTT e pediríamos de novo o que já está a caminho.
uint32_t EspacoDoPedidoUs(uint32_t rtt_ms) { return std::max<uint32_t>(rtt_ms * 500, 4000); }

uint64_t ChaveDoPedaco(uint32_t quadro, uint16_t pedaco) {
  return (static_cast<uint64_t>(quadro) << 16) | pedaco;
}

constexpr size_t kMaxBytesGuardados = 6 * 1024 * 1024;
constexpr size_t kMaxFilaPedacos = 20000;

}  // namespace

Fio::~Fio() { Encerrar(); }

bool Fio::AbrirSoquete(uint16_t porta, std::string* erro) {
  if (!soquete_.Abrir(porta, erro)) return false;
  est_ = Estatisticas{};
  ultima_janela_us_ = AgoraUs();
  ultimo_pacote_recebido_us_ = AgoraUs();
  inicio_aperto_us_ = AgoraUs();
  return true;
}

bool Fio::Servir(uint16_t porta, const std::string& senha, std::string* erro) {
  sou_anfitriao_ = true;
  senha_ = senha;
  if (!AbrirSoquete(porta, erro)) return false;
  if (!par_.Gerar(erro)) return false;
  meu_nonce_ = Sortear(16);
  fase_ = Fase::kEsperandoOla;
  RY_INFO("fio: servindo na porta %u, esperando visitante", soquete_.PortaLocal());
  return true;
}

bool Fio::Conectar(const Endereco& destino, const std::string& senha, std::string* erro) {
  sou_anfitriao_ = false;
  senha_ = senha;
  parceiro_ = destino;
  if (!AbrirSoquete(0, erro)) return false;
  if (!par_.Gerar(erro)) return false;
  meu_nonce_ = Sortear(16);
  Sortear(reinterpret_cast<uint8_t*>(&sessao_), sizeof(sessao_));
  fase_ = Fase::kEsperandoOlaOk;
  tentativas_ola_ = 0;
  MandarOla();
  RY_INFO("fio: procurando %s", destino.Texto().c_str());
  return true;
}

void Fio::Encerrar() {
  if (fase_ == Fase::kPronto) MandarCifrado(Tipo::kTchau, nullptr, 0);
  fase_ = Fase::kParado;
  soquete_.Fechar();
  fila_.clear();
  guardados_.clear();
  ordem_guardados_.clear();
  bytes_guardados_ = 0;
  montando_.clear();
  entrada_pendente_.clear();
  entrada_fora_de_ordem_.clear();
}

void Fio::CairPor(const std::string& motivo) {
  if (fase_ == Fase::kParado) return;
  RY_AVISO("fio: %s", motivo.c_str());
  fase_ = Fase::kParado;
  if (ao_cair) ao_cair(motivo);
}

void Fio::MandarOla() {
  // O cumprimento vai em claro: é ele que combina a chave. Leva a pública ECDH
  // e um nonce, e nada mais — nem a senha, que nunca sai daqui.
  std::vector<uint8_t> corpo;
  corpo.insert(corpo.end(), par_.Publica().begin(), par_.Publica().end());
  corpo.insert(corpo.end(), meu_nonce_.begin(), meu_nonce_.end());
  MandarCru(sou_anfitriao_ ? Tipo::kOlaOk : Tipo::kOla, corpo.data(), corpo.size());
}

bool Fio::MandarCru(Tipo tipo, const uint8_t* corpo, size_t tamanho) {
  if (parceiro_.Vazio()) return false;
  std::vector<uint8_t> pacote(sizeof(Cabecalho) + tamanho);
  Cabecalho cab{};
  cab.versao = kVersao;
  cab.tipo = static_cast<uint8_t>(tipo);
  cab.sessao = sessao_;
  cab.nonce = 0;
  memcpy(pacote.data(), &cab, sizeof(cab));
  if (tamanho) memcpy(pacote.data() + sizeof(cab), corpo, tamanho);
  std::string erro;
  const bool ok = soquete_.Enviar(parceiro_, pacote.data(), pacote.size(), &erro);
  if (ok) {
    est_.bytes_enviados += pacote.size();
    bytes_na_janela_saida_ += pacote.size();
  }
  return ok;
}

bool Fio::MandarCifrado(Tipo tipo, const uint8_t* corpo, size_t tamanho) {
  if (!cifra_saida_.Pronta() || parceiro_.Vazio()) return false;

  Cabecalho cab{};
  cab.versao = kVersao;
  cab.tipo = static_cast<uint8_t>(tipo);
  cab.sessao = sessao_;
  cab.nonce = proximo_nonce_++;

  std::vector<uint8_t> pacote(sizeof(Cabecalho));
  memcpy(pacote.data(), &cab, sizeof(cab));

  std::string erro;
  if (!cifra_saida_.Selar(cab.nonce, pacote.data(), sizeof(cab), corpo, tamanho, &pacote, &erro)) {
    RY_ERRO("fio: não consegui cifrar: %s", erro.c_str());
    return false;
  }
  const bool ok = soquete_.Enviar(parceiro_, pacote.data(), pacote.size(), &erro);
  if (ok) {
    est_.bytes_enviados += pacote.size();
    bytes_na_janela_saida_ += pacote.size();
  }
  return ok;
}

bool Fio::FecharAperto(const std::vector<uint8_t>& publica_do_outro, const std::vector<uint8_t>& nonce_deles,
                       bool sou_anfitriao) {
  std::string erro;
  std::vector<uint8_t> segredo;
  if (!par_.Combinar(publica_do_outro, &segredo, &erro)) {
    RY_ERRO("fio: ECDH falhou: %s", erro.c_str());
    return false;
  }

  // A ordem dos nonces na derivação tem de ser a MESMA nos dois lados, senão as
  // chaves saem diferentes e nada abre. Fixamos: primeiro o do visitante.
  const std::vector<uint8_t>& nonce_visitante = sou_anfitriao ? nonce_deles : meu_nonce_;
  const std::vector<uint8_t>& nonce_anfitriao = sou_anfitriao ? meu_nonce_ : nonce_deles;

  std::vector<uint8_t> ida, volta;
  if (!DerivarSegredo(segredo, nonce_visitante, nonce_anfitriao, senha_, &ida, &volta, &erro)) {
    RY_ERRO("fio: derivação falhou: %s", erro.c_str());
    return false;
  }

  // "ida" é visitante → anfitrião. Cada lado cifra com a sua e abre com a outra.
  const std::vector<uint8_t>& minha_saida = sou_anfitriao ? volta : ida;
  const std::vector<uint8_t>& minha_entrada = sou_anfitriao ? ida : volta;
  if (!cifra_saida_.Abrir(minha_saida, &erro) || !cifra_entrada_.Abrir(minha_entrada, &erro)) {
    RY_ERRO("fio: AES falhou: %s", erro.c_str());
    return false;
  }

  fase_ = Fase::kPronto;
  proximo_nonce_ = 1;
  anti_repeticao_ = AntiRepeticao{};
  ultimo_pacote_recebido_us_ = AgoraUs();
  RY_INFO("fio: conectado a %s (cifrado, AES-256-GCM)", parceiro_.Texto().c_str());
  return true;
}

bool Fio::EnviarQuadro(uint32_t numero, bool chave, uint16_t largura, uint16_t altura, const uint8_t* dados,
                       size_t tamanho) {
  if (fase_ != Fase::kPronto || tamanho == 0) return false;
  if (fila_.size() > kMaxFilaPedacos) {
    // A fila estourou: a rede não está dando conta do que o codificador produz.
    // Jogar fora o que ainda não saiu é melhor do que crescer sem fim — o
    // quadro velho não interessa mais a ninguém.
    RY_AVISO("fio: fila cheia (%zu pedaços), descartando o atraso", fila_.size());
    fila_.clear();
  }

  const uint32_t por_pacote = kCorpoVideoMax;
  const uint32_t pedacos = static_cast<uint32_t>((tamanho + por_pacote - 1) / por_pacote);
  if (pedacos > 0xFFFF) {
    RY_ERRO("fio: quadro grande demais (%zu bytes)", tamanho);
    return false;
  }

  for (uint32_t i = 0; i < pedacos; i++) {
    const uint32_t deslocamento = i * por_pacote;
    const uint32_t neste = std::min<uint32_t>(por_pacote, static_cast<uint32_t>(tamanho) - deslocamento);

    CabecalhoVideo cv{};
    cv.quadro = numero;
    cv.deslocamento = deslocamento;
    cv.tamanho_total = static_cast<uint32_t>(tamanho);
    cv.pedaco = static_cast<uint16_t>(i);
    cv.pedacos = static_cast<uint16_t>(pedacos);
    cv.largura = largura;
    cv.altura = altura;
    cv.chave = chave ? 1 : 0;

    std::vector<uint8_t> corpo(sizeof(cv) + neste);
    memcpy(corpo.data(), &cv, sizeof(cv));
    memcpy(corpo.data() + sizeof(cv), dados + deslocamento, neste);

    PedacoNaFila p;
    p.quadro = numero;
    p.pedaco = static_cast<uint16_t>(i);
    p.datagrama = std::move(corpo);
    fila_.push_back(std::move(p));
  }
  return true;
}

void Fio::Guardar(const PedacoNaFila& p) {
  const uint64_t k = ChaveDoPedaco(p.quadro, p.pedaco);
  guardados_[k] = p.datagrama;
  ordem_guardados_.push_back(k);
  bytes_guardados_ += p.datagrama.size();
  while (bytes_guardados_ > kMaxBytesGuardados && !ordem_guardados_.empty()) {
    const uint64_t velho = ordem_guardados_.front();
    ordem_guardados_.pop_front();
    auto it = guardados_.find(velho);
    if (it != guardados_.end()) {
      bytes_guardados_ -= it->second.size();
      guardados_.erase(it);
    }
  }
}

void Fio::EscoarFila(uint64_t agora_us) {
  if (fila_.empty()) {
    ultimo_envio_us_ = agora_us;
    credito_bytes_ = 0;
    return;
  }
  // Ritmo: o orçamento em bits por segundo vira uma cota de bytes que vai
  // acumulando com o tempo. Sem isto, um quadro-chave de 200 KB sai numa rajada
  // de 170 datagramas colados, e é assim que se enche o buffer de qualquer
  // roteador no caminho — a perda que vem depois é auto-infligida.
  const uint64_t passou = agora_us - ultimo_envio_us_;
  ultimo_envio_us_ = agora_us;
  credito_bytes_ += (static_cast<double>(orcamento_bps_) / 8.0) * (static_cast<double>(passou) / 1e6);
  // Um teto no crédito: parado por meio segundo, ele não pode acumular meio
  // segundo de rajada e soltar tudo de uma vez.
  const double teto = static_cast<double>(orcamento_bps_) / 8.0 * 0.05;
  if (credito_bytes_ > teto) credito_bytes_ = teto;

  while (!fila_.empty() && credito_bytes_ > 0) {
    PedacoNaFila& p = fila_.front();
    if (!MandarCifrado(Tipo::kVideo, p.datagrama.data(), p.datagrama.size())) break;
    credito_bytes_ -= static_cast<double>(p.datagrama.size() + sizeof(Cabecalho) + kSeloGcm);
    Guardar(p);
    fila_.pop_front();
  }
}

bool Fio::EnviarEntrada(const uint8_t* dados, size_t tamanho) {
  if (fase_ != Fase::kPronto) return false;
  EntradaPendente e;
  e.sequencia = proxima_seq_entrada_++;
  CabecalhoEntrada ce{};
  ce.sequencia = e.sequencia;
  e.corpo.resize(sizeof(ce) + tamanho);
  memcpy(e.corpo.data(), &ce, sizeof(ce));
  memcpy(e.corpo.data() + sizeof(ce), dados, tamanho);
  e.enviado_us = AgoraUs();
  e.tentativas = 1;
  MandarCifrado(Tipo::kEntrada, e.corpo.data(), e.corpo.size());
  entrada_pendente_.push_back(std::move(e));
  return true;
}

bool Fio::PedirQuadroChave() {
  if (fase_ != Fase::kPronto) return false;
  return MandarCifrado(Tipo::kChave, nullptr, 0);
}

void Fio::Bombear(uint32_t prazo_ms) {
  if (fase_ == Fase::kParado) return;

  // 1. o que chegou
  std::vector<uint8_t> buffer;
  Endereco de;
  std::string erro;
  uint32_t restante = prazo_ms;
  while (true) {
    const int n = soquete_.Receber(&buffer, &de, restante, &erro);
    restante = 0;  // as leituras seguintes não esperam: só drenam o que já está lá
    if (n < 0) {
      CairPor("o soquete falhou: " + erro);
      return;
    }
    if (n == 0) break;
    est_.bytes_recebidos += static_cast<uint64_t>(n);
    bytes_na_janela_entrada_ += static_cast<uint64_t>(n);
    Tratar(buffer.data(), buffer.size(), de);
    if (fase_ == Fase::kParado) return;
  }

  const uint64_t agora = AgoraUs();

  // 2. o cumprimento, enquanto ele não fecha
  if (fase_ == Fase::kEsperandoOlaOk && agora - inicio_aperto_us_ > 250000ull * (tentativas_ola_ + 1)) {
    if (++tentativas_ola_ > 20) {
      CairPor("o outro lado não respondeu");
      return;
    }
    inicio_aperto_us_ = agora;
    MandarOla();
  }

  if (fase_ != Fase::kPronto) return;

  // 3. o que ainda não saiu, no ritmo da rede
  EscoarFila(agora);
  // 4. quadros incompletos: pedir de volta ou desistir
  CuidarDaMontagem(agora);
  // 5. entrada não confirmada: insistir
  CuidarDaEntrada(agora);
  // 6. medir
  Pulsar(agora);
  AtualizarOrcamento(agora);

  if (agora - ultimo_pacote_recebido_us_ > 8000000ull) CairPor("o outro lado sumiu (8 s sem nada)");
}

void Fio::Tratar(const uint8_t* dados, size_t tamanho, const Endereco& de) {
  if (tamanho < sizeof(Cabecalho)) return;
  Cabecalho cab{};
  memcpy(&cab, dados, sizeof(cab));
  if (cab.versao != kVersao) return;

  const uint8_t* corpo = dados + sizeof(Cabecalho);
  const size_t corpo_len = tamanho - sizeof(Cabecalho);
  const Tipo tipo = static_cast<Tipo>(cab.tipo);

  if (tipo == Tipo::kOla || tipo == Tipo::kOlaOk) {
    TratarClaro(cab, corpo, corpo_len, de);
    return;
  }

  if (fase_ != Fase::kPronto) return;
  if (de != parceiro_) return;
  if (cab.sessao != sessao_) return;
  // Um pacote com nonce repetido é lixo — ou alguém regravando um pacote antigo
  // para fazer o clique acontecer de novo. Ver AntiRepeticao.
  if (!anti_repeticao_.Aceitar(cab.nonce)) return;

  std::vector<uint8_t> claro;
  std::string erro;
  if (!cifra_entrada_.Abrir(cab.nonce, dados, sizeof(Cabecalho), corpo, corpo_len, &claro, &erro)) return;

  ultimo_pacote_recebido_us_ = AgoraUs();
  TratarCifrado(cab, claro);
}

void Fio::TratarClaro(const Cabecalho& cab, const uint8_t* corpo, size_t tamanho, const Endereco& de) {
  if (tamanho < 80) return;  // 64 da pública + 16 do nonce
  const Tipo tipo = static_cast<Tipo>(cab.tipo);

  std::vector<uint8_t> publica(corpo, corpo + 64);
  std::vector<uint8_t> nonce(corpo + 64, corpo + 80);

  if (sou_anfitriao_ && tipo == Tipo::kOla && fase_ == Fase::kEsperandoOla) {
    parceiro_ = de;
    sessao_ = cab.sessao;
    if (!FecharAperto(publica, nonce, true)) return;
    // A resposta vai DEPOIS de fechar deste lado: se ela se perder, o visitante
    // repete o cumprimento e nós respondemos de novo — sem refazer a chave,
    // porque a dele é a mesma.
    MandarOla();
    return;
  }

  if (sou_anfitriao_ && tipo == Tipo::kOla && fase_ == Fase::kPronto && de == parceiro_) {
    MandarOla();  // ele não ouviu a resposta; repetimos
    return;
  }

  if (!sou_anfitriao_ && tipo == Tipo::kOlaOk && fase_ == Fase::kEsperandoOlaOk && de == parceiro_) {
    FecharAperto(publica, nonce, false);
  }
}

void Fio::TratarCifrado(const Cabecalho& cab, const std::vector<uint8_t>& corpo) {
  switch (static_cast<Tipo>(cab.tipo)) {
    case Tipo::kVideo:
      TratarVideo(corpo);
      break;
    case Tipo::kFalta:
      TratarFalta(corpo);
      break;
    case Tipo::kEntrada:
      TratarEntrada(corpo);
      break;
    case Tipo::kEntradaOk:
      TratarEntradaOk(corpo);
      break;
    case Tipo::kPing: {
      if (corpo.size() < sizeof(CabecalhoPing)) break;
      MandarCifrado(Tipo::kPong, corpo.data(), corpo.size());
      break;
    }
    case Tipo::kPong: {
      if (corpo.size() < sizeof(CabecalhoPing)) break;
      CabecalhoPing cp{};
      memcpy(&cp, corpo.data(), sizeof(cp));
      const uint32_t agora_rtt = static_cast<uint32_t>(AgoraUs() - cp.carimbo_us);
      // Média móvel curta: um RTT isolado alto é ruído, mas uma subida
      // sustentada é fila se formando e precisa aparecer rápido.
      est_.rtt_us = est_.rtt_us == 0 ? agora_rtt : (est_.rtt_us * 3 + agora_rtt) / 4;
      if (est_.rtt_min_us == 0 || agora_rtt < est_.rtt_min_us) est_.rtt_min_us = agora_rtt;
      est_.rtt_ms = (est_.rtt_us + 500) / 1000;
      est_.rtt_min_ms = (est_.rtt_min_us + 500) / 1000;
      break;
    }
    case Tipo::kChave:
      if (ao_pedir_chave) ao_pedir_chave();
      break;
    case Tipo::kTchau:
      CairPor("o outro lado encerrou");
      break;
    default:
      break;
  }
}

void Fio::TratarVideo(const std::vector<uint8_t>& corpo) {
  if (corpo.size() < sizeof(CabecalhoVideo)) return;
  CabecalhoVideo cv{};
  memcpy(&cv, corpo.data(), sizeof(cv));
  const uint8_t* dados = corpo.data() + sizeof(cv);
  const size_t tamanho = corpo.size() - sizeof(cv);

  if (cv.pedacos == 0 || cv.tamanho_total == 0) return;
  if (cv.deslocamento + tamanho > cv.tamanho_total) return;
  // Já entregamos este quadro ou um mais novo: o pedaço é de um quadro morto.
  if (cv.quadro <= ultimo_entregue_) return;

  pedacos_na_janela_++;
  if (cv.quadro > maior_quadro_visto_) maior_quadro_visto_ = cv.quadro;

  auto& q = montando_[cv.quadro];
  if (q.pedacos == 0) {
    q.numero = cv.quadro;
    q.chave = cv.chave != 0;
    q.largura = cv.largura;
    q.altura = cv.altura;
    q.tamanho_total = cv.tamanho_total;
    q.pedacos = cv.pedacos;
    q.chegou.assign(cv.pedacos, false);
    q.dados.assign(cv.tamanho_total, 0);
    q.primeiro_us = AgoraUs();
    q.ultimo_pedaco_us = q.primeiro_us;
    q.ultimo_pedido_us = q.primeiro_us;
  }
  if (cv.pedaco >= q.pedacos || q.chegou[cv.pedaco]) return;
  q.ultimo_pedaco_us = AgoraUs();

  memcpy(q.dados.data() + cv.deslocamento, dados, tamanho);
  q.chegou[cv.pedaco] = true;
  q.recebidos++;

  if (q.recebidos == q.pedacos) {
    QuadroRecebido pronto;
    pronto.numero = q.numero;
    pronto.chave = q.chave;
    pronto.largura = q.largura;
    pronto.altura = q.altura;
    pronto.dados = std::move(q.dados);
    pronto.montagem_us = static_cast<uint32_t>(AgoraUs() - q.primeiro_us);
    const uint32_t numero = q.numero;
    montando_.erase(cv.quadro);
    ultimo_entregue_ = numero;
    est_.quadros_completos++;
    // Quadros mais velhos do que este nunca mais serão entregues em ordem —
    // segurar a memória deles não serve a nada.
    for (auto it = montando_.begin(); it != montando_.end();) {
      if (it->first < numero) it = montando_.erase(it);
      else ++it;
    }
    if (ao_receber_quadro) ao_receber_quadro(std::move(pronto));
  }
}

void Fio::CuidarDaMontagem(uint64_t agora_us) {
  const uint32_t prazo = PrazoDoQuadroUs(est_.rtt_ms);
  const uint32_t espaco = EspacoDoPedidoUs(est_.rtt_ms);

  for (auto it = montando_.begin(); it != montando_.end();) {
    QuadroEmMontagem& q = it->second;

    // O prazo conta do ÚLTIMO pedaço que chegou, não do primeiro.
    //
    // Contando do primeiro, um quadro grande morria enquanto ainda estava
    // chegando: 35 pedaços a 4 Mb/s levam 84 ms, e o prazo de 40 ms os matava
    // pelo meio. O resultado media zero por cento de entrega numa rede
    // PERFEITA — e a culpa não era da rede, era desta conta. Um quadro que está
    // progredindo não está travado; abandonar é para quem parou.
    const uint64_t parado = agora_us - q.ultimo_pedaco_us;
    const uint64_t idade = agora_us - q.primeiro_us;
    // ... com um limite absoluto, senão um quadro cujo resto nunca vem — porque
    // o outro lado morreu no meio dele — ficaria na memória para sempre.
    const bool desistir = (parado > prazo && q.numero < maior_quadro_visto_) || idade > 2000000ull;

    if (desistir) {
      // Desistimos. Insistir daqui em diante só atrasa o que vem depois.
      est_.quadros_abandonados++;
      perdas_na_janela_ += (q.pedacos - q.recebidos);
      const uint32_t numero = q.numero;
      it = montando_.erase(it);
      if (numero > ultimo_entregue_) ultimo_entregue_ = numero;
      // Sem este quadro o decodificador perde a referência: só um quadro-chave
      // o traz de volta.
      MandarCifrado(Tipo::kChave, nullptr, 0);
      continue;
    }

    // Só pede de volta quando JÁ CHEGOU pedaço de um quadro mais novo: antes
    // disso, o que falta provavelmente ainda está a caminho, e pedir cedo
    // duplica tráfego justamente quando ele está apertado.
    const bool ficou_para_tras = q.numero < maior_quadro_visto_;
    const bool na_hora = agora_us - q.ultimo_pedido_us > espaco;
    if (ficou_para_tras && na_hora && q.recebidos < q.pedacos) {
      q.ultimo_pedido_us = agora_us;
      std::vector<uint16_t> faltando;
      for (uint16_t i = 0; i < q.pedacos && faltando.size() < 256; i++) {
        if (!q.chegou[i]) faltando.push_back(i);
      }
      if (!faltando.empty()) {
        CabecalhoFalta cf{};
        cf.quadro = q.numero;
        cf.quantos = static_cast<uint16_t>(faltando.size());
        std::vector<uint8_t> corpo(sizeof(cf) + faltando.size() * sizeof(uint16_t));
        memcpy(corpo.data(), &cf, sizeof(cf));
        memcpy(corpo.data() + sizeof(cf), faltando.data(), faltando.size() * sizeof(uint16_t));
        MandarCifrado(Tipo::kFalta, corpo.data(), corpo.size());
        est_.pedacos_pedidos += static_cast<uint32_t>(faltando.size());
      }
    }
    ++it;
  }
}

void Fio::TratarFalta(const std::vector<uint8_t>& corpo) {
  if (corpo.size() < sizeof(CabecalhoFalta)) return;
  CabecalhoFalta cf{};
  memcpy(&cf, corpo.data(), sizeof(cf));
  const size_t esperado = sizeof(cf) + static_cast<size_t>(cf.quantos) * sizeof(uint16_t);
  if (corpo.size() < esperado) return;

  const uint16_t* indices = reinterpret_cast<const uint16_t*>(corpo.data() + sizeof(cf));
  for (uint16_t i = 0; i < cf.quantos; i++) {
    auto it = guardados_.find(ChaveDoPedaco(cf.quadro, indices[i]));
    if (it == guardados_.end()) continue;  // já saiu da memória: não dá para ajudar
    // Vai na FRENTE da fila: um pedaço pedido de volta é o gargalo de um quadro
    // que já está quase pronto do outro lado.
    PedacoNaFila p;
    p.quadro = cf.quadro;
    p.pedaco = indices[i];
    p.datagrama = it->second;
    fila_.push_front(std::move(p));
    est_.pedacos_reenviados++;
  }
}

void Fio::TratarEntrada(const std::vector<uint8_t>& corpo) {
  if (corpo.size() < sizeof(CabecalhoEntrada)) return;
  CabecalhoEntrada ce{};
  memcpy(&ce, corpo.data(), sizeof(ce));
  const uint8_t* dados = corpo.data() + sizeof(ce);
  const size_t tamanho = corpo.size() - sizeof(ce);

  // Confirma SEMPRE, inclusive o que já tínhamos: se a confirmação anterior se
  // perdeu, o outro lado está reenviando e precisa ouvir que já chegou.
  CabecalhoEntrada ok{};
  ok.sequencia = ultima_entrada_recebida_;

  if (ce.sequencia == ultima_entrada_recebida_ + 1) {
    ultima_entrada_recebida_ = ce.sequencia;
    if (ao_receber_entrada) ao_receber_entrada(dados, tamanho);
    // E o que tinha chegado adiantado agora entra na ordem certa.
    while (true) {
      auto it = entrada_fora_de_ordem_.find(ultima_entrada_recebida_ + 1);
      if (it == entrada_fora_de_ordem_.end()) break;
      ultima_entrada_recebida_ = it->first;
      if (ao_receber_entrada) ao_receber_entrada(it->second.data(), it->second.size());
      entrada_fora_de_ordem_.erase(it);
    }
    ok.sequencia = ultima_entrada_recebida_;
  } else if (ce.sequencia > ultima_entrada_recebida_ + 1) {
    // Chegou adiantada: guarda até a que falta aparecer. Entregar fora de ordem
    // seria soltar um botão antes de apertá-lo.
    entrada_fora_de_ordem_[ce.sequencia].assign(dados, dados + tamanho);
  }

  MandarCifrado(Tipo::kEntradaOk, reinterpret_cast<const uint8_t*>(&ok), sizeof(ok));
}

void Fio::TratarEntradaOk(const std::vector<uint8_t>& corpo) {
  if (corpo.size() < sizeof(CabecalhoEntrada)) return;
  CabecalhoEntrada ce{};
  memcpy(&ce, corpo.data(), sizeof(ce));
  while (!entrada_pendente_.empty() && entrada_pendente_.front().sequencia <= ce.sequencia) {
    entrada_pendente_.pop_front();
  }
}

void Fio::CuidarDaEntrada(uint64_t agora_us) {
  const uint64_t espera = std::max<uint64_t>(static_cast<uint64_t>(est_.rtt_ms) * 1500, 12000);
  for (auto& e : entrada_pendente_) {
    if (agora_us - e.enviado_us < espera) continue;
    if (e.tentativas > 40) {
      CairPor("a entrada não está chegando ao outro lado");
      return;
    }
    e.enviado_us = agora_us;
    e.tentativas++;
    MandarCifrado(Tipo::kEntrada, e.corpo.data(), e.corpo.size());
  }
}

void Fio::Pulsar(uint64_t agora_us) {
  if (agora_us - ultimo_ping_us_ < 500000ull) return;
  ultimo_ping_us_ = agora_us;
  CabecalhoPing cp{};
  cp.carimbo_us = agora_us;
  cp.quadros_vistos = est_.quadros_completos;
  MandarCifrado(Tipo::kPing, reinterpret_cast<const uint8_t*>(&cp), sizeof(cp));
}

void Fio::AtualizarOrcamento(uint64_t agora_us) {
  if (agora_us - ultima_janela_us_ < 1000000ull) return;
  const double segundos = static_cast<double>(agora_us - ultima_janela_us_) / 1e6;
  ultima_janela_us_ = agora_us;

  est_.kbps_saida = static_cast<uint32_t>((bytes_na_janela_saida_ * 8.0 / segundos) / 1000.0);
  est_.kbps_entrada = static_cast<uint32_t>((bytes_na_janela_entrada_ * 8.0 / segundos) / 1000.0);
  bytes_na_janela_saida_ = 0;
  bytes_na_janela_entrada_ = 0;

  const uint32_t total = pedacos_na_janela_ + perdas_na_janela_;
  est_.perda_pct = total > 0 ? (100.0 * perdas_na_janela_ / total) : 0.0;
  pedacos_na_janela_ = 0;
  perdas_na_janela_ = 0;

  // Controle de ritmo, versão simples e honesta:
  //
  //   • perda alta OU fila se formando (RTT bem acima do mínimo) → recua forte;
  //   • rede limpa → cresce 8% por segundo.
  //
  // Cresce devagar e recua rápido de propósito. O erro para o lado de baixo
  // custa nitidez; o erro para o lado de cima custa ATRASO, que é o defeito que
  // o usuário sente e o motivo de tudo isto existir.
  const bool fila_formando = est_.rtt_min_ms > 0 && est_.rtt_ms > est_.rtt_min_ms + 50;
  if (est_.perda_pct > 8.0 || fila_formando) {
    orcamento_bps_ = static_cast<uint32_t>(orcamento_bps_ * 0.7);
  } else if (est_.perda_pct > 2.0) {
    orcamento_bps_ = static_cast<uint32_t>(orcamento_bps_ * 0.92);
  } else {
    // Rede limpa: cresce 30% por segundo, e nunca fica abaixo do que já está
    // saindo com folga. Sem a segunda parte, uma sessão que precisa de 20 Mb/s
    // levaria meio minuto para chegar lá partindo de 8 — e os primeiros trinta
    // segundos são justamente quando a pessoa decide se o programa é rápido.
    const uint32_t com_folga = static_cast<uint32_t>(est_.kbps_saida * 1000ull * 3 / 2);
    orcamento_bps_ = std::max<uint32_t>(static_cast<uint32_t>(orcamento_bps_ * 1.3), com_folga);
  }
  orcamento_bps_ = std::max<uint32_t>(orcamento_bps_, 400000);
  orcamento_bps_ = std::min<uint32_t>(orcamento_bps_, limite_bps_);
}

}  // namespace ryke
