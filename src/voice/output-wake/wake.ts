/**
 * I-150:
 * wake this window's audio output before she speaks.
 *
 * Why: the dev journal showed the program did not drop audio (played, the shared AudioContext already running, first PCM
 * 300–460 ms), yet the opening syllables were missing on the user's AirPods Pro (Bluetooth). Chromium's Web Audio stops the
 * real output stream after a stretch of digital silence (media SilentSinkSuspender, about 30 s) while the AudioContext stays
 * 'running'; with no stream open, Windows lets the Bluetooth A2DP link sleep, and when her voice starts the headset needs
 * roughly 0.3–1 s to wake, which eats the first syllables. The free system voice has the same exposure.
 *
 * What: when speech is coming, an inaudible, non-zero tone (knobs.ts WAKE_LEVEL, WAKE_TONE_HZ) plays on the window's shared
 * warm output, so the silence detector sees sound and the stream and the headset stay up. It keeps playing while the output
 * is in use and for KEEP_AFTER_MS after the last use or request, then stops (ramped, no click), so the browser may suspend
 * the stream again and the computer can still sleep. It is never on all the time.
 *
 * A cold output (no use and no wake tone within WAKE_COLD_AFTER_MS, or the context had to be resumed) holds her first sound
 * until WAKE_LEAD_MS after the tone began: `readyAt()` for a scheduled Web Audio start (context seconds), `holdMs()` for the
 * system voice (milliseconds on the clock). A warm output never holds.
 *
 * The tone is invisible to "she is speaking": it is its own oscillator straight to the destination. It never goes through a
 * voice player, so it never opens the mouth, never produces lip-sync levels, never marks a sentence heard (I-165 bubble) and
 * never feeds the speech hold. Whoever asks (VoiceOutput) asks only when read-aloud is on and the volume is above 0.
 *
 * `OutputWake` is the pure scheduling (injected clock, timers and tone starter; tests drive it with a fake clock);
 * `startWakeTone` is the thin Web Audio part. `SharedAudioOutput` (../audio-output.ts) owns one and never builds a context
 * for it.
 */
import { KEEP_AFTER_MS, WAKE_COLD_AFTER_MS, WAKE_LEAD_MS, WAKE_LEVEL, WAKE_RAMP_MS, WAKE_TONE_HZ } from './knobs';

export interface WakeTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
/** A started tone: when it started on its context's clock (seconds), and how to stop it (ramped). */
export interface WakeSignal { readonly startedAt: number; stop(): void }
export interface WakeTiming { leadMs: number; keepAfterMs: number; coldAfterMs: number }
export interface OutputWakeOptions extends Partial<WakeTiming> {
  now(): number;
  timers: WakeTimers;
  /** Start the tone on this running context; null when it cannot (a context without oscillators, an error). */
  start(context: AudioContext): WakeSignal | null;
}

export class OutputWake {
  private signal: WakeSignal | null = null;
  private signalOn: AudioContext | null = null;
  /** Asked for and not started yet (the output is still starting). */
  private wanted = false;
  /** The wake asked for (or running) began on a cold output: her first sound waits for the lead. */
  private cold = false;
  private startedMs = -Infinity;
  /** Context time before which a cold output's first sound does not start; -Infinity when warm. */
  private readyAtS = -Infinity;
  /** Last moment the output was known to carry sound (in use, or the tone): the cold test counts from here. */
  private lastSoundMs = -Infinity;
  /** Last request or end of use: the tone stops KEEP_AFTER after this. */
  private touchedMs = -Infinity;
  /** Holders of the output (her audio, a cue): the tone never stops while one holds it. */
  private busy = 0;
  private timer: unknown = null;
  /** Tones started and stopped, for tests and diagnostics. */
  starts = 0;
  stops = 0;

  constructor(private readonly options: OutputWakeOptions) {}

  private get lead(): number { return this.options.leadMs ?? WAKE_LEAD_MS; }
  private get keepAfter(): number { return this.options.keepAfterMs ?? KEEP_AFTER_MS; }
  private get coldAfter(): number { return this.options.coldAfterMs ?? WAKE_COLD_AFTER_MS; }
  private now(): number { return this.options.now(); }

  /** The tone is playing now. */
  get active(): boolean { return this.signal !== null; }

  /**
   * Speech is coming. `outputRunning`: the context was already running (not suspended, not starting). The caller then gets
   * the output running and calls `running()`; a tone already playing just keeps going for KEEP_AFTER more.
   */
  request(outputRunning: boolean): void {
    const now = this.now();
    this.touchedMs = now;
    if (!this.signal && !this.wanted) {
      this.wanted = true;
      this.cold = !outputRunning || this.quietMs(now) > this.coldAfter;
    }
    this.arm();
  }

