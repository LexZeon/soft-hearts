/**
 * I-091 step 2: during a call, once the user has paused after saying something, she makes one very short sound in her own
 * voice ("嗯……", "诶？") while her real reply is on its way. Pure scheduling (no DOM); the player and the host's pick are ports.
 *
 * Rules:
 *  - at most one sound per user turn (a turn ends when her real reply sounds);
 *  - never while her reply is loading or sounding, and the reply's first sound stops a sound still playing (it never talks over
 *    the real reply);
 *  - never the same sound twice in a row (the pick is told the last one);
 *  - the user talking again before the sound started cancels it.
 */
import type { CallFillerId, CallFillerPick } from '../../../shared/voice/voice-call';

export interface CallFillerPlayer {
  /** Starts the sound now; null when it could not start (no clip, no device). */
  /** `began`: when the sound really starts (the system voice's own start); absent: at once. */
  play(id: CallFillerId): Promise<{ ended: Promise<void>; began?: Promise<void> } | null>;
  stop(): void;
}
export interface CallFillerSchedulerOptions {
  choose(last: CallFillerId | null): Promise<CallFillerPick | null>;
  player: CallFillerPlayer;
  /** Her real reply is loading or sounding now. */
  replyBusy(): boolean;
  timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** A sound started (for the per-turn timing line). */
  started?(id: CallFillerId): void;
}

export class CallFillerScheduler {
  private armed = true;
  private replied = false;
  private token = 0;
  private timer: unknown = null;
  private playing: { id: CallFillerId; token: number } | null = null;
  private lastId: CallFillerId | null = null;
  constructor(private readonly options: CallFillerSchedulerOptions) {}

  get last(): CallFillerId | null { return this.lastId; }
  get busy(): boolean { return this.playing !== null; }

  /** The user has been quiet for `quietMs` after saying enough (MediaInput, call mode). */
  paused(quietMs: number): void {
    if (!this.armed || this.timer !== null || this.playing || this.replied) return;
    const token = ++this.token;
    this.timer = 'choosing';
    void Promise.resolve().then(() => this.options.choose(this.lastId)).then(pick => {
      if (token !== this.token) return;
      this.timer = null;
      if (!pick) { this.armed = false; return; } // her pick was "no sound" for this turn
      this.timer = this.options.timers.set(() => { this.timer = null; void this.fire(pick.id, token); }, Math.max(0, pick.delayMs - quietMs));
    }, () => { if (token === this.token) this.timer = null; });
  }

  /** The user is talking (again): a sound not yet started is dropped; after her reply this starts a new turn. */
  spoke(): void {
    this.cancelPending();
    if (this.replied) { this.replied = false; this.armed = true; }
  }

  /** Her reply's first characters arrived: a sound not yet started is dropped; one playing finishes; the turn is answered. */
  answered(): void {
    this.cancelPending();
    this.replied = true; this.armed = false;
  }

  /** Her real reply is about to sound or sounds now: stop the sound, and none until the user's next turn. */
  replySounding(): void {
    this.cancelPending();
    if (this.playing) { this.playing = null; this.options.player.stop(); }
    this.replied = true; this.armed = false;
  }

  /** Hang-up, barge-in or mode change: nothing pending, nothing playing; the next turn starts fresh. */
  reset(): void {
    this.cancelPending();
    if (this.playing) { this.playing = null; this.options.player.stop(); }
    this.replied = false; this.armed = true;
  }

  private cancelPending(): void {
    this.token++;
    if (this.timer !== null && this.timer !== 'choosing') this.options.timers.clear(this.timer);
    this.timer = null;
  }

  private async fire(id: CallFillerId, token: number): Promise<void> {
    if (token !== this.token || !this.armed || this.playing || this.options.replyBusy()) return;
    this.armed = false; this.lastId = id;
    const playing = this.playing = { id, token };
    let started: { ended: Promise<void>; began?: Promise<void> } | null = null;
    try { started = await this.options.player.play(id); } catch { started = null; }
    if (this.playing !== playing) { if (started) this.options.player.stop(); return; } // stopped meanwhile
    if (!started || this.options.replyBusy()) { this.playing = null; if (started) this.options.player.stop(); return; }
    try { this.options.started?.(id); } catch { /* timing only */ }
    void started.ended.finally(() => { if (this.playing === playing) this.playing = null; });
  }
}
