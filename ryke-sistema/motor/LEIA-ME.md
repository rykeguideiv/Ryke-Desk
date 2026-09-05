# Motor nativo — acesso remoto sem navegador e sem WebRTC

Este é o coração do `ryke-sistema`: captura, comprime, transporta, descomprime e
desenha, tudo em C++ falando direto com o Windows. Nenhum navegador, nenhum
WebRTC, nenhum servidor de sinalização.

## Como compilar e provar

```
COMPILAR.cmd
```

Exige apenas o **Visual Studio Build Tools** com o conjunto C++. O script
compila e roda as três provas; se qualquer uma reprovar, ele para.

## Como usar

```
ryke-sistema.exe --anfitriao --senha SUA-SENHA --porta 5900
ryke-sistema.exe --visitante 192.168.0.10:5900 --senha SUA-SENHA
```

Sem argumento nenhum, ele pergunta. Na janela do visitante, **F11** alterna
tela cheia.

## O caminho de um quadro

```
  ANFITRIÃO                                             VISITANTE
  ─────────                                             ─────────
  DXGI Desktop Duplication      4,8 ms
        ↓
  BGRA → NV12 (multinúcleo)     2,6 ms
        ↓
  H.264 pela placa (NVENC)      2,2 ms
        ↓
  parte em pedaços de 1200 B
  cifra AES-256-GCM
        ↓
  ────────────── UDP ──────────────→   remonta o quadro
                                       pede de volta o que faltou
                                             ↓
                                       H.264 → NV12               6 ms
                                             ↓
                                       Direct3D 11 desenha
```

## O que foi medido nesta máquina

Sessão real de 1920x1080, anfitrião e visitante em processos separados
(RTX/NVENC, Windows 11):

| medida | valor |
|---|---|
| quadros por segundo, no anfitrião | **60** |
| quadros por segundo, desenhados no visitante | **54–56** |
| banda | 3,9–9 Mb/s |
| ida e volta da rede | 2,5–7 ms |
| perda | 0% |
| captura + conversão + codificação | 9,6 ms por quadro |
| decodificação | 5,5–7 ms (decodificador por software) |

E com perda **provocada** no transporte (`prova-transporte`):

| perda forçada | quadros completos | como |
|---|---|---|
| 0% | 120 de 120 | — |
| 5% | 117 de 120 (97%) | 198 pedidos de retransmissão, 194 atendidos |
| 20% | 112 de 120 (93%) | idem |

Sem retransmissão seletiva, um quadro de 35 pedaços a 20% de perda teria 0,04%
de chance de chegar inteiro. E a **entrada** (mouse e teclado), que é
retransmitida até ser confirmada, chegou 200 de 200, em ordem e sem duplicata,
com 20% de perda nos dois sentidos.

## Por que um transporte próprio

O WebRTC resolve videoconferência: ele **esconde** variação da rede
acrescentando atraso, porque para conversar isso é o certo. Para acesso remoto é
o contrário — é melhor ver um quadro imperfeito agora do que o quadro perfeito
daqui a 80 ms, porque a pessoa está com a mão no mouse esperando a resposta.

Além disso o WebRTC vem inteiro ou não vem: para usar o transporte era preciso
arrastar o navegador junto, e é justamente o navegador que não consegue capturar
a tela quando o processo está elevado — o defeito que originou este projeto.

As regras deste transporte cabem em duas linhas:

- **Vídeo é perecível.** Pedaço que falta é pedido de volta enquanto o quadro
  ainda vale; vencido o prazo, abandona-se o quadro e pede-se um quadro-chave.
  Nunca trava esperando.
- **Entrada é sagrada.** Retransmitida até ser confirmada e entregue em ordem.
  Um clique perdido é um clique que a pessoa deu e não aconteceu.

## Segurança

Chave por sessão via **ECDH P-256**, misturada com a **senha combinada fora da
rede**, e cada pacote selado com **AES-256-GCM** (as primitivas do próprio
Windows, via CNG — nada de terceiros).

A senha na derivação é o que transforma um ECDH anônimo — que combina chave com
quem quer que atenda — numa troca que só fecha entre dois lados que já sabiam a
mesma coisa. `prova-cripto` verifica: com a senha errada o aperto até fecha, e
**nenhum pacote atravessa**. Também recusa pacote alterado (um bit no corpo ou
no cabeçalho) e pacote regravado e reenviado.

## O que já existe e o que falta

Existe, provado e medido:

- captura por DXGI, codec H.264 por hardware, transporte próprio, cifra,
  injeção de mouse e teclado, janela e desenho por Direct3D;
- mouse completo: os cinco botões (inclusive os laterais), roda vertical e
  horizontal, e **arrasto** — com a máscara de botões em todo movimento, que é a
  lição que o aplicativo atual aprendeu quebrando;
- teclado por posição física da tecla, não por caractere;
- solta tudo ao perder o foco, ao cair a sessão e ao fechar.

Falta, e não é pouco (ver `../PENDENTE.md`):

- o **número Ryke** e a malha de encontro — hoje é `endereço:porta`, ou seja,
  rede local ou porta liberada;
- transferência de arquivos, área de transferência, vários visitantes com setas
  coloridas, Modo Gamer, modo administrador, Ctrl+Alt+Del;
- a interface completa do 1.0.43;
- decodificação por **DXVA** (hoje o decodificador cai para software e é ele que
  consome os 6 ms do visitante);
- instalador e assinatura.

## Onde mexer

| pasta | o quê |
|---|---|
| `src/base` | tempo monotônico e registro |
| `src/transporte` | o fio: pacote, cifra, soquete, retransmissão, ritmo |
| `src/codec` | conversão de cor e o par codificador/decodificador |
| `src/captura` | Desktop Duplication |
| `src/entrada` | injeção de mouse e teclado |
| `src/ui` | janela Win32 e desenho Direct3D |
| `src/app` | as duas pontas e a linha de comando |
| `testes` | as três provas |
