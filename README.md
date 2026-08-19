# Ryke Desk

Acesso remoto entre dois computadores em qualquer lugar do Brasil.
**Sem servidor, sem cadastro, sem VPS.** Instala e funciona.

---

## Como funciona

O problema de todo software de acesso remoto é o primeiro instante: dois
computadores atrás do roteador das suas operadoras não conseguem se achar. A
solução usual é manter um servidor no meio para apresentar um ao outro — o que
custa dinheiro todo mês e cria um dono, porque se esse servidor cai, ninguém
mais conecta.

O Ryke Desk não tem servidor. Ele usa **pontos de encontro públicos** — caixas
de recado abertas na internet, de operadores independentes, que qualquer um
pode usar sem cadastro. São de duas famílias, e a razão de serem duas está
logo abaixo:

```
 PC do Ceará              8 pontos de encontro públicos            PC de SP
      │            MQTT (portas alternativas) + Nostr (443)            │
      │  "sou o 481 922 730" ──►  ▣▣▣▣ ▣▣▣▣  ◄── "quero o 481..."      │
      │                                                                │
      └──────  tela, teclado, mouse e arquivos: DIRETO, cifrado ───────┘
```

**Por que duas famílias.** Os corretores MQTT atendem em portas incomuns
(8084, 8884, 8081). Rede de casa não liga para isso; rede de empresa quase
sempre libera só 80 e 443 e barra o resto. Os relays Nostr falam na **443**, a
mesma porta de qualquer site — para o firewall é tráfego HTTPS comum.

Isso importa mais do que parece: dois computadores só se enxergam se
compartilharem **pelo menos um** ponto. Sem uma alternativa na 443, um PC no
trabalho e outro em casa podiam ficar os dois "online" e mesmo assim nunca se
encontrarem, por estarem em pontos sem interseção. Por isso o programa abre
todos os que a rede permitir, e os Ajustes mostram quais foram alcançados.

O número do computador vira um endereço embaralhado, e o recado vai cifrado. Os
corretores repassam bytes que não sabem ler. Depois que os dois se acham, saem
de cena: **a imagem, o teclado e os arquivos vão direto de um PC ao outro.**

Publica-se em todos ao mesmo tempo, de propósito. Se um sair do ar, os outros
seguem e o usuário não percebe nada.

## Baixar

Os instaladores oficiais ficam nas **[Releases deste
repositório](../../releases)** — sempre o `RykeDesk-Setup-<versão>.exe` da
versão mais recente. A partir da 1.0.17 o instalador é **assinado pelo SignPath
Foundation**, o que faz o Windows reconhecê-lo como um programa com editor
verificado. É esse o arquivo a baixar; qualquer `.exe` do Ryke Desk vindo de
outro lugar não passou por este processo.

## Usando

1. Instale a versão mais recente do `RykeDesk-Setup-<versão>.exe` (ver
   **Baixar**, acima) nos dois computadores.
2. O programa abre direto na tela principal, mostrando o **número deste
   computador** — 12 dígitos, como `481 922 730 155`. Não há nada a escolher:
   sem servidor, todo Ryke Desk é ao mesmo tempo quem recebe e quem acessa.
3. Para acessar o outro, digite o número dele e clique em *Conectar*.

**Atualizar é só rodar o instalador de novo.** Ele fecha o Ryke Desk que
estiver aberto — primeiro pedindo, depois insistindo — e **remove a versão
anterior antes de instalar a nova**, em vez de escrever por cima. Escrever por
cima com o programa aberto era o pior tipo de falha: os arquivos em uso não
eram substituídos, a instalação dizia "concluída" e o programa continuava
sendo o antigo. Nada é perguntado; quem mandou instalar quer instalar.

A configuração fica em `%APPDATA%\ryke-desk` e não é tocada: número, senha,
favoritos e senhas guardadas atravessam a atualização intactos.

**O número não muda sozinho.** Nem ao reinstalar por cima. Ele só muda quando
alguém aperta *Trocar numeração* em Ajustes, e com confirmação — porque é o
número que as pessoas anotam e passam adiante, e trocá-lo em silêncio quebraria
quem já o tinha salvo.

**Favoritos.** Doze dígitos ninguém decora. Clique em *Salvar nos favoritos com
um nome* e dê um apelido — "Notebook da Ana". Depois é só clicar no nome. O
botão fica sempre à vista, mesmo desligado enquanto o número não está completo:
recurso escondido até a pessoa fazer a coisa certa é recurso que não existe.

