/**
 * O ponto de encontro aguenta um transporte hostil?
 *
 * Os corretores são públicos: qualquer pessoa assina os tópicos e lê tudo que
 * passa. Estes testes tratam o transporte como adversário — envelope trocado,
 * assinatura remendada, mensagem repetida horas depois, número errado — e
 * exigem que nada disso vire uma sessão.
 *
 *   node --import ./test/ts-resolve.mjs test/encontro.test.mjs
 */
import {
  DIGITOS_NUMERO,
  topicoDe,
  chaveDe,
  criarIdentidade,
  exportarIdentidade,
  importarIdentidade,
  impressaoDe,
  selar,
  abrir,
  sortearNumero,
  novoIdMensagem,
  VALIDADE_ENVELOPE_MS,
} from '../src/shared/encontro.ts';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

// ─────────────────────────── Tópico ───────────────────────────

const t1 = await topicoDe('481922730155');
const t2 = await topicoDe('481922730155');
const t3 = await topicoDe('481922730154');

check('o tópico é estável para o mesmo número', t1 === t2);
check('números diferentes vão para tópicos diferentes', t1 !== t3);
check('o número não aparece no tópico', !t1.includes('481922730155'), t1);
check('o tópico tem forma previsível', /^ryke\/v1\/[0-9a-f]{32}$/.test(t1), t1);

// ─────────────────────────── Envelope ───────────────────────────

const NUMERO = '481922730155';
const chave = await chaveDe(NUMERO);
const anfitriao = await criarIdentidade();
const visitante = await criarIdentidade();

const selado = await selar(chave, visitante, {
  de: '900111222333',
  para: NUMERO,
  dados: { t: 'knock', app: 'ryke-desk', name: 'PC do Ceará', modo: 'pedido' },
});

const lido = await abrir(chave, selado);
check('o envelope abre com a chave certa', lido !== null);
check('o conteúdo chega intacto', lido?.interior.dados?.name === 'PC do Ceará');
check('o remetente é identificado', lido?.interior.de === '900111222333');
check('a impressão digital confere com a do remetente', lido?.impressao === visitante.impressao);
check(
  'a impressão do anfitrião é diferente da do visitante',
  visitante.impressao !== anfitriao.impressao,
);

// ──────────────────── Ataques que devem falhar ────────────────────

const chaveErrada = await chaveDe('999888777666');
check('quem não sabe o número não lê nada', (await abrir(chaveErrada, selado)) === null);

const adulterado = Uint8Array.from(selado);
adulterado[adulterado.length - 5] ^= 0x01;
check('um byte trocado invalida o envelope', (await abrir(chave, adulterado)) === null);

const ivMexido = Uint8Array.from(selado);
ivMexido[2] ^= 0xff;
check('mexer no IV invalida o envelope', (await abrir(chave, ivMexido)) === null);

check('lixo de outro programa no mesmo corretor é ignorado',
  (await abrir(chave, new TextEncoder().encode('mensagem qualquer de outro app'))) === null);
check('envelope curto demais é ignorado', (await abrir(chave, new Uint8Array(5))) === null);

// Repetição tardia: capturar hoje e reenviar amanhã não pode valer.
const antigo = await selar(chave, visitante, {
  de: '900111222333', para: NUMERO, dados: { t: 'bye' },
  ts: Date.now() - VALIDADE_ENVELOPE_MS - 1000,
});
check('mensagem fora do prazo é descartada', (await abrir(chave, antigo)) === null);

const futuro = await selar(chave, visitante, {
  de: '900111222333', para: NUMERO, dados: { t: 'bye' },
  ts: Date.now() + VALIDADE_ENVELOPE_MS + 1000,
});
check('relógio adiantado demais também é descartado', (await abrir(chave, futuro)) === null);

// O ataque central deste desenho: alguém que descobriu o número tenta se
// passar pelo anfitrião. Consegue cifrar (sabe o número), mas assina com a
// chave dele — e a impressão digital denuncia.
const impostor = await criarIdentidade();
const forjado = await selar(chave, impostor, {
  de: NUMERO, para: '900111222333', dados: { t: 'accepted' },
});
const lidoForjado = await abrir(chave, forjado);
check('o impostor consegue cifrar (ele sabe o número)', lidoForjado !== null);
check(
  'mas a impressão digital dele não é a do anfitrião legítimo',
  lidoForjado?.impressao !== anfitriao.impressao,
  `${lidoForjado?.impressao} ≠ ${anfitriao.impressao}`,
);

// ─────────────────────── Identidade em repouso ───────────────────────

const guardada = await exportarIdentidade(anfitriao);
const recuperada = await importarIdentidade(guardada);
check('a identidade sobrevive a reiniciar o programa', recuperada.impressao === anfitriao.impressao);
check('a chave pública recuperada é a mesma', recuperada.publicaBruta === anfitriao.publicaBruta);
check('não guardamos a chave privada em texto plano no envelope', !selado.includes?.('d'), 'formato binário');

const assinadoDepois = await selar(chave, recuperada, { de: NUMERO, para: '900111222333', dados: { t: 'accepted' } });
const conferido = await abrir(chave, assinadoDepois);
check('assinatura feita com a chave recuperada é aceita', conferido?.impressao === anfitriao.impressao);

// ──────────────────────── Impressão digital ────────────────────────

const imp = await impressaoDe(anfitriao.publicaBruta);
check('a impressão tem forma legível', /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(imp), imp);
check('a impressão é determinística', imp === (await impressaoDe(anfitriao.publicaBruta)));
check('não usa letras ambíguas (I, L, O, U)', !/[ILOU]/.test(imp), imp);

// ───────────────────────── Números sorteados ─────────────────────────

const numeros = new Set();
for (let i = 0; i < 3000; i++) numeros.add(sortearNumero());
check(`todo número tem ${DIGITOS_NUMERO} dígitos`,
  [...numeros].every((n) => new RegExp(`^[0-9]{${DIGITOS_NUMERO}}$`).test(n)));
check('nenhum começa com zero', [...numeros].every((n) => n[0] !== '0'));
check('3000 sorteios sem repetição', numeros.size === 3000, `${numeros.size} distintos`);

// O tópico precisa ser CARO de derivar. Se fosse um resumo barato, quem
// escutasse os corretores montaria a tabela inversa tópico→número em segundos
// e leria o combinado de todo mundo — a chave cara não adiantaria nada,
// porque o elo mais fraco é que define a força da corrente.
const tCusto = Date.now();
await topicoDe('111222333444');
const custoMs = Date.now() - tCusto;
check('derivar o tópico é caro o bastante para inviabilizar varredura', custoMs >= 20,
  `${custoMs}ms por número`);

const ids = new Set();
for (let i = 0; i < 2000; i++) ids.add(novoIdMensagem());
check('identificadores de mensagem não repetem', ids.size === 2000);

console.log(falhas === 0 ? '\nPonto de encontro validado.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
