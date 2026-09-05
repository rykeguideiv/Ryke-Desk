// A ponte entre o duplicador em C++ e o JavaScript.
//
// A superficie e de proposito minuscula — abrir, pedir quadro, fechar. Toda a
// politica (o que fazer quando o quadro se perde, quando trocar de monitor,
// quantos quadros por segundo pedir) mora do lado do JavaScript, onde da para
// mudar sem recompilar e onde os testes ja vivem.

#include <napi.h>

#include <memory>
#include <string>
#include <vector>

#include "duplicador.h"

namespace {

class Captura : public Napi::ObjectWrap<Captura> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "Captura",
                                      {
                                          InstanceMethod("iniciar", &Captura::Iniciar),
                                          InstanceMethod("proximo", &Captura::Proximo),
                                          InstanceMethod("parar", &Captura::Parar),
                                          InstanceMethod("ativo", &Captura::Ativo),
                                      });
    exports.Set("Captura", func);
    return exports;
  }

  explicit Captura(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<Captura>(info), duplicador_(std::make_unique<ryke::Duplicador>()) {}

 private:
  Napi::Value Iniciar(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    uint32_t indice = 0;
    if (info.Length() > 0 && info[0].IsNumber()) indice = info[0].As<Napi::Number>().Uint32Value();

    std::string erro;
    if (!duplicador_->Iniciar(indice, &erro)) {
      Napi::Error::New(env, erro).ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Object saida = Napi::Object::New(env);
    saida.Set("largura", Napi::Number::New(env, duplicador_->Largura()));
    saida.Set("altura", Napi::Number::New(env, duplicador_->Altura()));
    return saida;
  }

  // Devolve:
  //   null                          — nada mudou na tela dentro do tempo
  //   { perdido: true }             — o duplicador caiu; quem chama recria
  //   { largura, altura, dados }    — quadro novo, em BGRA
  Napi::Value Proximo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    uint32_t timeout = 16;  // ~1 quadro a 60 Hz
    if (info.Length() > 0 && info[0].IsNumber()) timeout = info[0].As<Napi::Number>().Uint32Value();

    std::vector<uint8_t> quadro;
    uint32_t largura = 0, altura = 0;
    std::string erro;
    const ryke::Resultado r = duplicador_->Proximo(timeout, &quadro, &largura, &altura, &erro);

    switch (r) {
      case ryke::Resultado::kSemNovidade:
        return env.Null();
      case ryke::Resultado::kPerdido: {
        Napi::Object saida = Napi::Object::New(env);
        saida.Set("perdido", Napi::Boolean::New(env, true));
        return saida;
      }
      case ryke::Resultado::kErro:
        Napi::Error::New(env, erro).ThrowAsJavaScriptException();
        return env.Undefined();
      case ryke::Resultado::kQuadro:
      default:
        break;
    }

    Napi::Object saida = Napi::Object::New(env);
    saida.Set("largura", Napi::Number::New(env, largura));
    saida.Set("altura", Napi::Number::New(env, altura));
    saida.Set("dados", Napi::Buffer<uint8_t>::Copy(env, quadro.data(), quadro.size()));
    return saida;
  }

  Napi::Value Parar(const Napi::CallbackInfo& info) {
    duplicador_->Parar();
    return info.Env().Undefined();
  }

  Napi::Value Ativo(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), duplicador_->Ativo());
  }

  std::unique_ptr<ryke::Duplicador> duplicador_;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) { return Captura::Init(env, exports); }

}  // namespace

NODE_API_MODULE(ryke_captura, InitAll)
