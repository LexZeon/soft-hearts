# I-016 A (docs/claude/2026-11-03-listen-kind.md): synthetic speech with Windows SAPI (no real recording, lines written for this).
# Writes 48 kHz 16-bit mono WAVs into .local/listen-kind/sapi (gitignored) for scripts/listen-kind/eval.ts.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\listen-kind\make-speech.ps1
param([string]$Out = (Join-Path $PSScriptRoot '..\..\.local\listen-kind\sapi'))
Add-Type -AssemblyName System.Speech
$out = $Out
New-Item -ItemType Directory -Force $out | Out-Null
$zh = @(
  '你怎么现在才来，我在门口等了你整整一个小时。算了，先进去吧，电影马上就要开始了。',
  '窗外的雨一直下个不停，她把那封信看了一遍又一遍，最后还是没有寄出去。',
  '明天上午九点开会，记得把上周的数据整理好，我们要一起看一下进度。',
  '你听我说，这件事不是你想的那样。我本来想早点告诉你的，可是一直找不到机会。',
  '好的，那我们就先这样定下来。如果有什么变化，你随时给我打电话。',
  '这道题其实不难，关键是先把条件看清楚，然后一步一步地往下推。',
  '他站在车站的站台上，看着最后一班车慢慢开远，才发现自己忘了说再见。',
  '喂，你能听到吗？我这边信号不太好，你再说一遍好不好？'
)
$en = @(
  'Where were you last night? I called you three times and you never picked up. We really need to talk.',
  'The rain kept falling as the old train pulled away from the quiet station.',
  'Okay everyone, let us get started. First, a quick update on the project timeline, then questions.',
  'I am not saying you are wrong, I am just saying we should think about this a little longer.',
  'Can you hear me now? Great. So, as I was saying, the meeting has been moved to Thursday afternoon.',
  'She opened the door slowly, and for a moment nobody in the room said a single word.',
  'Today we will look at how plants turn sunlight into energy, step by step.',
  'Honestly, I did not expect it to end like that. I thought they would finally make up.'
)
$voices = @{ 'huihui' = 'Microsoft Huihui Desktop'; 'zira' = 'Microsoft Zira Desktop'; 'david' = 'Microsoft David Desktop' }
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($key in $voices.Keys) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try { $s.SelectVoice($voices[$key]) } catch { Write-Output "missing voice $($voices[$key])"; continue }
  $lines = if ($key -eq 'huihui') { $zh } else { $en }
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $file = Join-Path $out ("{0}-{1:d2}.wav" -f $key, $i)
    $s.SetOutputToWaveFile($file, $format)
    $s.Rate = 0
    $s.Speak($lines[$i])
    $s.SetOutputToNull()
  }
  $s.Dispose()
}
# A few "ha ha" lines as synthetic laughter.
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Huihui Desktop')
$s.SetOutputToWaveFile((Join-Path $out 'laugh-00.wav'), $format); $s.Speak('哈哈哈哈，哈哈哈，哈哈哈哈哈。'); $s.SetOutputToNull()
$s.Dispose()
Get-ChildItem $out | Measure-Object | ForEach-Object { "wav files: $($_.Count)" }
