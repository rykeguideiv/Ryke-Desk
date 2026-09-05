@echo off
rem  Compila o motor nativo e roda as provas.
rem
rem  Nao precisa de nada instalado alem do Visual Studio Build Tools com o
rem  conjunto C++. Sem CMake no PATH: usamos o que vem dentro do proprio VS.
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
  echo  [x] O conjunto de ferramentas C++ nao esta instalado no Visual Studio.
  exit /b 1
)

set "CMAKE=%VSDIR%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
if not exist "%CMAKE%" set "CMAKE=cmake"

call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1

echo.
echo  == configurando ==
"%CMAKE%" -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release 2>nul
if errorlevel 1 (
  echo  Ninja nao disponivel, usando o gerador do Visual Studio.
  "%CMAKE%" -S . -B build -G "Visual Studio 17 2022" -A x64
  if errorlevel 1 exit /b 1
  set "CONFIG=--config Release"
)

echo.
echo  == compilando ==
"%CMAKE%" --build build %CONFIG%
if errorlevel 1 exit /b 1

echo.
echo  == provas ==
for %%p in (prova-cripto prova-transporte prova-codec) do (
  echo.
  echo  ---- %%p ----
  if exist "build\bin\%%p.exe" ( "build\bin\%%p.exe" ) else ( "build\bin\Release\%%p.exe" )
  if errorlevel 1 (
    echo.
    echo  [x] %%p reprovou.
    exit /b 1
  )
)

echo.
echo  Tudo compilado e aprovado.
echo  O programa esta em build\bin\ryke-sistema.exe
