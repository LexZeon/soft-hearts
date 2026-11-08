import type { PetInteractionFeedback } from './PetInteraction';
import type { FeedCueKind } from '../../shared/feed-cue';
import { defaultAudioTimers, type AudioOutputTimers } from './audio-output';

/**
 * B06 × R02.
 *
 *   idle ──snack at the mouth──▶ mouth: pause speech + bubble, cue "啊"
 *   mouth ──delivered──▶ eating: cue "嗯" (the stage chews)
 *   mouth / eating ──snack gone──▶ after the cue and a short beat: resume
 *
 * This module owns only that timing. The targets (VoiceOutput and the bubble
 * pacer) own how they pause, the cue port owns the sound. Cancellation stays
 * with their owners: a stop, a new message or a context change cancels exactly
 * as before. Cues play only while read-aloud is on; the mouth always moves.
 */

/** Natural beat after the bite (or the snack leaving) before she goes on talking. */
export const FEED_RESUME_DELAY_MS = 400;
/** Never hold speech longer than this, even if the snack stays at her mouth. */
export const FEED_MAX_PAUSE_MS = 12_000;
/** A cue that cannot start this soon after its moment is skipped, never played late. */
export const FEED_CUE_DEADLINE_MS: Readonly<Record<FeedCueKind, number>> = Object.freeze({ ah: 250, mm: 350 });
/** Resume never waits on a cue longer than this. */
export const FEED_CUE_WAIT_MS = 3000;
/** Small gap between the end of a cue and the reply going on. */
const CUE_GAP_MS = 150;

/**
 * The "preparing at the mouth" state that drives the B06 mouth opening: the
 * snack is inside the mouth radius (`near` reaches 1 exactly there, where the
 * preparation timer runs), prepared, or being eaten (accepted feedback is
 * `prepared`). Approaching from further away does not pause anything.
 */
export function feedHoldsMouth(feedback: Pick<PetInteractionFeedback, 'feeding' | 'prepared' | 'near'> | null | undefined): boolean {
  return !!feedback && feedback.feeding === true && (feedback.prepared === true || (feedback.near ?? 0) >= 1);
}
/** The snack was accepted at the mouth (the bite). */
export function feedDelivered(feedback: Pick<PetInteractionFeedback, 'feeding' | 'accepted'> | null | undefined): boolean {
  return !!feedback && feedback.feeding === true && feedback.accepted === true;
}

/** `release`: give the speech engine up while paused (cancel, re-speak on resume) so a system-voice cue can use it. */
export interface PausableSpeech { pause(release?: boolean): void; resume(): void }
export interface FeedCueStarted { readonly ended: Promise<void> }
export interface FeedCuePort {
  /** Warm up (fetch/decode clips) so the next cue can start at once. */
  prepare?(): void;
  /**
   * The snack being fed now changed: its interaction session (undefined: a snack without one), or null once it is gone (dragged
   * away, cancelled, eaten and done). A moment still waiting to start for the previous snack is dropped (T-209 #32).
   */
  feeding?(sessionId: string | null | undefined): void;
  /** Start `kind` within `deadlineMs`, or not at all (null: not ready, voice off, too late). */
  play(kind: FeedCueKind, deadlineMs: number): Promise<FeedCueStarted | null>;
  stop(): void;
  /** True when cues speak on the replies' own engine (system voice). */
  sharesEngine?(): boolean;
}
/** Decision sent to the other window: it pauses/resumes its own speech, it never runs the machine. */
export interface FeedPauseMessage { paused: boolean; release?: boolean }
export interface FeedSpeechPauseOptions {
  targets: readonly PausableSpeech[];
  /** Tell the other window (the pet sees the snack; either window may be speaking). */
  broadcast?(message: FeedPauseMessage): void;
  cues?: FeedCuePort;
  /** Read-aloud switch: cues play only while it is on. */
  voiceOn?(): boolean;
  timers?: AudioOutputTimers;
  now?(): number;
  resumeDelayMs?: number;
  maxPauseMs?: number;
}

