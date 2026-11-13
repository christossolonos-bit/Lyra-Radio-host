@echo off
rem Double-click to start Lyra Radio. Close this window (or press Ctrl+C) to stop her.
title Lyra Radio
cd /d "%~dp0"

if not exist .env (
  echo No .env file found. Copy .env.example to .env and add your keys first.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing...
  call npm install
)

rem open the page a few seconds after the server starts
start "" cmd /c "timeout /t 4 >nul & start http://localhost:5177"

echo Starting Lyra... (the page opens in your browser; press GO LIVE)
echo TikTok vertical view: http://localhost:5177/?layout=vertical
echo.
call npm run holo
pause
