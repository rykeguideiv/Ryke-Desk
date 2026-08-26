import { useEffect, useRef } from 'react';
import type { Sessao } from '../lib/sessao';

/**
 * Teclado do celular ligado ao Windows do outro lado.
 *
 * Há dois caminhos, e os dois são necessários:
 *
 *   TEXTO — o que o usuário digita vai como texto literal. É o único jeito
 *   confiável para acentos e emojis: o teclado do Android não expõe "qual
 *   tecla física foi apertada", e mapear caractere de volta para tecla daria
 *   errado em qualquer layout diferente do esperado.
 *
 *   TECLAS — Esc, Tab, setas, Enter e as combinações não produzem texto
 *   nenhum, então vão pela posição física da tecla, exatamente como no
 *   desktop. É o que faz Ctrl+C ser Ctrl+C do outro lado.
 *
 * O campo é invisível e serve só para chamar o teclado do sistema; nada do
 * que é digitado fica guardado nele.
 */

/** Combinações que não existem no teclado do celular e sem as quais falta metade do Windows. */
const ATALHOS: [string, string, string[]][] = [
  ['Esc', 'Escape', ['Escape']],
  ['Tab', 'Tab', ['Tab']],
  ['↑', 'ArrowUp', ['ArrowUp']],
  ['↓', 'ArrowDown', ['ArrowDown']],
  ['←', 'ArrowLeft', ['ArrowLeft']],
  ['→', 'ArrowRight', ['ArrowRight']],
  ['Ctrl+C', 'copiar', ['ControlLeft', 'KeyC']],
  ['Ctrl+V', 'colar', ['ControlLeft', 'KeyV']],
  ['Ctrl+Z', 'desfazer', ['ControlLeft', 'KeyZ']],
  ['Alt+Tab', 'trocar janela', ['AltLeft', 'Tab']],
  ['Win', 'menu iniciar', ['MetaLeft']],
];

export function TecladoRemoto({ sessao, onFechar }: { sessao: Sessao; onFechar: () => void }): React.JSX.Element {
  const campo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    campo.current?.focus();
  }, []);

  return (
    <div className="teclado">
      <div className="atalhos">
        {ATALHOS.map(([rotulo, titulo, codes]) => (
          <button key={rotulo} title={titulo} onClick={() => sessao.combinacao(codes)}>
            {rotulo}
          </button>
        ))}
        {/* Fora da lista acima porque não é injeção de tecla: o Windows reserva
            o Ctrl+Alt+Del e nenhum programa consegue simulá-lo. Este botão pede
            a chamada oficial (SendSAS) do outro lado, que pode recusar — e a
            recusa vira aviso na tela em vez de silêncio. */}
        <button title="tela de seguranca do Windows" onClick={() => sessao.sas()}>
          Ctrl+Alt+Del
        </button>
      </div>

      <div className="linha-digitar">
        <input
          ref={campo}
          className="campo-invisivel"
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Digite aqui para o computador…"
          onChange={(e) => {
            const valor = e.target.value;
            if (valor) sessao.texto(valor);
            e.target.value = '';
          }}
          onKeyDown={(e) => {
            // Teclas que não produzem texto precisam ir pela posição física.
            if (e.key === 'Enter') { sessao.combinacao(['Enter']); e.preventDefault(); }
            if (e.key === 'Backspace') { sessao.combinacao(['Backspace']); e.preventDefault(); }
          }}
        />
        <button className="bt" onClick={() => sessao.combinacao(['Backspace'])}>⌫</button>
        <button className="bt" onClick={() => sessao.combinacao(['Enter'])}>⏎</button>
        <button className="bt sair" onClick={onFechar}>Fechar</button>
      </div>
    </div>
  );
}
