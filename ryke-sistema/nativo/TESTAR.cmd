@echo off
rem  Duplo clique aqui para MEDIR a captura nativa nesta maquina.
rem
rem  Nao e o Ryke Desk. E a prova de um componente: ele abre a tela pela
rem  Desktop Duplication API, captura por 5 segundos e diz quantos quadros por
rem  segundo conseguiu. Uma janela colorida aparece durante a medida, so para
rem  dar o que capturar — sem ela a tela ficaria parada e o resultado seria
rem  zero quadros, o que nao provaria nada.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

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
node prova.cjs
set CODIGO=%ERRORLEVEL%

echo.
if "%CODIGO%"=="0" (
  echo  ------------------------------------------------------------
  echo   O numero que importa e a TAXA acima.
  echo.
  echo   Referencia: no modo administrador, a captura que o Ryke Desk
  echo   usa hoje cai para 1 quadro por segundo. Esta aqui nao cai.
  echo  ------------------------------------------------------------
) else (
  echo  A prova falhou. A saida acima diz o motivo.
)
echo.
pause
