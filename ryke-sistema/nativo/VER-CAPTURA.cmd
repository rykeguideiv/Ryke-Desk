@echo off
rem  Duplo clique aqui para VER a captura nativa funcionando.
rem
rem  Abre uma janela que mostra esta tela sendo capturada pela API do Windows,
rem  com duas taxas no titulo:
rem
rem    captura  — quantos quadros por segundo a Desktop Duplication entregou
rem    previa   — quantas vezes por segundo a janela redesenhou
rem
rem  Sao numeros diferentes de proposito. Desenhar 1920x1080 no processador e
rem  caro; capturar nao. Misturar os dois faria a captura parecer mais lenta do
rem  que e — foi o que aconteceu na primeira versao deste demo.
rem
rem  O TESTE QUE IMPORTA: abra este arquivo normalmente e anote a taxa. Depois
rem  clique com o botao direito -> "Executar como administrador" e compare.
rem  A captura do Chromium, que o Ryke Desk usa hoje, cai para 1 quadro por
rem  segundo quando elevada. Esta nao deve cair.
setlocal
cd /d "%~dp0"
set "EXE=demo\RykeCaptura-Demo.exe"

if exist "%EXE%" goto :abrir

echo.
echo  O demo ainda nao foi compilado. Compilando...
echo.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo  [x] Visual Studio Build Tools nao encontrado.
  echo      Instale com:
  echo        winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  echo.
  pause
  exit /b 1
)
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (
  echo  [x] O conjunto de ferramentas C++ nao esta instalado no Visual Studio.
  echo.
  pause
  exit /b 1
)
if not exist "demo\obj" mkdir "demo\obj"
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cl /nologo /EHsc /std:c++17 /O2 /DNDEBUG /Fo:demo\obj\ demo\demo.cpp src\duplicador.cc /Fe:%EXE% /link /SUBSYSTEM:WINDOWS d3d11.lib dxgi.lib user32.lib gdi32.lib advapi32.lib
if not exist "%EXE%" (
  echo.
  echo  [x] A compilacao falhou. O motivo esta acima.
  echo.
  pause
  exit /b 1
)
echo.
echo  Compilado.

:abrir
echo.
echo  Abrindo a captura nativa. Feche a janela para sair.
echo.
start "" "%EXE%"
