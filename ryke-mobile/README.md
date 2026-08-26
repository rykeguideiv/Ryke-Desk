# Ryke Desk Mobile

Acessa um computador com Ryke Desk a partir de um celular Android.
**Sem servidor, sem cadastro** — a mesma malha de encontro do desktop.

```
release/RykeDesk-Mobile.apk    (4,1 MB)
```

---

## Só acessa, nunca é acessado

O aplicativo é **exclusivamente visitante**. Ele entra em computadores; nenhum
computador entra nele. Isso não é uma limitação a ser removida depois, é o
escopo — e é o que faz o aplicativo ser pequeno e seguro.

A prova disso não está num texto de marketing, está no que o Android mostra na
instalação: **a única permissão que o aplicativo pede é acesso à internet.**

| Permissão | Situação |
|---|---|
| Internet | única pedida |
| Câmera, microfone | não pedidas |
| Arquivos, contatos, localização | não pedidas |
| Captura de tela, sobreposição | não pedidas |

Sem essas permissões, o aplicativo é tecnicamente incapaz de ver ou controlar
o celular — independente do que qualquer computador do outro lado tente fazer.

## Usando

1. Instale o APK (o Android vai pedir para permitir "fontes desconhecidas").
2. Peça o número de 12 dígitos de quem tem o Ryke Desk no computador.
3. Digite o número. **Sem senha**, o computador toca e alguém precisa clicar em
   *Permitir*. **Com senha**, entra direto.

**Favoritos e recentes.** Depois de uma sessão, o número fica em *Conexões
recentes*. A estrela ao lado dele pede um nome e o transforma em favorito —
que é o caminho natural, porque ninguém batiza um computador antes de saber se
a conexão funciona. Dá para salvar direto pelo botão *Salvar nos favoritos com
um nome*, com o número completo no campo.

**Senha guardada, se você quiser.** Ao digitar a senha aparece a caixinha
*Guardar a senha deste computador*. Ela é gravada só depois de o acesso dar
certo, e vai **cifrada com AES-GCM** — nunca em texto puro, para que uma cópia
de segurança do aparelho não entregue a senha de bandeja. A chave que cifra sai
da identidade desta instalação, então os bytes não abrem em outro telefone.

E o limite disso, dito na própria caixinha: quem destravar este celular entra
sem saber a senha, e um aparelho com root tem acesso aos dois lados — à senha
cifrada e à chave. A cifragem detém leitura casual, não um invasor com o
aparelho na mão. Desmarcar a caixinha apaga na hora.

### Gestos

Dedo grosso e cursor fino não combinam: uma tela de 1920×1080 espremida em seis
polegadas dá cerca de três pixels remotos por pixel do celular. Por isso o gesto
não finge ser um mouse — ele é traduzido:

| Gesto | No computador |
|---|---|
| Toque curto | clique esquerdo onde o dedo encostou |
| Toque longo | clique direito (menu de contexto) |
| Arrastar um dedo | segura o botão e arrasta |
| Dois dedos | rolagem, como a roda do mouse |
| Pinça | amplia a **visualização** (o computador não sabe) |

A pinça é o que salva a precisão: ampliando três vezes, cada pixel remoto ganha
tamanho de dedo e o clique passa a acertar.

### Controle de mouse

O toque direto é rápido para alvo grande e ruim para trabalho fino: o dedo tapa
exatamente o que se quer ver, e não existe "chegar perto e ajustar". O botão
**Ativar controle de mouse**, na barra de cima, resolve isso.

Aparece um joystick no canto de baixo à esquerda e cinco botões à direita — a
divisão de qualquer controle de videogame, e a única que deixa mover e clicar
ao mesmo tempo, que é o que permite **arrastar**.

