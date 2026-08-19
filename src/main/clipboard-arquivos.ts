/**
 * Colocar um arquivo na área de transferência do Windows, do jeito que o
 * Explorador entende.
 *
 * O PROBLEMA
 *
 * Copiar um arquivo no computador de casa e colar numa pasta do computador
 * remoto não funcionava. O arquivo até atravessava — ia parar na pasta de
 * downloads do outro lado —, mas o Ctrl+V lá não fazia nada, porque a área de
 * transferência de lá continuava vazia. Do ponto de vista de quem usa, "não
 * copia".
 *
 * O FORMATO
 *
 * O Explorador cola a partir do `CF_HDROP`, e só dele. É um formato antigo e
 * literal: um bloco de memória global com um cabeçalho `DROPFILES` de 20 bytes
 * seguido da lista de caminhos em UTF-16, cada um terminado em zero, e um zero
 * a mais no fim para marcar o fim da lista.
 *
 *     ┌──────────────── DROPFILES (20 bytes) ────────────────┐
 *     │ pFiles = 20   (onde a lista começa, a partir daqui)  │
 *     │ pt.x = 0, pt.y = 0   (ponto do arrastar; não usamos) │
 *     │ fNC = 0              (coordenadas de cliente)        │
 *     │ fWide = 1            (a lista é UTF-16, não ANSI)    │
 *     └──────────────────────────────────────────────────────┘
 *       "C:\pasta\arquivo.txt\0"  ... "\0"
 *
 * Não dá para fazer isso pelo Electron: o `clipboard.writeBuffer` registra um
 * formato NOVO com o nome que se der, então escrever em "CF_HDROP" criaria um
 * formato particular chamado "CF_HDROP" — que o Explorador ignora. É preciso o
 * identificador numérico 15, e para isso a API do Windows direto.
 *
 * Escrevemos também o `FileNameW`, que é o que o próprio Ryke Desk lê para
 * saber que há um arquivo copiado. É o mesmo par que o Explorador publica ao
 * copiar um arquivo, então a área de transferência fica indistinguível de uma
 * cópia feita à mão.
 */
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const OpenClipboard = user32.func('int __stdcall OpenClipboard(void *hWnd)');
const CloseClipboard = user32.func('int __stdcall CloseClipboard()');
const EmptyClipboard = user32.func('int __stdcall EmptyClipboard()');
const SetClipboardData = user32.func('void* __stdcall SetClipboardData(uint32 uFormat, void *hMem)');
const GetClipboardData = user32.func('void* __stdcall GetClipboardData(uint32 uFormat)');
const IsClipboardFormatAvailable = user32.func('int __stdcall IsClipboardFormatAvailable(uint32 uFormat)');
const RegisterClipboardFormatW = user32.func('uint32 __stdcall RegisterClipboardFormatW(str16 lpszFormat)');

const DragQueryFileW = koffi
  .load('shell32.dll')
  .func('uint32 __stdcall DragQueryFileW(void *hDrop, uint32 iFile, _Out_ char16_t *buf, uint32 cch)');

const GlobalAlloc = kernel32.func('void* __stdcall GlobalAlloc(uint32 uFlags, size_t dwBytes)');
const GlobalLock = kernel32.func('void* __stdcall GlobalLock(void *hMem)');
const GlobalUnlock = kernel32.func('int __stdcall GlobalUnlock(void *hMem)');
const GlobalFree = kernel32.func('void* __stdcall GlobalFree(void *hMem)');

const CF_HDROP = 15;
/** Memória móvel: a área de transferência assume a posse e libera depois. */
const GMEM_MOVEABLE = 0x0002;
const GMEM_ZEROINIT = 0x0040;

/**
 * Monta o bloco CF_HDROP para uma lista de caminhos.
 *
 * Separado do resto de propósito: é a parte que erra em silêncio. Um byte fora
 * do lugar no cabeçalho não derruba nada — a colagem simplesmente não acontece,
 * ou acontece com um nome truncado, e não há mensagem de erro em lugar nenhum
 * para explicar. Sendo função pura, o formato pode ser conferido byte a byte.
 */
