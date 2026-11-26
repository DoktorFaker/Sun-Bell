@echo off
title The Sun Bell - dev server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening https://nodejs.org - install the LTS version, then run this file again.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing packages ^(first run only^)...
  call npm install
  if errorlevel 1 ( echo npm install failed. & pause & exit /b 1 )
)
echo Starting the game at http://localhost:5173 - keep this window open while you play.
call npm run dev
pause
