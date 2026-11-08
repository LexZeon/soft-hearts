/**
 * 语音输入的收音数字 (体验记录): what one voice-input
 * capture received, as numbers only. Pure, no DOM: src/ui/MediaInput.ts feeds it every microphone chunk and reports one summary when the
 * capture ends (stopped, failed) or when the silent-microphone watch fires. It never holds audio, words or a device name.
 */
export interface VoiceCaptureStatsReport {
  end: 'stopped' | 'no-sound' | 'failed';
  chunks: number;
  /** Largest absolute sample (0–1) and the largest chunk RMS (0–1). */
  peak: number;
  rms: number;
  /** The speech gate's threshold (SpeechLevelGate.threshold) when the report was made. */
  threshold: number;
  sampleRate: number;
  /** The app never names an input device (getUserMedia without a device id), so this is 'default'; 'unknown' when it cannot be said. */
  device: 'default' | 'specified' | 'unknown';
  /** She was speaking (the microphone paused) when the capture opened, and how long chunks were skipped for that. */
  pausedAtStart: boolean;
  pausedMs: number;
  /** Audio seconds received. */
  seconds: number;
}

export class VoiceCaptureStats {
  private chunks = 0; private peak = 0; private rms = 0; private rate = 0; private seconds = 0; private pausedMs = 0;
  private pausedAtStart = false;
  private told = false;
  constructor(private readonly device: VoiceCaptureStatsReport['device'] = 'default') {}

  /** The capture opened; `paused`: she was speaking at that moment. */
  begin(paused: boolean): void {
    this.chunks = 0; this.peak = 0; this.rms = 0; this.rate = 0; this.seconds = 0; this.pausedMs = 0; this.pausedAtStart = paused; this.told = false;
  }
  /** One microphone chunk (whether or not the segmenter was paused for her speech). */
  chunk(samples: ArrayLike<number>, sampleRate: number): void {
    if (!samples.length || !(sampleRate > 0)) return;
    let energy = 0, peak = 0;
    for (let index = 0; index < samples.length; index++) { const value = samples[index]; energy += value * value; const magnitude = Math.abs(value); if (magnitude > peak) peak = magnitude; }
    this.chunks++; this.rate = sampleRate; this.seconds += samples.length / sampleRate;
    if (peak > this.peak) this.peak = peak;
    const rms = Math.sqrt(energy / samples.length);
    if (rms > this.rms) this.rms = rms;
  }
  /** A chunk skipped because she was speaking. */
  paused(seconds: number): void { if (seconds > 0) this.pausedMs += seconds * 1000; }
  /** The report so far; null when no chunk ever arrived and nothing was paused (a capture that never heard the microphone says nothing new). */
  report(end: VoiceCaptureStatsReport['end'], threshold: number): VoiceCaptureStatsReport | null {
    // The silent-microphone report already told this capture's numbers; its later stop adds nothing.
    if (end === 'stopped' && (this.told || (!this.chunks && !this.pausedMs))) return null;
    if (end === 'no-sound') this.told = true;
    return { end, chunks: this.chunks, peak: this.peak, rms: this.rms, threshold, sampleRate: this.rate, device: this.device,
      pausedAtStart: this.pausedAtStart, pausedMs: Math.round(this.pausedMs), seconds: Math.round(this.seconds * 10) / 10 };
  }
}
