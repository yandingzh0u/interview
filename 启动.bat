@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Beiti - Local Interview Bank

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Install it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

node server.mjs
echo.
echo   Server stopped. Your questions are saved in data\bank.jsonl
pause
