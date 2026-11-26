/**
 * I-099/I-100: in a call, she listens for whether you have FINISHED, not only whether you went
 * quiet. A small model (Smart Turn v3.2, run on this computer by the local recognizer's process; shared/voice/smart-turn.json) hears
 * the last seconds of your turn when you pause and says how likely it is that the turn is complete.
 *
 *  - CallTurnStream: the window's side of the conversation with the host (window.desktop.voiceCallTurn); warms up when a call
 *    starts; any failure falls back, a run of them for the rest of the call. No model, no answer: today's silence rule.
 *  - TurnEndJudge: per call, per pause. After `pauseMs` of quiet it asks once. Complete (>= threshold): the turn ends now.
 *    Not complete: wait for up to `capMs` of silence (you may be thinking); speaking again makes it one turn. No answer: today's
 *    silence rule (endpointSilenceMs). It also says how each turn ended, for the experience record.
 *  - toTurnAudio: the turn's audio as the model wants it (16 kHz).
 * Pure apart from the injected API and timers; tests drive them with fakes. Outside a call nothing here exists.
 */
import { VOICE_CALL_KNOBS, type VoiceCallKnobs } from '../../../shared/behaviors/voice-call/knobs';
import { StreamResampler } from './vad';

/** The model looks at no more than the last 8 s of the turn (what it was trained on). */
export const TURN_AUDIO_SECONDS = 8;

/** How a call turn's end was decided (a closed set; shared/memory/journal.ts). */
export type TurnEndBy = 'smart-turn' | 'smart-waited' | 'silence';

