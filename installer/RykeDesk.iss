; ============================================================================
;  Ryke Desk - instalador (Inno Setup 6)
;
;  Empacota a pasta desempacotada gerada pelo electron-builder
;  (release\win-unpacked) num unico setup.exe.
;
;  Gerar:  npm run dist        (compila, empacota e chama este script)
;  ou:     iscc installer\RykeDesk.iss
;
;  Decisoes que importam para NAO ser barrado pelo antivirus:
;   - sem compressao/empacotamento suspeito (lzma2 normal, tudo legivel)
;   - metadados de fabricante e versao preenchidos (VersionInfo*)
;   - o mesmo AppId em toda versao, para atualizar em vez de duplicar
;   - assinatura digital fica a cargo de quem publica (ver SignTool no README)
; ============================================================================

#define AppName "Ryke Desk"
#define AppVersion "1.0.4"
#define AppPublisher "Ryke"
#define AppExeName "Ryke Desk.exe"
#define AppId "{{B7E4B3A2-9C1D-4E6F-8A5B-2D3C4E5F6A7B}"
; O mesmo identificador, sem a chave dobrada que o [Setup] exige. O codigo
; Pascal precisa dele cru para achar o desinstalador da versao anterior.
#define AppIdCru "{B7E4B3A2-9C1D-4E6F-8A5B-2D3C4E5F6A7B}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=no
OutputDir=..\release\RykeDesk-Setup-{#AppVersion}
OutputBaseFilename=Instalar-RykeDesk-{#AppVersion}
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
; O Panda bloqueou a copia temporaria criada pelo carregador do instalador.
; Sem SetupLdr, o Setup roda diretamente da pasta e nao cria nenhum .tmp
; executavel. Os arquivos .bin gerados precisam ficar ao lado do Setup.exe.
UseSetupLdr=no
Compression=none
SolidCompression=no
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Precisa de admin: o programa injeta teclado/mouse e libera portas no
; firewall, e o executavel instalado ja pede elevacao por conta propria.
PrivilegesRequired=admin

; Instalar por cima de um programa aberto e o caminho mais curto para uma
; instalacao pela metade: arquivos em uso nao sao substituidos, e o usuario so
; descobre depois, quando alguma coisa nao funciona.
;
; "force" fecha sozinho quem estiver segurando os arquivos, sem perguntar. E o
; que o usuario espera - ele mandou instalar, nao quer uma pergunta sobre
; gerenciamento de processos. O codigo abaixo ainda fecha o programa antes
; disso, de forma educada; isto aqui e a rede de seguranca.
CloseApplications=force
RestartApplications=no

; Metadados no proprio setup.exe - um instalador "anonimo" e o que mais
; assusta o SmartScreen.
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} - instalador
VersionInfoProductName={#AppName}
VersionInfoCopyright=Copyright (C) 2026 {#AppPublisher}

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar um atalho na area de trabalho"; GroupDescription: "Atalhos:"
Name: "firewall"; Description: "Liberar o Ryke Desk no Firewall do Windows (recomendado)"; GroupDescription: "Rede:"

[Files]
; Toda a pasta desempacotada do app. flatten NAO - preservamos a estrutura.
Source: "..\release\win-unpacked\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\Desinstalar {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
; Libera o PROGRAMA no firewall, e nao portas fixas.
;
; As regras antigas abriam 8787/TCP e 8788/UDP, do tempo em que havia um
; servidor embutido. Nao existe mais servidor: o encontro acontece em pontos
; publicos (trafego de saida, que o firewall ja permite) e a sessao e WebRTC,
; que negocia portas altas aleatorias. Regra por porta fixa nao serviria.
;
; O que ajuda de verdade e liberar o executavel a RECEBER conexao: aumenta a
; chance de o caminho direto fechar sem depender de retransmissor.
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""Ryke Desk"" dir=in action=allow program=""{app}\{#AppExeName}"" enable=yes profile=any"; Flags: runhidden; Tasks: firewall

; Abre automaticamente ao concluir, sem depender da caixa da tela final.
;
; O flag shellexec NAO e enfeite. Sem ele o Inno usa CreateProcess, que falha
; com erro 740 (ERROR_ELEVATION_REQUIRED) ao lancar um executavel marcado como
; requireAdministrator - CreateProcess nao sabe elevar, so ShellExecute sabe.
; Era exatamente esse o erro que aparecia logo depois de instalar.
Filename: "{app}\{#AppExeName}"; Flags: nowait shellexec runasoriginaluser

[UninstallRun]
; Remove as regras de firewall ao desinstalar - nao deixamos rastro.
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Ryke Desk"""; Flags: runhidden; RunOnceId: "DelFwRyke"
; Nomes usados ate a versao anterior, para quem instalar por cima.
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Ryke Desk (sinalizacao)"""; Flags: runhidden; RunOnceId: "DelFwSinal"
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Ryke Desk (descoberta)"""; Flags: runhidden; RunOnceId: "DelFwDesc"

[Code]
// O miolo vive num arquivo a parte porque tambem e compilado por um instalador
// de mentira, em test\instalador\, que exercita a remocao da versao anterior
// de ponta a ponta - com um programa aberto - sem mexer na instalacao real.
//
// Daqui para baixo ja e Pascal: comentario e // ou chaves, nunca ponto-e-virgula.
#include "atualizar.pas"
