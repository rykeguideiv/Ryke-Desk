// A cifra do fio faz o que promete?
//
// Cada caso aqui é um jeito de o transporte ser atacado ou dar errado na rede
// de verdade: o pacote alterado no caminho, o pacote regravado e reenviado, a
// senha errada, o cabeçalho mexido. Um "sim" aqui não prova que o sistema é
// seguro — prova que estas quatro portas estão fechadas.

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "transporte/cripto.h"

using namespace ryke;

static int falhas = 0;
static void check(const char* rotulo, bool ok, const char* extra = "") {
  printf("%s %s%s%s\n", ok ? " ok  " : "FALHA", rotulo, extra[0] ? " — " : "", extra);
  if (!ok) falhas++;
}

// Fecha um aperto de mão completo entre dois lados e devolve as quatro cifras.
static bool Apertar(const std::string& senha_a, const std::string& senha_b, Cifra* a_saida, Cifra* a_entrada,
                    Cifra* b_saida, Cifra* b_entrada) {
  ParDeChaves a, b;
  std::string erro;
  if (!a.Gerar(&erro) || !b.Gerar(&erro)) return false;

  const std::vector<uint8_t> nonce_a = Sortear(16);
  const std::vector<uint8_t> nonce_b = Sortear(16);

  std::vector<uint8_t> seg_a, seg_b;
  if (!a.Combinar(b.Publica(), &seg_a, &erro)) return false;
  if (!b.Combinar(a.Publica(), &seg_b, &erro)) return false;
  if (seg_a != seg_b) return false;

  std::vector<uint8_t> ida_a, volta_a, ida_b, volta_b;
  if (!DerivarSegredo(seg_a, nonce_a, nonce_b, senha_a, &ida_a, &volta_a, &erro)) return false;
  if (!DerivarSegredo(seg_b, nonce_a, nonce_b, senha_b, &ida_b, &volta_b, &erro)) return false;

  return a_saida->Abrir(ida_a, &erro) && a_entrada->Abrir(volta_a, &erro) && b_saida->Abrir(volta_b, &erro) &&
         b_entrada->Abrir(ida_b, &erro);
}

