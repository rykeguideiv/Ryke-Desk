cmake_minimum_required(VERSION 3.20)
project(ryke_motor CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
  # /utf-8 nao e opcional aqui: os comentarios e as mensagens deste projeto sao
  # em portugues, e sem isto o MSVC le o arquivo na pagina de codigo local e os
  # acentos viram aviso C4819 — ou pior, texto errado no que o usuario ve.
  add_compile_options(/W4 /permissive- /utf-8 /Zc:__cplusplus /EHsc)
  # UNICODE nao e detalhe: sem ele, macros como IDC_ARROW resolvem para a
  # versao ANSI e nao entram nas funcoes ...W que este projeto usa em todo
  # lugar. Meio termo entre A e W e a origem classica de nome de arquivo
  # acentuado que nao abre.
  add_compile_definitions(NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS UNICODE _UNICODE)
  # Sem isto, um erro de conversao vira aviso e passa despercebido num projeto
  # que vai crescer para dezenas de milhares de linhas.
  add_compile_options(/we4715 /we4716)
endif()

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

# ── a biblioteca do motor ────────────────────────────────────────────
add_library(motor STATIC
  src/base/tempo.cc
  src/base/log.cc
  src/transporte/soquete.cc
  src/transporte/cripto.cc
  src/transporte/fio.cc
  src/captura/duplicador.cc
  src/codec/mf.cc
  src/codec/cores.cc
  src/codec/codificador.cc
  src/codec/decodificador.cc
  src/entrada/injetor.cc
)
target_include_directories(motor PUBLIC src)
target_link_libraries(motor PUBLIC
  ws2_32 bcrypt
  d3d11 dxgi
  mf mfplat mfreadwrite mfuuid
  user32 gdi32 advapi32 winmm ole32
)

# ── provas ───────────────────────────────────────────────────────────
add_executable(prova-transporte testes/prova-transporte.cc)
target_link_libraries(prova-transporte PRIVATE motor)

add_executable(prova-cripto testes/prova-cripto.cc)
target_link_libraries(prova-cripto PRIVATE motor)

add_executable(prova-codec testes/prova-codec.cc)
target_link_libraries(prova-codec PRIVATE motor)

# ── o produto ────────────────────────────────────────────────────────
add_executable(ryke-sistema WIN32
  src/app/principal.cc
  src/app/anfitriao.cc
  src/app/visitante.cc
  src/ui/janela.cc
  src/ui/pintor.cc
)
target_link_libraries(ryke-sistema PRIVATE motor)
