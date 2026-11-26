@echo off
rem I-030: double-click in Explorer to (re)install the "我在用电脑" tray (see install.ps1). User level only.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
timeout /t 15