export function montarHDROP(caminhos: string[]): Buffer {
  const cabecalho = Buffer.alloc(20);
  cabecalho.writeUInt32LE(20, 0); // pFiles: a lista começa logo depois
  // pt.x, pt.y, fNC ficam em zero.
  cabecalho.writeUInt32LE(1, 16); // fWide: caminhos em UTF-16

  const partes: Buffer[] = [cabecalho];
  for (const caminho of caminhos) {
    partes.push(Buffer.from(caminho, 'ucs2'));
    partes.push(Buffer.from([0, 0])); // fim deste caminho
  }
  partes.push(Buffer.from([0, 0])); // fim da lista

  return Buffer.concat(partes);
}

/** O mesmo caminho no formato que o próprio Ryke Desk lê ao vigiar a área. */
export function montarFileNameW(caminho: string): Buffer {
  return Buffer.concat([Buffer.from(caminho, 'ucs2'), Buffer.from([0, 0])]);
}

/**
 * Lê os caminhos que o Explorer publicou no formato nativo CF_HDROP.
 *
 * `FileNameW` não é obrigatório e algumas versões/extensões do Explorer não
 * o publicam. CF_HDROP, ao contrário, é exatamente o formato usado pelo
 * próprio Windows para colar arquivos e por isso é a fonte confiável.
 */
export function lerArquivosCopiados(): string[] {
  if (!IsClipboardFormatAvailable(CF_HDROP)) return [];
  if (!OpenClipboard(null)) return [];
  try {
    const hDrop = GetClipboardData(CF_HDROP);
    if (!hDrop) return [];
    const quantidade = DragQueryFileW(hDrop, 0xffffffff, null, 0);
    const caminhos: string[] = [];
    for (let i = 0; i < quantidade; i++) {
      const tamanho = DragQueryFileW(hDrop, i, null, 0);
      if (!tamanho) continue;
      const buffer = Buffer.alloc((tamanho + 1) * 2);
      const escritos = DragQueryFileW(hDrop, i, buffer, tamanho + 1);
      if (escritos) caminhos.push(buffer.toString('ucs2', 0, escritos * 2));
    }
    return caminhos;
  } catch {
    return [];
  } finally {
    CloseClipboard();
  }
}

/** Copia um bloco para memória global e entrega a posse à área de transferência. */
function publicar(formato: number, dados: Buffer): boolean {
  const handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, dados.length);
  if (!handle) return false;
  const destino = GlobalLock(handle);
  if (!destino) {
    GlobalFree(handle);
    return false;
  }
  try {
    koffi.encode(destino, koffi.array('uint8', dados.length), [...dados]);
  } finally {
    GlobalUnlock(handle);
  }
  // A partir daqui a memória pertence à área de transferência: não se libera.
  if (!SetClipboardData(formato, handle)) {
    GlobalFree(handle);
    return false;
  }
  return true;
}

/**
 * Põe os arquivos na área de transferência desta máquina.
 *
 * Depois disto, um Ctrl+V no Explorador — ou em qualquer programa que aceite
 * arquivos — cola de verdade.
 */
export function copiarArquivos(caminhos: string[]): boolean {
  if (caminhos.length === 0) return false;
  // hWnd nulo: a área de transferência fica associada à tarefa atual, o que
  // basta e evita depender de uma janela nossa estar viva.
  if (!OpenClipboard(null)) return false;
  try {
    EmptyClipboard();
    const ok = publicar(CF_HDROP, montarHDROP(caminhos));
    const formatoNome = RegisterClipboardFormatW('FileNameW');
    if (formatoNome) publicar(formatoNome, montarFileNameW(caminhos[0]));
    return ok;
  } catch {
    return false;
  } finally {
    CloseClipboard();
  }
}