**Senha guardada, se você quiser.** A caixinha *Guardar a senha deste
computador* evita digitar toda vez. Ela é gravada só depois de o acesso dar
certo — guardar antes deixaria uma senha errada salva para sempre — e fica
cifrada pela DPAPI do Windows, presa a esta máquina e a esta conta. O que isso
**não** protege está escrito na própria caixinha: quem usar este Windows com a
sua conta vai conseguir entrar sem saber a senha. Desmarcar apaga na hora.

**A senha fica trancada durante uma sessão.** Enquanto alguém estiver
controlando este computador, não dá para trocar nem remover a senha de acesso
— nem por esta tela, nem por baixo dela. Quem está do outro lado enxerga a tela
e comanda o teclado: poderia abrir o Ryke Desk daqui, digitar uma senha nova e
passar a entrar quando quisesse, e o dono só descobriria quando a própria senha
parasse de funcionar. Encerre a sessão e a troca volta a ser possível.

Duas formas de entrar:

| Modo | Como | Quando usar |
|---|---|---|
| **Supervisionado** | Só o número. O outro PC toca e alguém clica em *Permitir*. | Suporte a alguém que está na frente da máquina. |
| **Não supervisionado** | Número + senha. Entra direto. | Acessar a sua própria máquina, que está sozinha. |

## As duas setas

Dentro da sessão você navega com **o cursor do seu próprio Windows** — o mesmo
de sempre, que responde na hora porque nem sai da sua máquina.

Antes ele ficava escondido e o que você via era a seta do computador remoto,
que vem desenhada dentro do vídeo e portanto chega com o atraso da imagem.
Mexer o mouse e ver a seta responder meio segundo depois torna qualquer
trabalho fino insuportável.

Agora o outro computador informa, pelo canal de controle (que é rápido), onde
o cursor dele está de verdade — e o Ryke Desk desenha ali uma **seta
vermelho-clara com o nome da máquina embaixo**. Ficam duas setas distintas:

| Seta | O que é |
|---|---|
| A comum, branca | a sua. Instantânea, é ela que você usa para mirar. |
| Vermelho-clara, com nome | onde o cursor do outro computador está. |

A posição é lida do Windows de lá, e não deduzida do que você mandou: quando a
pessoa que está no outro computador mexe no mouse dela, a seta marcada se mexe
junto e você vê acontecer.

> **O que não dá para fazer:** o Windows tem um cursor só. Os dois — você e
> quem está sentado na outra máquina — comandam o mesmo ponteiro; não existem
> dois cursores independentes, e nenhum programa de acesso remoto consegue
> isso. Para que a pessoa de lá não atrapalhe enquanto você trabalha, use o
> botão **Travar lá** da barra, que desliga o teclado e o mouse físicos dela.

## A barra da sessão

Ela some sozinha e volta quando o cursor **encosta** no topo da tela — encostar
mesmo, não chegar perto. Antes bastava passar a menos de 70 pixels do alto, e
isso tornava inalcançável a parte mais usada da tela do outro lado: 70 pixels do
alto de um computador é onde ficam as guias do navegador, a barra de título de
toda janela e o menu de todo programa. Ir clicar numa guia do Chrome remoto
fazia a barra saltar na frente e receber o clique.

Encostar é fácil de acertar de propósito justamente porque o sistema prende o
cursor na borda: dá para jogar o mouse para cima com força que ele para lá. Uma
vez aberta, ela fica até o cursor sair da área dela — dá para descer até os
botões sem ela fugir.

## Teclado: todas as teclas vão para lá

Durante a sessão, a barra tem o botão **Teclas**, ligado por padrão. Com ele
ligado, o Ryke Desk instala um gancho de teclado enquanto a janela está em
primeiro plano e manda **tudo** para o outro computador — inclusive o que o
Windows costuma consumir antes de qualquer aplicativo enxergar:

| Combinação | Sem a captura | Com a captura |
|---|---|---|
| **Ctrl+Shift+Esc** | abria o Gerenciador de Tarefas *daqui* | abre o *de lá* |
| **Tecla Windows** | menu Iniciar daqui | menu Iniciar de lá |
| **Ctrl+Esc**, **Alt+Tab**, **Alt+Esc** | agiam aqui | agem lá |

