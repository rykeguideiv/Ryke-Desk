/**
 * O desenho da camada de setas do anfitrião (ver `ponteiros.html`).
 *
 * Recebe a lista pronta do processo principal e mexe apenas no `transform` de
 * cada seta. Nada de framework e nada de recriar elementos a cada quadro: a
 * lista muda de conteúdo raramente (alguém entra ou sai) e de posição o tempo
 * todo, e são coisas com custos muito diferentes.
 */
import { corDoPonteiro, svgDaSeta, type Ponteiro } from '../../shared/ponteiros';

const palco = document.getElementById('palco')!;
const aviso = document.getElementById('aviso')!;
const avisoQuem = document.getElementById('aviso-quem')!;
const desenhadas = new Map<string, { el: HTMLDivElement; marca: string }>();

/** O último quadro pedido, para não desenhar mais de uma vez por repintura. */
let pendente: Ponteiro[] | null = null;
let agendado = false;

/**
 * O aviso de sessão em andamento.
 *
 * Usa `textContent`, e não `innerHTML`, porque o que entra aqui são rótulos
 * ligados a quem está do outro lado. Montar marcação com isso seria abrir uma
 * injeção numa janela que roda sempre no topo da tela de outra pessoa.
 */
function atualizarAviso(lista: Ponteiro[]): void {
  aviso.classList.toggle('ligado', lista.length > 0);
  if (lista.length === 0) {
    avisoQuem.textContent = '';
    return;
  }
  const nomes = lista.map((p) => p.nome).join(' · ');
  avisoQuem.textContent = lista.length === 1 ? `por ${nomes}` : `por ${lista.length} pessoas: ${nomes}`;
}

function desenhar(lista: Ponteiro[]): void {
  // A tarja conta TODO mundo que está conectado, inclusive quem está no Modo
  // Gamer e por isso não tem seta desenhada. Ver `oculta` em shared/ponteiros.
  atualizarAviso(lista);

  const vivos = new Set<string>();

  for (const p of lista) {
    if (p.oculta) continue;
    vivos.add(p.id);
    let alvo = desenhadas.get(p.id);
    // A marca é o que define o DESENHO (cor e nome). Enquanto ela não muda,
    // só o transform é tocado — que é o caminho barato, sem relayout.
    const marca = `${p.cor}|${p.nome}`;
    if (!alvo) {
      const el = document.createElement('div');
      el.className = 'seta';
      palco.appendChild(el);
      alvo = { el, marca: '' };
      desenhadas.set(p.id, alvo);
    }
    if (alvo.marca !== marca) {
      alvo.el.innerHTML = svgDaSeta(corDoPonteiro(p.cor), p.nome);
      alvo.marca = marca;
    }
    // A janela cobre exatamente o monitor capturado, então a fração da tela é
    // a fração da janela — nenhuma conversão no meio.
    const x = p.x * window.innerWidth;
    const y = p.y * window.innerHeight;
    alvo.el.style.transform = `translate(${x}px, ${y}px)`;
  }

  for (const [id, alvo] of desenhadas) {
    if (vivos.has(id)) continue;
    alvo.el.remove();
    desenhadas.delete(id);
  }
}

window.rykePonteiros.on((lista) => {
  pendente = lista;
  if (agendado) return;
  agendado = true;
  requestAnimationFrame(() => {
    agendado = false;
    if (pendente) desenhar(pendente);
  });
});
