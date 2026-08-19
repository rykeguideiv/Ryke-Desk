import { mudarBotao } from '../src/shared/botoes.ts';

let falhas = 0;
const check = (rotulo, ok) => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}`);
  if (!ok) falhas++;
};

const pressionados = new Set();
check('não envia soltar direito se ele nunca foi pressionado', mudarBotao(pressionados, 2, false) === false);
check('envia o primeiro pressionar direito', mudarBotao(pressionados, 2, true) === true);
check('não duplica o pressionar direito', mudarBotao(pressionados, 2, true) === false);
check('envia o soltar correspondente', mudarBotao(pressionados, 2, false) === true);
check('não repete o soltar ao encerrar a sessão', mudarBotao(pressionados, 2, false) === false);
check('o conjunto termina vazio', pressionados.size === 0);

console.log(falhas === 0 ? '\nBotões do mouse validados.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