Três combinações continuam sendo desta janela, e precisam ser:
**Ctrl+Alt+Shift+X** encerra a sessão, **Ctrl+Alt+Shift+F** alterna a tela
cheia, e **Esc**, quando se está em tela cheia, devolve a janela. Sem uma saída
local, com o teclado todo capturado, só o mouse resolveria.

Fora da tela cheia o Esc atravessa normalmente, que é onde ele costuma ser
necessário — e mesmo em tela cheia dá para mandá-lo pelo menu *Teclas*.

O gancho sai no instante em que a janela perde o foco, e some junto com a
sessão. Nada de teclado sequestrado com o programa em segundo plano.

**Ctrl+Alt+Del continua sendo exceção**, e não por descuido: o Windows entrega
essa combinação direto ao Winlogon, num caminho que nenhum programa comum
alcança — é o que garante que a tela de bloqueio seja mesmo do Windows, e não
de um impostor. Por isso existe o botão dela no menu *Teclas*: ele injeta a
combinação do outro lado, que é onde ela precisa acontecer.

## Qualidade da imagem

Vem em **Automática**, que é o que serve para quase todo mundo: o programa mede
a rede a cada dois segundos e ajusta sozinho — cede taxa primeiro, depois
quadros, e só por último resolução, porque texto borrado é o que mais atrapalha
quem está trabalhando na máquina do outro.

Dá para fixar em **Baixa**, **Média** ou **Alta** pelo botão *Imagem* durante a
sessão. "Alta" tira todos os freios, e por isso é a única que pergunta antes de
ficar: se a rede não sustentar, a imagem passa a chegar tão atrasada que o
usuário não consegue nem clicar para desfazer. Ela se desfaz sozinha em 20
segundos se ninguém confirmar — o mesmo cuidado que o Windows toma ao trocar a
resolução do monitor.

### Sobre o atraso

O maior responsável pelo atraso não é a rede: é o buffer que o navegador
mantém para reproduzir vídeo liso. Faz todo sentido para assistir a um filme e
atrapalha aqui, onde imagem lisa que chega atrasada é pior do que imagem
levemente irregular que chega junto com o movimento do mouse. O Ryke Desk
encurta esse buffer e o mantém proporcional à trepidação medida da rede.

A barra da sessão mostra os dois números: **ms** é a ida e volta até o outro
computador; **ms img** é o atraso da imagem em si — o que a mão sente.

## Segurança

O transporte é público, então o projeto parte do princípio de que **ele é
hostil** — entrega bytes e não merece confiança para mais nada.

- **Envelope cifrado** (AES-GCM, chave derivada do número com PBKDF2/210 mil
  voltas). Quem não sabe o número não lê nada.
- **Endereço na malha também derivado com PBKDF2.** Parece detalhe e não é: os
  corretores são públicos, e com um resumo barato qualquer um montaria a
  tabela inversa endereço→número em segundos, recuperaria o número de todos os
  computadores ativos e leria o combinado deles. A chave cara não adiantaria
  nada — o elo mais fraco é que define a força da corrente.
- **Número de 12 dígitos** (900 bilhões). Sem servidor não há quem distribua
  números, então cada máquina sorteia o seu, e o tamanho do espaço é a única
  defesa contra repetição. Com 9 dígitos, 10 mil instalações já dariam 5% de
  chance de colisão; com 12, são 0,006%. Se ainda assim dois computadores
  responderem pelo mesmo número, o programa **avisa em vez de escolher um no
  chute**.
- **Identidade fixada na primeira conexão** (ECDSA P-256, modelo do SSH). Cada
  máquina assina o que envia. Se o computador por trás de um número mudar, o
  programa **recusa e avisa** — é o que impede alguém que descobriu o seu
  número de atender no seu lugar.
- **Senha por desafio-resposta** (scrypt + HMAC). A senha nunca trafega; o
  disco guarda só um verificador, cifrado pela DPAPI do Windows.
- **SDP carimbado** com chave derivada da senha, para que nem um corretor
  malicioso consiga se pôr no meio da negociação.
- **Freio contra força bruta**, por número e global — este último porque o
  atacante escolhe o próprio número e poderia zerar o contador só reconectando.
- **Área de transferência com interruptor**: ligada, tudo que você copiar
  durante uma sessão vai para o outro lado, inclusive uma senha. Está nos
  Ajustes.

## O que isto não resolve

Duas limitações reais, ditas com todas as letras:

**Redes que bloqueiam até a porta 443.** Aí não há saída — mas é o mesmo caso
em que nenhum site abriria.

