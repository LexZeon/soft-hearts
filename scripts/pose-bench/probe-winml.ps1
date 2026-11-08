# Pose feasibility bench: can the in-box Windows ML (Windows.AI.MachineLearning, ships with Windows) run an ONNX model, and on
# which device kinds? Reports per-device-kind load / first / median latency and which GPU-engine LUIDs this process touched.
# Uses only what is already in Windows (no install, no download). NOT product code.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File probe-winml.ps1 -ModelPath <onnx> -Out <json>
param([string]$ModelPath, [string]$Out)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.AI.MachineLearning.LearningModel, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
[void][Windows.AI.MachineLearning.LearningModelDevice, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
[void][Windows.AI.MachineLearning.LearningModelDeviceKind, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
[void][Windows.AI.MachineLearning.LearningModelSession, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
[void][Windows.AI.MachineLearning.LearningModelBinding, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
[void][Windows.AI.MachineLearning.TensorFloat, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
$results = @{}
$model = [Windows.AI.MachineLearning.LearningModel]::LoadFromFilePath($ModelPath)
$results.inputs = @($model.InputFeatures | ForEach-Object { "$($_.Name):$($_.Kind)" })
$results.outputs = @($model.OutputFeatures | ForEach-Object { "$($_.Name):$($_.Kind)" })
$data = New-Object 'float[]' (3 * 416 * 416)
for ($i = 0; $i -lt $data.Length; $i++) { $data[$i] = 100.0 }
$shape = [long[]](1, 3, 416, 416)
$myPid = [System.Diagnostics.Process]::GetCurrentProcess().Id
foreach ($kind in "Cpu", "DirectX", "DirectXHighPerformance", "DirectXMinPower") {
  $r = @{}
  try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $kindEnum = [Enum]::Parse([Windows.AI.MachineLearning.LearningModelDeviceKind], $kind)
    $dev = [Windows.AI.MachineLearning.LearningModelDevice]::new($kindEnum)
    $sess = [Windows.AI.MachineLearning.LearningModelSession]::new($model, $dev)
    $r.sessionMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 0)
    $bind = [Windows.AI.MachineLearning.LearningModelBinding]::new($sess)
    $tensor = [Windows.AI.MachineLearning.TensorFloat]::CreateFromArray($shape, $data)
    $bind.Bind("input", $tensor)
    $sw.Restart(); $null = $sess.Evaluate($bind, "w"); $r.firstMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
    $times = @()
    for ($i = 0; $i -lt 30; $i++) { $sw.Restart(); $null = $sess.Evaluate($bind, "w"); $times += $sw.Elapsed.TotalMilliseconds }
    $times = $times | Sort-Object
    $r.p50Ms = [math]::Round($times[15], 2); $r.p90Ms = [math]::Round($times[27], 2)
    # which GPU-engine LUIDs did this process use? (busy engines show up in the performance counters)
    $c = Get-Counter "\GPU Engine(pid_$($myPid)*)\Utilization Percentage" -ErrorAction SilentlyContinue
    $r.gpuEngineInstances = @($c.CounterSamples | Where-Object { $_.CookedValue -gt 0 } | ForEach-Object { $_.InstanceName })
    $r.ok = $true
  } catch { $r.ok = $false; $r.error = $_.Exception.Message }
  $results[$kind] = $r
}
$results | ConvertTo-Json -Depth 6 | Set-Content -Path $Out -Encoding utf8
