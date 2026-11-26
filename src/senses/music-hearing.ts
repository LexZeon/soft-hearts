/**
 * Whether she hears the music, as the stage is told it (docs/claude/2026-11-22-music-cut-every-10s.md).
 *
 * On 2026-11-22 (Gene in the companion window on the Unbound engine, 「和她一起听」 on) every ~10.1 s
 * the journal had the music verdict go false with why "capture-stopped" 3-7 s after it went true, and her dance tier went to none with
 * it. The capture never stopped: the receiver (src/voice/AudioReadingClient.ts refreshDance) calls a source "dancing" only while a frame
 * came in the last 250 ms, and the host is busy for longer than that now and then (the 一起看 screen frame every 10 s, a clip, a revision
 * of the capture state). Each time the stage was told "not hearing" (setMusicEnabled(false)), and that is a reset of the music recognizer
 * (MusicLikeness.reset): the song started over, and her dance with it.
 *
 * So the stage is told "not hearing" only for a real end:
 *  - stop(): the host says the capture's dance is off (the switch turned off, the capture released or lost) — at once;
 *  - lapse() while the capture is no longer consented (`consented()` false) — at once;
 *  - frames silent for longer than MUSIC_STALL_GRACE_MS — then she really heard nothing (the recognizer's own gap rule is the same
 *    2 s: music-likeness.ts starts over after a gap over 2 s).
 * A stall shorter than that (frames late, the capture state's revision bumped) keeps her hearing; the recognizer fills the missed
 * bins itself, so it sees one continuous stream.
 *
 * Privacy: this never makes her hear anything the capture did not deliver; it only keeps "hearing" from flickering off between frames
 * of a capture that is still on. A frame comes only while the host accepted it under the user's switch.
 */

/** Frames may stop this long (ms) while the capture is on before she stops hearing (music-likeness.ts: a gap over 2 s starts over). */
export const MUSIC_STALL_GRACE_MS = 2_000;

export interface MusicHearingPorts {
  /** Monotonic ms (performance.now). */
  now(): number;
  /** Hearing changed: the stage's setMusicEnabled. */
  enabled(on: boolean): void;
  /** The capture's dance is still on (the user's switch and a live capture). Asked only after a lapse; absent: counted as on. */
  consented?(): boolean;
  /** A timer to look again when the grace runs out (the window); absent: the owner calls tick() each display frame (the full-screen page). */
  schedule?(run: () => void, ms: number): unknown;
  cancel?(handle: unknown): void;
}

export class MusicHearing {
  private heardAt = -Infinity;
  private on = false;
  private stopped = true;
  private lapsed = false;
  private timer: unknown = null;
  private disposed = false;

  constructor(private readonly ports: MusicHearingPorts, private readonly graceMs = MUSIC_STALL_GRACE_MS) {}

  /** She hears now. */
  get hearing(): boolean { return this.on; }

  /** A frame (or the receiver's "frames are coming") reached the stage. */
  frame(): void {
    if (this.disposed) return;
    this.heardAt = this.ports.now(); this.stopped = false; this.lapsed = false;
    this.settle();
  }
  /** The receiver says frames stopped coming: not a stop by itself (a stall); hearing holds while the capture is still consented. */
  lapse(): void { if (this.disposed) return; this.lapsed = true; this.settle(); }
  /** The capture's dance went off (the switch, a release, a loss): hearing ends now. */
  stop(): void { if (this.disposed) return; this.stopped = true; this.settle(); }
  /** Look again (each display frame without a timer, or the timer). */
  tick(): void { if (!this.disposed) this.settle(); }

  dispose(): void {
    if (this.disposed) return;
    this.stopped = true; this.settle(); this.disposed = true; this.clearTimer();
  }

  private wanted(now: number): boolean {
    if (this.stopped || !(now - this.heardAt <= this.graceMs)) return false;
    if (!this.lapsed) return true;
    try { return this.ports.consented?.() ?? true; } catch { return false; }
  }

  private settle(): void {
    const now = this.ports.now(), want = this.wanted(now);
    if (want !== this.on) {
      this.on = want;
      try { this.ports.enabled(want); } catch { /* the stage's own */ }
    }
    if (!want) { this.clearTimer(); return; }
    if (this.timer !== null || !this.ports.schedule) return;
    const wait = Math.max(1, Math.ceil(this.heardAt + this.graceMs - now) + 1);
    this.timer = this.ports.schedule(() => { this.timer = null; this.tick(); }, wait);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    try { this.ports.cancel?.(this.timer); } catch { /* gone */ }
    this.timer = null;
  }
}

/** What the stage takes from the receiver (the window's stage and the old stage alike). */
export interface MusicHearingStage<S> { setMusicEnabled(on: boolean): void; setMusicSample(sample: S): void }

/**
 * The receiver's two callbacks (AudioReadingClient onMusicEnabled / onMusicSample) through MusicHearing, for the window's wiring:
 * the receiver's "on" and every sample are frames, its "off" is a lapse that holds while `consented()` (「和她一起听」 and its capture are on).
 */
export function hearingReceiver<S>(stage: MusicHearingStage<S>, consented: () => boolean,
  clock: Pick<MusicHearingPorts, 'now' | 'schedule' | 'cancel'> = { now: () => performance.now(), schedule: (run, ms) => setTimeout(run, ms), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }) {
  const hearing = new MusicHearing({ ...clock, consented, enabled: on => stage.setMusicEnabled(on) });
  return {
    hearing,
    enabled(active: boolean): void { if (active) hearing.frame(); else hearing.lapse(); },
    sample(sample: S): void { hearing.frame(); if (hearing.hearing) stage.setMusicSample(sample); },
  };
}
