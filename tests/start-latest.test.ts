import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const launcher = fileURLToPath(new URL("../scripts/start-latest.ps1", import.meta.url));
const refresher = fileURLToPath(new URL("../scripts/refresh-desktop-shortcuts.ps1", import.meta.url));
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const windows = process.platform === "win32";

async function fixture(scenario: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "soft-hearts-launcher-"));
  const root = path.join(directory, "project space 中文 & literal");
  const version = "a".repeat(64);
  const installed = path.join(root, "release", "development", version, "win-arm64-unpacked");
  await mkdir(path.join(installed, "resources"), { recursive: true });
  await writeFile(path.join(installed, "soft hearts next.exe"), "fake executable: never run");
  await writeFile(path.join(installed, "resources", "app.asar"), "validated fixture");
  const harness = path.join(directory, "harness.ps1");
  await writeFile(harness, "\ufeff" + String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$root = ${quote(root)}
$version = 'a' * 64
$devProfile = Join-Path $root 'profile space 中文'
$stableProfile = Join-Path $root 'stable profile'
New-Item -ItemType Directory -Path $devProfile,$stableProfile -Force | Out-Null
@{version=1;directory=$devProfile}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'release\desktop-development-profile.json') -Encoding UTF8
@{version=1;directory=$stableProfile}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'release\desktop-profile.json') -Encoding UTF8
$exe = Join-Path $root ('release\development\' + $version + '\win-arm64-unpacked\soft hearts next.exe')
$asar = Get-Item -LiteralPath (Join-Path (Split-Path $exe) 'resources\app.asar')
$hash = (Get-FileHash -LiteralPath $asar.FullName -Algorithm SHA256).Hash
$sha = [Security.Cryptography.SHA256]::Create()
try { $owner = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()+[char]10+'development'+[char]10+$devProfile.ToLowerInvariant())))).Replace('-', '').Substring(0,24) } finally { $sha.Dispose() }
@{version=1;executable=('release/development/' + $version + '/win-arm64-unpacked/soft hearts next.exe');asarSha256=$hash;buildId=('b'*64)}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'release\desktop-current.json') -Encoding UTF8
$global:fakeProcesses = @()
$global:stopped = @()
$global:graceful = @()
$global:started = @()
$global:failGraceful = $false
$global:showSenderExits = $false
$global:asrReady = $false
$global:asrBecomesReady = $true
$global:asrManagerFails = $false
$global:asrManagerTimesOut = $false
$global:asrHealthCalls = 0
$global:asrWaits = @()
$global:asrKills = 0
$global:asrWarnings = @()
function Invoke-RestMethod {
  [CmdletBinding()]param([string]$Uri, [string]$Method, [int]$TimeoutSec, [int]$MaximumRedirection)
  if ($Uri -ne 'http://127.0.0.1:19942/health') { throw 'Unexpected fixture health endpoint' }
  $global:asrHealthCalls++
  return [pscustomobject]@{ service='fixture-offline-asr'; ready=[bool]$global:asrReady }
}
function Write-Warning { [CmdletBinding()]param([string]$Message); $global:asrWarnings += $Message }
function Add-AsrBinding {
  $profile = $stableProfile
  New-Item -ItemType Directory -Path $profile -Force | Out-Null
  @{version=1;directory=$profile}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'release\desktop-profile.json') -Encoding UTF8
  @{voiceInput=@{baseUrl='http://127.0.0.1:19942/v1';model='fixture-asr';apiKey='fixture-secret'}}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $profile 'settings.json') -Encoding UTF8
  $manager = Join-Path $root 'never execute manager space & 中文.ps1'
  Set-Content -LiteralPath $manager 'throw "This fixture manager must never be executed."' -Encoding UTF8
  $binding = @{version=1;baseUrl='http://127.0.0.1:19942/v1';model='fixture-asr';healthService='fixture-offline-asr';startScript=$manager;sha256=(Get-FileHash -LiteralPath $manager -Algorithm SHA256).Hash}
  $binding|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'release\desktop-asr.json') -Encoding UTF8
  return [pscustomobject]@{Profile=$profile;Manager=$manager;Binding=$binding}
}
function Fake([int]$Number, [string]$Command, [string]$Executable = $exe, [int]$Parent = 0) {
  [pscustomobject]@{ ProcessId = $Number; ExecutablePath = $Executable; CommandLine = $Command; CreationDate = $asar.LastWriteTimeUtc.AddMinutes(5); ParentProcessId = $Parent }
}
function Get-CimInstance {
  [CmdletBinding()]param([string]$ClassName, [string]$Filter)
  if ($Filter -match '^ParentProcessId = (\d+)$') { return @($global:fakeProcesses | Where-Object { $_.ParentProcessId -eq [int]$Matches[1] }) }
  if ($Filter -match '^ProcessId = (\d+)$') { return @($global:fakeProcesses | Where-Object { $_.ProcessId -eq [int]$Matches[1] }) }
  return $global:fakeProcesses
}
function Stop-Process {
  [CmdletBinding()]param([int]$Id)
  $global:stopped += $Id
  $global:fakeProcesses = @($global:fakeProcesses | Where-Object { $_.ProcessId -ne $Id })
}
function Start-Process {
  [CmdletBinding()]param([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory, [string]$WindowStyle, [switch]$PassThru)
  $global:started += [pscustomobject]@{ FilePath=$FilePath; Arguments=$ArgumentList; Directory=$WorkingDirectory; WindowStyle=$WindowStyle; NodeMode=$env:ELECTRON_RUN_AS_NODE; Profile=$env:MMD_DESK_USER_DATA; ScriptPolicy=$env:PSExecutionPolicyPreference }
  if ([IO.Path]::GetFileName($FilePath) -eq 'powershell.exe') {
    $wrapper = [pscustomobject]@{ExitCode=$(if($global:asrManagerFails){1}else{0})}
    $wrapper|Add-Member ScriptMethod WaitForExit {
      param([int]$Milliseconds)
      $global:asrWaits += $Milliseconds
      if($Milliseconds -eq 120000 -and $global:asrManagerTimesOut){return $false}
      if($Milliseconds -eq 120000){$global:asrReady=$global:asrBecomesReady}
      return $true
    }
    $wrapper|Add-Member ScriptMethod Kill {$global:asrKills++}
    $wrapper|Add-Member ScriptMethod Dispose {}
    return $wrapper
  }
  if ($ArgumentList -contains ('--soft-hearts-stop=' + $owner)) {
    if ($global:failGraceful) { throw 'The isolated executable cannot send a graceful request.' }
    $requestedProfiles = @($ArgumentList | Where-Object { $_.Trim('"').StartsWith('--user-data-dir=') })
    $requestedProfile = if ($requestedProfiles.Count) { $requestedProfiles[0].Trim('"').Substring('--user-data-dir='.Length) } else { '' }
    $exiting = @($global:fakeProcesses | Where-Object {
      $sameProfile = if ($requestedProfile) { $_.CommandLine.Contains('"--user-data-dir=' + $requestedProfile + '"') } else { $_.CommandLine -notmatch '--user-data-dir=' }
      $_.ExecutablePath -eq $FilePath -and $_.CommandLine -match ('--soft-hearts-desktop=' + $owner) -and $_.CommandLine -notmatch '--type=' -and $sameProfile
    } | Select-Object -First 1)
    $global:graceful += @($exiting | ForEach-Object { $_.ProcessId })
    $global:fakeProcesses = @($global:fakeProcesses | Where-Object { $global:graceful -notcontains $_.ProcessId })
  }
  return [pscustomobject]@{ Id=9000; HasExited=[bool]$global:showSenderExits }
}
function Start-Sleep { [CmdletBinding()]param([int]$Milliseconds) }
$marker = '--soft-hearts-desktop=' + $owner + ' --soft-hearts-build=' + $hash + ' "--user-data-dir=' + $devProfile + '"'
${scenario}
`, "utf8");
  try {
    const { stdout, stderr } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", harness], { encoding: "utf8", timeout: 60000, windowsHide: true, env: { ...process.env, PSModulePath: undefined } });
    assert.doesNotMatch(stdout + stderr, /SHOULD_NOT_LEAK_FIXTURE_JSON/, 'public launcher diagnostics must never include a rejected settings body');
    const result = stdout.split(/\r?\n/).find(line => line.startsWith("RESULT:"));
    assert.ok(result, stdout); return JSON.parse(result.slice(7));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('soft-hearts-launcher-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test("desktop launcher CheckOnly detects stale owned builds without touching profiles or processes", { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$global:fakeProcesses = @(
  (Fake 101 $marker),
  (Fake 102 ('--soft-hearts-desktop=' + $owner + ' --soft-hearts-build=' + ('0' * 64) + ' "--user-data-dir=' + $devProfile + '"')),
  (Fake 103 ('--soft-hearts-desktop=' + $owner + ' --soft-hearts-build=' + $hash + ' "--user-data-dir=' + (Join-Path $root 'other profile') + '"')),
  (Fake 104 ($marker + ' --type=renderer')),
  (Fake 105 ('unmarked "--user-data-dir=' + $devProfile + '"'))
)
$report = & ${quote(launcher)} -WorkspaceRoot $root -CheckOnly
Write-Output ('RESULT:' + (@{ Report=$report; Stopped=$global:stopped; Graceful=$global:graceful; Started=$global:started } | ConvertTo-Json -Depth 6 -Compress))
`);
  assert.deepEqual(result.Report.OwnedPids, [101, 102]);
  assert.deepEqual(result.Report.StalePids, [102]);
  assert.deepEqual(result.Report.UnmarkedTargetPids, [105]);
  assert.deepEqual(result.Stopped, []); assert.deepEqual(result.Started, []);
  assert.deepEqual(result.Graceful, []);
});

