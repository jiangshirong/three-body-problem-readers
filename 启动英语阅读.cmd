@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0服务\start-english.ps1" -Restart
if errorlevel 1 if not defined READER_NO_PAUSE pause