export class FeedSpeechPause {
  private phase: 'idle' | 'mouth' | 'eating' = 'idle';
  private feeding = false;
  /** The snack being fed (its session, '' without one), null while none. */
  private snack: string | null = null;
  private holding = false;
  private delivered = false;
  private paused = false;
  /** The max pause ran out during this hold: ignore it until the snack is released once. */
  private exhausted = false;
  private resumeTimer: unknown = null;
  /** Resume is waiting for the current cue to end (bounded by FEED_CUE_WAIT_MS). */
  private resumeWaiting = false;
  private maxTimer: unknown = null;
  /** Bumped by every new cue, cancel and release: stale cue results and resume waits do nothing. */
  private cueToken = 0;
  private resumeToken = 0;
  /** Settles when the latest cue has ended or was skipped. */
  private cueDone: Promise<void> | null = null;
  private disposed = false;
  constructor(private readonly options: FeedSpeechPauseOptions) {}

  get active(): boolean { return this.paused; }
  get state(): 'idle' | 'mouth' | 'eating' { return this.phase; }

  /** Local feeding feedback (pet window): runs the machine and broadcasts its decisions. */
  feedback(feedback: Pick<PetInteractionFeedback, 'feeding' | 'prepared' | 'near' | 'accepted' | 'sessionId'> | null | undefined): void {
    if (this.disposed) return;
    const feeding = !!feedback?.feeding, holding = feedHoldsMouth(feedback), delivered = feedDelivered(feedback);
    // Each snack's sounds are its own: the cue port hears which snack this is, and when it is gone.
    const snack = feeding ? (typeof feedback?.sessionId === 'string' ? feedback.sessionId : '') : null;
    if (snack !== this.snack) {
      this.snack = snack;
      try { this.options.cues?.feeding?.(snack === '' ? undefined : snack); } catch { /* A cue is optional. */ }
    }
    if (feeding && !this.feeding) { try { this.options.cues?.prepare?.(); } catch { /* A cue is optional. */ } }
    this.feeding = feeding;
    if (!holding && this.holding) this.exhausted = false;
    if (holding && !this.holding) this.approach();
    this.holding = holding;
    if (delivered && !this.delivered) this.deliver();
    this.delivered = delivered;
    if (!holding && this.phase !== 'idle') this.leave();
  }

  /** A decision from the other window (booleans from older builds mean paused / not paused). */
  receive(value: unknown): void {
    if (this.disposed) return;
    const message: FeedPauseMessage | null = typeof value === 'boolean' ? { paused: value }
      : value && typeof value === 'object' && typeof (value as FeedPauseMessage).paused === 'boolean' ? value as FeedPauseMessage : null;
    if (!message) return;
    if (message.paused) {
      if (this.paused) return;
      this.paused = true;
      // The pet decides when to resume; this bound only covers a pet that went away.
      this.maxTimer = this.timers.set(() => { this.maxTimer = null; this.release(false); }, this.maxPauseMs + 1000);
      this.apply(true, message.release === true);
    } else this.release(false);
  }

  /** A reply stop/cancel in this window: drop the cue in flight; resume no longer waits for it. */
  cancelCues(): void {
    this.cueToken++; this.cueDone = null;
    try { this.options.cues?.stop(); } catch { /* Best effort. */ }
    if (this.paused && !this.holding && this.phase !== 'idle') this.scheduleResume();
  }


  /** Resume at once (window hidden, disposal). */
  reset(): void {
    this.holding = this.delivered = this.feeding = false; this.exhausted = false;
    this.cueToken++; this.cueDone = null;
    if (this.snack !== null) { this.snack = null; try { this.options.cues?.feeding?.(null); } catch { /* A cue is optional. */ } }
    try { this.options.cues?.stop(); } catch { /* Best effort. */ }
    this.release(true);
  }

