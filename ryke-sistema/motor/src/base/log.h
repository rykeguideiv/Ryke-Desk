// Registro: console e arquivo, com carimbo de tempo relativo.
//
// O tempo é RELATIVO ao início do processo, em milissegundos, e não a data do
// dia. Num programa de tempo real quase toda pergunta é "quanto tempo passou
// entre estas duas linhas", e ler isso de dois carimbos ISO é trabalho manual
// que ninguém faz — então some a informação que mais importa.

#pragma once

#include <string>

namespace ryke {

enum class Nivel { kDetalhe, kInfo, kAviso, kErro };

// Começa a gravar num arquivo além do console. Chamar de novo troca o arquivo.
void LogParaArquivo(const std::string& caminho);

// Abaixo deste nível nada é registrado. Padrão: kInfo.
void LogNivelMinimo(Nivel nivel);

void LogEscrever(Nivel nivel, const char* formato, ...);

#define RY_DETALHE(...) ::ryke::LogEscrever(::ryke::Nivel::kDetalhe, __VA_ARGS__)
#define RY_INFO(...) ::ryke::LogEscrever(::ryke::Nivel::kInfo, __VA_ARGS__)
#define RY_AVISO(...) ::ryke::LogEscrever(::ryke::Nivel::kAviso, __VA_ARGS__)
#define RY_ERRO(...) ::ryke::LogEscrever(::ryke::Nivel::kErro, __VA_ARGS__)

// Um HRESULT em texto legível — inclusive o texto do Windows quando existe.
std::string TextoDoHResult(long hr);

// O último erro do Windows (GetLastError) em texto legível.
std::string TextoDoUltimoErro();

}  // namespace ryke
