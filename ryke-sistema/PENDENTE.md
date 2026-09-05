# O que falta

> **Atualizado.** O motor nativo existe e foi medido — ver `motor/LEIA-ME.md`.
> Uma sessão real de acesso remoto já roda ponta a ponta em C++, com captura
> DXGI, H.264 por hardware, transporte próprio sobre UDP (sem WebRTC), cifra
> AES-256-GCM, injeção de mouse e teclado, e desenho por Direct3D. O que segue
> abaixo é o que ainda NÃO existe nele.

## Pronto e medido

- [x] Captura por Desktop Duplication (DXGI).
- [x] Codificador H.264 por hardware (NVENC/Quick Sync/VCE via Media Foundation),
      em modo de baixa latência, sem quadros B.
- [x] Decodificador H.264 (hoje cai para software — falta DXVA).
- [x] Conversão BGRA→NV12 multinúcleo: 2,6 ms a 1080p.
- [x] Transporte próprio: fragmentação, retransmissão seletiva com prazo,
      ritmo de envio, controle de banda, medição de ida e volta.
- [x] Cifra: ECDH P-256 + senha, AES-256-GCM por pacote, anti-repetição.
- [x] Injeção de mouse (cinco botões, roda nos dois eixos, arrasto com máscara
      de botões) e teclado por posição física.
- [x] Janela Win32 e desenho por Direct3D 11, com proporção preservada.
- [x] Três provas automáticas: `prova-cripto`, `prova-transporte`, `prova-codec`.

## O que falta no motor, em ordem de valor

1. **Decodificação por DXVA.** Hoje o decodificador é software e consome 6 ms
   por quadro no visitante — é o maior item de atraso que sobrou. Exige ligar o
   MFT a um `IMFDXGIDeviceManager` e receber a saída como textura, o que de
   quebra elimina a cópia até a tela.
2. **Captura sem descer para a memória.** Hoje o quadro sai da GPU para a RAM
   (duas cópias) e volta. O caminho certo é DXGI → VideoProcessor (BGRA→NV12 na
   GPU) → codificador, sem o quadro nunca sair de lá. Elimina os 2,6 ms de
   conversão e boa parte dos 4,8 ms de captura.
3. **Número Ryke e encontro.** Hoje é `endereço:porta` — rede local ou porta
   liberada. Falta a malha que o aplicativo atual já tem.
4. **Rodar como SISTEMA**, que é o motivo original deste projeto: capturar e
   injetar na área de trabalho protegida do UAC. Ver `src/win32.ts`, que planeja
   o serviço e nunca foi executado.
5. Área de transferência, transferência de arquivos, vários visitantes com setas
   coloridas, Modo Gamer, Ctrl+Alt+Del.
6. A interface completa do 1.0.43.
7. Instalador e assinatura.

## 0. Assinar o código — virou pré-requisito, não enfeite

Descoberto ao tentar validar a fundação: **o Smart App Control do Windows 11
está ligado nesta máquina e bloqueou o `koffi.node`**.

```
CodeIntegrity 3077 — node.exe tentou carregar koffi.node  → bloqueado
CodeIntegrity 3118 — Smart App Control Block Details
Get-AuthenticodeSignature koffi.node → NotSigned
```

**O tamanho certo do problema, sem alarme falso:** os bloqueios registrados são
todos de `node.exe` e `bash.exe` carregando o `koffi.node` da PASTA DE
DESENVOLVIMENTO. O aplicativo **instalado** não foi bloqueado nenhuma vez — ele
continua funcionando. O que isto travou, hoje, foi a validação deste projeto.

O risco real é para instalações NOVAS: o Smart App Control vem ligado em
Windows 11 recém-instalado e decide por reputação. O `koffi` é a ponte para o
`SendInput`; se ele for barrado numa máquina de cliente, a sessão conecta,
mostra a tela e **não responde a nada** — o pior sintoma possível, porque
parece defeito de rede.

Vale para o projeto novo tanto quanto para o atual, porque **esta arquitetura
inteira é koffi**: tokens, sessões e áreas de trabalho. Assinar deixou de ser
"tirar o aviso do SmartScreen" e passou a ser condição para funcionar.

- [ ] Certificado de assinatura (SignPath ou equivalente).
- [ ] Assinar também os `.node` desempacotados, e não só o `.exe` — é o que o
      `electron-builder` **não** faz sozinho.
- [ ] Conferir numa máquina com Smart App Control ligado, que é o caso real.