  dispose(): void { this.reset(); this.disposed = true; }

  private approach(): void {
    if (this.exhausted) return;
    this.cancelResume();
    if (this.phase === 'mouth') return; // back at the mouth within the beat: same pause, no second "啊"
    this.phase = 'mouth';
    if (!this.paused) {
      this.paused = true;
      this.maxTimer = this.timers.set(() => { this.maxTimer = null; this.exhausted = this.holding; this.release(true); }, this.maxPauseMs);
      // A system-voice cue needs the engine: the paused reply gives it up (and is re-spoken from its last word).
      const release = this.cuesOn() && this.options.cues?.sharesEngine?.() === true;
      this.apply(true, release);
      this.options.broadcast?.({ paused: true, ...(release ? { release } : {}) });
    }
    this.cue('ah');
  }

  private deliver(): void {
    if (!this.paused || this.phase === 'eating') return; // speech already resumed (max pause): no cue over it
    this.phase = 'eating';
    this.cue('mm');
  }

  private leave(): void {
    if (!this.paused) { this.phase = 'idle'; return; }
    if (this.resumeTimer === null && !this.resumeWaiting) this.scheduleResume();
  }

  private cue(kind: FeedCueKind): void {
    const token = ++this.cueToken;
    const cues = this.options.cues;
    if (!cues || !this.cuesOn()) { this.cueDone = null; return; }
    let started: Promise<FeedCueStarted | null>;
    try { started = cues.play(kind, FEED_CUE_DEADLINE_MS[kind]); } catch { this.cueDone = null; return; }
    this.cueDone = started.then(result => token === this.cueToken ? result?.ended : undefined, () => undefined).then(() => {});
  }

  /** Resume after the snack is gone: once the cue has ended, and not before the natural beat. */
  private scheduleResume(): void {
    this.cancelResume();
    const token = this.resumeToken, leftAt = this.now(), cue = this.cueDone;
    const begin = () => {
      if (token !== this.resumeToken || !this.paused) return;
      const delay = Math.max(this.resumeDelayMs - (this.now() - leftAt), cue ? CUE_GAP_MS : 0);
      this.resumeTimer = this.timers.set(() => { this.resumeTimer = null; if (token === this.resumeToken) this.release(true); }, delay);
    };
    if (!cue) { begin(); return; }
    this.resumeWaiting = true;
    let done = false;
    const go = () => {
      if (done) return; done = true;
      this.timers.clear(cap);
      if (token !== this.resumeToken) return;
      this.resumeWaiting = false; begin();
    };
    const cap = this.timers.set(go, FEED_CUE_WAIT_MS);
    void cue.then(go);
  }

  private cancelResume(): void {
    this.resumeToken++; this.resumeWaiting = false;
    if (this.resumeTimer !== null) { this.timers.clear(this.resumeTimer); this.resumeTimer = null; }
  }

  private release(local: boolean): void {
    this.cancelResume();
    if (this.maxTimer !== null) { this.timers.clear(this.maxTimer); this.maxTimer = null; }
    this.phase = 'idle';
    if (!this.paused) return;
    this.paused = false;
    this.apply(false, false);
    if (local) this.options.broadcast?.({ paused: false });
  }

  private apply(paused: boolean, release: boolean): void {
    for (const target of this.options.targets) {
      try { if (paused) target.pause(release); else target.resume(); } catch { /* One target never blocks another. */ }
    }
  }

  private cuesOn(): boolean { try { return this.options.voiceOn?.() ?? true; } catch { return false; } }
  private get resumeDelayMs(): number { return this.options.resumeDelayMs ?? FEED_RESUME_DELAY_MS; }
  private get maxPauseMs(): number { return this.options.maxPauseMs ?? FEED_MAX_PAUSE_MS; }
  private get timers(): AudioOutputTimers { return this.options.timers ?? defaultAudioTimers; }
  private now(): number { return this.options.now?.() ?? performance.now(); }
}
