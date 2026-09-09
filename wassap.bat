@echo off
REM Double-click this to open the wassap dashboard.
REM Everything - linking, syncing, reviewing - happens in the browser.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, or not on your PATH.
  echo Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo First run: installing dependencies. This takes a few minutes...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo Install failed. Scroll up for the reason.
    pause
    exit /b 1
  )
)

echo Starting wassap. Close this window when you are done.
echo.
node bin/wassap.js ui --open
pause
