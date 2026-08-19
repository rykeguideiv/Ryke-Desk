/**
 * Cliente minimo do protocolo de depuracao do Chromium, compartilhado pelos
 * testes. Abre uma aba e avalia JavaScript dentro dela.
 */
import { WebSocket } from 'ws';

export class Aba {
  constructor(nome, ws) {
    this.nome = nome;
    this.ws = ws;
    this.seq = 1;
    this.pendentes = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const espera = this.pendentes.get(msg.id);
      if (espera) {
        this.pendentes.delete(msg.id);
        espera(msg);
      }
    });
  }

  static async abrir(nome, porta, tentativas = 60) {
    for (let i = 0; i < tentativas; i++) {
      try {
        const alvos = await fetch(`http://127.0.0.1:${porta}/json/list`).then((r) => r.json());
        const pagina = alvos.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (pagina) {
          const ws = new WebSocket(pagina.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
          await new Promise((res, rej) => {
            ws.once('open', res);
            ws.once('error', rej);
          });
          return new Aba(nome, ws);
        }
      } catch {
        /* Electron ainda subindo */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${nome}: a porta de depuracao ${porta} nao respondeu`);
  }

  async avaliar(expressao) {
    const id = this.seq++;
    const resposta = await new Promise((res, rej) => {
      const prazo = setTimeout(() => rej(new Error(`${this.nome}: tempo esgotado`)), 30_000);
      this.pendentes.set(id, (msg) => {
        clearTimeout(prazo);
        res(msg);
      });
      this.ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression: expressao, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (resposta.error) throw new Error(`${this.nome}: ${resposta.error.message}`);
    const r = resposta.result;
    if (r.exceptionDetails) {
      throw new Error(`${this.nome}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  /**
   * Repete a avaliacao ate dar um valor verdadeiro ou estourar o prazo.
   *
   * Erros de avaliacao contam como "ainda nao": logo depois de a janela abrir,
   * a pagina ainda esta navegando e o Chromium responde "Execution context was
   * destroyed". Isso e estado transitorio, nao falha do teste.
   */
  async esperar(expressao, prazoMs = 30_000, intervalo = 400) {
    const limite = Date.now() + prazoMs;
    let ultimo;
    let ultimoErro = null;
    while (Date.now() < limite) {
      try {
        ultimo = await this.avaliar(expressao);
        ultimoErro = null;
        if (ultimo) return ultimo;
      } catch (err) {
        ultimoErro = err;
      }
      await new Promise((r) => setTimeout(r, intervalo));
    }
    if (ultimoErro) throw ultimoErro;
    return ultimo ?? false;
  }

  /** Espera a pagina terminar de carregar antes do primeiro comando. */
  async pronta(prazoMs = 30_000) {
    await this.esperar(`document.readyState === 'complete' && !!document.getElementById('root')`, prazoMs, 300);
  }

  fechar() {
    this.ws.close();
  }
}

export const preencher = (seletor, valor) => `(() => {
  const campo = document.querySelector(${JSON.stringify(seletor)});
  if (!campo) return 'campo nao encontrado: ' + ${JSON.stringify(seletor)};
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(campo, ${JSON.stringify(valor)});
  campo.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`;

export const clicarTexto = (texto) => `(() => {
  const alvo = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(texto)}));
  if (!alvo) return 'botao nao encontrado: ' + ${JSON.stringify(texto)};
  alvo.click();
  return 'ok';
})()`;

/**
 * Clica por seletor, quando o texto não distingue.
 *
 * "Salvar" aparece em mais de um lugar da tela — no botão de guardar a senha e
 * no de salvar um favorito. Clicar pelo texto pegava o primeiro da página, que
 * nem sempre é o desejado, e o teste falhava acusando um defeito inexistente.
 */
export const clicarSeletor = (seletor) => `(() => {
  const alvo = document.querySelector(${JSON.stringify(seletor)});
  if (!alvo) return 'nada em: ' + ${JSON.stringify(seletor)};
  if (alvo.disabled) return 'desligado: ' + ${JSON.stringify(seletor)};
  alvo.click();
  return 'ok';
})()`;
