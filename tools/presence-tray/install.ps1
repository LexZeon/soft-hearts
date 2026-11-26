# I-030: build the "我在用电脑" tray program with the C# compiler that ships with Windows, put it in
# %USERPROFILE%\.claude-presence, start it, and (unless -NoStartup) add a shortcut to the user's Startup folder so it starts
# at sign-in. User level only: no system setting, no service, no admin. Re-running replaces the program (the running copy,
# which is ours, is closed first; so is a copy installed before 2026-11-12 under ...\claude-presence). -Uninstall removes the
# shortcut and stops the program (the state folder stays).
# Run it from Explorer (安装托盘.cmd), not from inside the Claude desktop app: that app is a Windows package, and a shortcut it
# writes into the Startup folder lands in its private copy, which Windows does not start at sign-in. The script says so if it happens.
param([switch]$NoStartup, [switch]$NoStart, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $env:USERPROFILE '.claude-presence'
$exe = Join-Path $target 'PresenceTray.exe'
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude 我在用电脑.lnk'

function Stop-Tray {
  # This copy, or one installed before 2026-11-12 (any folder named claude-presence, including the Claude app's private copy).
  Get-Process -Name 'PresenceTray' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -or $_.Path -like '*\claude-presence\PresenceTray.exe' } | ForEach-Object {
    $_.CloseMainWindow() | Out-Null
    if (-not $_.WaitForExit(2000)) { $_.Kill() }
  }
}

if ($Uninstall) {
  Stop-Tray
  if (Test-Path $startup) { Remove-Item $startup }
  Write-Output '已停下托盘程序并去掉开机启动；状态文件夹留着。'
  return
}

$csc = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\FrameworkArm64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw '没找到 Windows 自带的 C# 编译器（csc.exe）。' }

New-Item -ItemType Directory -Force $target | Out-Null
Stop-Tray
$out = Join-Path $target 'PresenceTray.new.exe'
& $csc /nologo /target:winexe /codepage:65001 /optimize+ "/out:$out" /r:System.Windows.Forms.dll /r:System.Drawing.dll (Join-Path $here 'PresenceTray.cs')
if ($LASTEXITCODE -ne 0) { throw "编译失败（退出码 $LASTEXITCODE）。" }
Move-Item -Force $out $exe
Write-Output "已编译：$exe"

if (-not $NoStartup) {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($startup)
  $link.TargetPath = $exe
  $link.WorkingDirectory = $target
  $link.Description = '托盘里的"我在用电脑"开关：勾着时 Claude 的重活有上限'
  $link.Save()
  Write-Output "已放进开机启动：$startup"
  $private = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Packages\*\LocalCache\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Claude 我在用电脑.lnk') -ErrorAction SilentlyContinue
  if ($private) { Write-Warning '这次是在某个打包应用（比如 Claude 桌面应用）里运行的，开机启动可能没生效。请在资源管理器里双击 tools\presence-tray\安装托盘.cmd 再装一次。' }
}
if (-not $NoStart) { Start-Process -FilePath $exe; Write-Output '已启动，托盘里能看到绿色的勾。' }
