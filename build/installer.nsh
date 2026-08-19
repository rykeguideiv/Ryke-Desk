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
  ; Primeiro o pedido educado, para o aplicativo salvar o que precisa e
  ; soltar o gancho de teclado; depois a forca, so se ainda estiver vivo.
  nsExec::ExecToLog 'taskkill /IM "Ryke Desk.exe" /T'
  Sleep 1200
  nsExec::ExecToLog 'taskkill /F /IM "Ryke Desk.exe" /T'
  Sleep 400

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
  ${IfNot} ${Silent}
    DetailPrint "Reabrindo o Ryke Desk como administrador..."
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  ${EndIf}
!macroend
