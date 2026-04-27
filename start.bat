@echo off
cd /d "%~dp0"
echo ================================
echo   Code: Zero Line - Dev Server
echo ================================
echo.
echo Starting Vite (browser will open automatically)...
echo Press Ctrl+C to stop the server.
echo.
call npm run dev
echo.
echo Server stopped.
pause
