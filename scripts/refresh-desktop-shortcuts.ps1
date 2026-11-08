#Requires -Version 5.1
[CmdletBinding()]
param([string]$WorkspaceRoot = '', [switch]$LatestOnly, [switch]$StableOnly, [string]$ManifestFile = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $WorkspaceRoot) { $WorkspaceRoot = Split-Path -Parent $PSScriptRoot }
$projectRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $WorkspaceRoot).Path).TrimEnd('\')
$release = Join-Path $projectRoot 'release'
$releasePrefix = $release.TrimEnd('\') + '\'
if ($LatestOnly -and $StableOnly) { throw 'LatestOnly and StableOnly cannot be combined.' }
if ($ManifestFile -and -not $StableOnly) { throw 'ManifestFile is permitted only with StableOnly.' }
$launcher = Join-Path $release 'start-latest.ps1'
function Entry-Icon([string]$file) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'The desktop build reference is missing.' }
    if ((Get-Item -LiteralPath $file).Length -gt 16384) { throw 'The desktop build reference is too large.' }
    $manifest = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if (-not $manifest.PSObject.Properties['executable'] -or -not ($manifest.executable -is [string]) -or [IO.Path]::IsPathRooted($manifest.executable)) { throw 'The desktop executable reference must be relative.' }
    $icon = [IO.Path]::GetFullPath((Join-Path $projectRoot $manifest.executable))
    if (-not $icon.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($icon) -ne 'soft hearts next.exe' -or -not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'The desktop executable must exist inside this project release directory.' }
    return $icon
}
$desktop = [Environment]::GetFolderPath('Desktop')
# Fixed names from scripts/lib/app-identity.mjs, spelled with char codes so this file stays ASCII.
$deliveredName = 'soft hearts next - ' + (-join ([char[]]@(0x7A33,0x5B9A,0x7248))) + '.lnk'
$latestName = 'soft hearts next - ' + (-join ([char[]]@(0x6700,0x65B0,0x5F00,0x53D1,0x7248))) + '.lnk'
$hasDelivered = Test-Path -LiteralPath (Join-Path $release 'desktop-delivered.json') -PathType Leaf
if ($LatestOnly -and $hasDelivered -and -not (Test-Path -LiteralPath (Join-Path $desktop $deliveredName) -PathType Leaf)) {
    throw 'The existing complete-delivery shortcut is missing. No desktop shortcuts were changed.'
}
$entries = @()
if (-not $StableOnly) {
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'The desktop launcher must be installed before creating its shortcuts.' }
    $entries += [pscustomobject]@{ Name=$latestName; Launcher=$launcher; Channel='development'; Icon=(Entry-Icon (Join-Path $release 'desktop-current.json')); Description='Start the development soft hearts next desktop build' }
}
if ($ManifestFile) {
    if (-not [IO.Path]::IsPathRooted($ManifestFile)) { throw 'The staged stable reference must be an absolute path.' }
    $deliveredFile = [IO.Path]::GetFullPath($ManifestFile)
    if (-not $deliveredFile.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $deliveredFile.Substring($releasePrefix.Length).Replace('\', '/') -notmatch '^stable/[a-fA-F0-9]{64}/stable-manifest\.json$') { throw 'The staged stable reference must be in its immutable version directory.' }
} else { $deliveredFile = Join-Path $release 'desktop-delivered.json' }
$hasSelectedDelivery = Test-Path -LiteralPath $deliveredFile -PathType Leaf
if ($StableOnly -and -not $hasSelectedDelivery) { throw 'The complete delivery reference is missing. No desktop shortcuts were changed.' }
if ($hasSelectedDelivery -and -not $LatestOnly) {
    if (-not (Test-Path -LiteralPath (Join-Path $desktop $deliveredName) -PathType Leaf)) { throw 'The existing complete-delivery shortcut is missing. No desktop shortcuts were changed.' }
    if ((Get-Item -LiteralPath $deliveredFile).Length -gt 16384) { throw 'The complete delivery reference is too large. No desktop shortcuts were changed.' }
    $manifestHash = (Get-FileHash -LiteralPath $deliveredFile -Algorithm SHA256).Hash
    $manifest = Get-Content -LiteralPath $deliveredFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $relativeLauncher = if ($manifest.PSObject.Properties['launcher']) { $manifest.launcher } else { $null }
    $launcherHash = if ($manifest.PSObject.Properties['launcherSha256']) { $manifest.launcherSha256 } else { $null }
    $exeHash = if ($manifest.PSObject.Properties['exeSha256']) { $manifest.exeSha256 } else { $null }
    $asarHash = if ($manifest.PSObject.Properties['asarSha256']) { $manifest.asarSha256 } else { $null }
    if (-not ($relativeLauncher -is [string]) -or [IO.Path]::IsPathRooted($relativeLauncher) -or
        -not ($launcherHash -is [string]) -or $launcherHash -notmatch '^[a-fA-F0-9]{64}$' -or
        -not ($exeHash -is [string]) -or $exeHash -notmatch '^[a-fA-F0-9]{64}$' -or
        -not ($asarHash -is [string]) -or $asarHash -notmatch '^[a-fA-F0-9]{64}$' -or
        $manifest.version -ne 1 -or $manifest.platform -ne 'win32' -or $manifest.arch -notin @('x64', 'arm64') -or
        -not ($manifest.buildId -is [string]) -or $manifest.buildId -notmatch '^[a-fA-F0-9]{64}$') { throw 'The complete delivery identity is invalid.' }
    if ($relativeLauncher.Replace('\', '/') -notmatch ('^release/stable/[a-fA-F0-9]{64}/win-' + $manifest.arch + '-unpacked/start-latest\.ps1$')) { throw 'The complete launcher must belong to an immutable stable version.' }
    $deliveredLauncher = [IO.Path]::GetFullPath((Join-Path $projectRoot $relativeLauncher))
    $deliveredIcon = Entry-Icon $deliveredFile
    if (-not $deliveredLauncher.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($deliveredLauncher) -ne 'start-latest.ps1' -or
        -not [string]::Equals((Split-Path -Parent $deliveredLauncher), (Split-Path -Parent $deliveredIcon), [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $deliveredLauncher -PathType Leaf) -or
        -not [string]::Equals((Get-FileHash -LiteralPath $deliveredLauncher -Algorithm SHA256).Hash, $launcherHash, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals((Get-FileHash -LiteralPath $deliveredIcon -Algorithm SHA256).Hash, $exeHash, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals((Get-FileHash -LiteralPath (Join-Path (Split-Path -Parent $deliveredIcon) 'resources\app.asar') -Algorithm SHA256).Hash, $asarHash, [StringComparison]::OrdinalIgnoreCase)) { throw 'The complete delivery launcher, executable and app must match their immutable identity.' }
    $selfManifest = Join-Path (Split-Path -Parent (Split-Path -Parent $deliveredLauncher)) 'stable-manifest.json'
    if (-not (Test-Path -LiteralPath $selfManifest -PathType Leaf) -or (Get-Item -LiteralPath $selfManifest).Length -gt 16384) { throw 'The immutable stable version reference is missing or too large.' }
    if ($ManifestFile -and -not [string]::Equals($deliveredFile, $selfManifest, [StringComparison]::OrdinalIgnoreCase)) { throw 'The staged stable reference does not belong to the selected launcher.' }
    $selfHash = (Get-FileHash -LiteralPath $selfManifest -Algorithm SHA256).Hash
    $selfReference = Get-Content -LiteralPath $selfManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($key in @('version','executable','asarSha256','buildId','launcher','launcherSha256','exeSha256','platform','arch')) {
        if (-not $manifest.PSObject.Properties[$key] -or -not $selfReference.PSObject.Properties[$key] -or
            -not [string]::Equals([string]$manifest.$key, [string]$selfReference.$key, [StringComparison]::Ordinal)) { throw 'The selected reference differs from the immutable version reference.' }
    }
    $entries += [pscustomobject]@{ Name=$deliveredName; Launcher=$deliveredLauncher; Channel='stable'; Icon=$deliveredIcon; Description='Start the stable soft hearts next delivery'; ManifestFile=$deliveredFile; ManifestSha256=$manifestHash; SelfManifest=$selfManifest; SelfSha256=$selfHash; LauncherSha256=$launcherHash; ExeSha256=$exeHash; AsarSha256=$asarHash }
}
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shell = New-Object -ComObject WScript.Shell
foreach ($entry in $entries) {
    $shortcut = $shell.CreateShortcut((Join-Path $desktop $entry.Name))
    $shortcut.TargetPath = $powershell
    $expectedArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + $entry.Launcher + '" -Channel ' + $entry.Channel + ' -WorkspaceRoot "' + $projectRoot + '"'
    $shortcut.Arguments = $expectedArguments
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.IconLocation = $entry.Icon
    $shortcut.WindowStyle = 7
    $shortcut.Description = $entry.Description
    $shortcut.Save()
    if ($entry.Channel -eq 'stable') {
        $shortcutPath = Join-Path $desktop $entry.Name
        if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw 'The stable shortcut was not saved; no success receipt was issued.' }
        $saved = $shell.CreateShortcut($shortcutPath)
        $savedIcon = [string]$saved.IconLocation
        if ($savedIcon -match '^(.*),(-?\d+)$') {
            if ($Matches[2] -ne '0') { throw 'Stable shortcut icon index differs; no success receipt was issued.' }
            $savedIcon = $Matches[1]
        }
        if (-not [string]::Equals($saved.TargetPath, $powershell, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($saved.Arguments, $expectedArguments, [StringComparison]::Ordinal) -or
            -not [string]::Equals($saved.WorkingDirectory, $projectRoot, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($savedIcon, $entry.Icon, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals((Get-FileHash -LiteralPath $entry.ManifestFile -Algorithm SHA256).Hash, $entry.ManifestSha256, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals((Get-FileHash -LiteralPath $entry.SelfManifest -Algorithm SHA256).Hash, $entry.SelfSha256, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals((Get-FileHash -LiteralPath $entry.Launcher -Algorithm SHA256).Hash, $entry.LauncherSha256, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals((Get-FileHash -LiteralPath $entry.Icon -Algorithm SHA256).Hash, $entry.ExeSha256, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals((Get-FileHash -LiteralPath (Join-Path (Split-Path -Parent $entry.Icon) 'resources\app.asar') -Algorithm SHA256).Hash, $entry.AsarSha256, [StringComparison]::OrdinalIgnoreCase)) { throw 'Stable shortcut readback or source identity changed; no success receipt was issued.' }
        [pscustomobject]@{ channel='stable'; manifestSha256=$entry.ManifestSha256.ToLowerInvariant(); launcherSha256=$entry.LauncherSha256.ToLowerInvariant(); launcherPath=$entry.Launcher; shortcutPath=$shortcutPath; shortcutSha256=(Get-FileHash -LiteralPath $shortcutPath -Algorithm SHA256).Hash.ToLowerInvariant(); targetPath=$saved.TargetPath; arguments=$saved.Arguments } | ConvertTo-Json -Compress
    } else { Write-Output ('Updated desktop entry: ' + $entry.Name) }
}
