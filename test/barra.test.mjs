/**
 * A barra da sessão não pode roubar o alto da tela remota.
 *
 * O DEFEITO RELATADO
 *
 * "Ao aproximar o mouse no topo abre o menu superior, porém eu não consigo
 * clicar nas guias do Chrome." Exato: a barra abria com o cursor a menos de 70
 * pixels do topo, e 70 pixels do alto de um computador é onde ficam as guias
 * do navegador, a barra de título de toda janela e o menu de todo programa.
 *
 * POR QUE ISTO NÃO É UM TESTE DE INTERFACE
 *
 * Tentei primeiro no navegador de verdade, e ele mentia: ao abrir, a barra
 * muda o que está sob o cursor, e o Chromium dispara em seguida um evento de
 * ponteiro com a posição REAL do mouse — que num teste automatizado está em
 * outro lugar. A barra fechava sozinha e o teste acusava um defeito que não
 * existia. A política separada é conferível sem essa interferência.
 *
 *   node --import ./test/ts-resolve.mjs test/barra.test.mjs
 */
import {
  decidirBarra,
  ENCOSTOU_NO_TOPO,
  FAIXA_DA_BARRA,
  FAIXA_COM_ABAS,
  FOLGA_JANELA,
} from '../src/renderer/src/lib/barra.ts';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

/** Cursor num monitor comum: screenY grande, longe do topo físico da tela. */
const NA_TELA = 500;

console.log('\n── o alto da tela remota fica livre ──\n');

{
  // As alturas onde de fato ficam as coisas: guias do Chrome (~10 a 40px),
  // barra de endereço (~50), menu de programas (~30).
  const alturas = [8, 12, 20, 28, 35, 45, 55, 62];
  const abriuAlguma = alturas.filter((y) => decidirBarra(false, y, NA_TELA) === true);
  check('passar pelas guias do navegador não abre a barra',
    abriuAlguma.length === 0,
    `conferido em ${alturas.join(', ')} pixels do topo`);
}

{
  check('e mais abaixo também não', decidirBarra(false, 200, NA_TELA) === false);
  check('nem no meio da tela', decidirBarra(false, 540, NA_TELA) === false);
}

console.log('\n── encostar no topo, sim, abre ──\n');

{
  check('cursor colado na borda de cima abre', decidirBarra(false, 0, NA_TELA) === true);
  check('e um pixel abaixo ainda conta como encostar', decidirBarra(false, 1, NA_TELA) === true);
  check('mas logo depois já não conta',
    decidirBarra(false, ENCOSTOU_NO_TOPO + 1, NA_TELA) === false,
    `${ENCOSTOU_NO_TOPO + 1}px do topo`);
}

{
  // Janela sem moldura maximizada pode ficar alguns pixels acima do visível:
  // o cursor está preso na borda física da tela sem o clientY chegar a zero.
  check('cursor na borda física da tela abre, mesmo com a janela deslocada',
    decidirBarra(false, 8, 0) === true);
  check('mas longe do topo da janela, não',
    decidirBarra(false, FOLGA_JANELA + 5, 0) === false);
}

{
  // Monitor posicionado ACIMA do principal: screenY é negativo em toda a área.
  // Tratar isso como "encostou" deixaria a barra aberta o tempo todo lá.
  check('num monitor acima do principal a barra não vive aberta',
    decidirBarra(false, 300, -400) === false,
    'screenY negativo em toda a área daquele monitor');
}

console.log('\n── aberta, continua aberta até sair da área dela ──\n');

{
  check('descer do topo até os botões não fecha',
    decidirBarra(true, 30, NA_TELA) === true, 'o cursor ainda está sobre a barra');
  check('na borda de baixo da barra ainda fica',
    decidirBarra(true, FAIXA_DA_BARRA, NA_TELA) === true);
  check('sair da área dela fecha',
    decidirBarra(true, FAIXA_DA_BARRA + 1, NA_TELA) === false);
  check('e bem longe, fecha também', decidirBarra(true, 600, NA_TELA) === false);
}

{
  // O caminho completo de quem quer usar a barra: sobe até encostar, desce
  // até um botão, clica, e volta para a tela.
  let aberta = false;
  const trajeto = [400, 200, 60, 20, 0];
  for (const y of trajeto) aberta = decidirBarra(aberta, y, NA_TELA);
  check('subir até encostar abre no fim do trajeto', aberta === true, trajeto.join(' → '));

  for (const y of [10, 25, 40]) aberta = decidirBarra(aberta, y, NA_TELA);
  check('e permanece aberta enquanto se anda sobre ela', aberta === true);

  aberta = decidirBarra(aberta, 300, NA_TELA);
  check('voltando para a tela, fecha', aberta === false);
}

{
  // O trajeto que causou a reclamação: mirar uma guia do navegador vindo de
  // baixo. Em nenhum instante a barra pode aparecer.
  let aberta = false;
  const nunca = [];
  for (const y of [500, 300, 150, 80, 62, 45, 30, 18, 12]) {
    aberta = decidirBarra(aberta, y, NA_TELA);
    if (aberta) nunca.push(y);
  }
  check('mirar uma guia vindo de baixo não abre a barra em nenhum instante',
    nunca.length === 0, nunca.length ? `abriu em ${nunca.join(', ')}` : 'nenhuma vez');
}

console.log('\n── com abas, a barra desce e a faixa acompanha ──\n');

{
  // Com duas ou mais conexões, a barra de menu fica sob a barra de abas, e
  // seus botões ficam por volta de 46 a 90px. A faixa maior tem de mantê-la
  // aberta enquanto o cursor desce até eles — o defeito era fechar no meio.
  check('com abas, descer até os botões (que agora ficam mais abaixo) não fecha',
    decidirBarra(true, 80, NA_TELA, FAIXA_COM_ABAS) === true,
    `${80}px, dentro da faixa de ${FAIXA_COM_ABAS}`);
  check('e na faixa normal esse mesmo ponto fecharia — era o bug',
    decidirBarra(true, 80, NA_TELA) === false);
  check('abaixo da barra de menu inteira, fecha',
    decidirBarra(true, FAIXA_COM_ABAS + 1, NA_TELA, FAIXA_COM_ABAS) === false);
}

console.log(falhas === 0 ? '\nBarra da sessao validada.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
