{ ==========================================================================
  Fechar o programa e remover a versao anterior, sem perguntar nada.

  Duas coisas que davam errado ao atualizar:

    1. Com o Ryke Desk aberto, os arquivos em uso nao eram substituidos. A
       instalacao terminava dizendo "concluida" e o programa continuava sendo
       o antigo - o pior tipo de falha, porque parece sucesso.

    2. Instalar por cima deixava restos da versao anterior na pasta. Arquivo
       que sumiu de uma versao para a outra continuava la, e um dia alguem
       ia se perguntar por que existe.

  A ordem importa: primeiro fecha o programa, so depois desinstala. Ao
  contrario, o desinstalador esbarraria nos mesmos arquivos em uso.

  O QUE NAO SE PERDE: a configuracao (numero de 12 digitos, senha, favoritos)
  mora em %APPDATA% e nao e tocada pela desinstalacao. Atualizar mantem o
  mesmo numero - ninguem precisa avisar os contatos de nada.
  ========================================================================== }

const
  CHAVE_DESINSTALACAO =
    'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#AppIdCru}_is1';
  { 60 x 500ms = 30s. Desinstalar esta versao leva segundos; o teto existe
    para nunca deixar o instalador pendurado numa espera infinita. }
  ESPERA_MAXIMA = 60;

{ Fecha o Ryke Desk que estiver rodando.

  Primeiro o pedido educado (taskkill sem /F manda fechar a janela, e o
  programa ainda solta o teclado bloqueado e avisa o outro lado que a sessao
  acabou). Depois o empurrao, para quem nao respondeu. }
procedure FecharPrograma();
var
  codigo: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/C taskkill /IM "{#AppExeName}" /T',
       '', SW_HIDE, ewWaitUntilTerminated, codigo);
  Sleep(1500);
  Exec(ExpandConstant('{cmd}'), '/C taskkill /F /IM "{#AppExeName}" /T',
       '', SW_HIDE, ewWaitUntilTerminated, codigo);
  Sleep(500);
end;

function DesinstaladorAnterior(var caminho: String): Boolean;
begin
  Result := RegQueryStringValue(HKLM, CHAVE_DESINSTALACAO, 'UninstallString', caminho);
  if not Result then
    Result := RegQueryStringValue(HKLM32, CHAVE_DESINSTALACAO, 'UninstallString', caminho);
  { Instalacao antiga feita so para o usuario atual. }
  if not Result then
    Result := RegQueryStringValue(HKCU, CHAVE_DESINSTALACAO, 'UninstallString', caminho);
  if Result then
    caminho := RemoveQuotes(caminho);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  desinstalador: String;
  codigo, esperas: Integer;
begin
  Result := '';
  FecharPrograma();

  if not DesinstaladorAnterior(desinstalador) then
    exit;
  if not FileExists(desinstalador) then
    exit;

  WizardForm.StatusLabel.Caption := 'Removendo a versao anterior...';
  if not Exec(desinstalador, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART',
              '', SW_HIDE, ewWaitUntilTerminated, codigo) then
  begin
    Result := 'Nao foi possivel remover a versao anterior do Ryke Desk.' #13#10 #13#10
            + 'Desinstale pelo Painel de Controle e rode este instalador de novo.';
    exit;
  end;

  { O desinstalador do Inno se copia para a pasta temporaria e devolve o
    controle na hora - esperar o processo nao adianta, ele ja terminou. O que
    diz que a remocao acabou de verdade e o proprio arquivo desaparecer. }
  esperas := 0;
  while FileExists(desinstalador) and (esperas < ESPERA_MAXIMA) do
  begin
    Sleep(500);
    esperas := esperas + 1;
  end;

  { Passou do teto: a remocao emperrou. Instalar por cima ainda funciona, e e
    melhor do que abandonar quem so queria atualizar - entao seguimos. }
end;

{ O mesmo cuidado ao desinstalar: com o programa aberto, a remocao deixaria
  arquivos para tras e pediria reinicio sem necessidade. }
function InitializeUninstall(): Boolean;
begin
  FecharPrograma();
  Result := True;
end;

{ A configuracao (numero Ryke, senha, favoritos, senhas guardadas) fica em
  %APPDATA% de cada usuario e NAO e apagada na desinstalacao, de proposito:

    - a instalacao e por maquina, entao o desinstalador so enxergaria o
      %APPDATA% de quem esta desinstalando - apagar ali daria a falsa
      impressao de limpeza geral, deixando os outros perfis intactos;

    - atualizar mantendo o mesmo numero de 12 digitos e o comportamento
      desejado: ninguem quer avisar os contatos de um numero novo por causa
      de uma atualizacao. E por isso que a remocao automatica da versao
      anterior, logo acima, nao custa nada a quem atualiza.

  Para remover de vez:  %APPDATA%\ryke-desk }
