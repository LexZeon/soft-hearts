/**
 * I-099: in a call, a small neural network (Silero VAD,
 * run on this computer by the local recognizer's process) says whether each 32 ms of the microphone is a person speaking.
 * MediaInput uses it, in a call only, to decide when the user starts (VOICE_CALL_KNOBS.vad.startMs of speech), when they
 * have finished (endpointSilenceMs of non-speech) and whether they are talking over her (speech that also passed the echo
 * gate). Whenever it cannot answer, the call goes by loudness exactly as before (the RMS gate).
 *
 *  - CallVadStream: the window's side of the conversation with the host: resamples each chunk to 16 kHz and asks
 *    (window.desktop.voiceCallVad); warms up when a call starts; after a few failures it goes by loudness and warms up again
 *    after retryAfterMs (2026-11-19: a busy computer made it give up for the whole call, "不说话也被当成说话了").
 *  - VadSpeechDetector: probabilities → "is this chunk speech" with Silero's two thresholds, and the start rule.
 *  - ChunkLead: the moments just before the start was confirmed, so the first syllable reaches recognition.
 * Pure apart from the injected API and timers; tests drive them with fakes. No audio is kept beyond the lead.
 */
import { VOICE_CALL_KNOBS, type VoiceCallKnobs } from '../../../shared/behaviors/voice-call/knobs';

export const VAD_RATE = 16_000;
export const VAD_WINDOW_MS = 32;

