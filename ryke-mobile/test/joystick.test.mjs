/**
 * O joystick, provado com relógio de mentira.
 *
 * Movimento de cursor é o tipo de coisa que "parece funcionar" em qualquer
 * teste manual de dez segundos e falha feio no uso: rápido demais para caçar
 * um pixel, lento demais para atravessar a tela, ou andando sozinho porque o
 * polegar apoiado nunca fica exatamente parado.
 *
 * Nada aqui precisa de tela, de dedo ou de celular — a política é função pura,
 * e é por isso que dá para conferir número por número.
 *
 *   node --import ./test/ts-resolve.mjs test/joystick.test.mjs
 */
import {
  CURVA,
  PASSO_MAXIMO_MS,
  RAIO_BASE,
  VELOCIDADE_MAX,
  ZONA_MORTA,
  caixaConteudo,
  fracaoParaTela,
  limitarPan,
  passoCursor,
  telaParaFracao,
  vetorDoDedo,
} from '../src/lib/joystick.ts';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};
const perto = (a, b, tolerancia) => Math.abs(a - b) <= tolerancia;

console.log('\n── a haste ──\n');

{
  const v = vetorDoDedo(0, 0);
  check('dedo no centro não inclina nada', v.x === 0 && v.y === 0);
}
{
  const v = vetorDoDedo(RAIO_BASE, 0);
  check('dedo na borda da base é inclinação total', perto(v.x, 1, 1e-9) && v.y === 0);
}
{
  // Escorregar o polegar para fora da base é comum; disparar o cursor por
  // causa disso, não.
  const v = vetorDoDedo(RAIO_BASE * 5, RAIO_BASE * 5);
  check('passar da base não acelera além do batente', perto(Math.hypot(v.x, v.y), 1, 1e-9));
}
{
  const v = vetorDoDedo(30, -60, 100);
  check('a base é medida na hora, não fixa', perto(v.x, 0.3, 1e-9) && perto(v.y, -0.6, 1e-9));
}

console.log('\n── o passo do cursor ──\n');

/** Roda o joystick por um tempo, em quadros de 16ms, e diz onde o cursor parou. */
function conduzir(vetor, ms, inicio = { x: 0.5, y: 0.5 }) {
  let c = inicio;
  for (let t = 0; t < ms; t += 16) c = passoCursor(c, vetor, 16);
  return c;
}

{
  const c = conduzir({ x: ZONA_MORTA * 0.9, y: 0 }, 3000);
  check('polegar apoiado dentro da zona morta não move o cursor', c.x === 0.5 && c.y === 0.5);
}
{
  const c = conduzir({ x: 1, y: 0 }, 1000, { x: 0, y: 0.5 });
  check(
    'inclinação total atravessa a tela em cerca de um segundo',
    perto(c.x, VELOCIDADE_MAX, 0.05) || c.x === 1,
    `chegou a ${c.x.toFixed(3)}`,
  );
}
{
  const meio = conduzir({ x: 0.5, y: 0 }, 1000, { x: 0, y: 0.5 }).x;
  const cheio = conduzir({ x: 1, y: 0 }, 1000, { x: 0, y: 0.5 }).x;
  // É esta desproporção que permite caçar um pixel: metade da haste tem de
  // dar muito menos do que metade da velocidade.
  check('meia haste anda bem menos que metade da haste cheia', meio < cheio * 0.25,
    `${meio.toFixed(3)} contra ${cheio.toFixed(3)}`);
  check('mas meia haste anda alguma coisa', meio > 0.02, meio.toFixed(4));
}
{
  const c = conduzir({ x: 1, y: 1 }, 400, { x: 0.2, y: 0.2 });
  const dx = c.x - 0.2;
  const dy = c.y - 0.2;
  check('a diagonal anda igual nos dois eixos', perto(dx, dy, 1e-9), `${dx.toFixed(4)} / ${dy.toFixed(4)}`);
  check('e a diagonal não é mais rápida que a reta', perto(Math.hypot(dx, dy), conduzir({ x: 1, y: 0 }, 400, { x: 0.2, y: 0.2 }).x - 0.2, 1e-9));
}
{
  const c = conduzir({ x: -1, y: -1 }, 5000, { x: 0.5, y: 0.5 });
  check('o cursor nunca sai da tela', c.x === 0 && c.y === 0);
  const d = conduzir({ x: 1, y: 1 }, 5000, { x: 0.5, y: 0.5 });
  check('nem pelo outro lado', d.x === 1 && d.y === 1);
}
{
  // O Android congela a WebView ao trocar de aplicativo. O primeiro quadro
  // depois disso traz um salto de tempo enorme, e sem teto o cursor
  // teletransportaria para o canto.
  const salto = passoCursor({ x: 0.5, y: 0.5 }, { x: 1, y: 0 }, 4000);
  const teto = passoCursor({ x: 0.5, y: 0.5 }, { x: 1, y: 0 }, PASSO_MAXIMO_MS);
  check('travamento longo não teletransporta o cursor', salto.x === teto.x, `parou em ${salto.x.toFixed(3)}`);
}
{
  // Trinta quadros por segundo num aparelho fraco tem de andar o mesmo tanto
  // que sessenta num bom — senão o controle muda de sensibilidade sozinho.
  let a = { x: 0, y: 0.5 };
  for (let t = 0; t < 960; t += 16) a = passoCursor(a, { x: 0.7, y: 0 }, 16);
  let b = { x: 0, y: 0.5 };
  for (let t = 0; t < 960; t += 32) b = passoCursor(b, { x: 0.7, y: 0 }, 32);
  check('a velocidade não depende da taxa de quadros', perto(a.x, b.x, 1e-9), `${a.x.toFixed(4)} / ${b.x.toFixed(4)}`);
}
{
  const util = (0.5 - ZONA_MORTA) / (1 - ZONA_MORTA);
  const esperado = VELOCIDADE_MAX * Math.pow(util, CURVA) * 0.016;
  const c = passoCursor({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0 }, 16);
  check('a curva é a que está documentada', perto(c.x - 0.5, esperado, 1e-12));
}

