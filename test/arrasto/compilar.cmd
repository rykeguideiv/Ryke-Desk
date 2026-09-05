@echo off
rem  Compila a janela-alvo do teste de arrasto.
rem
rem  Ela nao faz parte do produto: e um instrumento de medida. Existe porque
rem  "o arrasto chegou?" nao se responde olhando o cursor — o cursor se move de
rem  qualquer jeito. Quem sabe e a janela que recebeu os eventos.
setlocal
cd /d "%~dp0"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo  [x] Visual Studio Build Tools nao encontrado.
  echo      winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  exit /b 1
)
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (
  echo  [x] O conjunto de ferramentas C++ nao esta instalado.
  exit /b 1
)

call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cl /nologo /EHsc /std:c++17 /O2 /DNDEBUG alvo-arrasto.cpp /Fe:alvo-arrasto.exe /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib
if not exist "alvo-arrasto.exe" (
  echo  [x] A compilacao falhou.
  exit /b 1
)
del /q *.obj 2>nul
echo  alvo-arrasto.exe pronto.
