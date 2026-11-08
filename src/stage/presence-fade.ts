/**
 * C2 换成她: when the model changes, the one on stage fades out while she keeps moving (never frozen, never cut),
 * then the new one fades in once her pose and motions are in place. Driven by the stage's own frame deltas, like a
 * keyframe tween: smoothstep between the two values, so the fade starts and ends at zero speed (R29: no jump, no
 * one-frame cut). A fade that changes direction starts from the value shown now.
 * Pure: no DOM; MmdStage applies the value to its canvas.
 */
export const PRESENCE_FADE_OUT_MS = 320;
export const PRESENCE_FADE_IN_MS = 420;

const smoothstep = (p: number) => p * p * (3 - 2 * p);

export class PresenceFade {
  private shown = 1;
  private from = 1;
  private to = 1;
  private elapsedMs = 0;
  private durationMs = 0;
  private waiters: (() => void)[] = [];

  /** The opacity on screen now (0 hidden, 1 fully there). */
  get value(): number { return this.shown; }
  /** Where the current fade is going. */
  get target(): number { return this.to; }
  get fading(): boolean { return this.shown !== this.to; }

  /** Fade from what is shown now to `to` over `ms`; resolves `whenDone` waiters when it gets there. */
  fadeTo(to: number, ms: number): void {
    const target = Math.min(1, Math.max(0, to));
    this.from = this.shown; this.to = target; this.elapsedMs = 0; this.durationMs = Math.max(0, ms);
    if (this.from === target || this.durationMs === 0) { this.shown = target; this.resolve(); }
  }
  /** Set without a fade (only while nothing of her is on screen). */
  set(value: number): void {
    this.shown = this.from = this.to = Math.min(1, Math.max(0, value));
    this.elapsedMs = this.durationMs = 0;
    this.resolve();
  }
  /** One display frame of `deltaSeconds`; returns the opacity to show. */
  frame(deltaSeconds: number): number {
    if (this.shown === this.to) return this.shown;
    this.elapsedMs += Math.max(0, deltaSeconds) * 1000;
    const progress = this.durationMs ? Math.min(1, this.elapsedMs / this.durationMs) : 1;
    this.shown = progress >= 1 ? this.to : this.from + (this.to - this.from) * smoothstep(progress);
    if (this.shown === this.to) this.resolve();
    return this.shown;
  }
  /** Not on screen (hidden window): nothing can be seen, so the fade simply arrives. */
  settle(): void { if (this.shown !== this.to) { this.shown = this.to; this.resolve(); } }
  /** Resolves when the current fade has arrived (immediately when none is running). */
  whenDone(): Promise<void> {
    if (this.shown === this.to) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }
  private resolve(): void { const waiters = this.waiters; this.waiters = []; for (const waiter of waiters) waiter(); }
}
