@echo off
title The Sun Bell - publish to Cloudflare
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 ( echo Install Node.js first: https://nodejs.org & pause & exit /b 1 )
if not exist node_modules ( call npm install || ( pause & exit /b 1 ) )
echo Building the game...
call npm run build || ( pause & exit /b 1 )
echo.
echo Publishing to Cloudflare. The first time, a browser window asks you to sign in and allow Wrangler.
call npx --yes wrangler@4 deploy
echo.
echo Done. Your game's address is shown above (ends in .workers.dev).
pause
