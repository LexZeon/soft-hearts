#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$NoLaunch,
    # After the usual start: install or update the development desktop channel and refresh both shortcuts.
    [switch]$UpdateDesktop,
    # Alone: make the current development version the stable version (promote-to-stable.cmd).
    [switch]$PromoteStable
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.local\runtime'
$minimumNode = [version]'22.12.0'

function Get-NodeInfo([string]$Executable) {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $null }
    try {
        $details = & $Executable -p 'JSON.stringify({version:process.versions.node,arch:process.arch})' 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $details = ($details -join '') | ConvertFrom-Json
        if ([version]$details.version -lt $minimumNode) { return $null }
        $directory = Split-Path -Parent $Executable
        $npm = $null
        $pnpm = $null
        foreach ($modules in @((Join-Path $directory 'node_modules'), (Join-Path (Split-Path -Parent $directory) 'node_modules'))) {
            $npmCandidate = Join-Path $modules 'npm\bin\npm-cli.js'
            if (Test-Path -LiteralPath $npmCandidate -PathType Leaf) { $npm = $npmCandidate }
            $pnpmPackage = Join-Path $modules 'pnpm\package.json'
            $pnpmCandidate = Join-Path $modules 'pnpm\bin\pnpm.cjs'
            if ((Test-Path -LiteralPath $pnpmPackage -PathType Leaf) -and (Test-Path -LiteralPath $pnpmCandidate -PathType Leaf)) {
                $installed = Get-Content -LiteralPath $pnpmPackage -Raw | ConvertFrom-Json
                if ($installed.version -eq $script:pnpmVersion) { $pnpm = $pnpmCandidate }
            }
        }
        if ($npm -or $pnpm) { return [pscustomobject]@{ Path = $Executable; Version = $details.version; Arch = $details.arch; Npm = $npm; Pnpm = $pnpm } }
    } catch { }
    return $null
}

function Find-Node {
    $candidates = @()
    $candidates += @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    if (Test-Path -LiteralPath $runtimeRoot -PathType Container) {
        $candidates += @(Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter 'node-v*-win-*' | Sort-Object LastWriteTime -Descending | ForEach-Object { Join-Path $_.FullName 'node.exe' })
    }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($base) { $candidates += Join-Path $base 'nodejs\node.exe' }
    }
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        $found = Get-NodeInfo $candidate
        if ($found) { return $found }
    }
    return $null
}

# Match the desktop host's discovery (scripts/claude-discovery.mjs) without logging in or reading credentials.
function Find-ClaudeExecutable {
    $override = [Environment]::GetEnvironmentVariable('CLAUDE_PATH', 'Process')
    if ($override) {
        if (Test-Path -LiteralPath $override -PathType Leaf) {
            return [pscustomobject]@{ Path = $override; Status = 'found' }
        }
        # An explicit override is authoritative, including when it is invalid.
        return [pscustomobject]@{ Path = $null; Status = 'invalid-override' }
    }
    foreach ($directory in @(([Environment]::GetEnvironmentVariable('PATH', 'Process') -split [IO.Path]::PathSeparator))) {
        $directory = $directory.Trim('"')
        if (-not $directory) { continue }
        $candidate = Join-Path $directory 'claude.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [pscustomobject]@{ Path = $candidate; Status = 'found' }
        }
    }
    $candidates = @()
    if ($env:USERPROFILE) { $candidates += Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\claude.exe' }
    if ($env:APPDATA) { $candidates += Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe' }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [pscustomobject]@{ Path = $candidate; Status = 'found' } }
    }
    return [pscustomobject]@{ Path = $null; Status = 'missing' }
}

# Read-only: asks the official CLI whether it is signed in. Never prints account details or touches credentials.
function Test-ClaudeLogin([string]$Executable) {
    try {
        $raw = & $Executable 'auth' 'status' 2>$null
        if ($LASTEXITCODE -ne 0 -and -not $raw) { return $null }
        $status = ($raw -join '') | ConvertFrom-Json
        return [bool]$status.loggedIn
    } catch { return $null }
}

function Get-WindowsArch {
    try { $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
    catch { $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE } }
    switch ($architecture.ToLowerInvariant()) {
        'arm64' { return 'arm64' }
        'x64' { return 'x64' }
        'amd64' { return 'x64' }
        default { throw "This preview requires Windows x64 or ARM64 (detected: $architecture)." }
    }
}

