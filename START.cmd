@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer first: https://nodejs.org
  pause
  exit /b 1
)
:menu
cls
echo.
echo   PHOTO STUDIO
echo   ------------
echo   1  Open Photo Share web server
echo   2  Open Photo Booth
echo   3  Check web connection
echo   Q  Quit
echo.
choice /c 123Q /n /m "Choose: "
if errorlevel 4 exit /b 0
if errorlevel 3 goto check
if errorlevel 2 goto booth
if errorlevel 1 goto web
:web
if not exist node_modules\express goto install
call npm.cmd start
goto done
:booth
if not exist photobooth\node_modules\electron goto install
pushd photobooth
call npm.cmd start
popd
goto done
:check
call npm.cmd run check:booth
goto done
:install
echo Run scripts\install-local.ps1 in PowerShell to install dependencies first.
:done
echo.
pause
goto menu
