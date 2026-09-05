// A janela do visitante: onde a tela do outro computador aparece.
//
// Win32 puro, sem framework. São duas janelas: a de fora, com a barra de estado
// embaixo, e uma filha que ocupa o resto e onde o Direct3D desenha. Separar as
// duas resolve um conflito real — a cadeia de troca em modo "flip" não convive
// bem com controles comuns desenhados por cima dela.
//
// A ENTRADA SAI DAQUI EM FRAÇÃO, NUNCA EM PIXEL
//
// A janela pode ter qualquer tamanho e a tela do outro lado tem o dela. Quem
// converte é este arquivo, uma vez, no ponto em que ele sabe onde a imagem foi
// desenhada — inclusive as barras pretas das sobras. Mandar pixel obrigaria o
// outro lado a adivinhar a nossa geometria.

#pragma once

#include <cstdint>
#include <functional>
#include <string>

struct HWND__;

namespace ryke {

struct EventoMouse {
  double fx = 0;
  double fy = 0;
  uint32_t botoes = 0;   // máscara do que está apertado
  int botao = -1;        // qual mudou (-1 = só movimento)
  bool desce = false;
  int roda_vertical = 0;
  int roda_horizontal = 0;
};

struct EventoTecla {
  uint16_t scan = 0;
  bool estendida = false;
  bool desce = false;
};

class Janela {
 public:
  Janela() = default;
  ~Janela();
  Janela(const Janela&) = delete;
  Janela& operator=(const Janela&) = delete;

  std::function<void(const EventoMouse&)> ao_mouse;
  std::function<void(const EventoTecla&)> ao_tecla;
  std::function<void()> ao_perder_foco;
  std::function<void()> ao_fechar;

  bool Abrir(const std::string& titulo, int largura, int altura, std::string* erro);
  void Fechar();

  // Onde o Direct3D desenha.
  HWND__* AreaDeVideo() const { return video_; }
  HWND__* Principal() const { return janela_; }

  // Trata as mensagens pendentes. Devolve false quando a janela foi fechada.
  bool Bombear();

  void DefinirTextoDaBarra(const std::string& texto);
  void DefinirTitulo(const std::string& texto);

  // A imagem tem esta proporção: a janela usa isso para converter o ponteiro
  // em fração, descontando as barras pretas.
  void DefinirTamanhoDaImagem(uint32_t largura, uint32_t altura);

  void AlternarTelaCheia();

  // Quanto mede a área de vídeo agora.
  uint32_t LarguraDoVideo() const { return largura_video_; }
  uint32_t AlturaDoVideo() const { return altura_video_; }
  bool Redimensionou();

 private:
  static int64_t __stdcall Procedimento(HWND__* h, uint32_t msg, uint64_t wp, int64_t lp);
  int64_t Tratar(HWND__* h, uint32_t msg, uint64_t wp, int64_t lp);
  void Reposicionar();
  bool PontoParaFracao(int x, int y, double* fx, double* fy) const;
  uint32_t MascaraAtual(uint64_t wp) const;

  HWND__* janela_ = nullptr;
  HWND__* video_ = nullptr;
  HWND__* barra_ = nullptr;
  bool fechada_ = false;
  bool redimensionou_ = false;
  bool tela_cheia_ = false;
  uint32_t largura_video_ = 0;
  uint32_t altura_video_ = 0;
  uint32_t largura_imagem_ = 1920;
  uint32_t altura_imagem_ = 1080;
  // Para restaurar ao sair da tela cheia.
  int32_t guardado_[4] = {};
  uint32_t estilo_guardado_ = 0;
};

}  // namespace ryke