test('desktop launcher preserves the zone of PowerShell 7 typed manifest dates', { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$installed = $asar.LastWriteTimeUtc.AddMinutes(1)
@{ version=1; executable=('release/development/' + $version + '/win-arm64-unpacked/soft hearts next.exe'); asarSha256=$hash; installedAt=$installed.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'release\desktop-current.json')
$global:fakeProcesses = @((Fake 101 $marker))
function ConvertFrom-Json {
  [CmdletBinding()]param([Parameter(ValueFromPipeline=$true)][string]$InputObject)
  process { $value = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $InputObject; if ($value.PSObject.Properties['installedAt']) { $value.installedAt=$global:typedInstallDate }; $value }
}
$results = @()
foreach ($date in @($installed, [DateTimeOffset]$installed)) {
  $global:typedInstallDate = $date
  $report = & ${quote(launcher)} -WorkspaceRoot $root -CheckOnly
  $results += @{ Actual=$report.InstalledUtc.ToString('o'); Expected=$installed.ToString('o'); Stale=$report.StalePids }
}
Write-Output ('RESULT:' + (@{ Reports=$results; Started=$global:started; Stopped=$global:stopped } | ConvertTo-Json -Depth 6 -Compress))
`);
  for (const item of result.Reports) { assert.equal(item.Actual, item.Expected); assert.deepEqual(item.Stale, []); }
  assert.deepEqual(result.Started, []); assert.deepEqual(result.Stopped, []);
});

test("desktop launcher starts its GUI normally when no owned app is running", { skip: !windows }, async () => {
  const result = await fixture(String.raw`
& ${quote(launcher)} -WorkspaceRoot $root | Out-Null
Write-Output ('RESULT:' + (@{ Started=$global:started; Stopped=$global:stopped; Graceful=$global:graceful } | ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Started.length, 1); assert.equal(result.Started[0].WindowStyle, "Normal");
  assert.match(result.Started[0].Arguments[0], /^--soft-hearts-desktop=[A-F0-9]{24}$/);
  assert.match(result.Started[0].Arguments[1], /^--soft-hearts-build=[A-F0-9]{64}$/);
  assert.ok(result.Started[0].Arguments.every((argument: string) => !argument.startsWith('--soft-hearts-stop=')));
  assert.deepEqual(result.Stopped, []); assert.deepEqual(result.Graceful, []);
});

test("desktop launcher sends a normal show request for its current build and restart stays inside its exact owned process tree", { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$env:ELECTRON_RUN_AS_NODE = 'original-node-mode'
$env:MMD_DESK_USER_DATA = 'original-private-profile'
$global:fakeProcesses = @((Fake 201 $marker))
$global:showSenderExits = $true
& ${quote(launcher)} -WorkspaceRoot $root | Out-Null
$reused = @{ Started=@($global:started); Stopped=@($global:stopped); Graceful=@($global:graceful); Remaining=@($global:fakeProcesses | ForEach-Object {$_.ProcessId}) }
$global:showSenderExits = $false
$otherProfile = Join-Path $root 'other profile'
$global:fakeProcesses = @((Fake 201 $marker), (Fake 202 ($marker + ' --type=renderer') $exe 201), (Fake 203 'unrelated child' 'C:\other.exe' 201), (Fake 204 ('--soft-hearts-desktop=' + $owner + ' --soft-hearts-build=' + $hash + ' "--user-data-dir=' + $otherProfile + '"')))
& ${quote(launcher)} -WorkspaceRoot $root -Restart | Out-Null
Write-Output ('RESULT:' + (@{ Reused=$reused; Stopped=$global:stopped; Graceful=$global:graceful; Started=$global:started; Remaining=@($global:fakeProcesses | ForEach-Object {$_.ProcessId}); NodeMode=$env:ELECTRON_RUN_AS_NODE; Profile=$env:MMD_DESK_USER_DATA } | ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Reused.Started.length, 1); assert.equal(result.Reused.Started[0].WindowStyle, "Normal");
  assert.ok(result.Reused.Started[0].Arguments.every((argument: string) => !argument.startsWith('--soft-hearts-stop=')));
  assert.deepEqual(result.Reused.Remaining, [201]); assert.deepEqual(result.Reused.Stopped, []); assert.deepEqual(result.Reused.Graceful, []);
  assert.deepEqual(result.Stopped, [202]); assert.deepEqual(result.Graceful, [201]);
  assert.deepEqual(result.Remaining, [203, 204]);
  assert.equal(result.Started.length, 3);
  assert.deepEqual(result.Started.map((started: { WindowStyle: string }) => started.WindowStyle), ["Normal", "Hidden", "Normal"]);
  for (const started of result.Started) { assert.equal(started.NodeMode, null); assert.equal(started.Profile, null); }
  assert.equal(result.NodeMode, "original-node-mode"); assert.equal(result.Profile, "original-private-profile");
  assert.match(result.Started[0].FilePath, /project space 中文 & literal/);
  assert.match(result.Started[0].Arguments[0], /^--soft-hearts-desktop=[A-F0-9]{24}$/);
  assert.match(result.Started[0].Arguments[1], /^--soft-hearts-build=[A-F0-9]{64}$/);
  assert.match(result.Started[1].Arguments[1], /^--soft-hearts-stop=[A-F0-9]{24}$/);
  assert.match(result.Started[2].Arguments[1], /^--soft-hearts-build=[A-F0-9]{64}$/);
});

test("desktop deployment stop uses manifest time and never launches or takes unmarked/profile instances", { skip: !windows }, async () => {
  const result = await fixture(String.raw`
@{executable=('release/development/' + $version + '/win-arm64-unpacked/soft hearts next.exe');asarSha256=$hash;installedAt=$asar.LastWriteTimeUtc.AddHours(1).ToString('o');buildId='fixture'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'release\desktop-current.json') -Encoding UTF8
$global:fakeProcesses = @((Fake 301 $marker), (Fake 302 ($marker + ' --type=renderer') $exe 301), (Fake 303 ('--soft-hearts-desktop=' + $owner + ' --soft-hearts-build=' + $hash + ' "--user-data-dir=' + (Join-Path $root 'other profile') + '"')), (Fake 304 ('unmarked "--user-data-dir=' + $devProfile + '"')))
$report = & ${quote(launcher)} -WorkspaceRoot $root -CheckOnly
& ${quote(launcher)} -WorkspaceRoot $root -StopOnly | Out-Null
Write-Output ('RESULT:' + (@{Report=$report;Stopped=$global:stopped;Graceful=$global:graceful;Started=$global:started;Remaining=@($global:fakeProcesses | ForEach-Object {$_.ProcessId})} | ConvertTo-Json -Depth 6 -Compress))
`);
  assert.deepEqual(result.Report.StalePids, [301]);
  assert.deepEqual(result.Report.UnmarkedTargetPids, [304]);
  assert.deepEqual(result.Stopped, [302]); assert.deepEqual(result.Graceful, [301]);
  assert.deepEqual(result.Remaining, [303, 304]);
  assert.equal(result.Started.length, 1);
  assert.equal(result.Started[0].WindowStyle, "Hidden");
  assert.match(result.Started[0].Arguments[1], /^--soft-hearts-stop=[A-F0-9]{24}$/);
});

test("desktop launcher and shortcut refresher parse under Windows PowerShell 5.1 without a BOM requirement", { skip: !windows }, async () => {
  for (const file of [launcher, refresher]) {
    const source = await readFile(file);
    assert.ok(source.every(value => value < 128), "the script stays ASCII for Windows PowerShell");
    const command = `$errors=$null;$tokens=$null;[System.Management.Automation.Language.Parser]::ParseFile(${quote(file)},[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw ($errors|Out-String)}`;
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
  }
});

test("deployment can stop an owned app after an interrupted copy with no app.asar", { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$global:fakeProcesses = @((Fake 401 $marker), (Fake 402 ($marker + ' --type=renderer --user-data-dir=normal') $exe 401), (Fake 403 ($marker + ' --user-data-dir=private')), (Fake 404 ('unmarked "--user-data-dir=' + $devProfile + '"')))
Remove-Item -LiteralPath $asar.FullName
$report = & ${quote(launcher)} -WorkspaceRoot $root -StopOnly -CheckOnly
& ${quote(launcher)} -WorkspaceRoot $root -StopOnly | Out-Null
Write-Output ('RESULT:' + (@{Report=$report;Stopped=$global:stopped;Graceful=$global:graceful;Started=$global:started;Remaining=@($global:fakeProcesses | ForEach-Object {$_.ProcessId})} | ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Report.AsarSha256, null); assert.equal(result.Report.ModifiedUtc, null);
  assert.deepEqual(result.Report.OwnedPids, [401]);
  assert.deepEqual(result.Stopped, [402]); assert.deepEqual(result.Graceful, [401]);
  assert.deepEqual(result.Remaining, [403, 404]);
  assert.equal(result.Started.length, 1);
  assert.equal(result.Started[0].WindowStyle, "Hidden");
  assert.match(result.Started[0].Arguments[1], /^--soft-hearts-stop=[A-F0-9]{24}$/);
});

test("an incomplete executable cannot trigger a force stop or replacement launch", { skip: !windows }, async () => {
  const result = await fixture(String.raw`
function New-Object {
  param([string]$ComObject)
  if ($ComObject -ne 'WScript.Shell') { throw 'Unexpected test COM request' }
  $popup = [pscustomobject]@{}
  $popup | Add-Member -MemberType ScriptMethod -Name Popup -Value {param($Message,$Seconds,$Title,$Flags); return 0}
  return $popup
}
$global:fakeProcesses = @((Fake 501 $marker), (Fake 502 ($marker + ' --user-data-dir=private')), (Fake 503 'unmarked'))
$global:failGraceful = $true
Remove-Item -LiteralPath $asar.FullName
& ${quote(launcher)} -WorkspaceRoot $root -StopOnly | Out-Null
$code = $LASTEXITCODE
Write-Output ('RESULT:' + (@{Code=$code;Stopped=$global:stopped;Started=$global:started;Remaining=@($global:fakeProcesses | ForEach-Object {$_.ProcessId})} | ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Code, 1);
  assert.deepEqual(result.Stopped, []);
  assert.deepEqual(result.Remaining, [501, 502, 503]);
  assert.equal(result.Started.length, 1);
  assert.equal(result.Started[0].WindowStyle, "Hidden");
  assert.match(result.Started[0].Arguments[1], /^--soft-hearts-stop=[A-F0-9]{24}$/);
});

test("the configured desktop profile is owned while other profile and implicit instances remain untouched", { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$profile = $devProfile
$otherProfile = Join-Path $root 'other profile'
New-Item -ItemType Directory -Path $profile,$otherProfile -Force | Out-Null
$profileMarker = $marker
$global:fakeProcesses = @(
 (Fake 601 $profileMarker),
 (Fake 602 ('--soft-hearts-desktop=' + $owner + ' --soft-hearts-build=' + $hash + ' "--user-data-dir=' + $otherProfile + '"')),
 (Fake 603 ('--soft-hearts-desktop=' + $owner + ' --soft-hearts-build=' + $hash)),
 (Fake 604 ($profileMarker + ' --type=renderer') $exe 601),
 (Fake 605 ($profileMarker + ' "--user-data-dir=' + $profile + '"')),
 (Fake 606 ('unmarked "--user-data-dir=' + $profile + '"'))
)
$report = & ${quote(launcher)} -WorkspaceRoot $root -CheckOnly
& ${quote(launcher)} -WorkspaceRoot $root -StopOnly | Out-Null
Write-Output ('RESULT:' + (@{Report=$report;Profile=$profile;Stopped=$global:stopped;Graceful=$global:graceful;Started=$global:started;Remaining=@($global:fakeProcesses|ForEach-Object{$_.ProcessId})}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Report.ProfileDirectory, result.Profile);
  assert.deepEqual(result.Report.OwnedPids, [601]);
  assert.deepEqual(result.Report.UnmarkedTargetPids, [605, 606]);
  assert.deepEqual(result.Graceful, [601]); assert.deepEqual(result.Stopped, [604]);
  assert.deepEqual(result.Remaining, [602, 603, 605, 606]);
  assert.equal(result.Started.length, 1); assert.equal(result.Started[0].WindowStyle, "Hidden");
  assert.equal(result.Started[0].Arguments[3], `"--user-data-dir=${result.Profile}"`);
});

test("both fresh and reuse requests pass the same quoted explicit profile without leaking environment overrides", { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$profile = $devProfile
$env:MMD_DESK_USER_DATA = 'do-not-inherit-private-fixture'
& ${quote(launcher)} -WorkspaceRoot $root | Out-Null
$global:fakeProcesses = @((Fake 611 $marker))
$global:showSenderExits = $true
& ${quote(launcher)} -WorkspaceRoot $root | Out-Null
Write-Output ('RESULT:' + (@{Profile=$profile;Started=$global:started;Graceful=$global:graceful;Stopped=$global:stopped;EnvAfter=$env:MMD_DESK_USER_DATA;PolicyAfter=$env:PSExecutionPolicyPreference}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Started.length, 2);
  for (const item of result.Started) {
    assert.equal(item.Arguments[3], `"--user-data-dir=${result.Profile}"`);
    assert.equal(item.WindowStyle, "Normal"); assert.equal(item.Profile, null); assert.equal(item.ScriptPolicy, null);
  }
  assert.equal(result.EnvAfter, "do-not-inherit-private-fixture"); assert.equal(result.PolicyAfter, "RemoteSigned");
  assert.deepEqual(result.Graceful, []); assert.deepEqual(result.Stopped, []);
});

test("stable launcher reads its own immutable manifest and never takes the old normal process", { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$versionId='c'*64
$versionRoot=Join-Path $root ('release\stable\'+$versionId)
$delivery=Join-Path $versionRoot 'win-arm64-unpacked'
New-Item -ItemType Directory -Path (Join-Path $delivery 'resources') -Force | Out-Null
$deliveryExe=Join-Path $delivery 'soft hearts next.exe'
$stableLauncher=Join-Path $delivery 'start-latest.ps1'
Copy-Item -LiteralPath ${quote(launcher)} -Destination $stableLauncher
Set-Content -LiteralPath $deliveryExe 'never executed'
Set-Content -LiteralPath (Join-Path $delivery 'resources\app.asar') 'complete delivery fixture'
$deliveryHash=(Get-FileHash -LiteralPath (Join-Path $delivery 'resources\app.asar') -Algorithm SHA256).Hash
$manifest=@{version=1;executable=('release/stable/'+$versionId+'/win-arm64-unpacked/soft hearts next.exe');launcher=('release/stable/'+$versionId+'/win-arm64-unpacked/start-latest.ps1');launcherSha256=(Get-FileHash -LiteralPath $stableLauncher -Algorithm SHA256).Hash;exeSha256=(Get-FileHash -LiteralPath $deliveryExe -Algorithm SHA256).Hash;asarSha256=$deliveryHash;buildId=('b'*64);platform='win32';arch='arm64'}
$manifest|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $versionRoot 'stable-manifest.json') -Encoding UTF8
'{"unrelated":true}'|Set-Content -LiteralPath (Join-Path $root 'release\desktop-delivered.json') -Encoding UTF8
$legacy='--soft-hearts-desktop='+('1'*24)+' --soft-hearts-build='+('0'*64)+' "--user-data-dir='+$stableProfile+'"'
$global:fakeProcesses=@((Fake 701 $legacy $deliveryExe))
$report=& $stableLauncher -WorkspaceRoot $root -Delivered -CheckOnly
function New-Object {
 param([string]$ComObject)
 if($ComObject -ne 'WScript.Shell'){throw 'Unexpected fixture COM object'}
 $popup=[pscustomobject]@{}; $popup|Add-Member ScriptMethod Popup {param($Message,$Seconds,$Title,$Flags);0}; return $popup
}
& $stableLauncher -WorkspaceRoot $root -Channel stable | Out-Null
$blockedCode=$LASTEXITCODE
& $stableLauncher -WorkspaceRoot $root -Channel stable -StopOnly | Out-Null
$latest=& ${quote(launcher)} -WorkspaceRoot $root -CheckOnly
Write-Output ('RESULT:' + (@{Report=$report;Latest=$latest;BlockedCode=$blockedCode;DeliveryExe=$deliveryExe;Graceful=$global:graceful;Stopped=$global:stopped;Started=$global:started;Remaining=@($global:fakeProcesses|ForEach-Object{$_.ProcessId})}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Report.Channel, "stable"); assert.equal(result.Report.Executable, result.DeliveryExe);
  assert.equal(result.BlockedCode, 1);
  assert.deepEqual(result.Report.UnmarkedTargetPids, [701]); assert.deepEqual(result.Graceful, []); assert.deepEqual(result.Stopped, []);
  assert.deepEqual(result.Started, []); assert.deepEqual(result.Remaining, [701]);
  assert.equal(result.Latest.Channel, "development"); assert.notEqual(result.Latest.Executable, result.DeliveryExe);
});

test("missing delivered and invalid shared-profile references fail before launching anything", { skip: !windows }, async () => {
  const result = await fixture(String.raw`
& ${quote(launcher)} -WorkspaceRoot $root -Delivered -CheckOnly | Out-Null
$missingCode=$LASTEXITCODE
@{version=1;directory='relative-profile'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'release\desktop-profile.json')
& ${quote(launcher)} -WorkspaceRoot $root -CheckOnly | Out-Null
$profileCode=$LASTEXITCODE
Write-Output ('RESULT:' + (@{Missing=$missingCode;Profile=$profileCode;Started=$global:started;Stopped=$global:stopped}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Missing, 1); assert.equal(result.Profile, 1);
  assert.deepEqual(result.Started, []); assert.deepEqual(result.Stopped, []);
});

test("missing development profile fails closed instead of using stable profile", { skip: !windows }, async () => {
  const result = await fixture(String.raw`
Remove-Item -LiteralPath (Join-Path $root 'release\desktop-development-profile.json')
& ${quote(launcher)} -WorkspaceRoot $root -CheckOnly | Out-Null
$code=$LASTEXITCODE
Write-Output ('RESULT:' + (@{Code=$code;Started=$global:started;Stopped=$global:stopped;Health=$global:asrHealthCalls}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Code, 1); assert.deepEqual(result.Started, []); assert.deepEqual(result.Stopped, []); assert.equal(result.Health, 0);
});

test("a development reference to the stable profile is rejected before starting", { skip: !windows }, async () => {
  const result = await fixture(String.raw`
@{version=1;directory=$stableProfile}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'release\desktop-development-profile.json') -Encoding UTF8
& ${quote(launcher)} -WorkspaceRoot $root -CheckOnly | Out-Null
$code=$LASTEXITCODE
Write-Output ('RESULT:' + (@{Code=$code;Started=$global:started;Stopped=$global:stopped;Health=$global:asrHealthCalls}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Code, 1); assert.deepEqual(result.Started, []); assert.deepEqual(result.Stopped, []); assert.equal(result.Health, 0);
});

for (const mode of ['staged', 'global', 'tampered'] as const) test(`StableOnly ${mode} version readback`, { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$versionId='c'*64
$versionRoot=Join-Path $root ('release\stable\'+$versionId)
$delivery=Join-Path $versionRoot 'win-arm64-unpacked'
New-Item -ItemType Directory -Path (Join-Path $delivery 'resources') -Force | Out-Null
$deliveryExe=Join-Path $delivery 'soft hearts next.exe'; $stableLauncher=Join-Path $delivery 'start-latest.ps1'
Copy-Item -LiteralPath ${quote(launcher)} -Destination $stableLauncher
Set-Content -LiteralPath $deliveryExe 'fake executable'
Set-Content -LiteralPath (Join-Path $delivery 'resources\app.asar') 'fixture ASAR'
$manifest=@{version=1;executable=('release/stable/'+$versionId+'/win-arm64-unpacked/soft hearts next.exe');launcher=('release/stable/'+$versionId+'/win-arm64-unpacked/start-latest.ps1');launcherSha256=(Get-FileHash -LiteralPath $stableLauncher -Algorithm SHA256).Hash;exeSha256=(Get-FileHash -LiteralPath $deliveryExe -Algorithm SHA256).Hash;asarSha256=(Get-FileHash -LiteralPath (Join-Path $delivery 'resources\app.asar') -Algorithm SHA256).Hash;buildId=('b'*64);platform='win32';arch='arm64'}
$manifestFile=Join-Path $versionRoot 'stable-manifest.json'
$manifest|ConvertTo-Json|Set-Content -LiteralPath $manifestFile -Encoding UTF8
$manifest|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'release\desktop-delivered.json') -Encoding UTF8
$global:fixedName='soft hearts next - '+(-join ([char[]]@(0x7A33,0x5B9A,0x7248)))+'.lnk'
$global:fixedPath=Join-Path ([Environment]::GetFolderPath('Desktop')) $global:fixedName
$global:fakeLinkFile=Join-Path $root 'owned-synthetic-shortcut.bin'
Set-Content -LiteralPath $global:fakeLinkFile 'old shortcut bytes'
$global:shortcutCalls=@();$global:savedLink=$null;$global:tamperReadback=${mode === 'tampered' ? '$true' : '$false'}
function Test-Path {
 [CmdletBinding()]param([string]$LiteralPath,[string]$PathType)
 if($LiteralPath -eq $global:fixedPath){return Microsoft.PowerShell.Management\Test-Path -LiteralPath $global:fakeLinkFile -PathType Leaf}
 return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath -PathType $PathType
}
function Get-FileHash {
 [CmdletBinding()]param([string]$LiteralPath,[string]$Algorithm)
 if($LiteralPath -eq $global:fixedPath){$LiteralPath=$global:fakeLinkFile}
 return Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm
}
function New-Object {
 param([string]$ComObject)
 if($ComObject -ne 'WScript.Shell'){throw 'Unexpected COM object'}
 $shell=[pscustomobject]@{}
 $shell|Add-Member ScriptMethod CreateShortcut {
  param($Path)
  if($Path -ne $global:fixedPath){throw 'Unexpected shortcut target'}
  if($null -ne $global:savedLink){
   if($global:tamperReadback){$altered=$global:savedLink.PSObject.Copy();$altered.Arguments+=' --unexpected';return $altered}
   return $global:savedLink
  }
  $link=[pscustomobject]@{Path=$Path;TargetPath='';Arguments='';WorkingDirectory='';IconLocation='';WindowStyle=0;Description=''}
  $link|Add-Member ScriptMethod Save {
   $global:shortcutCalls+=@{Path=$this.Path;Target=$this.TargetPath;Arguments=$this.Arguments;Icon=$this.IconLocation}
   Set-Content -LiteralPath $global:fakeLinkFile -Value ('synthetic:'+ $this.TargetPath + $this.Arguments) -Encoding UTF8
   $global:savedLink=$this
  }
  return $link
 }
 return $shell
}
$failure=$null; $receiptText=@()
try { $receiptText=@(& ${quote(refresher)} -WorkspaceRoot $root -StableOnly ${mode === 'global' ? '' : '-ManifestFile $manifestFile'}) } catch { $failure=$_.Exception.Message }
$receipt=if($receiptText.Count){$receiptText[0]|ConvertFrom-Json}else{$null}
$bytesSha=(Get-FileHash -LiteralPath $global:fixedPath -Algorithm SHA256).Hash.ToLowerInvariant()
$selectedManifest=${mode === 'global' ? "(Join-Path $root 'release/desktop-delivered.json')" : '$manifestFile'}
$manifestSha=(Get-FileHash -LiteralPath $selectedManifest -Algorithm SHA256).Hash.ToLowerInvariant()
$launcherSha=(Get-FileHash -LiteralPath $stableLauncher -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output ('RESULT:' + (@{Receipt=$receipt;Failure=$failure;OutputLines=@($receiptText).Count;Links=$global:shortcutCalls;Manifest=$selectedManifest;ManifestSha=$manifestSha;Launcher=$stableLauncher;LauncherSha=$launcherSha;BytesSha=$bytesSha;Started=$global:started;Stopped=$global:stopped}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Links.length, 1);
  assert.equal(path.basename(result.Links[0].Path), 'soft hearts next - 稳定版.lnk');
  if (mode === 'tampered') { assert.equal(result.OutputLines, 0); assert.equal(result.Receipt, null); assert.match(result.Failure, /readback or source identity changed/); }
  else {
    assert.equal(result.Failure, null); assert.equal(result.OutputLines, 1);
    assert.equal(result.Receipt.channel, 'stable'); assert.equal(result.Receipt.launcherPath, result.Launcher);
    assert.equal(result.Receipt.manifestSha256, result.ManifestSha); assert.equal(result.Receipt.launcherSha256, result.LauncherSha);
    assert.equal(result.Receipt.shortcutPath, result.Links[0].Path);
    assert.equal(result.Receipt.shortcutSha256, result.BytesSha); assert.equal(result.Receipt.arguments, result.Links[0].Arguments);
    assert.match(result.Receipt.arguments, /-Channel stable -WorkspaceRoot/); assert.match(result.Receipt.targetPath, /powershell\.exe$/i);
  }
  assert.deepEqual(result.Started, []); assert.deepEqual(result.Stopped, []);
});

test("latest-only shortcut refresh preserves the fixed entry and refuses a missing fallback before writes", { skip: !windows }, async () => {
  for (const exists of [true, false]) {
    const result = await fixture(String.raw`
Set-Content -LiteralPath (Join-Path $root 'release\start-latest.ps1') 'fixture launcher'
@{executable=('release/development/' + $version + '/win-arm64-unpacked/soft hearts next.exe')}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'release\desktop-current.json')
@{executable='release/delivered/fixture/soft hearts next.exe'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'release\desktop-delivered.json')
$global:fixedExists = ${exists ? '$true' : '$false'}
$global:shortcutCalls=@()
$fixedName = 'soft hearts next - ' + (-join ([char[]]@(0x7A33,0x5B9A,0x7248))) + '.lnk'
$fixedPath = Join-Path ([Environment]::GetFolderPath('Desktop')) $fixedName
function Test-Path {
 [CmdletBinding()]param([string]$LiteralPath,[string]$PathType)
 if($LiteralPath -eq $fixedPath){return $global:fixedExists}
 return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath -PathType $PathType
}
function New-Object {
 param([string]$ComObject)
 if($ComObject -ne 'WScript.Shell'){throw 'Unexpected COM object in isolated shortcut fixture'}
 $shell=[pscustomobject]@{}
 $shell|Add-Member ScriptMethod CreateShortcut {
  param($Path)
  $link=[pscustomobject]@{Path=$Path;TargetPath='';Arguments='';WorkingDirectory='';IconLocation='';WindowStyle=0;Description=''}
  $link|Add-Member ScriptMethod Save {$global:shortcutCalls+=@{Path=$this.Path;Arguments=$this.Arguments}}
  return $link
 }
 return $shell
}
$failure=$null
try { & ${quote(refresher)} -WorkspaceRoot $root -LatestOnly | Out-Null }
catch { $failure=$_.Exception.Message }
Write-Output ('RESULT:' + (@{Links=$global:shortcutCalls;Failure=$failure;Started=$global:started;Stopped=$global:stopped}|ConvertTo-Json -Depth 6 -Compress))
`);
    assert.deepEqual(result.Started, []); assert.deepEqual(result.Stopped, []);
    if (exists) {
      assert.equal(result.Failure, null); assert.equal(result.Links.length, 1);
      assert.equal(path.basename(result.Links[0].Path), 'soft hearts next - 最新开发版.lnk');
      assert.match(result.Links[0].Arguments, /-ExecutionPolicy RemoteSigned -File/);
    } else {
      assert.match(result.Failure, /existing complete-delivery shortcut is missing/);
      assert.deepEqual(result.Links, []);
    }
  }
});


test('development launch never checks or restores the stable ASR binding', { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$fixture = Add-AsrBinding
$settingsFile = Join-Path $fixture.Profile 'settings.json'
$before = (Get-FileHash -LiteralPath $settingsFile -Algorithm SHA256).Hash
$modulesBefore = $env:PSModulePath
& ${quote(launcher)} -WorkspaceRoot $root | Out-Null
Write-Output ('RESULT:' + (@{Started=$global:started;Health=$global:asrHealthCalls;Waits=$global:asrWaits;Warnings=$global:asrWarnings;Manager=$fixture.Manager;SameSettings=($before -eq (Get-FileHash -LiteralPath $settingsFile -Algorithm SHA256).Hash);ModulesRestored=($modulesBefore -eq $env:PSModulePath)}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Health, 0); assert.deepEqual(result.Waits, []); assert.deepEqual(result.Warnings, []);
  assert.equal(result.Started.length, 1); assert.equal(result.Started[0].WindowStyle, 'Normal'); assert.equal(result.Started[0].ScriptPolicy, null);
  assert.equal(result.SameSettings, true); assert.equal(result.ModulesRestored, true);
});

test('opening development again never restores stable ASR or replaces the current app', { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$fixture = Add-AsrBinding
$global:fakeProcesses = @((Fake 801 $marker))
$global:showSenderExits = $true
& ${quote(launcher)} -WorkspaceRoot $root | Out-Null
Write-Output ('RESULT:' + (@{Started=$global:started;Health=$global:asrHealthCalls;Graceful=$global:graceful;Stopped=$global:stopped;Warnings=$global:asrWarnings}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Health, 0); assert.equal(result.Started.length, 1); assert.equal(result.Started[0].WindowStyle, 'Normal');
  assert.deepEqual(result.Graceful, []); assert.deepEqual(result.Stopped, []); assert.deepEqual(result.Warnings, []);
});

test('a ready stable ASR is not checked or restarted by development', { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$fixture = Add-AsrBinding
$global:asrReady = $true
& ${quote(launcher)} -WorkspaceRoot $root | Out-Null
Write-Output ('RESULT:' + (@{Started=$global:started;Health=$global:asrHealthCalls;Waits=$global:asrWaits;Warnings=$global:asrWarnings}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Health, 0); assert.equal(result.Started.length, 1); assert.deepEqual(result.Waits, []); assert.deepEqual(result.Warnings, []);
});

test('Windows PowerShell 5.1 reads a UTF-8 development profile and manifest without reading stable settings', { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$fixture = Add-AsrBinding
$utf8 = New-Object Text.UTF8Encoding $false
$fixture.Binding.model='合成识别模型'
$jsonFiles=@{
  (Join-Path $root 'release\desktop-profile.json')=@{version=1;directory=$fixture.Profile};
  (Join-Path $root 'release\desktop-development-profile.json')=@{version=1;directory=$devProfile};
  (Join-Path $root 'release\desktop-current.json')=@{version=1;executable=('release/development/'+$version+'/win-arm64-unpacked/soft hearts next.exe');asarSha256=$hash;buildId='合成构建'};
  (Join-Path $root 'release\desktop-asr.json')=$fixture.Binding;
  (Join-Path $fixture.Profile 'settings.json')=@{
    voiceInput=@{baseUrl='http://127.0.0.1:19942/v1';model='合成识别模型';language='zh';apiKey='fixture-secret'};
    model=@{path='C:\合成模型目录\model.pmx';name='合成模型名'};
    provider=@{kind='openai';baseUrl='http://127.0.0.1:19943/v1';model='合成聊天模型'};
    persona='中文人设：这是完整合成配置，路径 C:\合成角色\ 与引号 " 均须保留。'
  }
}
foreach($entry in $jsonFiles.GetEnumerator()){[IO.File]::WriteAllText($entry.Key,($entry.Value|ConvertTo-Json -Depth 8),$utf8)}
$withoutBom=@($jsonFiles.Keys|ForEach-Object{$bytes=[IO.File]::ReadAllBytes($_); -not($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)})
$before=(Get-FileHash -LiteralPath (Join-Path $fixture.Profile 'settings.json') -Algorithm SHA256).Hash
& ${quote(launcher)} -WorkspaceRoot $root | Out-Null
Write-Output ('RESULT:' + (@{Version=$PSVersionTable.PSVersion.Major;WithoutBom=$withoutBom;Started=$global:started;Health=$global:asrHealthCalls;Warnings=$global:asrWarnings;Profile=$devProfile;SameSettings=($before -eq (Get-FileHash -LiteralPath (Join-Path $fixture.Profile 'settings.json') -Algorithm SHA256).Hash)}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Version, 5); assert.equal(result.WithoutBom.length, 5); assert.ok(result.WithoutBom.every(Boolean));
  assert.equal(result.Health, 0); assert.equal(result.Started.length, 1); assert.deepEqual(result.Warnings, []);
  assert.match(result.Started[0].FilePath, /release\\development\\.*\\win-arm64-unpacked\\soft hearts next\.exe$/);
  assert.equal(result.Started[0].Arguments.at(-1), `"--user-data-dir=${result.Profile}"`); assert.equal(result.SameSettings, true);
});

test('development does not read or expose invalid stable settings JSON', { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$fixture = Add-AsrBinding
$utf8 = New-Object Text.UTF8Encoding $false
[IO.File]::WriteAllText((Join-Path $fixture.Profile 'settings.json'),'{{"persona":"SHOULD_NOT_LEAK_FIXTURE_JSON 中文人设反斜线 \q"}',$utf8)
& ${quote(launcher)} -WorkspaceRoot $root | Out-Null
Write-Output ('RESULT:' + (@{Started=$global:started;Health=$global:asrHealthCalls;Warnings=$global:asrWarnings}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Health, 0); assert.equal(result.Started.length, 1); assert.equal(result.Warnings.length, 0);
  assert.doesNotMatch(result.Warnings.join(''), /中文|persona|settings|SHOULD_NOT_LEAK|Unrecognized/);
});

for (const mode of ['CheckOnly', 'StopOnly', 'Delivered']) test(`${mode} never probes or restores a bound ASR`, { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$fixture = Add-AsrBinding
${mode === 'Delivered' ? String.raw`
$stableVersion = 'c' * 64
$versionRoot = Join-Path $root ('release\stable\' + $stableVersion)
$deliveryRoot = Join-Path $versionRoot 'win-arm64-unpacked'
New-Item -ItemType Directory -Path (Join-Path $deliveryRoot 'resources') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $deliveryRoot 'soft hearts next.exe') 'fake executable: never run'
Set-Content -LiteralPath (Join-Path $deliveryRoot 'resources\app.asar') 'fixed delivery fixture'
$stableLauncher=Join-Path $deliveryRoot 'start-latest.ps1'
Copy-Item -LiteralPath ${quote(launcher)} -Destination $stableLauncher
@{version=1;executable=('release/stable/'+$stableVersion+'/win-arm64-unpacked/soft hearts next.exe');launcher=('release/stable/'+$stableVersion+'/win-arm64-unpacked/start-latest.ps1');launcherSha256=(Get-FileHash -LiteralPath $stableLauncher -Algorithm SHA256).Hash;exeSha256=(Get-FileHash -LiteralPath (Join-Path $deliveryRoot 'soft hearts next.exe') -Algorithm SHA256).Hash;asarSha256=(Get-FileHash -LiteralPath (Join-Path $deliveryRoot 'resources\app.asar') -Algorithm SHA256).Hash;buildId=('b'*64);platform='win32';arch='arm64'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $versionRoot 'stable-manifest.json') -Encoding UTF8
` : ''}
& ${mode === 'Delivered' ? '$stableLauncher' : quote(launcher)} -WorkspaceRoot $root -${mode} | Out-Null
Write-Output ('RESULT:' + (@{Health=$global:asrHealthCalls;Waits=$global:asrWaits;Warnings=$global:asrWarnings;ManagerStarts=@($global:started|Where-Object{$_.FilePath -like '*powershell.exe'})}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Health, 0); assert.deepEqual(result.Waits, []); assert.deepEqual(result.ManagerStarts, []); assert.deepEqual(result.Warnings, []);
});

for (const mode of ['unbound', 'base-changed', 'model-changed']) test(`${mode} profile never activates the installed ASR binding`, { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$fixture = Add-AsrBinding
${mode === 'unbound' ? `Remove-Item -LiteralPath (Join-Path $root 'release/desktop-asr.json')` : ''}
${mode === 'base-changed' ? `@{voiceInput=@{baseUrl='http://127.0.0.1:19943/v1';model='fixture-asr'}}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $fixture.Profile 'settings.json') -Encoding UTF8` : ''}
${mode === 'model-changed' ? `@{voiceInput=@{baseUrl='http://127.0.0.1:19942/v1';model='FIXTURE-ASR'}}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $fixture.Profile 'settings.json') -Encoding UTF8` : ''}
& ${quote(launcher)} -WorkspaceRoot $root | Out-Null
Write-Output ('RESULT:' + (@{Health=$global:asrHealthCalls;Started=$global:started;Warnings=$global:asrWarnings}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Health, 0); assert.equal(result.Started.length, 1); assert.deepEqual(result.Warnings, []);
});

const invalidAsrBindings: Record<string, string> = {
  'string version': `$fixture.Binding.version='1'`,
  'boolean version': `$fixture.Binding.version=$true`,
  'unknown field': `$fixture.Binding.command='fixture-secret'`,
  'remote endpoint': `$fixture.Binding.baseUrl='http://example.test/v1'`,
  'HTTPS endpoint': `$fixture.Binding.baseUrl='https://127.0.0.1:19942/v1'`,
  credentials: `$fixture.Binding.baseUrl='http://fixture-secret@127.0.0.1:19942/v1'`,
  'query string': `$fixture.Binding.baseUrl='http://127.0.0.1:19942/v1?key=fixture-secret'`,
  'UNC manager': String.raw`$fixture.Binding.startScript='\\localhost\share\fixture-secret.ps1'`,
  'manager control character': '$fixture.Binding.startScript="C:\fixture-secret`n.ps1"',
  'manager tab character': '$fixture.Binding.startScript="C:\fixture-secret`t.ps1"',
  'wrong script hash': `$fixture.Binding.sha256='0' * 64`,
};
for (const [name, mutate] of Object.entries(invalidAsrBindings)) test(`development does not inspect stable ASR binding: ${name}`, { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$fixture = Add-AsrBinding
${mutate}
$fixture.Binding|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'release\desktop-asr.json') -Encoding UTF8
& ${quote(launcher)} -WorkspaceRoot $root | Out-Null
Write-Output ('RESULT:' + (@{Health=$global:asrHealthCalls;Started=$global:started;Warnings=$global:asrWarnings}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Health, 0); assert.equal(result.Started.length, 1); assert.equal(result.Warnings.length, 0);
  assert.doesNotMatch(result.Warnings.join(''), /fixture-secret|\.ps1|example\.test/);
});

for (const mode of ['manager-failure', 'not-ready', 'wrapper-timeout']) test(`development does not exercise stable ASR manager: ${mode}`, { skip: !windows }, async () => {
  const result = await fixture(String.raw`
$fixture = Add-AsrBinding
${mode === 'manager-failure' ? '$global:asrManagerFails=$true' : ''}
${mode === 'not-ready' ? '$global:asrBecomesReady=$false' : ''}
${mode === 'wrapper-timeout' ? '$global:asrManagerTimesOut=$true' : ''}
& ${quote(launcher)} -WorkspaceRoot $root | Out-Null
Write-Output ('RESULT:' + (@{Health=$global:asrHealthCalls;Started=$global:started;Warnings=$global:asrWarnings;Waits=$global:asrWaits;WrapperKills=$global:asrKills;AppStops=$global:stopped}|ConvertTo-Json -Depth 6 -Compress))
`);
  assert.equal(result.Started.length, 1); assert.equal(result.Warnings.length, 0); assert.deepEqual(result.AppStops, []);
  assert.equal(result.Health, 0); assert.deepEqual(result.Waits, []); assert.equal(result.WrapperKills, 0);
});