**Redes com CGNAT dos dois lados.** Quando as duas pontas usam internet sem
endereço próprio, não existe caminho direto possível, e só um retransmissor no
meio resolveria. Ele repassaria o vídeo inteiro — banda paga, que ninguém
oferece de graça: levantei os retransmissores públicos conhecidos e **nenhum
continua de pé sem cadastro**. Preferi não embutir endereços mortos, porque
cada um deles atrasa a negociação de todas as conexões. Quem cair nesse caso
tem o campo de retransmissor nos Ajustes.

**Aviso do Windows na instalação.** O instalador não é assinado digitalmente,
então o SmartScreen avisa até o programa ganhar reputação. A solução é um
certificado de assinatura de código (~US$ 200–400/ano) — não há atalho, e
qualquer "jeito de driblar o antivírus" seria exatamente o que um programa
malicioso faria.

## Desenvolvimento

```bash
npm install
npm run dev              # desenvolvimento
npm run typecheck
npm test                 # unitários + ponta a ponta (2 apps reais)
npm run dist             # instalador em release/
```

Um teste fica fora da suíte padrão porque depende da internet:

```bash
node --import ./test/ts-resolve.mjs test/internet.mjs
```

Ele confere todos os pontos de encontro públicos, faz dois computadores se
acharem de verdade pela internet, repete a prova **usando apenas a porta 443**
(simulando rede de empresa) e testa a descoberta de endereço. **Rode antes de
publicar uma versão** — é o que avisa se algum serviço público saiu do ar.

E o teste de ponta a ponta pode usar a infraestrutura real, em vez dos
corretores locais:

```bash
set RYKE_E2E_INTERNET=1 && node test/e2e.mjs
```

## Quando não conectar

Abra os **Ajustes** e olhe *Pontos de encontro alcançados*. Isso responde
sozinho a maior parte das dúvidas:

| O que aparece | O que significa |
|---|---|
| Nenhum ponto verde | Este PC não está saindo para a internet |
| Alguns verdes, nenhum na 443 | Rede restritiva; pode não achar quem está em rede de empresa |
| Vários verdes, inclusive 443 | A rede daqui está bem — verifique o outro PC e o número |

### Onde está o quê

| Arquivo | Papel |
|---|---|
| `src/shared/malha.ts` | A malha: vários corretores, dedupe, número autoemitido |
| `src/shared/encontro.ts` | Cifra do envelope, identidade, impressão digital |
| `src/shared/mqtt.ts` | Cliente MQTT 3.1.1 escrito à mão (sem dependência) |
| `src/shared/nostr.ts` | Segundo caminho, na porta 443, para redes restritas |
| `src/renderer/src/lib/session.ts` | A sessão WebRTC em si |
| `src/main/input.ts` | Injeção de teclado e mouse via `user32.dll` |
| `src/main/auth.ts` | Senha, desafio-resposta e freio de força bruta |

O cliente MQTT é escrito à mão de propósito: um programa que captura tela e
injeta teclado já é examinado com lupa por antivírus, e cada dependência a
mais é código de terceiro dentro do instalador que ninguém leu.

### Corretor próprio (opcional)

Quem preferir não depender de serviço público de cortesia pode somar um
corretor MQTT próprio — nos Ajustes, ou gravado no instalador:

```bash
set RYKE_SERVIDOR=wss://mqtt.suaempresa.com.br && npm run dist
```

Ele entra **junto** com os públicos, nunca no lugar deles: quem aponta o seu
não fica sem saída se ele cair.

---

### Nota sobre `src/servidor/` e `servidor-vps/`

São o servidor de sinalização da arquitetura anterior. **Nenhum código vivo os
usa** — ficaram no disco para consulta. Podem ser apagados sem efeito sobre o
programa.

---

## Licença

O Ryke Desk é software livre sob a **GNU General Public License v3.0 ou
posterior** (ver [`LICENSE`](LICENSE)). Qualquer um pode usar, estudar,
modificar e redistribuir — e todo trabalho derivado precisa continuar aberto
sob a mesma licença.

A assinatura de código dos instaladores segue a
[política de assinatura](docs/POLITICA-DE-ASSINATURA.md), feita pelo
[SignPath Foundation](https://signpath.org/), que oferece assinatura gratuita a
projetos de código aberto. A chave de assinatura nunca sai do HSM deles: a
equipe do Ryke Desk não a possui nem a manipula.
