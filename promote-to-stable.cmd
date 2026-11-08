@echo off
setlocal
rem soft hearts next: make the current development version the stable version.
rem The already tested development build is copied into its own stable folder, and only the
rem "soft hearts next" stable desktop shortcut is pointed at it. Nothing is rebuilt; the stable
rem version keeps using the existing soft-hearts-claude profile. The Codex edition is never touched.
cd /d "%~dp0"
if not exist "%~dp0scripts\setup.ps1" (
  echo The source files are missing. Nothing was promoted.
  goto failed
)
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0scripts\setup.ps1" -PromoteStable
if errorlevel 1 goto failed
echo.
echo Done. You can close this window.
timeout /t 20
exit /b 0
:failed
echo.
echo Nothing new was made stable. The message above explains why.
pause
exit /b 1
