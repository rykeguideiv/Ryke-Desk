; Migra as duas familias de instaladores usadas pelo Ryke Desk.
;
; Ate a 1.0.4 o aplicativo era instalado pelo Inno Setup para todos os
; usuarios. As versoes 1.0.5 e 1.0.6 passaram a usar NSIS apenas para o
; usuario atual. Sem esta migracao, o Windows considera as duas instalacoes
; programas diferentes e deixa a versao antiga instalada e/ou aberta.

!define RYKE_INNO_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\{B7E4B3A2-9C1D-4E6F-8A5B-2D3C4E5F6A7B}_is1"
!define RYKE_NSIS_USER_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\c475af87-7409-5f50-a0b8-25adac0144b6"

; ─────────────────────────────────────────────────────────────────────
; POR QUE NADA AQUI FECHA O APLICATIVO
;
; Este macro roda em `.onInit`, ou seja, no instante em que a pessoa da dois
; cliques no instalador — antes de ver qualquer tela, antes de escolher a
; pasta, antes de confirmar. Era aqui que estavam o `taskkill` e a remocao
; das versoes antigas.
;
; O efeito disso numa atualizacao feita REMOTAMENTE era o pior possivel: o
; instalador abria e a conexao caia na mesma hora, porque o Ryke Desk que
; sustentava a sessao acabava de ser morto. Quem estava do outro lado perdia
; a tela antes mesmo de conseguir clicar em "Instalar", e ficava sem como
; continuar — o computador remoto ficou sozinho com um instalador aberto.
;
; Fechar o aplicativo continua sendo necessario (nao da para substituir um
; .exe em uso), mas o momento certo e depois da confirmacao, ja dentro da
; secao de instalacao. Isso e exatamente o que `customCheckAppRunning` faz:
; o electron-builder o insere no lugar da sua propria verificacao de
; aplicativo em execucao, que acontece no comeco da copia dos arquivos.
;
; Resultado: abrir o instalador nao derruba mais nada. A sessao so cai no
; segundo em que a troca de arquivos realmente comeca — e ai o proprio
; instalador reabre o Ryke Desk no fim (ver `customInstall`).
; ─────────────────────────────────────────────────────────────────────
!macro customInit
!macroend

; Chamado pelo electron-builder no inicio da secao de instalacao, ja com o
; usuario tendo confirmado. Aqui sim: solta os arquivos em uso e limpa as
; instalacoes antigas.
!macro customCheckAppRunning
  DetailPrint "Encerrando o Ryke Desk para substituir os arquivos..."
  ; APAGAR AS TAREFAS PRIMEIRO — senao o app ressuscita e trava o exe.
  ; Uma versao antiga (1.0.33) rodava como administrador e era reaberta pela
  ; tarefa de logon /RL HIGHEST; enquanto ela existir, o taskkill abaixo mata o
  ; processo mas a tarefa o traz de volta, deixando o arquivo em uso e a
  ; atualizacao "conclui" sem trocar nada. Removendo as tarefas antes, o
  ; encerramento e definitivo e a copia dos arquivos novos sempre pega. O
  ; customInstall recria as tarefas (agora sem elevacao) no fim.
  nsExec::ExecToLog 'schtasks /Delete /TN "Ryke Desk" /F'
  nsExec::ExecToLog 'schtasks /Delete /TN "RykeDesk-Admin" /F'
  nsExec::ExecToLog 'schtasks /Delete /TN "RykeDesk-Entrada" /F'
  ; Primeiro o pedido educado, para o aplicativo salvar o que precisa e
  ; soltar o gancho de teclado; depois a forca, so se ainda estiver vivo.
  nsExec::ExecToLog 'taskkill /IM "Ryke Desk.exe" /T'
  Sleep 1200
  nsExec::ExecToLog 'taskkill /F /IM "Ryke Desk.exe" /T'
  Sleep 800

  ; Remove a instalacao NSIS por usuario criada pelas versoes 1.0.5/1.0.6.
  ; A configuracao e o numero Ryke ficam em AppData\Roaming e sao preservados.
  ReadRegStr $R0 HKCU "${RYKE_NSIS_USER_UNINSTALL_KEY}" "UninstallString"
  ${If} $R0 != ""
    DetailPrint "Removendo a instalacao anterior do Ryke Desk..."
    ExecWait '$R0 /S' $R1
    Sleep 1500
  ${EndIf}

  ; Remove a instalacao Inno Setup (1.0.4 e anteriores). Procuramos nas duas
  ; visoes do registro porque o Windows pode registra-la como 32 ou 64 bits.
  ReadRegStr $R0 HKLM64 "${RYKE_INNO_UNINSTALL_KEY}" "UninstallString"
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM32 "${RYKE_INNO_UNINSTALL_KEY}" "UninstallString"
  ${EndIf}
  ${If} $R0 == ""
    ReadRegStr $R0 HKCU "${RYKE_INNO_UNINSTALL_KEY}" "UninstallString"
  ${EndIf}
  ${If} $R0 != ""
    DetailPrint "Removendo a instalacao antiga do Ryke Desk..."
    ExecWait '$R0 /VERYSILENT /SUPPRESSMSGBOXES /NORESTART' $R1
    ; O desinstalador Inno termina o primeiro processo antes da copia
    ; temporaria concluir. Esta espera evita instalar enquanto ela apaga.
    Sleep 4000
  ${EndIf}
