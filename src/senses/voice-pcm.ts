// The microphone's PCM helpers (moved from src/senses/MediaInput.ts on 2026-11-19 to keep that file small): resampling to 16 kHz,
// the WAV the host recognizes, and the bounded utterance a capture collects. MediaInput re-exports them.
import { t } from '../../shared/foundation/ui-language';
import { DEFAULT_SPEECH_LEVEL } from '../voice';

/** Area averaging avoids simply dropping samples when converting native microphone PCM. */
export function resamplePcm(input: Float32Array, sourceRate: number, targetRate = 16000): Float32Array {
  if (!(sourceRate > 0) || !(targetRate > 0)) throw new Error(t('voice.capture.sampleRate'));
  if (sourceRate === targetRate) return input.slice();
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index++) {
    const start = index * ratio, end = Math.min(input.length, (index + 1) * ratio);
    if (ratio < 1) {
      const left = Math.floor(start), fraction = start - left;
      output[index] = input[left] * (1 - fraction) + input[Math.min(left + 1, input.length - 1)] * fraction;
    } else {
      let sum = 0;
      for (let sample = Math.floor(start); sample < end; sample++) sum += input[sample] * (Math.min(end, sample + 1) - Math.max(start, sample));
      output[index] = sum / (end - start);
    }
  }
  return output;
}

export function encodeWav(pcm: Float32Array, sampleRate = 16000): ArrayBuffer {
  const size = 44 + pcm.length * 2;
  if (size > 4_000_000) throw new Error(t('voice.capture.tooLarge'));
  const buffer = new ArrayBuffer(size), view = new DataView(buffer);
  const write = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  write(0, "RIFF"); view.setUint32(4, size - 8, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, pcm.length * 2, true);
  for (let index = 0; index < pcm.length; index++) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(pcm[index]) ? pcm[index] : 0));
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

/** One bounded utterance; short noises are discarded and trailing silence is trimmed. */
export class VoiceSegmenter {
  private chunks: Float32Array[] = [];
  private length = 0;
  private voiced = 0;
  private silence = 0;
  get active(): boolean { return this.length > 0; }
  /** Seconds of speech in the utterance being collected. */
  voicedSeconds(sampleRate: number): number { return sampleRate > 0 ? this.voiced / sampleRate : 0; }
  reset(): void { this.chunks = []; this.length = this.voiced = this.silence = 0; }
  /** I-099: the moments just before a start the VAD confirmed, at the front of a new utterance (neither speech nor silence). */
  lead(chunks: readonly Float32Array[]): void {
    if (this.length) return;
    for (const chunk of chunks) { this.chunks.push(chunk.slice()); this.length += chunk.length; }
  }
  /**
   * `silenceSeconds`: how long a pause ends the utterance (I-091 call mode passes its knob; otherwise 0.65 s as before).
   * `speechOverride` (I-099, a call's VAD): whether this chunk is speech, instead of its loudness against `level`.
   */
  push(samples: Float32Array, sampleRate: number, level = DEFAULT_SPEECH_LEVEL, silenceSeconds = 0.65, speechOverride?: boolean): Float32Array | null {
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    const speech = speechOverride ?? (samples.length > 0 && Math.sqrt(energy / samples.length) >= level);
    if (!speech && !this.length) return null;
    this.chunks.push(samples.slice()); this.length += samples.length;
    if (speech) { this.voiced += samples.length; this.silence = 0; }
    else this.silence += samples.length;
    if (this.silence < sampleRate * silenceSeconds && this.length < sampleRate * 15) return null;
    return this.flush(sampleRate);
  }
  /** I-099/I-100: the newest `seconds` of the utterance being collected, keeping at most `keepQuietMs` of the quiet at its end (a copy), or null. */
  tail(sampleRate: number, seconds: number, keepQuietMs: number): Float32Array | null {
    if (!this.length) return null;
    const end = this.length - Math.max(0, this.silence - Math.floor(sampleRate * keepQuietMs / 1000)), start = Math.max(0, end - Math.floor(sampleRate * seconds));
    if (end <= start) return null;
    const out = new Float32Array(end - start);
    let offset = 0;
    for (const chunk of this.chunks) {
      const from = Math.max(start, offset), to = Math.min(end, offset + chunk.length);
      if (to > from) out.set(chunk.subarray(from - offset, to - offset), from - start);
      offset += chunk.length;
    }
    return out;
  }
  flush(sampleRate: number): Float32Array | null {
    let result: Float32Array | null = null;
    if (this.voiced >= sampleRate * 0.25) {
      const length = Math.min(Math.floor(sampleRate * 15), this.length - Math.max(0, this.silence - Math.floor(sampleRate * 0.15)));
      result = new Float32Array(length);
      let offset = 0;
      for (const chunk of this.chunks) {
        const count = Math.min(chunk.length, length - offset);
        if (count <= 0) break;
        result.set(chunk.subarray(0, count), offset); offset += count;
      }
    }
    this.reset();
    return result;
  }
}
