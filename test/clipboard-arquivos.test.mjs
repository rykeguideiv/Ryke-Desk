/**
 * Copiar um arquivo aqui e colar numa pasta do computador remoto.
 *
 * O DEFEITO RELATADO
 *
 * "Ao copiar arquivo do pc e colar na pasta do pc da conexão não dá certo, não
 * copia." O arquivo até atravessava — ia parar na pasta de downloads do outro
 * lado —, mas o Ctrl+V lá não fazia nada, porque a área de transferência de lá
 * continuava vazia.
 *
 * POR QUE ESTE TESTE OLHA BYTES
 *
 * O Explorador do Windows cola a partir do formato `CF_HDROP`, e só dele: um
 * cabeçalho de 20 bytes seguido dos caminhos em UTF-16. Um campo no offset
 * errado não derruba nada e não produz mensagem nenhuma — a colagem
 * simplesmente não acontece, ou acontece com o nome truncado. É exatamente o
 * tipo de erro que só aparece na mão do usuário, e por isso o formato é
 * conferido campo a campo aqui.
 *
 * A segunda metade do teste usa o Windows de verdade: escreve na área de
 * transferência desta máquina e lê de volta pela API do sistema.
 *
 *   node --import ./test/ts-resolve.mjs test/clipboard-arquivos.test.mjs
 */
import { montarHDROP, montarFileNameW, copiarArquivos, lerArquivosCopiados } from '../src/main/clipboard-arquivos.ts';
import koffi from 'koffi';

let falhas = 0;
const check = (rotulo, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${rotulo}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

console.log('\n── o formato que o Explorador entende ──\n');

{
  const bloco = montarHDROP(['C:\\temp\\nota.txt']);

  check('a lista começa logo depois do cabeçalho', bloco.readUInt32LE(0) === 20,
    `pFiles = ${bloco.readUInt32LE(0)}`);
  check('o ponto de soltura fica zerado', bloco.readInt32LE(4) === 0 && bloco.readInt32LE(8) === 0);
  check('coordenadas de cliente, não de tela', bloco.readUInt32LE(12) === 0);
  // Sem esta bandeira o Windows lê os caminhos como ANSI: o primeiro byte zero
  // do UTF-16 encerraria o nome, e o arquivo colado viraria "C".
  check('a lista é declarada como UTF-16', bloco.readUInt32LE(16) === 1, 'fWide = 1');

  const lista = bloco.subarray(20);
  check('o caminho aparece inteiro, em UTF-16',
    lista.toString('ucs2').startsWith('C:\\temp\\nota.txt'),
    JSON.stringify(lista.toString('ucs2').replace(/\0/g, '·')));

  // Dois zeros terminam o caminho e mais dois terminam a lista. Faltando o
  // segundo par, o Windows continua lendo memória além do bloco.
  check('termina com dois zeros duplos',
    lista.subarray(-4).equals(Buffer.from([0, 0, 0, 0])),
    [...lista.subarray(-4)].join(','));

  const tamanhoEsperado = 20 + ('C:\\temp\\nota.txt'.length + 1) * 2 + 2;
  check('o tamanho fecha com a conta', bloco.length === tamanhoEsperado,
    `${bloco.length} de ${tamanhoEsperado}`);
}

{
  const bloco = montarHDROP(['C:\\a.txt', 'D:\\pasta\\b.png']);
  const texto = bloco.subarray(20).toString('ucs2');
  check('vários arquivos entram na mesma lista',
    texto.startsWith('C:\\a.txt\0D:\\pasta\\b.png\0\0'),
    JSON.stringify(texto.replace(/\0/g, '·')));
}

{
  // Acento e espaço em nome de arquivo são a regra, não a exceção.
  const nome = 'C:\\Área de Trabalho\\relatório final.pdf';
  const bloco = montarHDROP([nome]);
  check('acentos e espaços atravessam intactos',
    bloco.subarray(20).toString('ucs2').startsWith(nome), nome);

  const curto = montarFileNameW(nome);
  check('o formato antigo carrega o mesmo caminho',
    curto.toString('ucs2').replace(/\0+$/, '') === nome);
}

console.log('\n── na área de transferência de verdade ──\n');

{
  // Lê de volta pela API do Windows: é a única prova de que o bloco foi aceito
  // pelo sistema, e não só bem formado no papel.
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const OpenClipboard = user32.func('int __stdcall OpenClipboard(void *hWnd)');
  const CloseClipboard = user32.func('int __stdcall CloseClipboard()');
  const IsClipboardFormatAvailable = user32.func('int __stdcall IsClipboardFormatAvailable(uint32 f)');
  const GetClipboardData = user32.func('void* __stdcall GetClipboardData(uint32 uFormat)');
  const DragQueryFileW = koffi
    .load('shell32.dll')
    .func('uint32 __stdcall DragQueryFileW(void *hDrop, uint32 iFile, _Out_ char16_t *buf, uint32 cch)');
  const GlobalSize = kernel32.func('size_t __stdcall GlobalSize(void *hMem)');

  const alvo = 'C:\\temp\\ryke teste de colagem.txt';
  const escreveu = copiarArquivos([alvo]);
  check('o Windows aceitou o bloco', escreveu === true);

  const CF_HDROP = 15;
  check('a área de transferência passa a oferecer arquivos',
    IsClipboardFormatAvailable(CF_HDROP) === 1);
  check('o Ryke lê o formato nativo, sem depender de FileNameW',
    lerArquivosCopiados()[0] === alvo, String(lerArquivosCopiados()[0]));

  // E o Explorador, ao colar, faz exatamente isto: pergunta quantos arquivos
  // há e pede o nome de cada um.
  if (OpenClipboard(null)) {
    try {
      const hDrop = GetClipboardData(CF_HDROP);
      const quantos = hDrop ? DragQueryFileW(hDrop, 0xffffffff, null, 0) : 0;
      check('o sistema enxerga um arquivo na lista', quantos === 1, `${quantos} arquivo(s)`);

      if (quantos === 1) {
        const buf = Buffer.alloc(520 * 2);
        const escritos = DragQueryFileW(hDrop, 0, buf, 520);
        const lido = buf.toString('ucs2', 0, escritos * 2);
        check('e devolve o caminho exatamente como foi posto', lido === alvo, lido);
      }
      check('o bloco tem tamanho declarado', hDrop ? GlobalSize(hDrop) > 20 : false);
    } finally {
      CloseClipboard();
    }
  } else {
    check('abrir a área de transferência para conferir', false, 'outro programa a mantinha travada');
  }

  const segundoAlvo = 'C:\\temp\\segundo arquivo.png';
  const escreveuDois = copiarArquivos([alvo, segundoAlvo]);
  const leuDois = lerArquivosCopiados();
  check('dois arquivos copiados são lidos na mesma seleção',
    escreveuDois && leuDois.length === 2 && leuDois[0] === alvo && leuDois[1] === segundoAlvo,
    JSON.stringify(leuDois));

  // Deixar um caminho inventado na área de transferência faria o próximo
  // Ctrl+V de quem rodou o teste falhar sem explicação.
  const EmptyClipboard = user32.func('int __stdcall EmptyClipboard()');
  if (OpenClipboard(null)) {
    EmptyClipboard();
    CloseClipboard();
  }
}

console.log(falhas === 0 ? '\nColagem de arquivos validada.\n' : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