export interface CallVadApi { voiceCallVad(pcm: Float32Array, reset: boolean): Promise<readonly number[] | null> }
type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
const defaultTimers: Timers = { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/** Area-averaging resampler that keeps the leftover samples between chunks (so 48 kHz → 16 kHz loses nothing at the edges). */
export class StreamResampler {
  private carry = new Float32Array(0);
  private rate = 0;
  reset(): void { this.carry = new Float32Array(0); this.rate = 0; }
  push(samples: Float32Array, sourceRate: number, targetRate = VAD_RATE): Float32Array {
    if (!(sourceRate > 0)) return new Float32Array(0);
    if (sourceRate !== this.rate) { this.carry = new Float32Array(0); this.rate = sourceRate; }
    if (sourceRate === targetRate) return samples.slice();
    const input = new Float32Array(this.carry.length + samples.length);
    input.set(this.carry); input.set(samples, this.carry.length);
    const ratio = sourceRate / targetRate, count = Math.floor(input.length / ratio), output = new Float32Array(count);
    for (let index = 0; index < count; index++) {
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
    this.carry = input.slice(Math.min(input.length, Math.floor(count * ratio)));
    return output;
  }
}

type StreamState = 'idle' | 'warming' | 'ready' | 'off';

export class CallVadStream {
  private state: StreamState = 'idle';
  private readonly resampler = new StreamResampler();
  private failures = 0;
  private generation = 0;
  constructor(private readonly api: () => CallVadApi | null, private readonly knobs: VoiceCallKnobs['vad'] = VOICE_CALL_KNOBS.vad,
    private readonly timers: Timers = defaultTimers) {}

  /** The VAD answers now: chunks go through it (MediaInput queues them); otherwise loudness decides. */
  get ready(): boolean { return this.state === 'ready'; }
  /** For the journal and tests: idle (no call) / warming / ready / off (gave up for now; warms again after retryAfterMs). */
  get status(): StreamState { return this.state; }

  /** A call started in this window: a fresh stream; the model is loaded now (one silent window), loudness decides until then. */
  start(): void {
    const generation = ++this.generation;
    this.warm(generation);
  }

  private warm(generation: number): void {
    this.state = 'warming'; this.failures = 0; this.resampler.reset();
    void this.ask(new Float32Array(512), true, this.knobs.warmTimeoutMs).then(probs => {
      if (generation !== this.generation || this.state !== 'warming') return;
      if (probs) this.state = 'ready'; else this.giveUp(generation);
    });
  }

  /** Loudness decides for now; the model is tried again after retryAfterMs, within the same call only. */
  private giveUp(generation: number): void {
    this.state = 'off';
    this.timers.set(() => { if (generation === this.generation && this.state === 'off') this.warm(generation); }, this.knobs.retryAfterMs);
  }
  /** The call ended. */
  stop(): void { this.generation++; this.state = 'idle'; this.resampler.reset(); }

  /** One microphone chunk → the probabilities of the 32 ms windows it completed, or null (that chunk goes by loudness). */
  async probe(samples: Float32Array, sampleRate: number): Promise<readonly number[] | null> {
    if (this.state !== 'ready') return null;
    const generation = this.generation, pcm = this.resampler.push(samples, sampleRate);
    if (!pcm.length) return [];
    const probs = await this.ask(pcm, false, this.knobs.timeoutMs);
    if (generation !== this.generation || this.state !== 'ready') return null;
    if (probs) { this.failures = 0; return probs; }
    if (++this.failures >= this.knobs.failLimit) this.giveUp(generation); // loudness for now, the model again after retryAfterMs
    return null;
  }

  private ask(pcm: Float32Array, reset: boolean, timeoutMs: number): Promise<readonly number[] | null> {
    let api: CallVadApi | null;
    try { api = this.api(); } catch { api = null; }
    if (!api) return Promise.resolve(null);
    return new Promise(resolve => {
      let done = false;
      const finish = (value: readonly number[] | null) => { if (done) return; done = true; this.timers.clear(timer); resolve(value); };
      const timer = this.timers.set(() => finish(null), timeoutMs);
      let answer: Promise<readonly number[] | null>;
      try { answer = api.voiceCallVad(pcm, reset); } catch { finish(null); return; }
      answer.then(value => finish(Array.isArray(value) && value.every(p => typeof p === 'number' && p >= 0 && p <= 1) ? value : null), () => finish(null));
    });
  }
}

/** What the VAD says about one chunk. */
export interface VadHeard {
  /** The chunk counts as the user speaking (start confirmed, or still inside an utterance). */
  speech: boolean;
  /** The start was confirmed in this chunk (the lead before it belongs to the utterance). */
  started: boolean;
  /** Share of the chunk's windows at or above the threshold (barge-in); null when the chunk completed no window. */
  share: number | null;
  /** Milliseconds from the last speech window to the end of the chunk (for "the user's last speech frame"). */
  tailMs: number;
}

export class VadSpeechDetector {
  private run = 0;
  private last = false;
  constructor(private readonly knobs: VoiceCallKnobs['vad'] = VOICE_CALL_KNOBS.vad) {}
  reset(): void { this.run = 0; this.last = false; }

  /**
   * One chunk's probabilities. `inUtterance`: an utterance is being collected (then a window counts as speech down to the
   * lower threshold, so a short dip inside a sentence does not end it); otherwise the start needs startMs of windows at or
   * above the threshold in a row.
   */
  push(probs: readonly number[], inUtterance: boolean): VadHeard {
    const { threshold, negThreshold, startMs } = this.knobs;
    if (!probs.length) return { speech: inUtterance && this.last, started: false, share: null, tailMs: 0 };
    let speech = false, started = false, lastSpeech = -1, over = 0;
    for (let index = 0; index < probs.length; index++) {
      const p = probs[index];
      if (p >= threshold) over++;
      if (inUtterance || speech) {
        if (p >= negThreshold) { speech = true; lastSpeech = index; }
        continue;
      }
      this.run = p >= threshold ? this.run + VAD_WINDOW_MS : 0;
      if (this.run >= startMs) { speech = started = true; lastSpeech = index; this.run = 0; }
    }
    if (inUtterance) this.run = 0;
    this.last = speech;
    return { speech, started, share: over / probs.length, tailMs: speech ? (probs.length - 1 - lastSpeech) * VAD_WINDOW_MS : 0 };
  }
}

/** The last few chunks before an utterance (MediaInput feeds them in front of it when the VAD confirms the start). */
export class ChunkLead {
  private chunks: Float32Array[] = [];
  private samples = 0;
  keep(chunk: Float32Array, sampleRate: number, ms: number): void {
    this.chunks.push(chunk.slice()); this.samples += chunk.length;
    const limit = sampleRate * ms / 1000;
    while (this.chunks.length && this.samples - this.chunks[0].length >= limit) this.samples -= this.chunks.shift()!.length;
  }
  take(): Float32Array[] { const value = this.chunks; this.chunks = []; this.samples = 0; return value; }
  clear(): void { this.chunks = []; this.samples = 0; }
}
