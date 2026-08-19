/**
 * Leitura e escrita em disco dos arquivos que atravessam a sessão.
 *
 * O renderer é quem controla o ritmo (ele enxerga o bufferedAmount do
 * DataChannel), então o envio é por "puxada": o renderer pede o próximo
 * pedaço quando o canal tem espaço. O processo principal só cuida do disco —
 * e é aqui que ficam as travas contra nome malicioso e tamanho excessivo,
 * porque nada que vem da rede pode escolher onde gravar.
 */
import { createWriteStream, WriteStream } from 'node:fs';
import { open, mkdir, unlink, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_FILE_BYTES } from '../shared/protocol';

// Caracteres proibidos em nome de arquivo no Windows, mais os de controle.
// Espaço fica de fora: "Relatório final.pdf" deve continuar com o espaço.
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;
// Nomes que o Windows reserva para dispositivos, em qualquer extensão.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Reduz o que veio da rede a um nome de arquivo simples e seguro.
 * Descarta qualquer componente de caminho: "..\\..\\Windows\\System32\\x.dll"
 * vira "x.dll".
 */
export function sanitizeFileName(raw: string): string {
  let name = basename(raw.replace(/[/\\]+/g, sep)).replace(ILLEGAL, '_').trim();
  // O Windows também não aceita ponto ou espaço no fim do nome.
  name = name.replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'arquivo';
  if (RESERVED.test(name)) name = `_${name}`;
  // Deixa folga para o sufixo " (12)" sem estourar o limite do sistema.
  if (name.length > 200) {
    const ext = extname(name).slice(0, 20);
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

/** Acha um caminho livre em `dir`, virando "foto.png" em "foto (2).png". */
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate; // não existe: é nosso
    }
  }
  return join(dir, `${stem} (${randomUUID().slice(0, 8)})${ext}`);
}

type Incoming = {
  id: string;
  path: string;
  stream: WriteStream;
  expected: number;
  written: number;
};

type Outgoing = {
  id: string;
  path: string;
  handle: FileHandle;
  size: number;
};

export class Transfers {
  private incoming = new Map<string, Incoming>();
  private outgoing = new Map<string, Outgoing>();

  private downloadDir: string;

  constructor(downloadDir: string) {
    this.downloadDir = downloadDir;
  }

  setDownloadDir(dir: string): void {
    this.downloadDir = dir;
  }

  // ── recebimento ──

  /** Abre o arquivo de destino. Lança se o tamanho anunciado for inválido. */
  async begin(id: string, rawName: string, size: number): Promise<{ path: string }> {
    if (!Number.isFinite(size) || size < 0) throw new Error('tamanho inválido');
    if (size > MAX_FILE_BYTES) throw new Error('acima do limite de 500 MB');
    if (this.incoming.has(id)) throw new Error('transferência duplicada');

    await mkdir(this.downloadDir, { recursive: true });
    const path = await uniquePath(this.downloadDir, sanitizeFileName(rawName));

    const stream = createWriteStream(path, { flags: 'wx' });
    await new Promise<void>((res, rej) => {
      stream.once('open', () => res());
      stream.once('error', rej);
    });

    this.incoming.set(id, { id, path, stream, expected: size, written: 0 });
    return { path };
  }

  /** @returns total de bytes já gravados */
  async write(id: string, chunk: Buffer): Promise<number> {
    const entry = this.incoming.get(id);
    if (!entry) throw new Error('transferência desconhecida');

    // Um remetente hostil poderia mandar mais bytes do que anunciou para
    // encher o disco; cortamos exatamente no tamanho combinado.
    if (entry.written + chunk.length > entry.expected) {
      await this.abort(id, 'remetente enviou mais bytes do que o anunciado');
      throw new Error('excedeu o tamanho anunciado');
    }

    if (!entry.stream.write(chunk)) {
      await new Promise<void>((res) => entry.stream.once('drain', () => res()));
    }
    entry.written += chunk.length;
    return entry.written;
  }

  /** Fecha o arquivo e confere que chegou inteiro. */
  async finish(id: string): Promise<{ path: string; size: number }> {
    const entry = this.incoming.get(id);
    if (!entry) throw new Error('transferência desconhecida');
    this.incoming.delete(id);

    await new Promise<void>((res, rej) => entry.stream.end((err?: Error) => (err ? rej(err) : res())));

    if (entry.written !== entry.expected) {
      await unlink(entry.path).catch(() => {});
      throw new Error(`arquivo incompleto: ${entry.written} de ${entry.expected} bytes`);
    }
    return { path: entry.path, size: entry.written };
  }

  /** Cancela e apaga o arquivo parcial — nada de deixar lixo na pasta. */
  async abort(id: string, _reason: string): Promise<void> {
    const entry = this.incoming.get(id);
    if (!entry) return;
    this.incoming.delete(id);
    await new Promise<void>((res) => {
      entry.stream.once('close', () => res());
      entry.stream.destroy();
    });
    await unlink(entry.path).catch(() => {});
  }

  // ── envio ──

  async openForSend(path: string): Promise<{ id: string; name: string; size: number }> {
    const full = resolve(path);
    const info = await stat(full);
    if (!info.isFile()) throw new Error('só é possível enviar arquivos, não pastas');
    if (info.size > MAX_FILE_BYTES) throw new Error('acima do limite de 500 MB');

    const handle = await open(full, 'r');
    const id = randomUUID();
    this.outgoing.set(id, { id, path: full, handle, size: info.size });
    return { id, name: basename(full), size: info.size };
  }

  /** Lê um pedaço para o renderer empurrar no DataChannel. */
  async readSlice(id: string, offset: number, length: number): Promise<Buffer> {
    const entry = this.outgoing.get(id);
    if (!entry) throw new Error('envio desconhecido');
    const buffer = Buffer.allocUnsafe(Math.min(length, Math.max(0, entry.size - offset)));
    if (buffer.length === 0) return buffer;
    const { bytesRead } = await entry.handle.read(buffer, 0, buffer.length, offset);
    return bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  }

  async closeSend(id: string): Promise<void> {
    const entry = this.outgoing.get(id);
    if (!entry) return;
    this.outgoing.delete(id);
    await entry.handle.close().catch(() => {});
  }

  /** Fecha tudo ao encerrar a sessão, sem deixar arquivo pela metade. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.incoming.keys()].map((id) => this.abort(id, 'sessão encerrada')));
    await Promise.all([...this.outgoing.keys()].map((id) => this.closeSend(id)));
  }
}
