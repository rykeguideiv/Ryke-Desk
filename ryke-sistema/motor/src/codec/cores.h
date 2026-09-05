// BGRA (o que a tela dá) → NV12 (o que o codificador quer).
//
// POR QUE ESTA CONVERSÃO EXISTE
//
// A Desktop Duplication entrega BGRA: quatro bytes por pixel, um por canal.
// Todo codificador de vídeo por hardware quer NV12: luminância em um plano e as
// duas cores intercaladas em outro, com a cor na metade da resolução em cada
// eixo. O olho enxerga muito mais detalhe em brilho do que em cor, e é por isso
// que jogar fora três quartos da informação de cor não aparece — mas corta o
// dado pela metade antes mesmo de comprimir.
//
// POR QUE ELA IMPORTA TANTO PARA O DESEMPENHO
//
// A 1920x1080 e 60 quadros por segundo são 124 milhões de pixels por segundo.
// Uma conversão ingênua, um pixel de cada vez, gasta mais tempo do que os 16,7
// ms que existem entre dois quadros — ou seja, ela sozinha derruba a taxa. Por
// isso aqui tem duas coisas: contas em inteiro (nada de ponto flutuante por
// pixel) e divisão do trabalho entre os núcleos.
//
// O DESTINO FINAL DESTE ARQUIVO
//
// É desaparecer. O caminho certo é a GPU converter, sem o quadro nunca descer
// para a memória comum: a tela já está lá dentro quando é capturada, e o
// codificador também vive lá. Enquanto esse caminho não está pronto, esta é a
// ponte — e ela precisa ser rápida o bastante para não ser o gargalo.

#pragma once

#include <cstdint>

namespace ryke {

// Quantos bytes um quadro NV12 ocupa. O plano de brilho é largura*altura; o de
// cor tem metade das linhas, com os dois canais intercalados.
inline size_t TamanhoNv12(uint32_t largura, uint32_t altura) {
  return static_cast<size_t>(largura) * altura * 3 / 2;
}

// Converte um quadro inteiro. `passo_bgra` é quantos bytes há entre o começo de
// duas linhas na origem (pode ser maior do que largura*4).
//
// A altura precisa ser par: o plano de cor junta as linhas duas a duas.
void BgraParaNv12(const uint8_t* bgra, uint32_t passo_bgra, uint32_t largura, uint32_t altura,
                  uint8_t* nv12);

// A mesma coisa, dividida entre os núcleos disponíveis.
//
// `linhas` é sempre par em cada faixa, senão duas faixas vizinhas brigariam
// pela mesma linha do plano de cor.
void BgraParaNv12Paralelo(const uint8_t* bgra, uint32_t passo_bgra, uint32_t largura, uint32_t altura,
                          uint8_t* nv12);

// Quantas linhas de trabalho o conversor paralelo usa. Exposto para o teste
// conseguir provar que o resultado é idêntico ao da versão de uma linha só.
void DefinirLinhasDeTrabalho(unsigned quantas);

}  // namespace ryke
