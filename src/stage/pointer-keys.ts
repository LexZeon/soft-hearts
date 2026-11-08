/**
 * R29f: the cursor as keyframes. The host reads the screen cursor about every 100 ms (src/main.ts pointerTimer),
 * so the gaze target used to be a 10 Hz staircase: at each reading the eyes (first-order follow) jumped to full
 * speed and slowed down again, ten times a second, while the cursor itself moved steadily. Each reading is a key
 * here; the target the gaze follows goes in a straight line from where it is shown now to the newest key, over
 * the time the previous reading took (stage clock, bounded). A steadily moving cursor gives a steady speed, at
 * the cost of one reading of lag (~0.1 s; the head already lags 0.2 s).
 *
 * The first reading is taken at once (nothing was following yet). Pure, allocation-free.
 */
export const POINTER_KEY_SPAN_S = Object.freeze({ min: 0.05, max: 0.25, first: 0.1 });

export class PointerKeys {
  /** The target shown this frame. */
  readonly shown = { x: 0, y: 0 };
  private readonly from = { x: 0, y: 0 };
  private readonly to = { x: 0, y: 0 };
  private started = false;
  private elapsed = 0;
  private span: number = POINTER_KEY_SPAN_S.first;
  /** Stage time since the previous reading. */
  private sinceKey = 0;

  /** One display frame: `x`, `y` is the latest reading (the same values until the next one arrives). */
  frame(delta: number, x: number, y: number): Readonly<{ x: number; y: number }> {
    const dt = Number.isFinite(delta) ? Math.min(0.1, Math.max(0, delta)) : 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return this.shown;
    if (!this.started) {
      this.started = true;
      this.shown.x = this.from.x = this.to.x = x; this.shown.y = this.from.y = this.to.y = y;
      return this.shown;
    }
    this.sinceKey += dt;
    if (x !== this.to.x || y !== this.to.y) {
      this.span = Math.min(POINTER_KEY_SPAN_S.max, Math.max(POINTER_KEY_SPAN_S.min, this.sinceKey - dt || POINTER_KEY_SPAN_S.first));
      this.sinceKey = dt;
      this.from.x = this.shown.x; this.from.y = this.shown.y;
      this.to.x = x; this.to.y = y;
      this.elapsed = 0;
    }
    this.elapsed += dt;
    const k = Math.min(1, this.elapsed / this.span);
    this.shown.x = this.from.x + (this.to.x - this.from.x) * k;
    this.shown.y = this.from.y + (this.to.y - this.from.y) * k;
    return this.shown;
  }

  reset(): void { this.started = false; this.elapsed = 0; this.sinceKey = 0; this.span = POINTER_KEY_SPAN_S.first; }
}