| Onde | O que faz |
|---|---|
| Joystick (esquerda) | conduz o cursor; inclinar mais anda mais rápido |
| **Esquerdo** | clique; **segurando**, mantém o botão preso para arrastar |
| **Direito** | menu de contexto |
| **◀ Voltar** | volta a página (Alt+←) |
| **Copiar** / **Colar** | Ctrl+C e Ctrl+V |

Com o controle ligado, o dedo na imagem só navega: arrastar desloca a
visualização ampliada, e nada é enviado ao computador. Um círculo azul mostra
onde o cursor está — ele é desenhado no celular, e por isso responde na hora,
sem esperar a imagem chegar de volta.

A velocidade não é proporcional à inclinação: ela cresce numa curva, de modo que
o começo do movimento é lento o bastante para caçar um pixel e a ponta é rápida
o bastante para atravessar a tela em cerca de um segundo. Há uma zona morta no
centro, porque polegar apoiado nunca fica parado de verdade.

O botão **Teclado** abre o teclado do sistema mais uma fileira com o que não
existe num celular: Esc, Tab, setas, Ctrl+C, Ctrl+V, Alt+Tab, Win e
Ctrl+Alt+Del. Ele e o controle de mouse não aparecem juntos — disputariam o
mesmo polegar e o mesmo espaço.

## Compilando

Precisa do Android Studio instalado (o JDK vem dentro dele) e do SDK do Android.

```bash
npm install
npm run apk        # compila e deixa em release/RykeDesk-Mobile.apk
npm test           # unidade + ponta a ponta + conferência do APK
```

## Como isto conversa com o desktop

Os módulos de `src/shared/` são **cópias byte a byte** do projeto do PC. A pasta
é autossuficiente de propósito — dá para levá-la sozinha e compilar —, e o preço
dessa escolha é o risco de as duas cópias divergirem em silêncio. O sintoma
seria cruel: nada quebra na compilação, nenhum teste de unidade falha, e o
usuário simplesmente não conecta.

Por isso `test/compat.test.mjs` compara os arquivos e falha alto se alguém
esquecer de sincronizar. Ao mexer no protocolo do PC, copie os arquivos:

```bash
cp ../ryke-desk/src/shared/{mqtt,nostr,encontro,malha,protocol,keymap,adaptacao}.ts src/shared/
```

### A senha, e por que scrypt em JavaScript

O computador guarda `scrypt(senha, sal)` e confere um HMAC sobre um nonce. O
celular precisa chegar aos **mesmos bytes** — e o WebCrypto do navegador, que
tem PBKDF2, AES e HMAC, **não tem scrypt**: a função nunca foi padronizada para
a web.

Trocar por PBKDF2 no celular não era opção; faria a senha simplesmente nunca
conferir. Daí a `@noble/hashes`, e daí `test/auth-mobile.test.mjs`, que compara
o resultado das duas implementações — a do Node e a nossa — inclusive com
acentuação escrita de forma composta e decomposta, que é onde as normalizações
divergem.

## O que foi validado, e o que não foi

**Validado contra um PC real**, pelos pontos de encontro públicos da internet
(`npm run test:e2e`): entrar na malha, provar a senha, negociar o WebRTC,
receber a tela em 1920×1080, e o toque mover o **cursor real do Windows** —
conferido pela API do sistema, com erro de 0 pixel.

Esse teste roda os arquivos de `dist/` num Chromium de mesa, que é o mesmo
motor da WebView do Android. E `test/apk.test.mjs` confere byte a byte que o
APK contém exatamente esses arquivos.

**Não validado:** a instalação num aparelho de verdade. O emulador do Android
exige virtualização por hardware, que está desligada na BIOS desta máquina.
Para fechar essa última lacuna, ligue um telefone por USB com depuração ativa:

```bash
adb install release/RykeDesk-Mobile.apk
```

## Assinatura

O APK é de depuração, assinado com a chave de desenvolvimento do Android. Serve
para instalar e usar, mas não para publicar na Play Store — para isso é preciso
gerar uma chave própria e um build de release.