  /** The output runs on `context`: start the tone that was asked for. */
  running(context: AudioContext): void {
    if (!this.wanted || this.signal) return;
    this.wanted = false;
    let signal: WakeSignal | null = null;
    try { signal = this.options.start(context); } catch { signal = null; }
    if (!signal) { this.arm(); return; }
    this.signal = signal; this.signalOn = context; this.starts++;
    this.startedMs = this.now();
    this.readyAtS = this.cold && Number.isFinite(signal.startedAt) ? signal.startedAt + this.lead / 1000 : -Infinity;
    this.arm();
  }

  /** A holder took (true) or released (false) the output. Use is sound as far as the cold test goes. */
  use(active: boolean): void {
    const now = this.now();
    this.busy = active ? this.busy + 1 : Math.max(0, this.busy - 1);
    this.lastSoundMs = now;
    if (!active) this.touchedMs = now;
    this.arm();
  }

  /** Context time (s) before which her first sound on `context` must not start; -Infinity when the output is warm. */
  readyAt(context: AudioContext): number {
    return this.signal && this.signalOn === context ? this.readyAtS : -Infinity;
  }

  /** Milliseconds a first sound that starts now (the system voice) still waits for the wake; 0 when warm or no tone runs. */
  holdMs(): number {
    if (!this.signal || !Number.isFinite(this.readyAtS)) return 0;
    return Math.max(0, this.startedMs + this.lead - this.now());
  }

  /**
   * I-177 batch 2: the output moved to another device (../output-sink.ts). That device has heard nothing yet: a tone that was playing (or
   * asked for) starts again, cold, at the next `running()`, so her first sound there waits for the lead too.
   */
  moved(): void {
    const again = !!this.signal || this.wanted;
    this.stopTone();
    this.lastSoundMs = -Infinity;
    if (again) { this.wanted = true; this.cold = true; this.touchedMs = Math.max(this.touchedMs, this.now()); }
    this.arm();
  }

  /** The output is being suspended, replaced or closed: stop at once (a tone on a dead context helps nobody). */
  halt(): void {
    this.wanted = false;
    this.clearTimer();
    this.stopTone();
  }

  /** Time since the output last carried sound; 0 while it does. */
  private quietMs(now: number): number {
    return this.signal || this.busy > 0 ? 0 : now - this.lastSoundMs;
  }

  /** Stop the tone KEEP_AFTER after the last request or use, never while the output is held. */
  private arm(): void {
    this.clearTimer();
    if (this.busy > 0 || (!this.signal && !this.wanted)) return;
    const due = Math.max(0, this.touchedMs + this.keepAfter - this.now());
    this.timer = this.options.timers.set(() => {
      this.timer = null;
      if (this.busy > 0) return;
      if (this.now() < this.touchedMs + this.keepAfter) { this.arm(); return; }
      this.wanted = false; this.stopTone(); // KEEP_AFTER has passed: let the stream (and the computer) rest
    }, due);
  }

  private stopTone(): void {
    const signal = this.signal;
    if (!signal) return;
    this.signal = null; this.signalOn = null; this.readyAtS = -Infinity; this.stops++;
    this.lastSoundMs = this.now();
    try { signal.stop(); } catch { /* the context is gone */ }
  }

  private clearTimer(): void {
    if (this.timer !== null) { this.options.timers.clear(this.timer); this.timer = null; }
  }
}

export interface WakeToneOptions { level?: number; hz?: number; rampMs?: number }

/**
 * The thin Web Audio part: a very low tone (default about −66 dBFS at 30 Hz) straight to the destination, faded in and out
 * over WAKE_RAMP_MS. Returns null when the context cannot make one (test fakes without oscillators) or the level is 0.
 */
export function startWakeTone(context: AudioContext, options: WakeToneOptions = {}): WakeSignal | null {
  const level = options.level ?? WAKE_LEVEL, ramp = Math.max(0.005, (options.rampMs ?? WAKE_RAMP_MS) / 1000);
  if (!(level > 0) || typeof context.createOscillator !== 'function' || typeof context.createGain !== 'function') return null;
  try {
    const oscillator = context.createOscillator(), gain = context.createGain();
    const at = context.currentTime;
    oscillator.frequency.value = options.hz ?? WAKE_TONE_HZ;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + ramp);
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.start(at);
    let stopped = false;
    return {
      startedAt: at,
      stop() {
        if (stopped) return;
        stopped = true;
        try {
          const now = context.currentTime;
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(gain.gain.value, now);
          gain.gain.linearRampToValueAtTime(0, now + ramp);
          oscillator.onended = () => { try { oscillator.disconnect(); gain.disconnect(); } catch { /* gone */ } };
          oscillator.stop(now + ramp + 0.01);
        } catch { try { oscillator.disconnect(); gain.disconnect(); } catch { /* gone */ } }
      },
    };
  } catch { return null; }
}
