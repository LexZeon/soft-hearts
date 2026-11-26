#Requires -Version 5.1
# One desktop shortcut that starts soft hearts next from this source folder (the same thing a double-click on
# start-soft-hearts.cmd does). docs/claude/2026-11-26-install-flow-options-shortcut.md
#   -Action Create   make the shortcut (default). Exit 0 ok, 2 a different shortcut of that name exists (nothing changed), 1 error.
#   -Action Remove   delete it, but only a shortcut that carries this script's marker (the Description below). Exit 0 ok or nothing there.
# -DesktopFolder is the folder to write into (default: the user's desktop); tests pass a temporary folder, so they never touch a real desktop.
# A shortcut with the marker is ours (an earlier install, maybe from another folder) and is simply repointed: that is how an update keeps it
# working. A shortcut of the same name without the marker is the user's own: it is refused unless -Force (the agent asks the user first).
# The name is PRODUCT_NAME + '.lnk' from scripts/lib/app-identity.mjs (tests/source-desktop-shortcut.test.ts keeps the two spellings equal);
# it can never be one of the Codex edition's shortcut names. ASCII only (Windows PowerShell 5.1 reads this file in the ANSI code page).
[CmdletBinding()]
param(
    [ValidateSet('Create', 'Remove')][string]$Action = 'Create',
    [string]$DesktopFolder = [Environment]::GetFolderPath('Desktop'),
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$IconPath = '',
    [string]$Name = 'soft hearts next.lnk',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$marker = 'soft hearts next - starts the source folder it points to (made by scripts/desktop-shortcut.ps1)'

try {
    if (-not $DesktopFolder -or -not (Test-Path -LiteralPath $DesktopFolder -PathType Container)) { throw "The folder for the shortcut does not exist: $DesktopFolder" }
    if ($Name -ne [IO.Path]::GetFileName($Name) -or -not $Name.EndsWith('.lnk', [StringComparison]::OrdinalIgnoreCase)) { throw 'The shortcut name must be a plain file name ending in .lnk.' }
    $path = Join-Path $DesktopFolder $Name
    $shell = New-Object -ComObject WScript.Shell
    $existing = $null
    if (Test-Path -LiteralPath $path -PathType Leaf) { $existing = $shell.CreateShortcut($path) }
    $mine = [bool]($existing -and [string]$existing.Description -eq $marker)

    if ($Action -eq 'Remove') {
        if (-not $existing) { Write-Host "No shortcut named '$Name' there; nothing to remove."; exit 0 }
        if (-not $mine) { Write-Host "The shortcut '$Name' there was not made by this script; left alone."; exit 0 }
        Remove-Item -LiteralPath $path -Force
        Write-Host "Removed the desktop shortcut '$Name'."
        exit 0
    }

    $launcher = Join-Path $ProjectRoot 'start-soft-hearts.cmd'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "start-soft-hearts.cmd was not found in $ProjectRoot" }
    if ($existing -and -not $mine -and -not $Force) {
        $samePlace = [string]::Equals([string]$existing.TargetPath, $launcher, [StringComparison]::OrdinalIgnoreCase)
        if (-not $samePlace) {
            Write-Host "A different shortcut named '$Name' already exists in $DesktopFolder (it points to: $($existing.TargetPath)). Nothing was changed. Ask the user whether to replace it (-Force) or keep it."
            exit 2
        }
    }
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = $launcher
    $shortcut.Arguments = ''
    $shortcut.WorkingDirectory = $ProjectRoot
    $shortcut.WindowStyle = 7  # minimised: the cmd's console does not sit in front of her for the twenty seconds it stays open
    $shortcut.Description = $marker
    # Icon: -IconPath if given, else the project's own assets\icons\soft-hearts.ico (a plain black placeholder until 0.2.1,
    # scripts/make-placeholder-icon.mjs), else the prepared Electron program's icon. A missing file is never an error.
    $iconCandidates = @($IconPath, (Join-Path $ProjectRoot 'assets\icons\soft-hearts.ico'), (Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'))
    foreach ($candidate in $iconCandidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $shortcut.IconLocation = $candidate + ',0'; break }
    }
    $shortcut.Save()
    Write-Host "Desktop shortcut '$Name' is in $DesktopFolder and starts $ProjectRoot. Deleting it is harmless."
    exit 0
} catch {
    [Console]::Error.WriteLine("soft hearts next desktop shortcut: $($_.Exception.Message)")
    exit 1
}
