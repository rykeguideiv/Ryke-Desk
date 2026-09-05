// Mouse e teclado: o que chega pela rede vira entrada de verdade no Windows.
//
// A MESMA LIÇÃO DO APLICATIVO ATUAL, DE PROPÓSITO
//
// Este módulo nasce sabendo o que custou caro descobrir do outro lado (ver
// src/shared/gesto-mouse.ts e src/main/input.ts no Ryke Desk): um arrasto não é
// "clique com movimento", é uma sequência que precisa chegar inteira e em
// ordem, e um botão que fica apertado numa máquina alheia é o pior estrago que
// um programa destes causa.
//
// Por isso duas coisas estão aqui desde a primeira linha:
//
//   • a máscara de botões, para o anfitrião conseguir remontar o gesto mesmo
//     que uma mensagem se perca;
//   • `SoltarTudo`, chamado quando a sessão cai, quando o visitante some, e
//     quando o programa fecha — de todos os caminhos, sem exceção.

#pragma once

#include <cstdint>
#include <string>

namespace ryke {

// A ordem é a do DOM, a mesma do protocolo e a mesma do aplicativo atual:
// 0 esquerdo · 1 meio · 2 direito · 3 voltar · 4 avançar.
enum class Botao : uint8_t { kEsquerdo = 0, kMeio = 1, kDireito = 2, kVoltar = 3, kAvancar = 4 };

struct Tela {
  int32_t esquerda = 0;
  int32_t topo = 0;
  int32_t largura = 0;
  int32_t altura = 0;
};

// A área de trabalho inteira, somando todos os monitores.
Tela TelaVirtual();

class Injetor {
 public:
  // `fx`,`fy` são frações de 0 a 1 da tela capturada — nunca pixels. Assim o
  // visitante não precisa saber a resolução do outro lado, e mudar de monitor
  // no meio da sessão não desalinha o ponteiro.
  void MoverPara(double fx, double fy);
  void MoverRelativo(int32_t dx, int32_t dy);
  void Botao(ryke::Botao qual, bool apertado);
  void Roda(int32_t horizontal, int32_t vertical);

  // Tecla pela posição física (scan code), não pelo caractere.
  //
  // É a diferença entre funcionar e não funcionar com teclados diferentes: o
  // visitante manda "a tecla que fica ali", e o Windows do anfitrião aplica o
  // layout DELE. Mandar o caractere faria um teclado ABNT2 digitar acentos
  // errados num anfitrião com layout americano.
  void Tecla(uint16_t scan_code, bool estendida, bool apertada);

  // Solta tudo que este injetor deixou apertado. Ver o cabeçalho.
  void SoltarTudo();

  // O que está apertado agora, em máscara de bits (1 esquerdo, 2 meio, ...).
  uint32_t BotoesApertados() const { return botoes_; }

  // Concilia o que está apertado aqui com o que o visitante diz estar apertado.
  // É o mesmo mecanismo de `ajustarBotoes` no aplicativo atual, e existe pelo
  // mesmo motivo: um "apertar" perdido não pode matar o arrasto inteiro.
  void ConciliarBotoes(uint32_t mascara);

 private:
  uint32_t botoes_ = 0;
  // Scan codes apertados. 512 cobre os 256 normais e os 256 estendidos.
  bool teclas_[512] = {};
};

}  // namespace ryke
