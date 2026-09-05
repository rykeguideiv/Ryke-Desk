// Liga o Media Foundation, uma vez por processo.
//
// POR QUE ISTO VIROU UM ARQUIVO PRÓPRIO
//
// Estava dentro do codificador, e o decodificador aproveitava a carona — nos
// testes, onde os dois sobem juntos. No PRODUTO não: o visitante só decodifica,
// nunca codifica, e o Media Foundation nunca era iniciado. O sintoma foi
// "nenhum decodificador H.264 disponivel" numa máquina que tem três, e a causa
// era uma dependência que só existia por acidente da ordem em que o teste
// chamava as coisas.
//
// A lição, e o motivo de o arquivo existir mesmo sendo de dez linhas: quando
// dois módulos dependem de uma inicialização, ela pertence aos dois — não ao
// que por acaso roda primeiro.

#pragma once

namespace ryke {

// Devolve false se o Media Foundation não puder ser usado nesta máquina
// (acontece em edições N do Windows sem o pacote de mídia instalado).
bool GarantirMediaFoundation();

}  // namespace ryke