console.log('\n── onde a imagem está de verdade ──\n');

{
  // Um PC 16:9 num celular deitado 20:9: quase 20% da largura vira tarja preta.
  const c = caixaConteudo({ left: 0, top: 0, width: 800, height: 360 }, 1920, 1080);
  check('tela larga demais: tarjas nas laterais', perto(c.width, 640, 0.001) && perto(c.height, 360, 0.001),
    `${c.width}×${c.height} em ${c.left}`);
  check('e a imagem fica centralizada', perto(c.left, 80, 0.001) && c.top === 0);
}
{
  const c = caixaConteudo({ left: 0, top: 0, width: 360, height: 800 }, 1920, 1080);
  check('celular em pé: tarjas em cima e embaixo', perto(c.height, 202.5, 0.001) && perto(c.top, 298.75, 0.001));
}
{
  const c = caixaConteudo({ left: 10, top: 20, width: 320, height: 180 }, 1920, 1080);
  check('proporção igual: sem tarja nenhuma', c.width === 320 && c.height === 180 && c.left === 10 && c.top === 20);
}
{
  const c = caixaConteudo({ left: 0, top: 0, width: 800, height: 360 }, 0, 0);
  check('sem metadados do vídeo ainda, devolve a caixa como está', c.width === 800 && c.height === 360);
}
{
  const caixa = caixaConteudo({ left: 0, top: 0, width: 800, height: 360 }, 1920, 1080);
  // Tocar em 25% da largura da IMAGEM, e não do elemento: é aqui que o
  // cálculo antigo errava, e o erro crescia justamente na borda, onde ficam
  // a barra de tarefas e o botão de fechar janela.
  const f = telaParaFracao(caixa, { x: 80 + 640 * 0.25, y: 360 * 0.75 });
  check('toque na imagem vira a fração certa', perto(f.x, 0.25, 1e-9) && perto(f.y, 0.75, 1e-9));

  const naTarja = telaParaFracao(caixa, { x: 4, y: 10 });
  check('toque na tarja preta gruda na borda, não sai da tela', naTarja.x === 0 && naTarja.y >= 0);

  const volta = fracaoParaTela(caixa, { x: 0.25, y: 0.75 });
  const ida = telaParaFracao(caixa, volta);
  check('ida e volta chegam ao mesmo lugar', perto(ida.x, 0.25, 1e-9) && perto(ida.y, 0.75, 1e-9));
}

console.log('\n── arrastar a imagem ampliada ──\n');

{
  check('sem zoom, não há para onde arrastar', JSON.stringify(limitarPan({ x: 300, y: 300 }, 1, 400, 800)) === '{"x":0,"y":0}');
  const p = limitarPan({ x: 9999, y: -9999 }, 3, 400, 800);
  check('arrasto entusiasmado para no limite da imagem', p.x === 400 && p.y === -800, `${p.x},${p.y}`);
  const q = limitarPan({ x: 30, y: -20 }, 3, 400, 800);
  check('arrasto dentro do limite passa intacto', q.x === 30 && q.y === -20);
}

console.log(falhas === 0 ? '\nJoystick validado.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
