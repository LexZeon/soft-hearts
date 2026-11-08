# Pose feasibility bench: resource sampler. NOT product code.
# Samples once a second for -Seconds: whole-machine CPU %, per-process CPU / working set / private bytes for -Pids,
# and GPU engine utilisation (all engines, tagged by process id) from the "GPU Engine" performance counters.
# Writes raw JSON to -Out; bench-node.mjs / summarize.mjs reduce it. Usage:
#   powershell -NoProfile -File sampler.ps1 -TargetPids 1234,5678 -Seconds 20 -Out sample.json
param([string]$TargetPids = "", [int]$Seconds = 10, [string]$Out = "sample.json")
$ErrorActionPreference = "SilentlyContinue"
$pidList = @()
if ($TargetPids) { $pidList = $TargetPids.Split(",") | ForEach-Object { [int]$_ } }
$paths = @("\Processor Information(_Total)\% Processor Time", "\GPU Engine(*)\Utilization Percentage")
foreach ($p in $pidList) {
  $proc = Get-Process -Id $p
  if (-not $proc) { continue }
  $n = $proc.ProcessName
  $paths += "\Process V2($n`:$p)\% Processor Time"
  $paths += "\Process V2($n`:$p)\Working Set"
  $paths += "\Process V2($n`:$p)\Private Bytes"
}
$samples = @()
$counters = Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples ($Seconds + 1)
foreach ($set in $counters) {
  $row = @{ t = $set.Timestamp.ToString("o"); sysCpu = 0.0; procs = @{}; gpu = @() }
  foreach ($s in $set.CounterSamples) {
    $path = $s.Path
    if ($path -like "*processor information(_total)*") { $row.sysCpu = [math]::Round($s.CookedValue, 2); continue }
    if ($path -like "*gpu engine*") {
      if ($s.CookedValue -gt 0) { $row.gpu += ,@($s.InstanceName, [math]::Round($s.CookedValue, 2)) }
      continue
    }
    if ($path -match "process v2\((?<n>[^:]+):(?<pid>\d+)\)\\(?<c>.+)$") {
      $k = $Matches.pid
      if (-not $row.procs.ContainsKey($k)) { $row.procs[$k] = @{} }
      $row.procs[$k][$Matches.c] = [math]::Round($s.CookedValue, 2)
    }
  }
  $samples += $row
}
@{ pids = $pidList; seconds = $Seconds; samples = $samples } | ConvertTo-Json -Depth 8 -Compress | Set-Content -Path $Out -Encoding utf8
