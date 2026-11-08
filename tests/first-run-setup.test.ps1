# Isolated, synthetic filesystem checks. No real Claude Code, network, installer or app.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$setup = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts/setup.ps1'))
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($setup, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$finder = $ast.Find({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Find-ClaudeExecutable'
}, $true)
if (-not $finder) { throw 'Claude Code discovery function is missing' }
. ([scriptblock]::Create($finder.Extent.Text))

$owned = Join-Path $PSScriptRoot ('synthetic-' + [guid]::NewGuid().ToString('N'))
$original = @{}
foreach ($key in @('CLAUDE_PATH', 'PATH', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)')) {
    $original[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
function Check($condition, $message) { if (-not $condition) { throw $message } }
try {
    $pathBin = Join-Path $owned 'path-bin'
    $userHome = Join-Path $owned 'home'
    $nativeBin = Join-Path $userHome '.local/bin'
    $local = Join-Path $owned 'local'
    $wingetLinks = Join-Path $local 'Microsoft/WinGet/Links'
    foreach ($directory in @($pathBin, $nativeBin, $wingetLinks)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $pathExe = Join-Path $pathBin 'claude.exe'
    $nativeExe = Join-Path $nativeBin 'claude.exe'
    $wingetExe = Join-Path $wingetLinks 'claude.exe'
    foreach ($file in @($pathExe, $nativeExe, $wingetExe)) { [IO.File]::WriteAllText($file, 'synthetic') }
    [Environment]::SetEnvironmentVariable('PATH', $pathBin, 'Process')
    [Environment]::SetEnvironmentVariable('USERPROFILE', $userHome, 'Process')
    [Environment]::SetEnvironmentVariable('LOCALAPPDATA', $local, 'Process')
    [Environment]::SetEnvironmentVariable('APPDATA', (Join-Path $owned 'roaming'), 'Process')

    [Environment]::SetEnvironmentVariable('CLAUDE_PATH', (Join-Path $owned 'missing.exe'), 'Process')
    Check ((Find-ClaudeExecutable).Status -eq 'invalid-override') 'Missing explicit override must never fall back.'
    [Environment]::SetEnvironmentVariable('CLAUDE_PATH', $wingetExe, 'Process')
    Check ((Find-ClaudeExecutable).Path -eq $wingetExe) 'Valid explicit override must win.'
    [Environment]::SetEnvironmentVariable('CLAUDE_PATH', $null, 'Process')
    Check ((Find-ClaudeExecutable).Path -eq $pathExe) 'PATH executable must precede install-location fallbacks.'
    [Environment]::SetEnvironmentVariable('PATH', (Join-Path $owned 'empty'), 'Process')
    Check ((Find-ClaudeExecutable).Path -eq $nativeExe) 'The native installer location comes first among fallbacks.'
    Remove-Item -LiteralPath $nativeExe
    Check ((Find-ClaudeExecutable).Path -eq $wingetExe) 'The WinGet link is the next fallback.'
    [Environment]::SetEnvironmentVariable('LOCALAPPDATA', (Join-Path $owned 'empty-local'), 'Process')
    Check ((Find-ClaudeExecutable).Status -eq 'missing') 'Missing executable must be reported.'
    [Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
    Check ((Find-ClaudeExecutable).Status -eq 'missing') 'An absent PATH must not prevent a missing result.'

    # Run the real check-only entry against a disposable project and an empty
    # synthetic environment. The script must report missing Node without
    # downloading, building, launching, or invoking a Claude Code executable.
    $project = Join-Path $owned 'project'
    $scripts = Join-Path $project 'scripts'
    New-Item -ItemType Directory -Path $scripts -Force | Out-Null
    Copy-Item -LiteralPath $setup -Destination (Join-Path $scripts 'setup.ps1')
    [IO.File]::WriteAllText((Join-Path $project 'package.json'), '{"name":"soft-hearts-next","packageManager":"pnpm@11.25.0"}')
    [IO.File]::WriteAllText((Join-Path $project 'pnpm-lock.yaml'), 'lockfileVersion: 9.0')
    [Environment]::SetEnvironmentVariable('ProgramFiles', (Join-Path $owned 'empty-programs'), 'Process')
    [Environment]::SetEnvironmentVariable('ProgramFiles(x86)', (Join-Path $owned 'empty-programs-x86'), 'Process')
    $shell = (Get-Process -Id $PID).Path
    $output = & $shell -NoProfile -File (Join-Path $scripts 'setup.ps1') -CheckOnly 2>&1
    Check ($LASTEXITCODE -eq 0) "CheckOnly should report a missing Node rather than fail: $output"
    Check (($output | Out-String) -match 'Node.js 22.12\+.*missing') 'Missing Node must be reported.'
    Check (-not (Test-Path -LiteralPath (Join-Path $project '.local'))) 'CheckOnly must not create a runtime.'
    Check (-not (Test-Path -LiteralPath (Join-Path $project 'node_modules'))) 'CheckOnly must not install dependencies.'
    Check (($output | Out-String) -match 'Claude Code was not found') 'A missing Claude Code must be reported.'
    Write-Host 'PASS: Claude Code discovery and missing-Node CheckOnly use synthetic paths only.'
} finally {
    foreach ($key in $original.Keys) { [Environment]::SetEnvironmentVariable($key, $original[$key], 'Process') }
    if (Test-Path -LiteralPath $owned) {
        $resolved = (Resolve-Path -LiteralPath $owned).Path
        $allowedParent = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $resolved.StartsWith($allowedParent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Synthetic path escaped the owned test directory.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
