/**
 * A face em JavaScript da captura nativa.
 *
 * Aqui mora a POLITICA — recriar o duplicador quando ele cai, contar quadros,
 * decidir tempos. O modulo em C++ fica só com o que exige compilador: falar
 * Direct3D. Essa divisão é de propósito: politica muda com frequencia, e cada
 * mudanca dela nao deveria custar uma recompilacao.
 */
'use strict';

const { createRequire } = require('node:module');
const path = require('node:path');

/** Caminhos onde o .node pode estar, do mais provavel para o menos. */
const CAMINHOS = [
  path.join(__dirname, 'build', 'Release', 'ryke_captura.node'),
  path.join(__dirname, 'build', 'Debug', 'ryke_captura.node'),
];

let nativo = null;
let erroDeCarga = null;

function carregar() {
  if (nativo || erroDeCarga) return nativo;
  const req = createRequire(__filename);
  const tentativas = [];
  for (const caminho of CAMINHOS) {
    try {
      nativo = req(caminho);
      return nativo;
    } catch (e) {
      tentativas.push(`${path.basename(path.dirname(caminho))}: ${e.message}`);
    }
  }
  // A mensagem cita o Smart App Control de proposito: num Windows 11 recem
  // instalado ele barra .node sem assinatura, e o erro cru ("ERR_DLOPEN_FAILED")
  // nao da nenhuma pista disso. Ja aconteceu neste projeto.
  erroDeCarga = new Error(
    'não consegui carregar a captura nativa. Compile com "npm run build" dentro de ' +
      'ryke-sistema/nativo. Se ela existe e mesmo assim falha, o Smart App Control ' +
      'do Windows pode estar barrando um .node sem assinatura.\n' +
      tentativas.join('\n'),
  );
  return null;
}

/** A captura nativa esta disponivel nesta maquina? */
function disponivel() {
  return carregar() !== null;
}

/** O erro da ultima tentativa de carga, quando `disponivel()` devolve false. */
function porQueNaoCarregou() {
  carregar();
  return erroDeCarga;
}

/**
 * Uma sessao de captura sobre um monitor.
 *
 * Ela se reergue sozinha quando o duplicador cai — e ele cai por motivos
 * rotineiros: a area de trabalho trocou (o UAC entrou), a resolucao mudou, o
 * driver reiniciou. Tratar isso como excecao encheria o log de alarme falso
 * num evento que e simplesmente parte do funcionamento.
 */
class Tela {
  constructor(indice = 0) {
    this.indice = indice;
    this._captura = null;
    this.largura = 0;
    this.altura = 0;
    this.quadros = 0;
    this.recriacoes = 0;
  }

  abrir() {
    const mod = carregar();
    if (!mod) throw porQueNaoCarregou();
    this._captura = new mod.Captura();
    const info = this._captura.iniciar(this.indice);
    this.largura = info.largura;
    this.altura = info.altura;
    return info;
  }

  /**
   * O proximo quadro, ou `null` se nada mudou dentro do tempo.
   *
   * "Nada mudou" e o caso mais comum e NAO e problema: a Desktop Duplication
   * so entrega quadro quando a tela de fato muda. Uma pessoa lendo um texto
   * produz zero quadros, e esta certo.
   */
  proximo(timeoutMs = 16) {
    if (!this._captura) throw new Error('a captura não foi aberta');
    const r = this._captura.proximo(timeoutMs);
    if (r === null) return null;
    if (r.perdido) {
      this.recriacoes++;
      this._captura.parar();
      const info = this._captura.iniciar(this.indice);
      this.largura = info.largura;
      this.altura = info.altura;
      return null;
    }
    this.quadros++;
    return r;
  }

  fechar() {
    if (!this._captura) return;
    this._captura.parar();
    this._captura = null;
  }
}

module.exports = { Tela, disponivel, porQueNaoCarregou };
