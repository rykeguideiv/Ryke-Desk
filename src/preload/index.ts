/**
 * Ponte entre a interface e o sistema operacional.
 *
 * O renderer roda com contextIsolation e sem acesso ao Node. Tudo que ele pode
 * fazer no PC está listado aqui — uma superfície pequena e explícita, em vez
 * de entregar `require` para uma página web.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { Favorito, Papel, ScryptParams, Settings } from '../shared/config';
import type { PerfilCapturaSoftware } from '../shared/qualidade-captura';
import type { Ponteiro } from '../shared/ponteiros';

const api = {
  app: {
    info: () =>
      ipcRenderer.invoke('app:info') as Promise<{
        version: string;
        machineName: string;
        configPath: string;
        abi: { ok: boolean; inputSize: number };
      }>,
  },

  identity: {
    get: () => ipcRenderer.invoke('identity:get') as Promise<{ id: string | null; token: string | null }>,
    save: (id: string, token: string) => ipcRenderer.invoke('identity:save', id, token) as Promise<void>,
    /** Impressões digitais já fixadas, por número. */
    knownHosts: () => ipcRenderer.invoke('identity:knownHosts') as Promise<Record<string, string>>,
    pin: (numero: string, impressao: string) =>
      ipcRenderer.invoke('identity:pin', numero, impressao) as Promise<void>,
    /** Esquece a impressão de um número (o outro lado reinstalou o programa). */
    unpin: (numero: string) => ipcRenderer.invoke('identity:unpin', numero) as Promise<{ ok: boolean }>,
  },

  favorites: {
    list: () => ipcRenderer.invoke('favorites:list') as Promise<Favorito[]>,
    save: (numero: string, nome: string) =>
      ipcRenderer.invoke('favorites:save', numero, nome) as Promise<Favorito[]>,
    remove: (numero: string) => ipcRenderer.invoke('favorites:remove', numero) as Promise<Favorito[]>,
    touch: (numero: string) => ipcRenderer.invoke('favorites:touch', numero) as Promise<void>,
  },

  /** Senhas de acesso a OUTROS computadores, guardadas a pedido do usuário. */
  senhas: {
    lista: () => ipcRenderer.invoke('senhas:lista') as Promise<string[]>,
    ler: (numero: string) => ipcRenderer.invoke('senhas:ler', numero) as Promise<string | null>,
    salvar: (numero: string, senha: string) =>
      ipcRenderer.invoke('senhas:salvar', numero, senha) as Promise<void>,
    esquecer: (numero: string) => ipcRenderer.invoke('senhas:esquecer', numero) as Promise<{ ok: boolean }>,
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
    save: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:save', patch) as Promise<Settings>,
    pickFolder: () => ipcRenderer.invoke('settings:pickFolder') as Promise<string | null>,
  },

  role: {
    /** Aplica a resposta das duas perguntas iniciais. Liga o servidor se 'receber'. */
    apply: (papel: Papel) =>
      ipcRenderer.invoke('role:apply', papel) as Promise<{
        ok: boolean;
        papel: Papel;
        serverUrl: string;
        configurado: boolean;
      }>,
    status: () =>
      ipcRenderer.invoke('role:status') as Promise<{
        papel: Papel;
        ip: string;
        serverUrl: string;
        servidorPadrao: string;
        configurado: boolean;
        /** Pontos de encontro vindos do ambiente; null = usa os embutidos. */
        corretores: string[] | null;
        relays: string[] | null;
      }>,
    /** Volta à tela das duas perguntas; desliga o servidor se estava ligado. */
    reset: () => ipcRenderer.invoke('role:reset') as Promise<{ ok: boolean }>,
  },

  password: {
    status: () => ipcRenderer.invoke('password:status') as Promise<{ defined: boolean; travada: boolean }>,
    set: (password: string | null) => ipcRenderer.invoke('password:set', password) as Promise<{ defined: boolean }>,
  },

  auth: {
    /** Anfitrião: material do desafio para o número que está pedindo entrada. */
    challenge: (peerId: string) =>
      ipcRenderer.invoke('auth:challenge', peerId) as Promise<{
        challenge?: { salt: string; nonce: string; scrypt: ScryptParams };
        noPassword?: boolean;
        locked?: number;
      }>,
    /** Anfitrião: confere a prova recebida. */
    verify: (peerId: string, nonce: string, proof: string) =>
      ipcRenderer.invoke('auth:verify', peerId, nonce, proof) as Promise<{
        ok: boolean;
        reason?: string;
        locked?: number;
      }>,
    /** Visitante: converte a senha digitada na prova a enviar. */
    prove: (peerId: string, password: string, salt: string, nonce: string, params: ScryptParams) =>
      ipcRenderer.invoke('auth:prove', peerId, password, salt, nonce, params) as Promise<string>,
    /** Carimba o SDP com a chave derivada da senha (null se não houver senha). */
    sdpMac: (peerId: string, sdp: string) =>
      ipcRenderer.invoke('auth:sdpMac', peerId, sdp) as Promise<string | null>,
    /** Confere o carimbo do SDP recebido. */
    checkSdpMac: (peerId: string, sdp: string, mac: string | null) =>
      ipcRenderer.invoke('auth:checkSdpMac', peerId, sdp, mac) as Promise<'ok' | 'invalido' | 'sem-chave'>,
    /** Descarta a chave de sessão ao encerrar. */
    forget: (peerId: string) => ipcRenderer.invoke('auth:forget', peerId) as Promise<void>,
  },

  screen: {
    list: () =>
      ipcRenderer.invoke('screen:list') as Promise<
        { id: number; label: string; primary: boolean; width: number; height: number; scaleFactor: number }[]
      >,
    select: (id: number) => ipcRenderer.invoke('screen:select', id) as Promise<void>,
    active: () =>
      ipcRenderer.invoke('screen:active') as Promise<{ id: number; width: number; height: number; scaleFactor: number }>,
    /** Id nativo usado pela captura de compatibilidade em drivers problemáticos. */
    captureSource: () => ipcRenderer.invoke('screen:captureSource') as Promise<string | null>,
    /** Quadro JPEG para a rota por software, independente das APIs de mídia. */
    captureFrame: (perfil: PerfilCapturaSoftware) =>
      ipcRenderer.invoke('screen:captureFrame', perfil) as Promise<{
        bytes: Uint8Array;
        mime: 'image/jpeg' | 'image/png';
        width: number;
        height: number;
      }>,
    /** Diagnóstico do perfil realmente aplicado à última imagem reserva. */
    captureStatus: () => ipcRenderer.invoke('screen:captureStatus') as Promise<{
      mime: 'image/jpeg' | 'image/png';
      lossless: boolean;
      jpegQuality: number;
      width: number;
      height: number;
    } | null>,
    /** Monitores adicionados/removidos ou mudança entre Estender/Duplicar. */
    onChanged: (fn: () => void) => subscribe('screen:changed', fn),
  },

  programas: {
    instalar: () =>
      ipcRenderer.invoke('programas:instalar') as Promise<{
        ok: boolean;
        canceled?: boolean;
        message: string;
      }>,
  },

  /**
   * Chamado apenas no anfitrião, sempre com dados já validados pela sessão.
   *
   * Tudo aqui leva o número de QUEM mandou. Não é enfeite: com várias pessoas
   * na mesma máquina, é o `peerId` que diz de quem é a seta que se move, quem
   * está segurando um botão e para quem o cursor real precisa voltar.
   */
  input: {
    move: (peerId: string, fx: number, fy: number) => ipcRenderer.send('input:move', peerId, fx, fy),
    button: (peerId: string, button: 0 | 1 | 2, down: boolean, fx: number, fy: number) =>
      ipcRenderer.send('input:button', peerId, button, down, fx, fy),
    // Modo Gamer: deslocamento relativo e clique sem reposicionar o cursor.
    moveRel: (peerId: string, dx: number, dy: number) => ipcRenderer.send('input:moveRel', peerId, dx, dy),
    /** Entrou/saiu do Modo Gamer: some com a seta e prende o ponteiro no centro. */
    gamer: (peerId: string, on: boolean) => ipcRenderer.send('input:gamer', peerId, on),
    buttonRel: (button: 0 | 1 | 2, down: boolean) => ipcRenderer.send('input:buttonRel', button, down),
    wheel: (peerId: string, dx: number, dy: number, fx: number, fy: number) =>
      ipcRenderer.send('input:wheel', peerId, dx, dy, fx, fy),
    key: (code: string, down: boolean) => ipcRenderer.send('input:key', code, down),
    combo: (codes: string[]) => ipcRenderer.send('input:combo', codes),
    text: (value: string) => ipcRenderer.send('input:text', value),
    releaseAll: () => ipcRenderer.send('input:release'),
    blockLocal: (on: boolean) => ipcRenderer.invoke('input:block', on) as Promise<boolean>,
  },

  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read') as Promise<string>,
    write: (text: string) => ipcRenderer.invoke('clipboard:write', text) as Promise<void>,
    files: () => ipcRenderer.invoke('clipboard:files') as Promise<string[]>,
    onText: (fn: (text: string) => void) => subscribe('clipboard:text', fn),
    onFiles: (fn: (paths: string[]) => void) => subscribe('clipboard:files', fn),
  },

  files: {
    newId: () => ipcRenderer.invoke('files:newId') as Promise<string>,
    pick: () => ipcRenderer.invoke('files:pick') as Promise<{ id: string; name: string; size: number } | null>,
    open: (path: string) => ipcRenderer.invoke('files:open', path) as Promise<{ id: string; name: string; size: number }>,
    read: (id: string, offset: number, length: number) =>
      ipcRenderer.invoke('files:read', id, offset, length) as Promise<Uint8Array<ArrayBuffer>>,
    closeSend: (id: string) => ipcRenderer.invoke('files:closeSend', id) as Promise<void>,
    begin: (id: string, name: string, size: number) =>
      ipcRenderer.invoke('files:begin', id, name, size) as Promise<{ path: string }>,
    write: (id: string, chunk: Uint8Array) => ipcRenderer.invoke('files:write', id, chunk) as Promise<number>,
    finish: (id: string) => ipcRenderer.invoke('files:finish', id) as Promise<{ path: string; size: number }>,
    abort: (id: string, reason: string) => ipcRenderer.invoke('files:abort', id, reason) as Promise<void>,
    reveal: (path: string) => ipcRenderer.invoke('files:reveal', path) as Promise<void>,
    /**
     * Põe o arquivo recebido na área de transferência desta máquina, para que
     * um Ctrl+V numa pasta qualquer cole de verdade.
     */
    copiarParaAreaDeTransferencia: (paths: string[]) =>
      ipcRenderer.invoke('clipboard:copiarArquivos', paths) as Promise<boolean>,
  },

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    fullscreen: (on: boolean) => ipcRenderer.send('window:fullscreen', on),
    /** Sai da tela cheia e encolhe para metade do monitor, para arrastar à vontade. */
    janela: () => ipcRenderer.send('window:janela'),
    /** Traz a janela para a frente e pisca na barra de tarefas. */
    chamarAtencao: () => ipcRenderer.send('window:attention'),
    viewerMode: (on: boolean) => ipcRenderer.send('window:viewer', on),
    state: () =>
      ipcRenderer.invoke('window:state') as Promise<{
        maximized: boolean;
        fullscreen: boolean;
        minimizada: boolean;
      }>,
    onState: (fn: (state: { maximized: boolean; fullscreen: boolean }) => void) => subscribe('window:state', fn),
  },

  session: {
    setActive: (active: boolean) => ipcRenderer.send('session:active', active),
    /** Quantos visitantes controlam esta máquina agora — tranca a senha. */
    visitantes: (quantos: number) => ipcRenderer.send('sessao:visitantes', quantos),
    onSenhaTravada: (fn: (travada: boolean) => void) => subscribe('senha:travada', fn),
    /**
     * Onde o cursor desta máquina está, em fração da tela.
     *
     * Só chega enquanto há visitante conectado, e só quando o ponto muda.
     */
    onCursor: (fn: (ponto: { x: number; y: number }) => void) => subscribe('cursor:posicao', fn),
  },

  /**
   * As setas coloridas dos visitantes, do lado do ANFITRIÃO.
   *
   * A interface diz quem entrou e com que cor; o processo principal desenha
   * isso na camada transparente por cima da tela e devolve, vinte vezes por
   * segundo, onde cada seta está — para a interface repassar a cada visitante
   * as setas dos OUTROS.
   */
  ponteiros: {
    entrar: (peerId: string, nome: string, cor: number) => ipcRenderer.send('ponteiros:entrar', peerId, nome, cor),
    sair: (peerId: string) => ipcRenderer.send('ponteiros:sair', peerId),
    onEstado: (fn: (lista: Ponteiro[]) => void) => subscribe('ponteiros:estado', fn),
  },

  /**
   * Captura total do teclado, para que Ctrl+Shift+Esc, a tecla Windows e
   * Alt+Tab cheguem ao computador remoto em vez de agirem neste.
   */
  teclado: {
    capturar: (on: boolean) => ipcRenderer.invoke('teclado:capturar', on) as Promise<boolean>,
    // Modo Gamer: quando false, o Esc puro deixa de minimizar e vai ao jogo.
    escMinimiza: (on: boolean) => ipcRenderer.send('teclado:escMinimiza', on),
    onEvento: (
      fn: (evento:
        | { tipo: 'tecla'; code: string; pressionada: boolean }
        | { tipo: 'acao'; qual: 'sair' | 'telaCheia' | 'minimizar' | 'gamer' }
        | { tipo: 'soltar' }) => void,
    ) => subscribe('teclado:evento', fn),
  },
};

/** Assina um canal e devolve a função que cancela a assinatura. */
function subscribe<T>(channel: string, fn: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

contextBridge.exposeInMainWorld('ryke', api);

export type RykeApi = typeof api;
