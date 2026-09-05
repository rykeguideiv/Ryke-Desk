# Ryke Sistema — o componente que enxerga a área protegida

Este é um projeto **novo e separado**, dentro do Ryke Desk. Ele não altera o
aplicativo que já funciona: nasce ao lado dele, para resolver o único problema
que a arquitetura atual não tem como resolver.

## O problema, em uma frase

Quando alguém clica em algo que pede administrador no computador remoto, a
sessão congela e não volta. E entrar no "Modo administrador" não ajuda: piora,
porque derruba a imagem de 60 quadros para 1.

## Por que os dois caminhos estão fechados

Não é defeito de programação nossa. São duas regras do Windows, documentadas,
que se fecham uma contra a outra:

**1. A área protegida do UAC não entra na captura.** Com o UAC ligado, o
diálogo "deseja permitir?" é desenhado numa área de trabalho separada, à qual
nenhum programa comum tem acesso. A própria Microsoft descreve o efeito: o
diálogo aparece só na tela local e **quem está do outro lado vê tela preta**.

**2. Elevar o aplicativo mata a captura.** Medimos em produção:

```
16:13:56  captura=hardware  fonte=1920x1080@60      ← app normal: 60 fps
16:15:42  [modo] troca solicitada -> ELEVADO
16:15:46  [gpu] elevado=true
16:16:13  captura=SOFTWARE  NotReadableError        ← elevado: 1 fps
```

A causa é conhecida: o WebRTC captura pela *Desktop Duplication API*, e ela
exige privilégio de **Local System** nesse cenário — devolve `E_ACCESSDENIED`
para qualquer coisa abaixo disso. Ou seja: **administrador não basta**. É
preciso ser o SISTEMA.

> Isto é o que separa o Ryke Desk das ferramentas que "simplesmente funcionam".
> Elas não têm um truque melhor de captura: elas têm um componente rodando como
> SISTEMA.

## A arquitetura

Três peças, cada uma com o privilégio mínimo do seu trabalho:

```
┌─────────────────────────────────────────────────────────────┐
│  Ryke Desk (o app)                    integridade NORMAL     │
│  janela, WebRTC, rede, interface                             │
│  — nunca eleva, por isso a captura fica sempre em 60 fps     │
└───────────────────────────┬─────────────────────────────────┘
                            │ cano nomeado (o app é o servidor)
┌───────────────────────────┴─────────────────────────────────┐
│  Agente                    SISTEMA, na sessão do usuário     │
│  captura e injeta na área de trabalho ATIVA — inclusive na   │
│  protegida, que é o que só o SISTEMA alcança                 │
└───────────────────────────┬─────────────────────────────────┘
                            │ criado por
┌───────────────────────────┴─────────────────────────────────┐
│  Supervisor               SISTEMA, sessão 0 (sem tela)       │
│  vigia qual área de trabalho está na frente e (re)cria o     │
│  agente na certa: `winsta0\default` ou `winsta0\Winlogon`    │
└─────────────────────────────────────────────────────────────┘
```

### Por que três peças, e não duas

Um processo do Windows nasce **preso a uma área de trabalho** e não pode
mudar de área depois. Quando o UAC entra, a área ativa deixa de ser
`winsta0\default` e passa a ser `winsta0\Winlogon`. Por isso alguém precisa
estar **fora** dessas duas para observar a troca e criar um agente novo do lado
certo — e esse alguém é o supervisor, na sessão 0.

E o supervisor precisa ser SISTEMA por dois motivos: só o SISTEMA tem o
privilégio `SE_TCB_NAME`, exigido para criar um processo dentro da sessão de
outro usuário, e só ele tem acesso à área de trabalho protegida.

### Por que o app principal NÃO eleva

Esta é a decisão que devolve os 60 quadros. Hoje o "Modo administrador" reabre
o Ryke Desk inteiro elevado — e é exatamente isso que quebra a captura. Na
arquitetura nova o app fica **sempre** em integridade normal, onde a captura
por hardware funciona, e todo trabalho que exige privilégio vai para o agente.

Efeitos colaterais, todos bons:

- 60 quadros com e sem "modo administrador" — o app nunca eleva;
- a conexão **não cai** ao ligar ou desligar o modo, porque não há reinício;
- ninguém precisa autorizar a sessão de novo;
- clicar em janelas de administrador passa a funcionar (o agente é SISTEMA).

## A captura nativa (`nativo/`)

Além do caminho acima, este projeto traz a **captura em C++ pela Desktop
Duplication API** — o pedaço que o `koffi` não alcança, porque ali é COM sobre
Direct3D 11, e não função de DLL.

```
nativo/
  src/duplicador.h/.cc   o duplicador DXGI: device D3D11 → output → duplicação
  src/addon.cc           a ponte N-API, de propósito minúscula
  index.js               a política (recriar quando cai, contar quadros)
  prova.cjs              a MEDIDA: abre, captura por 5 s e diz quantos q/s deu
```

A divisão é deliberada: o C++ fica só com o que exige compilador, e toda
decisão que muda com frequência mora no JavaScript, onde não custa recompilar.

**O que ela dá, e o que não dá.** Ela não torna o modo normal mais rápido — a
captura do Chromium já mantém o quadro na GPU do início ao fim, e a nossa
precisa trazê-lo para a memória (duas cópias). O ganho dela é um só, e é o que
falta: **capturar rodando como SISTEMA, inclusive na área protegida do UAC**.
Por isso ela e a arquitetura de três peças acima são o mesmo plano, não dois.

## Estado

Fundação, e ela **não foi compilada nem executada nenhuma vez**. O que existe é
código escrito e documentado:

- `src/win32.ts` — tokens, sessões e áreas de trabalho (koffi);
- `nativo/` — o duplicador DXGI em C++ e sua ponte.

Nada disso foi provado. Faltam duas coisas antes de qualquer afirmação sobre
funcionar: a cadeia de compilação (Build Tools + Windows SDK + Python, em
instalação) e a assinatura de código — porque o Smart App Control barrou um
`.node` sem assinatura durante a primeira tentativa de validação.

O que falta está em [`PENDENTE.md`](./PENDENTE.md).

Nada aqui é chamado pelo aplicativo. Enquanto não estiver pronto e medido, o
Ryke Desk continua se comportando exatamente como hoje.

## Fontes

- [electron/electron#42882](https://github.com/electron/electron/issues/42882)
  — captura falha em contexto elevado.
- [discuss-webrtc: capturar com a tela bloqueada](https://groups.google.com/g/discuss-webrtc/c/Eso9KnK08cE)
  — `DuplicateOutput` exige Local System, senão `E_ACCESSDENIED`.
- [Microsoft — ways to capture the screen](https://learn.microsoft.com/nl-nl/archive/blogs/dsui_team/ways-to-capture-the-screen)
  — a área protegida do UAC e a tela preta para quem acessa remotamente.