export interface CallTurnApi { voiceCallTurn(pcm: Float32Array): Promise<number | null> }
type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
const defaultTimers: Timers = { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
type StreamState = 'idle' | 'warming' | 'ready' | 'off';

export class CallTurnStream {
  private state: StreamState = 'idle';
  private failures = 0;
  private generation = 0;
  constructor(private readonly api: () => CallTurnApi | null, private readonly knobs: VoiceCallKnobs['turn'] = VOICE_CALL_KNOBS.turn,
    private readonly timers: Timers = defaultTimers) {}

  /** The model answers now. */
  get ready(): boolean { return this.state === 'ready'; }
  get status(): StreamState { return this.state; }

  /** A call started in this window: the model is loaded now (one second of silence); until it answers, silence decides. */
  start(): void {
    const generation = ++this.generation;
    this.state = 'warming'; this.failures = 0;
    void this.request(new Float32Array(16_000), this.knobs.warmTimeoutMs).then(p => {
      if (generation !== this.generation || this.state !== 'warming') return;
      this.state = p === null ? 'off' : 'ready';
    });
  }
  /** The call ended. */
  stop(): void { this.generation++; this.state = 'idle'; }

  /** The turn's audio (16 kHz, last 8 s at most) → the probability that it is complete, or null (silence decides). */
  async ask(pcm: Float32Array): Promise<number | null> {
    if (this.state !== 'ready' || !pcm.length) return null;
    const generation = this.generation;
    const p = await this.request(pcm, this.knobs.timeoutMs);
    if (generation !== this.generation || this.state !== 'ready') return null;
    if (p !== null) { this.failures = 0; return p; }
    if (++this.failures >= this.knobs.failLimit) this.state = 'off'; // the rest of this call goes by silence
    return null;
  }

  private request(pcm: Float32Array, timeoutMs: number): Promise<number | null> {
    let api: CallTurnApi | null;
    try { api = this.api(); } catch { api = null; }
    if (!api) return Promise.resolve(null);
    return new Promise(resolve => {
      let done = false;
      const finish = (value: number | null) => { if (done) return; done = true; this.timers.clear(timer); resolve(value); };
      const timer = this.timers.set(() => finish(null), timeoutMs);
      let answer: Promise<number | null>;
      try { answer = api.voiceCallTurn(pcm); } catch { finish(null); return; }
      answer.then(value => finish(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null), () => finish(null));
    });
  }
}

export interface TurnEndPorts {
  /** The current turn's audio at 16 kHz (the last 8 s at most, the quiet at its end trimmed), or null when there is none. */
  audio(): Float32Array | null;
  /** The model said the turn is complete: end it now (the window cuts the utterance as if the silence had run out). */
  endNow(): void;
}

type Verdict = 'none' | 'incomplete' | 'unknown';

export class TurnEndJudge {
  private quietMs = 0;
  private generation = 0;
  private asked = false;
  private pending = false;
  private verdict: Verdict = 'none';
  private by: TurnEndBy | null = null;
  /** Per call: the last few "not yet" decisions, true when the wait ran to the cap (the user did not resume): the guard's evidence. */
  private recent: boolean[] = [];
  private off: 'guard' | null = null;
  constructor(private readonly stream: Pick<CallTurnStream, 'ready' | 'ask'>, private readonly knobs: VoiceCallKnobs['turn'], private readonly ports: TurnEndPorts) {}

  /** Set once the guard switched the model off for the rest of this call (the plain silence rule); the journal says so. */
  get offReason(): 'guard' | null { return this.off; }

  private note(wasted: boolean): void {
    this.recent.push(wasted);
    if (this.recent.length > this.knobs.guardOf) this.recent.shift();
    if (this.recent.filter(Boolean).length >= this.knobs.guardWasted) this.off = 'guard';
  }

  /** A new call, or the turn was cut some other way: forget this pause (a late answer for it is dropped). */
  reset(): void { this.generation++; this.quietMs = 0; this.asked = this.pending = false; this.verdict = 'none'; this.by = null; }

  /**
   * One chunk of the call's listening, `voiced` as the VAD (or the gate) decided. `inTurn`: an utterance is being collected.
   * Speaking again starts the pause over; a pause that reaches `pauseMs` asks the model once (the same audio would answer the
   * same later, so there is no second look).
   */
  chunk(voiced: boolean, inTurn: boolean, ms: number): void {
    if (this.off) return;
    if (voiced && this.verdict === 'incomplete') this.note(false); // she waited and you did resume: the model was right
    if (voiced || !inTurn || !this.stream.ready) { if (this.quietMs || this.asked || this.verdict !== 'none') this.reset(); return; }
    this.quietMs += ms;
    if (this.asked || this.quietMs < this.knobs.pauseMs) return;
    const pcm = this.ports.audio();
    this.asked = true;
    if (!pcm) { this.verdict = 'unknown'; return; }
    const generation = this.generation;
    this.pending = true;
    void this.stream.ask(pcm).then(p => {
      if (generation !== this.generation) return; // you spoke again or the turn ended: that answer is about something else
      this.pending = false;
      if (p === null) { this.verdict = 'unknown'; return; }
      if (p >= this.knobs.threshold) { this.by = 'smart-turn'; this.ports.endNow(); return; }
      this.verdict = 'incomplete';
    }).catch(() => { if (generation === this.generation) { this.pending = false; this.verdict = 'unknown'; } });
  }

  /** How many ms of quiet end the turn right now: `defaultMs` (today's rule) unless the model is being heard or said "not yet". */
  silenceMs(defaultMs: number): number {
    if (this.off || !this.stream.ready || this.verdict === 'unknown') return defaultMs;
    return Math.max(defaultMs, this.knobs.capMs);
  }

  /** How the turn that is being cut was decided (read once, at the cut). */
  takeBy(): TurnEndBy {
    const by: TurnEndBy = this.by ?? (this.verdict === 'incomplete' ? 'smart-waited' : 'silence');
    if (by === 'smart-waited') this.note(true); // she waited to the cap and you had not resumed: the wait was wasted
    this.reset();
    return by;
  }
}

/** The turn's audio at 16 kHz for the model (a fresh one-shot resample; the last partial sample is dropped). */
export function toTurnAudio(samples: Float32Array, sampleRate: number): Float32Array | null {
  if (!samples.length || !(sampleRate > 0)) return null;
  const out = new StreamResampler().push(samples, sampleRate);
  return out.length ? out : null;
}
