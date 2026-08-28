# Ryke Desk

**Acesso remoto entre dois computadores em qualquer lugar do Brasil.
Sem servidor, sem cadastro, sem mensalidade.** Instala e funciona.

[![Licença: GPL v3](https://img.shields.io/badge/Licen%C3%A7a-GPLv3-blue.svg)](LICENSE)
[![Plataforma: Windows](https://img.shields.io/badge/Plataforma-Windows%2010%2F11-0078D6.svg)](../../releases)
[![Assinado pelo SignPath Foundation](https://img.shields.io/badge/Assinado-SignPath%20Foundation-2ea44f.svg)](docs/POLITICA-DE-ASSINATURA.md)
[![Baixar](https://img.shields.io/badge/Baixar-Releases-orange.svg)](../../releases)

Você digita o número de 12 dígitos do outro computador, ele pergunta a senha (ou
alguém clica em *Permitir* do outro lado), e pronto: a tela dele aparece na sua,
o seu teclado e o seu mouse comandam, e os arquivos vão e vêm arrastando.

**O que o diferencia dos outros:**

| | |
|---|---|
| 🔴🔵🟢 | **Uma seta colorida para cada pessoa**, com o nome embaixo. O cursor de quem está na máquina continua sendo dele — duas pessoas trabalham na mesma tela ao mesmo tempo. [Como isso é possível](#as-setas-uma-para-cada-pessoa) |
| 🌐 | **Nenhum servidor para manter.** Nem meu, nem seu. Usa pontos de encontro públicos só para os dois PCs se acharem, e depois sai de cena |
| 🔒 | **Ponta a ponta.** Quem repassa o recado inicial não sabe lê-lo; a tela e os arquivos nunca passam por lá |
| ⌨️ | **O teclado inteiro vai**, incluindo Tecla Windows, Alt+Tab e Ctrl+Shift+Esc |
| 📁 | **Arquivos e pastas, sem limite de tamanho** — arraste, e a árvore chega montada do outro lado |
| 🎮 | **Modo Gamer:** mira 360° em jogos de tiro, que acesso remoto comum não faz |
| 🆓 | **De graça, e aberto.** Sem plano, sem limite de sessão, sem "uso comercial detectado" |

> Se o projeto te for útil, **deixe uma ⭐ no repositório** — é o que faz outras
> pessoas o encontrarem.

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

## No celular também

A pasta [`ryke-mobile/`](ryke-mobile/) é o aplicativo Android — ele **acessa** um
PC, não é acessado. Serve para resolver alguma coisa no computador de casa
estando na rua, com um joystick na tela para conduzir o cursor com o polegar
(o dedo é grosso, o cursor do Windows é fino; tocar direto na imagem seria um
brinquedo inútil).

O APK sai na mesma [Release](../../releases) do instalador do Windows. Ele pede
**uma única permissão: acesso à internet** — e isso é verificado por um teste
automático a cada compilação, junto com a conferência de que ele não pede
câmera, microfone, armazenamento, localização nem contatos.

Não está na Play Store: é assinado com a chave de depuração do Android, que é a
única possível num repositório público (uma chave de release é um segredo).
Instala-se abrindo o próprio arquivo, com "fontes desconhecidas" permitido.

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

## As setas: uma para cada pessoa

Este é o ponto em que o Ryke Desk se afasta do resto dos programas de acesso
remoto, e vale explicar o porquê antes do como.

**O problema.** O Windows tem **um** ponteiro. Todo programa de acesso remoto
faz a mesma coisa: pega o movimento do mouse de quem está de fora e o injeta no
sistema do outro lado. O resultado é que as duas pessoas passam a disputar o
mesmo cursor — quem está sentado na máquina vê a seta fugir da mão, e quem está
de fora vê a sua ser puxada de volta. Com dois visitantes, são três mãos num
mouse só. A saída oferecida em todo lugar é a mesma: desligar o teclado e o
mouse de quem está na máquina.

**O que o Ryke Desk faz.** Separa "onde eu estou apontando" de "onde o cursor do
Windows está". Cada visitante ganha uma **seta virtual própria**, colorida, com
o nome dele em letra pequena logo abaixo. Ela é desenho: anda sozinha, não
encosta no cursor do sistema e não atrapalha ninguém.

| Seta | De quem é |
|---|---|
| **Vermelha** | de quem conectou primeiro |
| **Azul** | do segundo acesso |
| **Verde** | do terceiro |
| Amarela, roxa, laranja, rosa, ciano | do quarto em diante |
| **Branca, sem cor nenhuma** | do dono da máquina — é a seta normal do Windows, sem alteração |

A ausência de cor é o que identifica o anfitrião, e o nome embaixo de cada seta
colorida é o que responde à pergunta que três setas na tela criam: *qual é a
minha?* Os dois lados veem a mesma coisa — quem está na máquina vê as setas dos
visitantes por cima da tela dele; cada visitante vê a do anfitrião e a dos
outros visitantes por cima do vídeo.

**E o clique?** Esse é o único momento em que o cursor real precisa se mexer: o
Windows entrega o clique a quem estiver *embaixo* do ponteiro — não existe
clicar num lugar sem estar nele. Então o Ryke Desk **pega o cursor emprestado**
pelo instante do clique e **o devolve** para onde ele estava. Arrastar é a
exceção que confirma a regra: enquanto o botão está apertado o cursor fica com o
visitante, porque um arrasto que larga o ponteiro no meio do caminho não
arrasta coisa nenhuma. E se, durante o empréstimo, a pessoa da máquina mexer no
mouse dela, a devolução é cancelada — o ponteiro é de quem está com a mão nele.

Na prática: **duas pessoas conseguem trabalhar na mesma tela ao mesmo tempo**,
uma apontando para uma coisa enquanto a outra mexe em outra. Era isso que a
disputa pelo cursor único impedia.

**A sua seta não tem atraso.** Ela não é um elemento desenhado pela página
perseguindo o mouse: é o cursor do seu próprio Windows, trocado por um desenho
colorido. Quem o move é o sistema, na mesma instrução em que o mouse se mexe.
Já a seta que vem desenhada *dentro do vídeo* chega com o atraso da imagem, e
por isso não serve para nada disso — mexer o mouse e ver a seta responder meio
segundo depois torna qualquer trabalho fino insuportável.

**O preço, dito com todas as letras.** Para o Windows do anfitrião, a seta
virtual não existe. Então programas que reagem ao mouse apenas *passando por
cima* — menus que abrem sozinhos, dicas de ferramenta — não a percebem enquanto
você só desliza. Se isso atrapalhar no seu caso, há um interruptor em
**Ajustes → Cada visitante com a própria seta**: desligado, o Ryke Desk volta ao
comportamento clássico, em que o seu mouse arrasta o cursor real do outro lado.

E se você quiser mesmo que a pessoa de lá não mexa em nada enquanto você
trabalha, o botão **Travar lá** da barra continua ali: ele desliga o teclado e o
mouse físicos dela.

> **Detalhe técnico.** A camada onde as setas dos visitantes são desenhadas na
> tela do anfitrião fica *fora da captura de vídeo* (`WDA_EXCLUDEFROMCAPTURE`,
> Windows 10 2004 ou mais novo). É de propósito: cada visitante desenha as setas
> localmente, sem atraso, e mandá-las também dentro do vídeo empilharia duas
> cópias de cada uma andando com um quadro de diferença.

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

**Botão *Janela*.** A sessão nasce ocupando o monitor inteiro, e isso deixava
quem quisesse olhar a tela remota *ao lado* de um documento daqui sem saída.
Clicar em *Janela* devolve a sessão a um retângulo com metade da largura e da
altura do monitor, centralizado — grande o bastante para continuar legível,
pequeno o bastante para sobrar espaço dos dois lados. Daí em diante o tamanho é
seu: arraste qualquer borda ou canto.

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

### Ctrl+Alt+Del

Tem botão próprio na barra, e não fica junto das outras combinações — porque
não é uma combinação como as outras.

O Windows intercepta o Ctrl+Alt+Del antes de qualquer programa em modo
usuário, num caminho reservado ao Winlogon. **Nenhum privilégio contorna
isso**, e isso não é defeito: é o que garante que a tela de bloqueio seja mesmo
do Windows, e não de um impostor pedindo a sua senha. Durante um tempo o Ryke
Desk mandou essa combinação pelo mesmo caminho das outras teclas, e o resultado
foi um botão que não fazia nada e não dizia nada.

A porta oficial é a API `SendSAS`, e ela exige que o computador acessado
libere: **Ajustes → Permitir Ctrl+Alt+Del remoto**. Isso liga a política
`SoftwareSASGeneration` do Windows, que vem desligada — e é decisão de quem é
dono da máquina, não de quem está do outro lado, por isso o programa não a liga
sozinho.

O que muda ao ligar, com todas as letras: um programa elevado passa a poder
**chamar** a tela de segurança do Windows. Ele não passa a poder imitá-la nem a
ler o que se digita nela — quem a desenha continua sendo o Winlogon, na área de
trabalho segura, fora do alcance de qualquer programa. Desligar devolve a
política ao estado anterior. É o mesmo mecanismo que todo programa de acesso
remoto usa para isto.

Enquanto não estiver liberado, o botão **diz o motivo** em vez de falhar
calado.

## Modo Gamer

Acesso remoto comum não serve para jogo de tiro, e o motivo é específico: o
mouse é mandado como **posição**, e num jogo de tiro virar a mira 360° é
empurrar o mouse sem parar. Com posição, o ponteiro bate na borda da tela e a
câmera trava ali.

O botão **Modo Gamer** na barra troca o envio para **deslocamento**: em vez de
"vá para tal ponto", vai "ande tanto para a direita", que é o que um mouse
físico faz. O ponteiro fica preso à janela (*pointer lock*) e some, e as setas
coloridas somem junto — num jogo quem desenha a mira é o jogo, e uma seta
parada por cima dela atrapalha exatamente o ponto da tela em que se está
olhando.

Três coisas fazem o giro ser realmente contínuo:

- **O ponteiro do outro lado volta ao centro a cada quadro**, por um caminho
  que o jogo não enxerga (`SetCursorPos` não gera evento de dispositivo, então
  não aparece no Raw Input). Assim ele nunca alcança a borda do monitor — e era
  a borda que travava a câmera e obrigava a arrastar o mouse várias vezes.
- **A fração do movimento é guardada, não descartada.** O deslocamento é
  enviado em número inteiro; o resto vai para o quadro seguinte. Sem isso, um
  movimento lento de 0,4 pixel por quadro arredondava para zero e a mira não
  saía do lugar por mais que a mão andasse — justamente na mira de precisão,
  onde mais dói.
- **Sensibilidade ajustável** (até 25×), no próprio aviso do modo. O movimento
  atravessa a aceleração de mouse de dois Windows, e o valor certo depende do
  DPI do seu mouse e da sensibilidade do jogo. Fica guardado no aparelho.

Para sair: **Ctrl+G**. Guarde esse atalho — com o ponteiro preso não dá para
clicar no botão, e é por isso que o programa mostra um diálogo ensinando o
atalho antes de ligar o modo.

> **Aviso honesto:** jogos com anticheat costumam recusar entrada injetada por
> software. Isto funciona nos que não bloqueiam. Não há como contornar aquilo
> sem um driver de dispositivo — e tentar seria exatamente o que o anticheat
> existe para impedir.

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

## Arquivos e pastas

Arraste para a janela da sessão, escolha pela gaveta de transferências, ou dê
**Ctrl+C** num arquivo no Explorador e **Ctrl+V** do outro lado. Pastas inteiras
também: vão com as subpastas e chegam montadas.

**Não há limite de tamanho.** Havia um teto de 500 MB, e ele era arbitrário —
nada na arquitetura precisava dele. Os bytes nunca passam inteiros pela
memória: quem envia lê o arquivo em pedaços de 64 KB conforme o canal tem
espaço, e quem recebe grava direto em disco, num fluxo.

O que protege o disco de quem recebe não é um número escolhido no chute, e sim
duas conferências reais:

- **O espaço livre precisa comportar o que foi anunciado**, e isso é conferido
  antes de o primeiro byte ser gravado. Um limite fixo tanto recusava uma
  transferência legítima de 50 GB quanto deixava passar 500 MB num disco com
  100 MB livres.
- **O remetente é cortado no instante em que passa de um byte do que
  prometeu**, e o arquivo parcial é apagado.

E o caminho dentro da pasta vem do outro computador, portanto é tratado como
texto hostil: cada segmento é higienizado e o resultado é conferido para
garantir que continua dentro da pasta de downloads. Um `..\..\` ali escreveria
onde bem entendesse na sua máquina.

### Por que uma transferência enorme derrubava a sessão

Cada bloco recebido redesenhava a interface inteira. Num arquivo de 50 GB isso
são milhões de redesenhos: o laço de eventos parava de fazer qualquer outra
coisa, o pulso da sessão deixava de ser respondido, a vigilância concluía —
corretamente — que a sessão tinha morrido, e no meio disso o processo podia
ficar sem memória e morrer de vez.

Quando isso acontecia, o computador **sumia da malha**, porque toda a rede vive
naquele processo. Era por isso que, depois da queda, ninguém mais respondia
naquele número.

Duas correções: o progresso passou a ser agrupado em quatro atualizações por
segundo (o olho não aproveita mais do que isso numa barra de progresso), e a
interface que morre agora **volta sozinha** — o número reaparece na malha em
segundos, em vez de o programa ficar aberto e inútil.

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

### Contra o uso da ferramenta para o mal

O uso indevido mais comum de todo programa de acesso remoto não é técnico: é o
**golpe do falso suporte**. A vítima recebe uma ligação — banco, Pix, Receita,
loja —, instala o programa, lê o número em voz alta e assiste alguém esvaziar a
conta dela. Nenhuma criptografia impede isso, porque a vítima autoriza. O que
ajuda é atrapalhar o golpe na hora exata, e o Ryke Desk faz três coisas:

- **Aviso específico no pedido de acesso.** Quando alguém pede para entrar sem
  senha, a tela pergunta em letras grandes: *"Alguém ligou para você e pediu
  para instalar isto?"* — e diz que banco, Pix, Receita e suporte de verdade
  nunca pedem acesso ao computador. Um "tenha cuidado" genérico já não é lido
  por ninguém; este é sobre o que está acontecendo naquele minuto.

- **Um aviso que o lado remoto não consegue esconder.** Enquanto a sessão
  estiver de pé, uma tarja vermelha fica no alto da tela do anfitrião dizendo
  quem está controlando. Ela vive numa janela sempre no topo, controlada pelo
  processo local: quem está do outro lado **não pode fechá-la, minimizá-la nem
  cobri-la**. E como ela fica *fora da captura de vídeo*, o golpista sequer sabe
  que ela está lá — não dá para pedir à vítima que a ignore. Isso derruba a
  parte central do golpe, que é minimizar a janela e trabalhar por baixo.

- **O rótulo da seta não pode ser falsificado.** O nome sob cada seta colorida
  vem só de duas fontes, e as duas são da própria máquina: o apelido que o dono
  dela salvou nos favoritos, ou o número por onde a conexão chegou. O nome que a
  outra máquina se dá **é ignorado de propósito** — sem isso, bastaria alguém se
  chamar "Suporte Microsoft" para que a interface do Ryke Desk carimbasse a
  mentira do golpista na tela da vítima.

E o que o programa deliberadamente **não** tem: modo furtivo, instalação
silenciosa e conexão sem que apareça nada na tela de quem é acessado. O acesso
não supervisionado exige uma senha que alguém definiu naquela máquina, de
propósito — não existe caminho para entrar num computador sem que o dono tenha
feito algo, uma vez, conscientemente.

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
| `src/shared/ponteiros.ts` | As setas coloridas: paleta, desenho e o porquê de tudo |
| `src/main/auth.ts` | Senha, desafio-resposta e freio de força bruta |
| `ryke-mobile/src/lib/joystick.ts` | O joystick do celular: zona morta, aceleração, limites |

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

## Quer ajudar?

O projeto é aberto e as contribuições são bem-vindas — inclusive as pequenas.

- **Achou um defeito?** [Abra uma issue](../../issues/new) contando o que você
  fez, o que esperava e o que aconteceu. A versão do Windows e a do Ryke Desk
  (canto dos Ajustes) resolvem metade das dúvidas antes da primeira resposta.
- **Tem uma ideia?** Abra uma issue antes do código. É mais rápido concordar
  sobre o problema do que discordar sobre uma solução já escrita.
- **Vai mandar código?** Faça um fork, trabalhe num branch e abra um Pull
  Request. Duas coisas são pedidas: que `npm run typecheck` e `npm run test:unit`
  passem, e que o comentário explique **por quê**, não o quê — é o padrão do
  código existente, e é o que faz alguém entender a decisão seis meses depois.
- **Não programa?** Também ajuda: traduzir, testar em redes diferentes,
  escrever um passo a passo, ou simplesmente **deixar uma ⭐**.

### Como rodar a partir do código

```bash
git clone https://github.com/rykeguideiv/Ryke-Desk.git
cd Ryke-Desk
npm install
npm run dev       # abre o app em modo de desenvolvimento
npm run typecheck # TypeScript, processo principal e interface
npm run test:unit # a bateria de testes (não precisa de rede)
npm run dist      # gera o instalador em release/
```

Precisa de Node.js 20+ e Windows 10/11. Não exige Visual Studio nem node-gyp: a
injeção de teclado e mouse usa [koffi](https://koffi.dev/), que carrega a
`user32.dll` por FFI com binários prontos.

## Uso comercial

A licença é a GPLv3, e ela é honesta sobre o que permite: tecnicamente,
**vender** uma cópia não é proibido — o que a GPL exige é que o código continue
aberto e que quem recebe a cópia ganhe os mesmos direitos, inclusive o de
redistribuir de graça.

Dito isso, aqui vai o pedido explícito do autor, sem enrolação:

> **O Ryke Desk foi feito para ser usado de graça.** Use na sua casa, na sua
> empresa, no seu suporte técnico, o quanto quiser — é para isso que ele existe
> e não há nada a pagar. O que eu peço é que ninguém pegue este trabalho,
> embrulhe e **venda como se fosse um produto seu**. Melhorar, adaptar,
> distribuir, ensinar: tudo isso é bem-vindo, e é o motivo de o código estar
> aberto.

Se você quer usar o Ryke Desk dentro de algo comercial e ficou em dúvida se
aquilo respeita o pedido acima, [abra uma issue](../../issues/new) e pergunte. É
melhor conversar do que adivinhar.

## Ryke Desk in English

Ryke Desk is a **serverless remote desktop for Windows**. Two machines find each
other through public MQTT/Nostr rendezvous points (no account, no VPS, nothing to
host), then connect **directly, peer to peer**, over encrypted WebRTC — screen,
keyboard, mouse, clipboard and file transfer.

Its distinctive feature: **each visitor gets their own colored, named cursor**
(red for the first, blue for the second, green for the third), drawn as a virtual
pointer. The host's real Windows cursor is never dragged around by remote
movement — it is only briefly *borrowed* at the instant of a click and put back.
This lets two people actually work on the same screen at the same time, which the
usual "one OS cursor, injected input" approach makes impossible.

The interface is in Brazilian Portuguese. Contributions, including translations,
are welcome — see **Quer ajudar?** above. Licensed under **GPL-3.0-or-later**;
the author asks that you not resell it as your own product (see **Uso comercial**).

## Licença

O Ryke Desk é software livre sob a **GNU General Public License v3.0 ou
posterior** (ver [`LICENSE`](LICENSE)). Qualquer um pode usar, estudar,
modificar e redistribuir — e todo trabalho derivado precisa continuar aberto
sob a mesma licença. Sobre vender, leia **[Uso comercial](#uso-comercial)**
acima: a licença permite, e o autor pede que não.

A assinatura de código dos instaladores segue a
[política de assinatura](docs/POLITICA-DE-ASSINATURA.md), feita pelo
[SignPath Foundation](https://signpath.org/), que oferece assinatura gratuita a
projetos de código aberto. A chave de assinatura nunca sai do HSM deles: a
equipe do Ryke Desk não a possui nem a manipula.
