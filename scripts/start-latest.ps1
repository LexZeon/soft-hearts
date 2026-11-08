#Requires -Version 5.1
# soft-hearts-launcher-v2
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$Restart,
    [switch]$StopOnly,
    [switch]$Delivered,
    [ValidateSet('development', 'stable')]
    [string]$Channel = 'development',
    [string]$WorkspaceRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Full-Path([string]$Value) { return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Value).Path).TrimEnd('\') }
function Same-Path([string]$Left, [string]$Right) { return [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase) }
function Read-Property($Value, [string]$Name) { if ($Value -and $Value.PSObject.Properties[$Name]) { return $Value.$Name }; return $null }
function Is-AppPath([string]$Value) {
    return $Value -and $Value.StartsWith($script:releasePrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($Value) -eq 'soft hearts next.exe'
}
function Profile-Argument([string]$CommandLine) {
    if (-not $CommandLine) { return [pscustomobject]@{ Present=$false; Valid=$true; Value='' } }
    $present = [regex]::Matches($CommandLine, '(?i)(?:^|\s)"?--user-data-dir(?:=|\s)').Count
    if (-not $present) { return [pscustomobject]@{ Present=$false; Valid=$true; Value='' } }
    $profileMatches = [regex]::Matches($CommandLine, '(?i)(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir=(?:"([^"]+)"|([^\s"]+))|--user-data-dir\s+(?:"([^"]+)"|([^\s"]+)))(?=\s|$)')
    if ($present -ne 1 -or $profileMatches.Count -ne 1) { return [pscustomobject]@{ Present=$true; Valid=$false; Value='' } }
    $value = ''
    foreach ($group in $profileMatches[0].Groups | Select-Object -Skip 1) { if ($group.Success) { $value = $group.Value; break } }
    try { $value = [IO.Path]::GetFullPath($value).TrimEnd('\') } catch { return [pscustomobject]@{ Present=$true; Valid=$false; Value='' } }
    return [pscustomobject]@{ Present=$true; Valid=$true; Value=$value }
}
function Uses-NormalProfile($Value) {
    $profile = Profile-Argument $Value.CommandLine
    if (-not $profile.Valid) { return $false }
    if ($script:normalProfile) { return $profile.Present -and (Same-Path $profile.Value $script:normalProfile) }
    return -not $profile.Present
}
function Is-OwnedMain($Value) {
    return (Is-AppPath $Value.ExecutablePath) -and $Value.CommandLine -and
        $Value.CommandLine -notmatch '(?:^|\s)"?--(?:type|soft-hearts-stop)(?:=|\s)' -and
        $Value.CommandLine -match ('(?:^|\s)--soft-hearts-desktop=' + $script:ownerId + '(?=\s|$)') -and
        (Uses-NormalProfile $Value)
}
function Start-Scoped([string]$Executable, [string[]]$Arguments, [switch]$Quiet) {
    $previousNodeMode = $env:ELECTRON_RUN_AS_NODE
    $previousProfile = $env:MMD_DESK_USER_DATA
    $previousScriptPolicy = $env:PSExecutionPolicyPreference
    try {
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        Remove-Item Env:MMD_DESK_USER_DATA -ErrorAction SilentlyContinue
        Remove-Item Env:PSExecutionPolicyPreference -ErrorAction SilentlyContinue
        $windowStyle = if ($Quiet) { 'Hidden' } else { 'Normal' }
        $launchArguments = @($Arguments)
        $launchArguments += "--soft-hearts-channel=$script:Channel"
        if ($script:normalProfile) { $launchArguments += ('"--user-data-dir=' + $script:normalProfile + '"') }
        return Start-Process -FilePath $Executable -ArgumentList $launchArguments -WorkingDirectory (Split-Path -Parent $Executable) -WindowStyle $windowStyle -PassThru
    } finally { $env:ELECTRON_RUN_AS_NODE = $previousNodeMode; $env:MMD_DESK_USER_DATA = $previousProfile; $env:PSExecutionPolicyPreference = $previousScriptPolicy }
}
function Request-Exit($Original) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($Original.ProcessId)" -ErrorAction SilentlyContinue
    if (-not $current -or -not (Same-Path $current.ExecutablePath $Original.ExecutablePath) -or $current.CreationDate -ne $Original.CreationDate -or -not (Is-OwnedMain $current)) { return }
    Start-Scoped $Original.ExecutablePath @("--soft-hearts-desktop=$script:ownerId", "--soft-hearts-stop=$script:ownerId") -Quiet | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $remaining = Get-CimInstance Win32_Process -Filter "ProcessId = $($Original.ProcessId)" -ErrorAction SilentlyContinue
        if (-not $remaining -or $remaining.CreationDate -ne $Original.CreationDate) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The previous app did not exit gracefully. Quit soft hearts next from its tray menu, then retry. No main process was force-stopped.'
}
function Stop-Matching($Original) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($Original.ProcessId)" -ErrorAction SilentlyContinue
    if ($current -and (Same-Path $current.ExecutablePath $Original.ExecutablePath) -and $current.CreationDate -eq $Original.CreationDate) {
        Stop-Process -Id $current.ProcessId -ErrorAction Stop
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            $remaining = Get-CimInstance Win32_Process -Filter "ProcessId = $($Original.ProcessId)" -ErrorAction SilentlyContinue
            if (-not $remaining -or $remaining.CreationDate -ne $Original.CreationDate) { return }
            Start-Sleep -Milliseconds 100
        }
        throw 'The previous owned app has not exited; the installed files were not changed.'
    }
}

# Optional machine-local binding installed by setup/Codex, never a renderer command.
# Check/stop and the immutable delivery path must not probe or start services.
function Test-BoundAsrReady([Uri]$Endpoint, [string]$Service) {
    try {
        $health = Invoke-RestMethod -Uri ($Endpoint.GetLeftPart([UriPartial]::Authority) + '/health') -Method Get -TimeoutSec 2 -MaximumRedirection 0
        $ready = Read-Property $health 'ready'
        return ($ready -is [bool]) -and $ready -and [string]::Equals([string](Read-Property $health 'service'), $Service, [StringComparison]::Ordinal)
    } catch { return $false }
}
function Restore-BoundAsr {
    if (-not $script:normalProfile) { return }
    $bindingFile = Join-Path $script:releasePrefix 'desktop-asr.json'
    if (-not (Test-Path -LiteralPath $bindingFile -PathType Leaf)) { return }
    try {
        if ((Get-Item -LiteralPath $bindingFile).Length -gt 16384) { throw 'Invalid ASR binding.' }
        $binding = Get-Content -LiteralPath $bindingFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $keys = @('version', 'baseUrl', 'model', 'healthService', 'startScript', 'sha256')
        $version = Read-Property $binding 'version'
        if (-not ($binding -is [pscustomobject]) -or @($binding.PSObject.Properties.Name | Where-Object { $keys -notcontains $_ }).Count -or
            ($version -isnot [int] -and $version -isnot [long]) -or $version -ne 1) { throw 'Invalid ASR binding.' }
        $baseUrl = Read-Property $binding 'baseUrl'
        $model = Read-Property $binding 'model'
        $service = Read-Property $binding 'healthService'
        $startScript = Read-Property $binding 'startScript'
        $scriptHash = Read-Property $binding 'sha256'
        if (-not ($baseUrl -is [string]) -or $baseUrl.Length -gt 2000 -or $baseUrl -match '[\x00-\x1f\x7f]' -or
            -not ($model -is [string]) -or -not $model.Trim() -or $model.Length -gt 200 -or $model -match '[\x00-\x1f\x7f]' -or
            -not ($service -is [string]) -or $service -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$' -or
            -not ($scriptHash -is [string]) -or $scriptHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid ASR binding.' }
        $endpoint = [Uri]$baseUrl
        $address = $null
        $loopback = [string]::Equals($endpoint.DnsSafeHost, 'localhost', [StringComparison]::OrdinalIgnoreCase) -or
            ([Net.IPAddress]::TryParse($endpoint.DnsSafeHost, [ref]$address) -and [Net.IPAddress]::IsLoopback($address))
        if (-not $endpoint.IsAbsoluteUri -or $endpoint.Scheme -ne 'http' -or -not $loopback -or $endpoint.UserInfo -or $endpoint.Query -or $endpoint.Fragment) { throw 'Invalid ASR binding.' }
        if (-not ($startScript -is [string]) -or $startScript.Length -gt 32768 -or $startScript -notmatch '^[A-Za-z]:[\\/]' -or
            $startScript -match '[\x00-\x1f\x7f"]' -or $startScript.IndexOf(':', 2) -ge 0 -or
            [IO.Path]::GetExtension($startScript) -ne '.ps1') { throw 'Invalid ASR manager.' }
        $startScript = Full-Path $startScript
        $managerFile = Get-Item -LiteralPath $startScript
        if ($managerFile.PSIsContainer -or $managerFile.Length -gt 1048576 -or -not (Same-Path (Get-FileHash -LiteralPath $startScript -Algorithm SHA256).Hash $scriptHash)) { throw 'Invalid ASR manager.' }
        $settingsFile = Join-Path $script:normalProfile 'settings.json'
        if (-not (Test-Path -LiteralPath $settingsFile -PathType Leaf)) { return }
        if ((Get-Item -LiteralPath $settingsFile).Length -gt 1048576) { throw 'Invalid ASR profile.' }
        $voiceConfig = Read-Property (Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json) 'voiceInput'
        $currentBase = Read-Property $voiceConfig 'baseUrl'
        if (-not ($currentBase -is [string]) -or -not [string]::Equals($currentBase.TrimEnd('/'), $baseUrl.TrimEnd('/'), [StringComparison]::Ordinal) -or
            -not [string]::Equals([string](Read-Property $voiceConfig 'model'), $model, [StringComparison]::Ordinal)) { return }
        if (Test-BoundAsrReady $endpoint $service) { return }
        # A source hash is not permission to override policy in a child manager.
        $managerSource = [IO.File]::ReadAllText($startScript, [Text.Encoding]::UTF8)
        if ($managerSource -match '(?i)(?:-\s*(?:ExecutionPolicy|EP)\b|Set-ExecutionPolicy|PSExecutionPolicyPreference)') {
            throw 'The bound speech manager needs an ordinary-policy review.'
        }
        $powershell = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $previousModulePath = $env:PSModulePath
        $previousScriptPolicy = $env:PSExecutionPolicyPreference
        $manager = $null
        try {
            Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue
            Remove-Item Env:PSExecutionPolicyPreference -ErrorAction SilentlyContinue
            # This waits only for the reviewed manager. Its durable ASR launch is
            # manager-owned; this wrapper never fabricates process detachment.
            $manager = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-NonInteractive', '-File', ('"' + $startScript + '"')) -WorkingDirectory (Split-Path -Parent $startScript) -WindowStyle Hidden -PassThru
            if (-not $manager.WaitForExit(120000)) {
                # Kill only our own timed-out wrapper, never its ASR process tree.
                try { $manager.Kill(); $manager.WaitForExit(1000) | Out-Null } catch { }
                throw 'ASR manager timed out.'
            }
            if ($manager.ExitCode -ne 0) { throw 'ASR manager failed.' }
        } finally {
            if ($manager) { $manager.Dispose() }
            $env:PSModulePath = $previousModulePath
            $env:PSExecutionPolicyPreference = $previousScriptPolicy
        }
        if (-not (Test-BoundAsrReady $endpoint $service)) { throw 'ASR manager did not become ready.' }
    } catch {
        Write-Warning 'soft hearts next: the bound local speech service could not be checked or restored. Text chat is still available; ask Codex to verify the local voice setup.'
    }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Use this launcher on Windows.' }
    if ($Delivered) {
        if ($PSBoundParameters.ContainsKey('Channel') -and $Channel -ne 'stable') { throw 'Delivered and Channel conflict.' }
        $Channel = 'stable'
    }
    if ($Channel -eq 'stable' -and -not $WorkspaceRoot) { throw 'The stable launcher requires the project workspace root.' }
    if (-not $WorkspaceRoot) { $WorkspaceRoot = Split-Path -Parent $PSScriptRoot }
    $projectRoot = Full-Path $WorkspaceRoot
    $releasePrefix = (Join-Path $projectRoot 'release').TrimEnd('\') + '\'
    $normalProfile = ''
    $profileName = if ($Channel -eq 'stable') { 'desktop-profile.json' } else { 'desktop-development-profile.json' }
    $profileFile = Join-Path $releasePrefix $profileName
    if ($Channel -eq 'development' -and -not (Test-Path -LiteralPath $profileFile -PathType Leaf)) { throw 'The development profile reference is missing. No normal profile was used.' }
    if (Test-Path -LiteralPath $profileFile -PathType Leaf) {
        if ((Get-Item -LiteralPath $profileFile).Length -gt 16384) { throw 'The desktop profile reference is too large.' }
        $profileReference = Get-Content -LiteralPath $profileFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $profileDirectory = Read-Property $profileReference 'directory'
        if ((Read-Property $profileReference 'version') -ne 1 -or -not ($profileDirectory -is [string]) -or
            $profileDirectory.IndexOfAny([char[]]"`0`r`n`"") -ge 0 -or $profileDirectory -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)' -or
            -not (Test-Path -LiteralPath $profileDirectory -PathType Container)) { throw 'The shared desktop profile reference is invalid. No profile was changed.' }
        $normalProfile = Full-Path $profileDirectory
    }
    if ($Channel -eq 'development') {
        $stableProfileFile = Join-Path $releasePrefix 'desktop-profile.json'
        $stableProfile = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'soft-hearts-claude')).TrimEnd('\')
        if (Test-Path -LiteralPath $stableProfileFile -PathType Leaf) {
            if ((Get-Item -LiteralPath $stableProfileFile).Length -gt 16384) { throw 'The stable profile reference is too large.' }
            $stableReference = Get-Content -LiteralPath $stableProfileFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $stableDirectory = Read-Property $stableReference 'directory'
            if ((Read-Property $stableReference 'version') -ne 1 -or -not ($stableDirectory -is [string]) -or
                $stableDirectory.IndexOfAny([char[]]"`0`r`n`"") -ge 0 -or $stableDirectory -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)' -or
                -not (Test-Path -LiteralPath $stableDirectory -PathType Container)) { throw 'The stable profile reference is invalid. No profile was changed.' }
            $stableProfile = Full-Path $stableDirectory
        }
        if ((Same-Path $normalProfile $stableProfile) -or $normalProfile.StartsWith($stableProfile + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $stableProfile.StartsWith($normalProfile + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The development and stable profiles must be separate.' }
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $profileIdentity = if ($normalProfile) { $normalProfile.ToLowerInvariant() } else { '<default-profile>' }
        $identity = $projectRoot.ToLowerInvariant() + "`n" + $Channel + "`n" + $profileIdentity
        $ownerId = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity)))).Replace('-', '').Substring(0, 24)
    }
    finally { $sha.Dispose() }
    $manifestFile = if ($Channel -eq 'stable') { Join-Path (Split-Path -Parent $PSScriptRoot) 'stable-manifest.json' } else { Join-Path $releasePrefix 'desktop-current.json' }
    $expectedHash = $null
    $installedUtc = $null
    if (Test-Path -LiteralPath $manifestFile -PathType Leaf) {
        if ((Get-Item -LiteralPath $manifestFile).Length -gt 16384) { throw 'The installed build manifest is too large.' }
        $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $relative = Read-Property $manifest 'executable'
        $expectedHash = Read-Property $manifest 'asarSha256'
        if ($Channel -eq 'stable' -and ((Read-Property $manifest 'version') -ne 1 -or -not $expectedHash)) { throw 'The complete delivery reference is invalid.' }
        if (-not ($expectedHash -is [string]) -or $expectedHash -notmatch '^[0-9a-fA-F]{64}$') { throw 'The installed build checksum is invalid.' }
        $installedText = Read-Property $manifest 'installedAt'
        if ($installedText) {
            # PowerShell 7 decodes ISO JSON dates into DateTime objects. Casting
            # those to text would discard their zone and shift the build time.
            if ($installedText -is [DateTimeOffset]) { $installedUtc = $installedText.UtcDateTime }
            elseif ($installedText -is [DateTime]) { $installedUtc = $installedText.ToUniversalTime() }
            else {
                $installedTime = [DateTimeOffset]::MinValue
                if (-not [DateTimeOffset]::TryParse([string]$installedText, [ref]$installedTime)) { throw 'The installed build date is invalid.' }
                $installedUtc = $installedTime.UtcDateTime
            }
        }
        if (-not ($relative -is [string]) -or [IO.Path]::IsPathRooted($relative)) { throw 'The installed executable must be relative to this source folder.' }
        $executable = Full-Path (Join-Path $projectRoot $relative)
        if (-not (Is-AppPath $executable)) { throw 'The installed executable must be soft hearts next.exe inside this project release folder.' }
        if ($Channel -eq 'development' -and $relative.Replace('\', '/') -notmatch '^release/development/[a-fA-F0-9]{64}/win-(x64|arm64)-unpacked/soft hearts next\.exe$') {
            throw 'The development executable must belong to an isolated development version.'
        }
        if ($Channel -eq 'stable') {
            $stableRelative = $relative.Replace('\', '/')
            if ($stableRelative -notmatch '^release/stable/[a-fA-F0-9]{64}/win-(x64|arm64)-unpacked/soft hearts next\.exe$') { throw 'The stable executable must belong to an immutable stable version.' }
            $stableLauncher = Read-Property $manifest 'launcher'
            $launcherHash = Read-Property $manifest 'launcherSha256'
            $exeHash = Read-Property $manifest 'exeSha256'
            $stableBuildId = Read-Property $manifest 'buildId'
            $platform = Read-Property $manifest 'platform'
            $arch = Read-Property $manifest 'arch'
            if (-not ($stableLauncher -is [string]) -or [IO.Path]::IsPathRooted($stableLauncher) -or
                -not ($launcherHash -is [string]) -or $launcherHash -notmatch '^[a-fA-F0-9]{64}$' -or
                -not ($exeHash -is [string]) -or $exeHash -notmatch '^[a-fA-F0-9]{64}$' -or
                -not ($stableBuildId -is [string]) -or $stableBuildId -notmatch '^[a-fA-F0-9]{64}$' -or
                $platform -ne 'win32' -or $arch -notin @('x64', 'arm64') -or
                $stableRelative -notmatch ('/win-' + $arch + '-unpacked/soft hearts next\.exe$')) { throw 'The stable delivery identity is invalid.' }
            $pinnedLauncher = Full-Path (Join-Path $projectRoot $stableLauncher)
            if (-not (Same-Path (Split-Path -Parent $pinnedLauncher) (Split-Path -Parent $executable)) -or
                -not (Same-Path $pinnedLauncher (Full-Path $PSCommandPath)) -or
                [IO.Path]::GetFileName($pinnedLauncher) -ne 'start-latest.ps1' -or
                -not (Same-Path (Get-FileHash -LiteralPath $pinnedLauncher -Algorithm SHA256).Hash $launcherHash) -or
                -not (Same-Path (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash $exeHash)) { throw 'The stable delivery does not match its immutable identity.' }
        }
        if ($expectedHash -and $expectedHash -notmatch '^[0-9a-fA-F]{64}$') { throw 'The installed build checksum is invalid.' }
    } else {
        if ($Channel -eq 'stable') { throw 'No complete delivery is pinned. Ask Codex to pin a fully verified delivery first.' }
        throw 'No validated development build reference exists. Ask Codex to complete deployment.'
    }
    $buildHash = $null
    $modifiedUtc = $null
    try {
        $asar = Get-Item -LiteralPath (Join-Path (Split-Path -Parent $executable) 'resources\app.asar')
        $modifiedUtc = $asar.LastWriteTimeUtc
        $buildHash = (Get-FileHash -LiteralPath $asar.FullName -Algorithm SHA256).Hash
    } catch {
        if (-not $StopOnly) { throw 'The installed app.asar is missing or unreadable. Ask Codex to complete deployment.' }
    }
    if (-not $StopOnly -and $expectedHash -and -not (Same-Path $expectedHash $buildHash)) { throw 'The installed build does not match its validated checksum. Ask Codex to complete deployment.' }
    # The process build marker retains the established ASAR SHA-256 meaning.
    # stableBuildId records source provenance separately; the version directory
    # is a composite identity and is never used as the process build marker.
    $runningBuildId = $buildHash
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'soft hearts next.exe'")
    $owned = @($processes | Where-Object { Is-OwnedMain $_ })
    $stale = @($owned | Where-Object {
        -not (Same-Path $_.ExecutablePath $executable) -or ($runningBuildId -and $_.CommandLine -notmatch ('(?:^|\s)--soft-hearts-build=' + $runningBuildId + '(?=\s|$)')) -or
        ($installedUtc -and $_.CreationDate.ToUniversalTime() -lt $installedUtc) -or ($modifiedUtc -and $_.CreationDate.ToUniversalTime() -lt $modifiedUtc)
    })
    $unmarked = @($processes | Where-Object {
        $profile = Profile-Argument $_.CommandLine
        (Is-AppPath $_.ExecutablePath) -and $_.CommandLine -notmatch '(?:^|\s)"?--type(?:=|\s)' -and
        ((Uses-NormalProfile $_) -or -not $_.CommandLine -or -not $profile.Valid -or ($Channel -eq 'stable' -and -not $profile.Present)) -and -not (Is-OwnedMain $_)
    })
    $runningEntries = @(@($owned) + @($unmarked) | ForEach-Object {
        $marker = [regex]::Match([string]$_.CommandLine, '(?:^|\s)--soft-hearts-build=([a-fA-F0-9]{64})(?=\s|$)')
        [pscustomobject]@{ ProcessId=$_.ProcessId; Executable=$_.ExecutablePath; BuildSha256=$(if ($marker.Success) { $marker.Groups[1].Value } else { $null }) }
    })
    $report = [pscustomobject]@{ Channel = $Channel; ProfileDirectory = $normalProfile; Executable = $executable; AsarSha256 = $buildHash; BuildId = $(if ($Channel -eq 'stable') { $stableBuildId } else { $null }); ModifiedUtc = $modifiedUtc; InstalledUtc = $installedUtc; OwnedPids = @($owned | ForEach-Object { $_.ProcessId }); StalePids = @($stale | ForEach-Object { $_.ProcessId }); UnmarkedTargetPids = @($unmarked | ForEach-Object { $_.ProcessId }); RunningEntries = $runningEntries; Restart = [bool]$Restart; StopOnly = [bool]$StopOnly }
    if ($CheckOnly) { $report; return }
    if (($unmarked.Count -or ($Channel -eq 'stable' -and $stale.Count)) -and -not $StopOnly) {
        $report
        $runningSummary = @($runningEntries | ForEach-Object { "PID $($_.ProcessId): $($_.Executable), build $($_.BuildSha256)" }) -join '; '
        throw "An existing app may use this profile. Target: $executable, build $runningBuildId. Running: $runningSummary. Quit it normally before starting the target version; no existing process was stopped."
    }
    if (-not $StopOnly -and -not $Restart -and $owned.Count -and -not $stale.Count) {
        # Electron's existing main receives second-instance and shows controls.
        # This normal sender may exit immediately; it is not a replacement main.
        Start-Scoped $executable @("--soft-hearts-desktop=$ownerId", "--soft-hearts-build=$runningBuildId") | Out-Null
        Write-Output "Requested current soft hearts next controls (PID $($owned[0].ProcessId))."
        return
    }
    foreach ($main in $owned) {
        # Only this launcher's exact executable/PID/start-time match is eligible.
        if (-not (Is-OwnedMain $main)) { continue }
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($main.ProcessId)" | Where-Object { (Same-Path $_.ExecutablePath $main.ExecutablePath) -and $_.CommandLine -match '(?:^|\s)--type=' })
        Request-Exit $main
        foreach ($child in $children) { Stop-Matching $child }
    }
    if ($StopOnly) { Write-Output "Stopped only this desktop launcher's owned app processes."; return }
    $started = Start-Scoped $executable @("--soft-hearts-desktop=$ownerId", "--soft-hearts-build=$runningBuildId")
    Start-Sleep -Milliseconds 900
    if ($started.HasExited) { throw 'The app did not stay open. Quit any older soft hearts next instance started outside this shortcut, then try again.' }
    Write-Output "Started validated soft hearts next (PID $($started.Id))."
} catch {
    $message = "soft hearts next: $($_.Exception.Message)"
    [Console]::Error.WriteLine($message)
    if (-not $CheckOnly) { try { (New-Object -ComObject WScript.Shell).Popup($message, 15, 'soft hearts next', 16) | Out-Null } catch {} }
    exit 1
}