int main() {
  printf("\n== ECDH e derivacao ==\n\n");
  {
    ParDeChaves a, b;
    std::string erro;
    check("gerar par de chaves A", a.Gerar(&erro), erro.c_str());
    check("gerar par de chaves B", b.Gerar(&erro), erro.c_str());
    check("a publica tem 64 bytes", a.Publica().size() == 64);
    check("as duas publicas sao diferentes", a.Publica() != b.Publica());

    std::vector<uint8_t> sa, sb;
    check("A combina com a publica de B", a.Combinar(b.Publica(), &sa, &erro), erro.c_str());
    check("B combina com a publica de A", b.Combinar(a.Publica(), &sb, &erro), erro.c_str());
    check("os dois chegam ao MESMO segredo", !sa.empty() && sa == sb);

    ParDeChaves c;
    c.Gerar(&erro);
    std::vector<uint8_t> sc;
    c.Combinar(a.Publica(), &sc, &erro);
    check("um terceiro chega a um segredo DIFERENTE", sc != sa);
  }

  printf("\n== a senha entra na chave ==\n\n");
  {
    Cifra as, ae, bs, be;
    check("aperto com a mesma senha fecha", Apertar("segredo", "segredo", &as, &ae, &bs, &be));

    const std::string texto = "a tela inteira de alguem";
    uint8_t cab[16] = {1, 3, 0, 0};
    std::vector<uint8_t> pacote(cab, cab + 16);
    std::string erro;
    check("A sela", as.Selar(7, cab, 16, reinterpret_cast<const uint8_t*>(texto.data()), texto.size(),
                             &pacote, &erro),
          erro.c_str());
    std::vector<uint8_t> aberto;
    check("B abre", be.Abrir(7, cab, 16, pacote.data() + 16, pacote.size() - 16, &aberto, &erro),
          erro.c_str());
    check("e o texto volta igual",
          aberto.size() == texto.size() && memcmp(aberto.data(), texto.data(), texto.size()) == 0);
  }

  {
    // ESTE é o caso que faz o ECDH anônimo virar autenticado: sem a senha
    // certa, o aperto até fecha — e o primeiro pacote não abre.
    Cifra as, ae, bs, be;
    Apertar("senha-certa", "senha-errada", &as, &ae, &bs, &be);
    const std::string texto = "nao deveria ser lido";
    uint8_t cab[16] = {1, 3, 0, 0};
    std::vector<uint8_t> pacote(cab, cab + 16);
    std::string erro;
    as.Selar(1, cab, 16, reinterpret_cast<const uint8_t*>(texto.data()), texto.size(), &pacote, &erro);
    std::vector<uint8_t> aberto;
    const bool abriu = be.Abrir(1, cab, 16, pacote.data() + 16, pacote.size() - 16, &aberto, &erro);
    check("com a SENHA ERRADA o pacote nao abre", !abriu);
  }

  printf("\n== o pacote mexido no caminho ==\n\n");
  {
    Cifra as, ae, bs, be;
    Apertar("x", "x", &as, &ae, &bs, &be);
    const std::string texto = "mouse: 100,200 clique";
    uint8_t cab[16] = {1, 4, 0, 0};
    std::vector<uint8_t> pacote(cab, cab + 16);
    std::string erro;
    as.Selar(3, cab, 16, reinterpret_cast<const uint8_t*>(texto.data()), texto.size(), &pacote, &erro);

    {
      std::vector<uint8_t> mexido = pacote;
      mexido[20] ^= 0x01;  // um bit no corpo
      std::vector<uint8_t> aberto;
      check("um bit trocado no CORPO invalida o pacote",
            !be.Abrir(3, cab, 16, mexido.data() + 16, mexido.size() - 16, &aberto, &erro));
    }
    {
      uint8_t cab_mexido[16];
      memcpy(cab_mexido, cab, 16);
      cab_mexido[1] = 3;  // finge que entrada e video
      std::vector<uint8_t> aberto;
      check("um bit trocado no CABECALHO invalida o pacote",
            !be.Abrir(3, cab_mexido, 16, pacote.data() + 16, pacote.size() - 16, &aberto, &erro));
    }
    {
      std::vector<uint8_t> aberto;
      check("o nonce errado invalida o pacote",
            !be.Abrir(4, cab, 16, pacote.data() + 16, pacote.size() - 16, &aberto, &erro));
    }
    {
      std::vector<uint8_t> curto = pacote;
      curto.resize(20);
      std::vector<uint8_t> aberto;
      check("um pacote truncado nao derruba nada",
            !be.Abrir(3, cab, 16, curto.data() + 16, curto.size() - 16, &aberto, &erro));
    }
  }

  printf("\n== o pacote regravado e reenviado ==\n\n");
  {
    AntiRepeticao ar;
    check("o primeiro passa", ar.Aceitar(1));
    check("o segundo passa", ar.Aceitar(2));
    check("repetir o 2 e recusado", !ar.Aceitar(2));
    check("repetir o 1 e recusado", !ar.Aceitar(1));
    check("fora de ordem, mas novo, passa", ar.Aceitar(5));
    check("o 3 atrasado ainda passa", ar.Aceitar(3));
    check("e nao passa duas vezes", !ar.Aceitar(3));

    // Um salto grande: e o que acontece depois de uma rajada perdida.
    AntiRepeticao ar2;
    ar2.Aceitar(1);
    check("um salto de 10 mil passa", ar2.Aceitar(10000));
    check("e o nonce 1, velho demais, nao passa mais", !ar2.Aceitar(1));
    check("um vizinho recente do salto passa", ar2.Aceitar(9999));
    check("e nao passa duas vezes", !ar2.Aceitar(9999));

    // A janela inteira, um a um: o deslocamento nao pode perder marca.
    AntiRepeticao ar3;
    bool todos = true;
    for (uint64_t i = 1; i <= 3000; i++) todos = todos && ar3.Aceitar(i);
    check("3000 nonces em ordem, todos aceitos", todos);
    bool nenhum = false;
    for (uint64_t i = 2500; i <= 3000; i++) nenhum = nenhum || ar3.Aceitar(i);
    check("e nenhum dos ultimos 500 e aceito de novo", !nenhum);
  }

  printf("\n%s\n\n", falhas == 0 ? "TUDO OK" : (std::to_string(falhas) + " FALHA(S)").c_str());
  return falhas == 0 ? 0 : 1;
}
