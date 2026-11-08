/**
 * A "pause listening while she speaks" that is allowed to last only as long as speaking can: the last line of defence behind
 * the per-flag leases (2026-11-06, 朗读过后听不见了 / 和她一起听答不上来). Whatever the cause — a reading that never reported its
 * end, a window that never said "stopped", a flag nobody thought of — a pause that has been on without a break for `maxMs` is
 * let go, reported once, and stays let go until the raw condition goes off at least once (then it is trusted again).
 */
export const PAUSE_MAX_MS = 10 * 60_000;

export class PauseGuard {
  private since: number | null = null;
  private forced = false;
  constructor(private readonly onForced: () => void, private readonly maxMs = PAUSE_MAX_MS) {}
  /** The raw "should be paused" in, the effective "is paused" out. Call it whenever the raw condition is evaluated and from a slow timer. */
  observe(raw: boolean, now: number): boolean {
    if (!raw) { this.since = null; this.forced = false; return false; }
    if (this.forced) return false;
    this.since ??= now;
    if (now - this.since < this.maxMs) return true;
    this.forced = true;
    try { this.onForced(); } catch { /* a journal problem never changes listening */ }
    return false;
  }
}