### Medido, não suposto

Com o Smart App Control desligado nesta máquina, a captura nativa foi
compilada e **medida**, 1920×1080, com uma janela animada na tela:

| contexto | quadros/s | recriações |
|---|---|---|
| processo normal | **57,7** | 0 |
| processo **ELEVADO** | **52,6** | 0 |

Compare com a captura do Chromium no mesmo cenário elevado, tirado do log de
produção: `NotReadableError` → rota de software → **1 quadro/s**.

**A conclusão que isto libera:** o módulo nativo resolve o "modo administrador =
1 fps" **sozinho**, sem precisar de SISTEMA. O componente SISTEMA fica sendo
necessário apenas para o diálogo do UAC em si, na área protegida — que é um
problema menor e separado.

Também confirmado: quadro em BGRA com o tamanho exato (8.294.400 bytes para
1920×1080), imagem não preta, e zero perdas de duplicador durante as medidas.

### O custo que a medida revelou

**456 MB/s** saindo da GPU a 60 quadros. É o preço de trazer o quadro para a
memória, e é o próximo problema real: esse volume não atravessa o IPC do
Electron. Ver o item 4.

### Sobre o Smart App Control (o muro do produto)

Enquanto ligado, ele bloqueou **tudo** que foi recém-compilado — inclusive um
"olá mundo" de três linhas. Não tem lista de exceções: é tudo ou nada.

Foi desligado aqui para permitir a medida, e isso é **irreversível nesta
máquina**. Mas o muro continua de pé para o produto: o aplicativo instalado
carrega o `koffi.node` dele porque já tem reputação; um cliente com Windows 11
recém-instalado não terá. **Assinar continua obrigatório antes de distribuir.**

## 1. Fundação win32 — feita, falta provar

`src/win32.ts` existe e está documentado. Só as leituras foram exercitadas em
`prova-win32.cjs`, e mesmo essas ficaram travadas pelo item 0.

- [x] Assinaturas koffi de token, sessão e área de trabalho.
- [x] Ler a sessão ativa e o NOME da área de trabalho na frente.
- [x] `criarComoSistemaNaSessao` escrito (duplicar token → mover de sessão →
      criar apontando `lpDesktop`).
- [ ] Rodar `prova-win32.cjs` sem bloqueio (depende do item 0).
- [ ] Provar a criação de processo de verdade, rodando como SISTEMA.

## 2. Supervisor (SISTEMA, sessão 0)

- [ ] Tarefa agendada `RykeDesk-Sistema` com `/RU SYSTEM /RL HIGHEST`, criada
      pelo instalador (que é elevado). Tarefa, e não serviço: o Node não
      responde ao Gerenciador de Serviços sem um invólucro nativo, e a tarefa
      como SISTEMA dá o mesmo privilégio sem esse peso.
- [ ] Laço que observa `nomeDaAreaAtiva()` e, a cada troca, recria o agente na
      área certa. Um processo não muda de área depois de criado — é a razão de
      o supervisor existir.
- [ ] Morrer junto com o aplicativo: nada de processo SISTEMA órfão.

## 3. Agente (SISTEMA, na sessão do usuário)

- [ ] Modo de execução próprio do mesmo executável (uma bandeira na linha de
      comando), que não abre janela nenhuma.
- [ ] Injeção de entrada na área ativa, inclusive na protegida.
- [ ] Captura na área protegida — é aqui que o `E_ACCESSDENIED` deixa de
      acontecer, porque agora somos SISTEMA.

## 4. O cano entre o app e o agente

- [ ] Cano nomeado com o **aplicativo como servidor**. Nessa direção o agente
      (mais privilegiado) abre o cano do app (menos privilegiado), que é o
      sentido que o Windows permite sem mexer em descritor de segurança.
- [ ] Autenticação por segredo sorteado por sessão, gravado onde só o usuário
      lê. Um cano de injeção de teclado sem autenticação é uma porta aberta
      para qualquer processo da máquina.
- [ ] Recuo seguro: sem agente, tudo continua como hoje (injeção local).

## 5. Ligar no aplicativo — por último

- [ ] "Modo administrador" deixa de reabrir o programa e passa a ligar/desligar
      o agente. É o que devolve os 60 quadros nos dois modos, sem derrubar a
      conexão e sem pedir autorização de novo.
- [ ] Aposentar o relançamento elevado (`trocarModo`) só depois que o caminho
      novo estiver funcionando de ponta a ponta.
