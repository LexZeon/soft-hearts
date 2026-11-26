// The one fixed PowerShell program that reads Windows' own "now playing" (the system media session, the one the volume flyout shows).
// Nothing is built from outside text: the script is a constant, it takes no arguments, it only reads (title, artist, app name, state,
// position) and prints one JSON line. No audio, no screen, no window contents, no network.

export const NOW_PLAYING_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(4000) | Out-Null; $t.Result }
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $session = $manager.GetCurrentSession()
  if ($null -eq $session) { '{"none":true}'; exit 0 }
  $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $info = $session.GetPlaybackInfo()
  $line = $session.GetTimelineProperties()
  [pscustomobject]@{
    title = [string]$props.Title; artist = [string]$props.Artist; app = [string]$session.SourceAppUserModelId
    status = [int]$info.PlaybackStatus; pos = [double]$line.Position.TotalSeconds; dur = [double]($line.EndTime - $line.StartTime).TotalSeconds
  } | ConvertTo-Json -Compress
} catch { '{"error":true}' }
`;
