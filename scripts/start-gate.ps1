# Decisions for start-soft-hearts.cmd that must run BEFORE any project script is allowed to run.
# The cmd does not start this file with -File (a file carrying the "downloaded from the internet" mark is refused
# under RemoteSigned); it reads the text and runs it as a script block, so this file is never itself blocked.
#   check    exit 0: nothing here carries the internet mark. exit 10: some script does (the names are printed).
#   unblock  remove the mark from files under the project folder only. exit 0 ok, 1 failed.
#   channel  exit 0: a development desktop channel already exists on this machine (release\desktop-current.json).
#            exit 1: none, so a first start only installs, builds and starts.
# The project folder comes from the SH_ROOT environment variable (the cmd's own folder). Nothing outside it is read
# or changed, and no execution policy is changed. ASCII only; Chinese text is written as \u escapes.
param([string]$Mode, [string]$Root = $env:SH_ROOT)
$ErrorActionPreference = 'Stop'
if (-not $Root) { Write-Host 'No project folder given.'; exit 1 }
$Root = [IO.Path]::GetFullPath($Root)
$skipped = '\node_modules\', '\.git\', '\.local\', '\release\'
function Get-ProjectFiles([string[]]$Extensions) {
    Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
        $path = $_.FullName.Substring($Root.Length - 1)
        if ($Extensions -and ($Extensions -notcontains $_.Extension.ToLowerInvariant())) { return $false }
        foreach ($part in $skipped) { if ($path.Contains($part)) { return $false } }
        return $true
    }
}
function Test-Marked([string]$File) {
    try { return [bool](Get-Item -LiteralPath $File -Stream 'Zone.Identifier' -ErrorAction Stop) } catch { return $false }
}
switch ($Mode) {
    'check' {
        $marked = @(Get-ProjectFiles @('.ps1', '.mjs', '.cmd') | Where-Object { Test-Marked $_.FullName })
        if ($marked.Count -eq 0) { exit 0 }
        Write-Host ''
        Write-Host 'Windows marked these soft hearts files as "downloaded from the internet" (this happens when a zip'
        Write-Host 'downloaded in a browser is unpacked). Windows refuses to run such scripts, so setup cannot start yet:'
        $marked | Select-Object -First 5 | ForEach-Object { Write-Host ('  ' + $_.FullName.Substring($Root.Length)) }
        if ($marked.Count -gt 5) { Write-Host ('  ... and ' + ($marked.Count - 5) + ' more') }
        Write-Host ''
        Write-Host ([regex]::Unescape('Windows \u628a\u8fd9\u4e2a\u6587\u4ef6\u5939\u91cc\u7684\u811a\u672c\u6807\u8bb0\u6210\u4e86\u201c\u4ece\u7f51\u4e0a\u4e0b\u8f7d\u201d\uff08\u6d4f\u89c8\u5668\u4e0b\u8f7d\u7684\u538b\u7f29\u5305\u89e3\u538b\u540e\u90fd\u4f1a\u8fd9\u6837\uff09\uff0c\u6240\u4ee5\u5148\u88ab\u62e6\u4e0b\u4e86\u3002'))
        Write-Host ([regex]::Unescape('\u8981\u4e0d\u8981\u53ea\u7ed9\u8fd9\u4e2a\u6587\u4ef6\u5939\u91cc\u7684 soft hearts \u6587\u4ef6\u53bb\u6389\u8fd9\u4e2a\u6807\u8bb0\uff1f\u4e0d\u4f1a\u6539\u52a8\u6587\u4ef6\u5939\u4ee5\u5916\u7684\u4efb\u4f55\u4e1c\u897f\uff0c\u4e5f\u4e0d\u4f1a\u6539\u7cfb\u7edf\u8bbe\u7f6e\u3002'))
        Write-Host ''
        Write-Host 'Remove the mark only from the files in this folder? Nothing outside this folder and no system setting is changed.'
        exit 10
    }
    'unblock' {
        try {
            # Only files under the project folder; just the Zone.Identifier stream is removed.
            Get-ProjectFiles $null | Where-Object { Test-Marked $_.FullName } | Unblock-File
            exit 0
        } catch { Write-Host ('Could not remove the mark: ' + $_.Exception.Message); exit 1 }
    }
    'channel' {
        if (Test-Path -LiteralPath (Join-Path $Root 'release\desktop-current.json') -PathType Leaf) { exit 0 }
        exit 1
    }
    default { Write-Host 'Unknown mode.'; exit 1 }
}
