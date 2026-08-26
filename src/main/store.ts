/**
 * Configuração persistente do Ryke Desk.
 *
 * Fica em %APPDATA%/ryke-desk/ryke-config.json. Os campos sensíveis (token do
 * dispositivo e verificador da senha) são cifrados com o safeStorage do
 * Electron, que no Windows usa a DPAPI amarrada à conta de usuário — copiar o
 * arquivo para outra máquina não serve de nada.
 */
import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Favorito, Quality, Settings } from '../shared/config';
import { QUALIDADES_ANTIGAS } from '../shared/config';
import { SERVIDOR_PADRAO } from '../shared/servidor-padrao';

export type { Favorito, Settings };

type Persisted = {
  version: 1;
  /**
   * Chave privada ECDSA deste computador, em JWK. Cifrada.
   *
   * É a identidade permanente da máquina na malha: o que prova, para quem já
   * se conectou aqui antes, que este número continua sendo este computador.
   * Perder o arquivo não impede de usar o programa — gera-se outra —, mas
   * quem já tinha se conectado vai receber o aviso de identidade trocada.
   */
  deviceToken?: string;
  /** O número Ryke, sorteado na primeira execução. */
  deviceId?: string;
  /** Verificador da senha: scrypt(senha, salt). Cifrado. */
  passwordSalt?: string;
  passwordVerifier?: string;
  /**
   * Impressões digitais já vistas, por número (fixação na primeira conexão).
   *
   * Não é segredo — é o contrário, é o que se compara. Fica em claro de
   * propósito: se estivesse cifrado com a DPAPI e o perfil do Windows fosse
   * trocado, todas as fixações se perderiam de uma vez e o usuário levaria um
   * alerta falso de golpe em cada contato conhecido.
   */
  knownHosts?: Record<string, string>;
  /** Computadores guardados com nome próprio. */
  favoritos?: Favorito[];
  /**
   * Senhas de acesso a outros computadores, por número. CIFRADAS.
   *
   * Guardar senha é sempre uma troca: some o incômodo de digitar toda vez, e
   * aparece o risco de alguém com acesso a esta máquina entrar nos
   * computadores da lista sem saber senha nenhuma. Por isso é opt-in, uma
   * marcação por computador, e nunca o padrão.
   *
   * A cifra é a DPAPI do Windows, amarrada à conta de usuário: copiar o
   * arquivo para outra máquina, ou abri-lo com outro usuário, não devolve
   * nada. Não protege contra quem já está logado nesta conta — nada
   * protegeria, e prometer o contrário seria mentira.
   */
  senhasSalvas?: Record<string, string>;
  settings?: Partial<Settings>;
};

const CIPHER_PREFIX = 'enc:v1:';

function defaults(): Settings {
  return {
    papel: null,
    // Vazio é o normal e o esperado: o encontro acontece na malha pública, sem
    // servidor nenhum. Este campo só existe para quem quiser somar um corretor
    // próprio à roda — não é requisito para nada funcionar.
    serverUrl: SERVIDOR_PADRAO,
    downloadDir: join(app.getPath('downloads'), 'Ryke Desk'),
    allowSupervisedAccess: true,
    syncClipboard: true,
    quality: 'auto',
    hostOnLaunch: true,
    blockLocalInput: false,
    setasIndependentes: true,
    permitirSasRemoto: false,
    displayName: process.env.COMPUTERNAME ?? 'Meu computador',
    turnUrl: '',
    turnUser: '',
    turnPass: '',
  };
}

export class Store {
  private file: string;
  private data: Persisted;

  constructor() {
    this.file = join(app.getPath('userData'), 'ryke-config.json');
    this.data = this.#read();
  }