# Download/extraction cleanup is confined to the project's managed runtime folder.
function Assert-RuntimePath([string]$Target) {
    $absolute = [IO.Path]::GetFullPath($Target)
    $prefix = [IO.Path]::GetFullPath($runtimeRoot).TrimEnd('\') + '\'
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing a runtime operation outside $runtimeRoot"
    }
    return $absolute
}

function Install-PortableNode([string]$Architecture) {
    Write-Host 'Finding the current Node.js LTS from nodejs.org...'
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60
    $release = $releases | Where-Object {
        $_.lts -and ($_.files -contains "win-$Architecture-zip") -and ([version]$_.version.TrimStart('v') -ge $minimumNode)
    } | Sort-Object { [version]$_.version.TrimStart('v') } -Descending | Select-Object -First 1
    if (-not $release) { throw "No supported official Node.js LTS ZIP was found for Windows $Architecture." }
    $version = $release.version
    if ($version -notmatch '^v\d+\.\d+\.\d+$') { throw 'Unexpected Node.js release metadata.' }
    $folderName = "node-$version-win-$Architecture"
    $archiveName = "$folderName.zip"
    $baseUrl = "https://nodejs.org/dist/$version"
    $manifest = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -TimeoutSec 60).Content
    if ($manifest -is [byte[]]) { $manifest = [Text.Encoding]::UTF8.GetString($manifest) }
    $entry = [regex]::Match($manifest, '(?m)^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($archiveName) + '\s*$')
    if (-not $entry.Success) { throw "The official checksum manifest does not contain $archiveName." }
    $expected = $entry.Groups[1].Value
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    $archive = Assert-RuntimePath (Join-Path $runtimeRoot $archiveName)
    $download = Assert-RuntimePath ("$archive.download-" + [guid]::NewGuid().ToString('N'))
    $extract = Assert-RuntimePath (Join-Path $runtimeRoot ('.extract-' + [guid]::NewGuid().ToString('N')))
    try {
        if (-not (Test-Path -LiteralPath $archive -PathType Leaf) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
            Write-Host "Downloading official $archiveName..."
            Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archiveName" -OutFile $download -TimeoutSec 300
            if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $expected) { throw 'Node.js ZIP SHA-256 verification failed; nothing was installed.' }
            Move-Item -LiteralPath $download -Destination $archive -Force
        }
        $target = Assert-RuntimePath (Join-Path $runtimeRoot $folderName)
        if (Test-Path -LiteralPath $target) { throw "An incomplete runtime already exists at $target. Ask Claude Code to inspect it before retrying." }
        Expand-Archive -LiteralPath $archive -DestinationPath $extract
        $unpacked = Assert-RuntimePath (Join-Path $extract $folderName)
        $verified = Get-NodeInfo (Join-Path $unpacked 'node.exe')
        if (-not $verified -or $verified.Version -ne $version.TrimStart('v') -or $verified.Arch -ne $Architecture) { throw 'The extracted Node.js runtime failed its version/architecture check.' }
        Move-Item -LiteralPath $unpacked -Destination $target
        return Get-NodeInfo (Join-Path $target 'node.exe')
    } finally {
        if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath (Assert-RuntimePath $download) -Force }
        if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath (Assert-RuntimePath $extract) -Recurse -Force }
    }
}

function Invoke-Pnpm([string[]]$Arguments) {
    if ($script:node.Pnpm) { & $script:node.Path $script:node.Pnpm @Arguments }
    else { & $script:node.Path $script:node.Npm 'exec' '--yes' "--package=pnpm@$script:pnpmVersion" '--' 'pnpm' @Arguments }
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') failed (exit $LASTEXITCODE)." }
}

# The existing desktop:update path (scripts/update-desktop.mjs). It prints its own Chinese status; its output
# is not captured here, so Node writes straight to this console. If the host redirects it anyway, it is read as
# UTF-8 rather than the console code page (e.g. GBK). A failure only sets the exit code: the app is already running.
function Invoke-DesktopChannels([string]$Mode) {
    $consoleEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        & $script:node.Path (Join-Path $projectRoot 'scripts\update-desktop.mjs') $Mode
        $script:desktopExitCode = $LASTEXITCODE
    } catch {
        [Console]::Error.WriteLine("soft hearts next desktop channels: $($_.Exception.Message)")
        $script:desktopExitCode = 1
    } finally { [Console]::OutputEncoding = $consoleEncoding }
}

