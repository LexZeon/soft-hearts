@echo off
setlocal
rem soft hearts next (Claude edition): unpack (first time only), install, build and start the usual way.
rem If a development desktop channel already exists on this machine, also update it and refresh its two desktop
rem shortcuts. A first start does not build that channel (it takes ten minutes or more); ask for it later with
rem   start-soft-hearts.cmd desktop      (or pnpm desktop:update)
rem Builds stay in this folder and settings in the soft-hearts-claude profiles; on the desktop only the two
rem "soft hearts next" shortcuts are written. Nothing here touches the Codex edition.
cd /d "%~dp0"
set "SH_ROOT=%~dp0"
set "SH_GATE=& ([scriptblock]::Create([IO.File]::ReadAllText($env:SH_ROOT + 'scripts\start-gate.ps1')))"
rem Scripts unpacked from a browser-downloaded zip carry the "downloaded from the internet" mark and Windows refuses
rem to run them. The gate reads its own text instead of running as a file, so it works anyway.
if not exist "%~dp0scripts\start-gate.ps1" goto nogate
powershell.exe -NoProfile -Command "%SH_GATE% check"
if errorlevel 10 goto marked
if errorlevel 1 goto failed
:nogate
rem A git checkout is updated with git; unpacking old delivery zips there would overwrite newer files.
if exist "%~dp0unpack-delivery.ps1" if not exist "%~dp0.git" (
  powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0unpack-delivery.ps1"
  if errorlevel 1 goto failed
)
if not exist "%~dp0scripts\setup.ps1" (
  echo The source files are missing. Unpack the soft-hearts-claude zip files into this folder first.
  goto failed
)
set "SH_DESKTOP="
if /i "%~1"=="desktop" set "SH_DESKTOP=1"
if not defined SH_DESKTOP if exist "%~dp0scripts\start-gate.ps1" (
  powershell.exe -NoProfile -Command "%SH_GATE% channel"
  if not errorlevel 1 set "SH_DESKTOP=1"
)
echo First start downloads Node.js and the app dependencies; it can take several minutes.
if defined SH_DESKTOP goto withdesktop
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0scripts\setup.ps1"
if errorlevel 1 goto failed
echo.
echo soft hearts next is running. You can close this window.
echo To also get the two desktop shortcuts ("soft hearts next - latest development version" and the stable one)
echo run start-soft-hearts.cmd desktop in a terminal; that builds a packaged copy and takes ten minutes or more.
timeout /t 20
exit /b 0
:withdesktop
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0scripts\setup.ps1" -UpdateDesktop
if errorlevel 3 goto desktopfailed
if errorlevel 1 goto failed
echo.
echo soft hearts next is running and the desktop shortcuts are up to date. You can close this window.
timeout /t 20
exit /b 0
:marked
echo.
set "SH_ANSWER="
set /p "SH_ANSWER=Remove the mark from the soft hearts files in this folder now? [Y/N] "
if /i "%SH_ANSWER%"=="Y" (
  powershell.exe -NoProfile -Command "%SH_GATE% unblock"
  if errorlevel 1 goto failed
  goto nogate
)
echo.
echo Nothing was changed. To do it by hand: right-click the zip file, Properties, tick Unblock, OK,
echo then unpack it again to a new folder and double-click start-soft-hearts.cmd there.
pause
exit /b 1
:desktopfailed
echo.
echo soft hearts next is running the usual way. The desktop channel update did not finish; the message above explains why.
pause
exit /b 0
:failed
echo.
echo Setup stopped. The message above explains why.
pause
exit /b 1
