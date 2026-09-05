@echo off
rem  Duplo clique aqui para MEDIR a captura nativa nesta maquina.
rem
rem  O resultado e GRAVADO em resultado.txt e aberto no Bloco de Notas — antes
rem  ele so aparecia na janela preta, de onde copiar texto exige clicar com o
rem  botao direito e marcar a selecao. Quem quer mandar o resultado nao deveria
rem  precisar saber disso.
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "SAIDA=%~dp0resultado.txt"

echo.
echo  == Prova da captura nativa (Desktop Duplication) ==
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  [x] Node nao encontrado no PATH. Instale o Node.js e tente de novo.
  echo.
  pause
  exit /b 1
)

if not exist "build\Release\ryke_captura.node" (
  echo  [x] O modulo nao esta compilado.
  echo      Rode, nesta pasta:  npm install  ^&^&  npm run build
  echo.
  pause
  exit /b 1
)

echo  Abrindo a janela animada ^(ela fecha sozinha^)...
start "" powershell -NoProfile -ExecutionPolicy Bypass -File "anima.ps1" -Segundos 12
timeout /t 2 /nobreak >nul

echo  Medindo...
echo.

rem  Grava e mostra ao mesmo tempo: a janela serve para acompanhar, o arquivo
rem  para copiar e mandar.
> "%SAIDA%" (
  echo == Prova da captura nativa do Ryke Desk ==
  echo Data: %DATE% %TIME%
  echo Maquina: %COMPUTERNAME%
  echo.
)
node prova.cjs >> "%SAIDA%" 2>&1
set CODIGO=%ERRORLEVEL%

type "%SAIDA%"

echo.
if "%CODIGO%"=="0" (
  echo  ------------------------------------------------------------
  echo   O numero que importa e a TAXA acima.
  echo.
  echo   Referencia: no modo administrador, a captura que o Ryke Desk
  echo   usa hoje cai para 1 quadro por segundo. Esta aqui nao cai.
  echo  ------------------------------------------------------------
) else (
  echo  A prova falhou. O motivo esta acima e no arquivo.
)
echo.
echo  Resultado salvo em: %SAIDA%
echo  Abrindo no Bloco de Notas para voce copiar ^(Ctrl+A, Ctrl+C^)...
start "" notepad "%SAIDA%"
echo.
pause