# Only the installed stable channel uses the real profile (%APPDATA%\soft-hearts-claude). The source app runs with the
# development profile (%APPDATA%\soft-hearts-claude-dev): scripts/source-profile.mjs seeds it once from stable and
# prints its folder as ASCII-only JSON, so no console code page can garble a non-ASCII path or its Chinese note.
function Get-SourceProfile {
    $raw = & $node.Path (Join-Path $projectRoot 'scripts\source-profile.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'The development profile for the source app could not be prepared (see above); the source app was not started.' }
    $answer = ($raw -join '') | ConvertFrom-Json
    $directory = [string]$answer.directory
    if (-not $directory -or -not [IO.Path]::IsPathRooted($directory) -or $directory.EndsWith('\') -or $directory.Contains('"') -or
        -not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'The development profile for the source app is unavailable; the source app was not started.' }
    if ($answer.message) { Write-Host $answer.message }
    return $directory
}

# The usual start: the Electron runtime from node_modules runs this source folder with the development profile.
function Start-SourceApp {
    # Node prints UTF-8, but Windows PowerShell decodes native output with the console code page
    # (e.g. GBK), which garbles non-ASCII project paths (Chinese folder names). Read it as UTF-8.
    $consoleEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        $electronExecutable = (& $node.Path '--input-type=commonjs' '-p' "require('electron')" | Out-String).Trim()
    } finally { [Console]::OutputEncoding = $consoleEncoding }
    if ($LASTEXITCODE -ne 0 -or -not $electronExecutable -or -not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
        # Fallback that needs no console decoding: electron records its binary name in path.txt.
        $pathFile = Join-Path $projectRoot 'node_modules\electron\path.txt'
        if (Test-Path -LiteralPath $pathFile -PathType Leaf) {
            $electronExecutable = Join-Path (Join-Path $projectRoot 'node_modules\electron\dist') ((Get-Content -LiteralPath $pathFile -Raw).Trim())
        }
    }
    if (-not $electronExecutable -or -not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) { throw 'Could not locate the prepared Electron executable.' }
    $projectArgument = '(?i)(?:^|\s)"?' + [regex]::Escape($projectRoot) + '"?(?:\s|$)'
    $existing = @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object {
        $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $electronExecutable, [StringComparison]::OrdinalIgnoreCase) -and
        $_.CommandLine -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match $projectArgument
    })
    if ($existing.Count) {
        Write-Host "This source app is already running (PID $($existing[0].ProcessId)); no duplicate was launched."
        return
    }
    $sourceProfile = Get-SourceProfile
    # Do not pass a process-scoped PowerShell policy override into the real app.
    [Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', $null, 'Process')
    $launched = Start-Process -FilePath $electronExecutable -ArgumentList @(('"' + $projectRoot + '"'), ('"--user-data-dir=' + $sourceProfile + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    Write-Host "Started the soft hearts next source app (PID $($launched.Id)) with the development profile $sourceProfile. Daily use belongs to the stable desktop shortcut, which keeps the real profile."
}

$previousPath = $env:PATH
$previousCache = $env:npm_config_cache
$previousElectronCache = $env:electron_config_cache
$previousElectronMode = $env:ELECTRON_RUN_AS_NODE
$previousProcessPolicy = [Environment]::GetEnvironmentVariable('PSExecutionPolicyPreference', 'Process')
$previousProtocol = [Net.ServicePointManager]::SecurityProtocol
$locationChanged = $false
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Use this setup script on Windows x64 or ARM64.' }
    $architecture = Get-WindowsArch
    $packageFile = Join-Path $projectRoot 'package.json'
    $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
    if ($package.name -ne 'soft-hearts-next' -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'pnpm-lock.yaml'))) { throw 'Open the complete soft hearts next source folder, containing package.json and pnpm-lock.yaml.' }
    if ($package.packageManager -notmatch '^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+sha\d+\.[a-fA-F0-9]+)?$') { throw 'package.json must pin an exact pnpm version.' }
    $script:pnpmVersion = $Matches[1]
    $script:node = Find-Node
    if ($PromoteStable) {
        # Promote only: no download, install, build or app launch. Nothing is rebuilt.
        if ($CheckOnly -or $NoLaunch -or $UpdateDesktop) { throw 'PromoteStable runs alone.' }
        if (-not $node) { throw 'Node.js was not found. Double-click start-soft-hearts.cmd once first; nothing was promoted.' }
        Invoke-DesktopChannels '--promote'
        exit $script:desktopExitCode
    }
    $claude = Find-ClaudeExecutable
    Write-Host "soft hearts next setup | Windows $architecture | pnpm $pnpmVersion"
    if ($claude.Status -eq 'found') {
        Write-Host "Claude Code: $($claude.Path)"
        $loggedIn = Test-ClaudeLogin $claude.Path
        if ($loggedIn -eq $true) { Write-Host 'Claude Code reports that you are signed in. Chat will use your own login; this does not prove a reply works yet.' }
        elseif ($loggedIn -eq $false) { Write-Warning 'Claude Code is installed but not signed in. Run "claude" in a terminal once and finish the official sign-in, then chat will work.' }
        else { Write-Warning 'Could not read the Claude Code sign-in status. If chat fails, run "claude" in a terminal and sign in.' }
    } elseif ($claude.Status -eq 'invalid-override') {
        Write-Warning 'CLAUDE_PATH points to a missing file. The app will not fall back to another executable; correct it before testing chat.'
    } else {
        Write-Warning 'Claude Code was not found. The app can start, but chat needs the official Claude Code (https://code.claude.com/docs/en/setup) and a sign-in.'
    }
    if ($CheckOnly) {
        if ($node) {
            Write-Host "Node.js $($node.Version) ($($node.Arch)): $($node.Path)"
            if ($node.Pnpm) { Write-Host "Pinned pnpm: $($node.Pnpm)" } else { Write-Host "npm: $($node.Npm)" }
        } else {
            Write-Host 'Node.js 22.12+ with npm or pinned pnpm is missing; normal setup can prepare the official portable LTS runtime.'
        }
        Write-Host "Dependencies present: $(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))"
        Write-Host "Build present: $(Test-Path -LiteralPath (Join-Path $projectRoot 'dist-electron\main.cjs'))"
        Write-Host 'Check only: no downloads, installs, builds, configuration changes or app launches.'
        return
    }
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
    if (-not $node) { $script:node = Install-PortableNode $architecture }
    if (-not $node) { throw 'A working Node.js/npm runtime could not be prepared.' }
    Write-Host "Using Node.js $($node.Version) ($($node.Arch)): $($node.Path)"
    # These environment overrides apply only to this process and its children.
    $env:PATH = (Split-Path -Parent $node.Path) + [IO.Path]::PathSeparator + $previousPath
    $env:npm_config_cache = Join-Path $projectRoot '.local\npm-cache'
    # Keep the Electron download inside this folder too.
    $env:electron_config_cache = Join-Path $projectRoot '.local\electron-cache'
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Push-Location -LiteralPath $projectRoot
    $locationChanged = $true
    Invoke-Pnpm -Arguments @('install', '--frozen-lockfile')
    # Electron 45 installs its binary on demand; prepare it without opening UI.
    & $node.Path '--input-type=commonjs' '-e' "require('electron')"
    if ($LASTEXITCODE -ne 0) { throw 'Electron runtime preparation failed. Keep the output and ask Claude Code to diagnose the download.' }
    # A type error must not keep the pet from starting, so the type check is only a warning here.
    # The development desktop channel update (scripts/update-desktop.mjs) still treats it as a hard gate.
    try { Invoke-Pnpm -Arguments @('run', 'typecheck') }
    catch {
        Write-Warning 'The type check reported errors (see above). The pet still starts the usual way; the development desktop channel will not update until they are fixed. Keep this window and ask Claude to look at it.'
    }
    Invoke-Pnpm -Arguments @('run', 'build:app')
    if ($NoLaunch) { Write-Host 'Setup and build complete. No app was launched.' }
    else { Start-SourceApp }
    if ($UpdateDesktop) {
        Write-Host ''
        Write-Host 'soft hearts next: installing or updating the development desktop channel and its shortcuts...'
        Invoke-DesktopChannels '--install'
        # 3 = the app was started the usual way; only the desktop channel update failed (its message is above).
        if ($script:desktopExitCode -ne 0) { exit 3 }
    }
} catch {
    [Console]::Error.WriteLine("soft hearts next setup: $($_.Exception.Message)")
    exit 1
} finally {
    if ($locationChanged) { Pop-Location }
    $env:PATH = $previousPath
    $env:npm_config_cache = $previousCache
    $env:electron_config_cache = $previousElectronCache
    $env:ELECTRON_RUN_AS_NODE = $previousElectronMode
    [Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', $previousProcessPolicy, 'Process')
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
}
