; ============================================================================
;  Instalador de mentira, para provar a atualizacao de verdade.
;
;  Compila duas vezes com o MESMO AppId e conteudos diferentes, imitando uma
;  versao nova chegando por cima de uma antiga. Usa exatamente o mesmo codigo
;  Pascal do instalador do Ryke Desk (installer\atualizar.pas), que e a parte
;  sob teste: fechar o programa aberto e remover a versao anterior.
;
;  Duas diferencas em relacao ao de verdade, e as duas existem para o teste
;  poder rodar sozinho:
;
;    - PrivilegesRequired=lowest, para nao pedir elevacao (o registro vai
;      parar em HKCU, um dos lugares onde o codigo procura);
;    - instala em {localappdata}, nunca em Arquivos de Programas.
;
;  Compilar:
;    ISCC /DORIGEM=<pasta> /DSAIDA=<pasta> /DNOME=<arquivo> /DVERSAO=1.0.0 versao.iss
; ============================================================================

#define AppIdCru "{9F1C2D3E-4B5A-6C7D-8E9F-0A1B2C3D4E5F}"
#define AppExeName "AppTeste.exe"

[Setup]
AppId={{9F1C2D3E-4B5A-6C7D-8E9F-0A1B2C3D4E5F}
AppName=Ryke Teste de Atualizacao
AppVersion={#VERSAO}
DefaultDirName={localappdata}\RykeTesteInstalador
PrivilegesRequired=lowest
OutputDir={#SAIDA}
OutputBaseFilename={#NOME}
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=yes
DisableWelcomePage=yes
Compression=none
CloseApplications=force
RestartApplications=no
Uninstallable=yes

[Files]
Source: "{#ORIGEM}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Code]
#include "..\..\installer\atualizar.pas"
