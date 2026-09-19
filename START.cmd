@echo off
cd /d "%~dp0"
title Mint Desk
if not exist "%~dp0runtime\node.exe" (
  echo Missing runtime. Extract the complete ZIP first.
  pause
  exit /b 1
)
if not exist "%~dp0Mint Desk.exe" (
  echo Missing launcher. Extract the complete ZIP first.
  pause
  exit /b 1
)
start "" "%~dp0Mint Desk.exe"
exit /b 0