!macroend

; Reabre o Ryke Desk assim que a copia termina.
;
; `Exec` e nao `ExecShellAsUser`, e isto e o ponto central de uma atualizacao
; remota dar certo. O aplicativo declara `requireAdministrator` no manifesto,
; entao toda abertura comum passa pelo UAC — que desenha a janela na area de
; trabalho SEGURA, invisivel para quem esta do outro lado de um acesso
; remoto. Numa maquina sem ninguem por perto, esse prompt e um beco sem
; saida: o aplicativo nunca sobe e nao ha como reconectar.
;
; Um processo iniciado por `Exec` herda o token do instalador, que ja esta
; elevado. Ou seja: sobe como administrador, do jeito que o aplicativo exige,
; e sem prompt nenhum. E o unico caminho em que a maquina remota volta
; sozinha ao ar depois de se atualizar.
;
; `runAfterFinish` fica desligado no package.json de proposito, para a tela
; final nao oferecer a caixa "Executar o Ryke Desk" — ele ja esta rodando.
!macro customInstall
  ; ───────────────────────────────────────────────────────────────────
  ; ABRIR JUNTO COM O WINDOWS — E **SEM** ELEVAÇÃO (é o que conserta a lentidão)
  ;
  ; DESCOBERTA que mudou a arquitetura: o Chromium, quando o processo roda como
  ; ADMINISTRADOR, não consegue INICIAR a captura de tela (getDisplayMedia devolve
  ; "NotReadableError: Could not start video source"), e o app caía numa rota
  ; reserva a ~1 quadro por segundo. Nenhum switch de GPU/sandbox nem o método WGC
  ; resolveu — captura e admin são incompatíveis no Electron. Rodar SEM elevação
  ; faz a captura voltar a 60 fps por hardware. Por isso o app agora é `asInvoker`.
  ;
  ; Então a tarefa de logon NÃO usa mais `/RL HIGHEST`: ela sobe o app no nível
  ; normal do usuário (é aí que a captura funciona). O `--minimizado` mantém a
  ; janela escondida no ícone perto do relógio, como pedido.
  DetailPrint "Configurando o Ryke Desk para abrir junto com o Windows..."
  nsExec::ExecToLog 'schtasks /Create /TN "Ryke Desk" /TR "\"$INSTDIR\${APP_EXECUTABLE_FILENAME}\" --minimizado" /SC ONLOGON /F'

  ; ───────────────────────────────────────────────────────────────────
  ; TAREFA DO "MODO ADMINISTRADOR" — elevação sob demanda, SEM UAC.
  ;
  ; O app roda sem elevação (é o que faz a captura funcionar). Mas o botão
  ; "Modo administrador" precisa poder subir o app ELEVADO quando o usuário for
  ; instalar algo no PC remoto — e sem a janela de UAC, que numa sessão remota
  ; apareceria na área de trabalho segura, invisível para quem controla.
  ; Esta tarefa RL HIGHEST, criada aqui pelo instalador (que é elevado), é o que
  ; o botão dispara: o próprio dono pode rodar a própria tarefa de nível mais
  ; alto sem novo prompt. Gatilho ONCE no passado — só roda quando chamada.
  nsExec::ExecToLog 'schtasks /Create /TN "RykeDesk-Admin" /TR "\"$INSTDIR\${APP_EXECUTABLE_FILENAME}\" --minimizado" /SC ONCE /ST 00:00 /RL HIGHEST /F'

  ; ───────────────────────────────────────────────────────────────────
  ; O AJUDANTE DE ENTRADA — o que torna o modo administrador indolor.
  ;
  ; Reabrir o programa inteiro elevado custava caro demais: elevado, o Chromium
  ; não consegue iniciar a captura de tela e a imagem cai de 60 quadros para 1;
  ; além disso a sessão caía no reinício e era preciso autorizar tudo de novo.
  ;
  ; Só a INJEÇÃO de mouse e teclado precisa de privilégio — a captura não. Esta
  ; tarefa sobe um ajudante elevado que não desenha nem captura nada, apenas
  ; injeta. Com ele, o aplicativo NUNCA eleva: a imagem continua rápida, a
  ; conexão não cai e ninguém precisa autorizar outra vez.
  ;
  ; RL HIGHEST pelo mesmo motivo da tarefa acima: numa sessão remota o UAC
  ; apareceria na área protegida, invisível para quem está controlando.
  nsExec::ExecToLog 'schtasks /Create /TN "RykeDesk-Entrada" /TR "\"$INSTDIR\${APP_EXECUTABLE_FILENAME}\" --ajudante-entrada" /SC ONCE /ST 00:00 /RL HIGHEST /F'

  ; ───────────────────────────────────────────────────────────────────
  ; LIBERAR NO FIREWALL — o que abre o caminho DIRETO entre os dois PCs.
  ;
  ; Num Windows recém-instalado o firewall bloqueia toda conexão de ENTRADA
  ; por padrão. Numa ferramenta de acesso remoto isso é fatal para o
  ; desempenho: sem poder receber a conexão direta, o WebRTC é empurrado para
  ; um caminho indireto (retransmitido por um servidor no meio), que adiciona
  ; atraso CONSTANTE — o mesmo atraso que não melhora ao baixar a qualidade, e
  ; a causa nº 1 de "está lento igual ao AnyDesk não estava". Liberar o
  ; programa (todas as portas, que no WebRTC são dinâmicas) deixa o par direto
  ; fechar. Apagamos antes para não empilhar regras a cada reinstalação.
  DetailPrint "Liberando o Ryke Desk no firewall do Windows..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Ryke Desk"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Ryke Desk" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=any'

  ; Abre o aplicativo assim que a cópia termina, ANTES da tela de "Concluir" —
  ; e SEM elevação, senão a captura de tela volta a falhar (ver acima).
  ;
  ; O instalador roda elevado, então um `Exec` direto herdaria o token de
  ; administrador e o app subiria elevado — justo o que não queremos. Lançar
  ; PELO `explorer.exe` resolve: o Explorador roda no nível normal do usuário, e
  ; todo processo que ele inicia nasce no mesmo nível. É o jeito padrão de
  ; "des-elevar" um lançamento a partir de um instalador elevado, e continua
  ; silencioso numa atualização remota (o Explorador já está de pé na sessão).
  ${IfNot} ${Silent}
    DetailPrint "Abrindo o Ryke Desk..."
    Exec '"$WINDIR\explorer.exe" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  ${EndIf}
!macroend

; Remove as tarefas agendadas ao desinstalar — a de inicialização e a que
; dispara o Ctrl+Alt+Del como SISTEMA. Sem deixar rastro.
!macro customUnInstall
  nsExec::ExecToLog 'schtasks /Delete /TN "Ryke Desk" /F'
  nsExec::ExecToLog 'schtasks /Delete /TN "RykeDesk-Admin" /F'
  nsExec::ExecToLog 'schtasks /Delete /TN "RykeDesk-Entrada" /F'
  nsExec::ExecToLog 'schtasks /Delete /TN "RykeDesk-SAS" /F'
  ; Tira a regra de firewall que abrimos na instalação — sem deixar rastro.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Ryke Desk"'
!macroend