  #read(): Persisted {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Persisted;
      if (parsed.version === 1) return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') console.warn('[store] configuração ilegível, recomeçando:', err);
    }
    return { version: 1 };
  }

  #write(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Cifra com DPAPI quando disponível; senão devolve o texto puro. */
  #protect(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) return value;
    return CIPHER_PREFIX + safeStorage.encryptString(value).toString('base64');
  }

  #unprotect(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (!value.startsWith(CIPHER_PREFIX)) return value;
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(CIPHER_PREFIX.length), 'base64'));
    } catch {
      // Perfil do Windows trocado ou chave DPAPI perdida: o dado é irrecuperável.
      return undefined;
    }
  }

  // ── identidade desta máquina na malha ──

  getIdentity(): { id: string | null; token: string | null } {
    return {
      id: this.data.deviceId ?? null,
      token: this.#unprotect(this.data.deviceToken) ?? null,
    };
  }

  saveIdentity(id: string, token: string): void {
    this.data.deviceId = id;
    this.data.deviceToken = this.#protect(token);
    this.#write();
  }

  // ── impressões digitais conhecidas ──

  getKnownHosts(): Record<string, string> {
    return { ...(this.data.knownHosts ?? {}) };
  }

  saveKnownHost(numero: string, impressao: string): void {
    this.data.knownHosts = { ...(this.data.knownHosts ?? {}), [numero]: impressao };
    this.#write();
  }

  /**
   * Esquece uma impressão fixada.
   *
   * Necessário quando a pessoa do outro lado formatou o computador ou
   * reinstalou o programa: a identidade mudou por um motivo legítimo, e sem
   * poder esquecer a antiga o usuário ficaria travado para sempre.
   */
  forgetKnownHost(numero: string): void {
    if (!this.data.knownHosts?.[numero]) return;
    const copia = { ...this.data.knownHosts };
    delete copia[numero];
    this.data.knownHosts = copia;
    this.#write();
  }

  // ── favoritos ──

  getFavoritos(): Favorito[] {
    // Mais recentes primeiro: é a ordem que o uso vai definindo sozinho, sem
    // pedir ao usuário que organize nada.
    return [...(this.data.favoritos ?? [])].sort((a, b) => b.usadoEm - a.usadoEm);
  }

  /** Cria ou renomeia. O número é a identidade; o nome é só rótulo. */
  saveFavorito(numero: string, nome: string): Favorito[] {
    const limpo = nome.trim().slice(0, 40);
    if (!limpo) return this.getFavoritos();
    const outros = (this.data.favoritos ?? []).filter((f) => f.numero !== numero);
    const anterior = (this.data.favoritos ?? []).find((f) => f.numero === numero);
    this.data.favoritos = [
      ...outros,
      { numero, nome: limpo, usadoEm: anterior?.usadoEm ?? Date.now() },
    ];
    this.#write();
    return this.getFavoritos();
  }

  /** Marca uso, para o favorito subir na lista sem o usuário ordenar nada. */
  touchFavorito(numero: string): void {
    const lista = this.data.favoritos ?? [];
    const alvo = lista.find((f) => f.numero === numero);
    if (!alvo) return;
    this.data.favoritos = lista.map((f) => (f.numero === numero ? { ...f, usadoEm: Date.now() } : f));
    this.#write();
  }

  removeFavorito(numero: string): Favorito[] {
    this.data.favoritos = (this.data.favoritos ?? []).filter((f) => f.numero !== numero);
    this.#write();
    return this.getFavoritos();
  }

  // ── senhas de OUTROS computadores, guardadas a pedido do usuário ──

  getSavedPassword(numero: string): string | null {
    const guardada = this.data.senhasSalvas?.[numero];
    return guardada ? (this.#unprotect(guardada) ?? null) : null;
  }

  saveSavedPassword(numero: string, senha: string): void {
    this.data.senhasSalvas = { ...(this.data.senhasSalvas ?? {}), [numero]: this.#protect(senha) };
    this.#write();
  }

  forgetSavedPassword(numero: string): void {
    if (!this.data.senhasSalvas?.[numero]) return;
    const copia = { ...this.data.senhasSalvas };
    delete copia[numero];
    this.data.senhasSalvas = copia;
    this.#write();
  }

  /** Só os números que têm senha guardada — nunca as senhas em si. */
  listSavedPasswords(): string[] {
    return Object.keys(this.data.senhasSalvas ?? {});
  }

  // ── senha de acesso ──

  hasPassword(): boolean {
    return Boolean(this.data.passwordSalt && this.data.passwordVerifier);
  }

  /** @returns o salt e o verificador em claro, ou null se não há senha definida */
  getPasswordMaterial(): { salt: Buffer; verifier: Buffer } | null {
    const salt = this.data.passwordSalt;
    const verifier = this.#unprotect(this.data.passwordVerifier);
    if (!salt || !verifier) return null;
    return { salt: Buffer.from(salt, 'hex'), verifier: Buffer.from(verifier, 'hex') };
  }

  savePassword(salt: Buffer, verifier: Buffer): void {
    this.data.passwordSalt = salt.toString('hex');
    this.data.passwordVerifier = this.#protect(verifier.toString('hex'));
    this.#write();
  }

  clearPassword(): void {
    delete this.data.passwordSalt;
    delete this.data.passwordVerifier;
    this.#write();
  }

  // ── preferências ──

  getSettings(): Settings {
    const bruto = { ...defaults(), ...this.data.settings };
    // Quem já usava o programa tem 'fluido' ou 'nitido' gravado. Traduzir é
    // melhor do que ignorar: a preferência foi uma escolha da pessoa.
    const traduzida = QUALIDADES_ANTIGAS[bruto.quality as string];
    if (traduzida) bruto.quality = traduzida;
    else if (!['auto', 'baixa', 'media', 'alta'].includes(bruto.quality)) bruto.quality = 'auto' as Quality;
    return bruto;
  }

  saveSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.#write();
    return this.getSettings();
  }

  get path(): string {
    return this.file;
  }
}
