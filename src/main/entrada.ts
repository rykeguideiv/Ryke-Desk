/**
 * Por onde a entrada sai: aqui mesmo, ou pelo ajudante elevado.
 *
 * Este módulo tem a mesma cara do `input.ts` de propósito. O `index.ts` troca
 * um import por outro e não muda mais nada — as dezenas de chamadas de
 * `input.moveMouseTo`, `input.key` e companhia continuam idênticas. Uma
 * mudança de arquitetura que não deixa rastro no código que a usa é uma
 * mudança que dá para desfazer.
 *
 * A REGRA
 *
 * Só o que INJETA é roteado. Perguntas sobre o estado da máquina — onde está o
 * cursor, que forma ele tem, se a área protegida está na frente — continuam
 * sendo respondidas aqui, porque funcionam sem privilégio nenhum e mandá-las
 * pelo cano só acrescentaria atraso a algo que roda vinte vezes por segundo.
 *
 * E QUANDO O AJUDANTE NÃO ESTÁ LÁ
 *
 * Injeta local, como sempre foi. É o que garante que ligar o ajudante nunca
 * seja pior do que não ter ligado: se ele não subir, se cair, se for morto pelo
 * antivírus, a sessão continua funcionando exatamente como antes.
 */
import * as input from './input';
import { enviarAoAjudante, ajudanteConectado } from './ajudante';
import type { BotaoMouse } from '../shared/botoes';

// ── perguntas: sempre locais ──────────────────────────────────────
export const cursorPosition = input.cursorPosition;
export const cursorShape = input.cursorShape;
export const cursorShapeAtPoint = input.cursorShapeAtPoint;
export const desktopSeguroAtivo = input.desktopSeguroAtivo;
export const doubleClickTime = input.doubleClickTime;
export const excluirDaCaptura = input.excluirDaCaptura;
export const isLocalInputBlocked = input.isLocalInputBlocked;
export const verifyAbi = input.verifyAbi;
export const getVirtualScreen = input.getVirtualScreen;

/** O modo administrador está de fato ativo — ou seja, há ajudante ouvindo? */
export const modoAdminAtivo = ajudanteConectado;

// ── injeção: pelo ajudante quando ele existe ──────────────────────

export function moveMouseTo(x: number, y: number): void {
  if (enviarAoAjudante({ c: 'mv', x, y })) return;
  input.moveMouseTo(x, y);
}

export function moveMouseRelative(dx: number, dy: number): void {
  if (enviarAoAjudante({ c: 'mvr', dx, dy })) return;
  input.moveMouseRelative(dx, dy);
}

export function mouseButton(button: BotaoMouse, down: boolean): void {
  if (enviarAoAjudante({ c: 'btn', b: button, down })) return;
  input.mouseButton(button, down);
}

export function mouseWheel(dx: number, dy: number): void {
  if (enviarAoAjudante({ c: 'whl', dx, dy })) return;
  input.mouseWheel(dx, dy);
}

export function key(code: string, down: boolean): void {
  if (enviarAoAjudante({ c: 'key', code, down })) return;
  input.key(code, down);
}

export function combo(codes: string[]): void {
  if (enviarAoAjudante({ c: 'combo', codes })) return;
  input.combo(codes);
}

export function typeText(t: string): void {
  if (enviarAoAjudante({ c: 'txt', t })) return;
  input.typeText(t);
}

export function warpCursor(x: number, y: number): boolean {
  if (enviarAoAjudante({ c: 'warp', x, y })) return true;
  return input.warpCursor(x, y);
}

export function blockLocalInput(on: boolean): boolean {
  // Vai aos DOIS: quem bloqueia a entrada física precisa ser quem tem
  // privilégio, mas o estado local também precisa acompanhar, senão
  // `isLocalInputBlocked` passa a mentir para a interface.
  enviarAoAjudante({ c: 'blk', on });
  return input.blockLocalInput(on);
}

/**
 * Solta tudo que ficou preso.
 *
 * Vai aos dois lados sempre, e sem atalho: uma tecla presa é o pior estrago
 * possível numa máquina de outra pessoa, e não dá para saber ao certo de qual
 * lado ela ficou — o ajudante pode ter subido no meio de um Ctrl apertado.
 */
export function releaseAll(): void {
  enviarAoAjudante({ c: 'rel' });
  input.releaseAll();
}
