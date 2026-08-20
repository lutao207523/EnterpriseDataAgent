@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Enterprise Report Agent
echo Starting Enterprise Report Agent...
node src\server.js
if errorlevel 1 (
  echo.
  echo The application failed to start. Make sure Node.js is installed.
  pause
)
