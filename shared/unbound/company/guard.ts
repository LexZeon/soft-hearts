/**
 * I-209 step 1: the frame-cost guard for several characters on stage (plan v2: "撑不住就自动少放一个"). Pure: frame intervals in, a
 * verdict out; the page reports it and the host sends one extra back (electron/unbound/company/host.ts), saying so in the panel.
 *
 * It reads frames the way the quality tier's watcher does (shared/unbound/perf-tiers.ts AdaptDown): one second at a time, a second is bad
 * when its p95 lateness is over OVER_BUDGET (the asked rate, so the quiet 30 fps is never "late"). It is quicker than the tier's watcher
 * (four of the last five seconds, against nine of ten), so with company on stage an extra goes back before her look gets coarser; with
 * nobody else on stage it never acts and the tier's rules are exactly as before. A load, a fade or a new arrival is not a slow machine:
 * every change of who is on stage starts a grace period, and frames longer than STALL_MS (a hitch, a hidden window) are left out.
 */
import { OVER_BUDGET, STALL_MS, lateness, percentile } from '../perf-tiers';

export const COMPANY_GUARD_KNOBS = Object.freeze({
  /** Seconds watched, and how many of them must be bad. */
  windowS: 5, badS: 4,
  /** After anyone arrives, leaves or finishes loading (ms). */
  graceMs: 4_000,
});

export interface CompanyGuardVerdict {
  /** How many were on stage (the one you talk with and the extras) while the frames were late. */
  present: number;
  /** The worst bad second's p95 frame interval (ms) and the budget it was over (ms). */
  p95Ms: number; budgetMs: number;
}

export class CompanyGuard {
  private bin: number[] = [];
  private binMs: number[] = [];
  private binStart = 0;
  private bad: { bad: boolean; p95Ms: number }[] = [];
  private graceUntil = 0;
  private presentNow = 1;
  private lastFps = 0;

  constructor(private readonly k = COMPANY_GUARD_KNOBS) {}

  /** Who is on stage changed (or someone finished loading): forget the frames so far and wait a moment. */
  changed(now: number, present: number): void {
    this.presentNow = Math.max(1, Math.floor(present));
    this.bin = []; this.binMs = []; this.bad = []; this.binStart = 0; this.graceUntil = now + this.k.graceMs;
  }

  /**
   * A drawn frame `intervalMs` after the previous one, asked at `fps`. Returns a verdict when the extras should be one fewer (the caller
   * reports it once and calls `changed` when the host's answer arrives), else null. With only the one you talk with: always null.
   */
  feed(now: number, intervalMs: number, fps: number): CompanyGuardVerdict | null {
    const rateChanged = fps !== this.lastFps;
    this.lastFps = fps;
    if (this.presentNow <= 1 || now < this.graceUntil || rateChanged || !(intervalMs > 0) || intervalMs >= STALL_MS || !(fps > 0)) return null;
    if (!this.binStart) this.binStart = now;
    if (now - this.binStart >= 1_000) {
      if (this.bin.length) {
        const p95 = percentile(this.bin, 0.95) ?? 0;
        this.bad.push({ bad: p95 > OVER_BUDGET, p95Ms: percentile(this.binMs, 0.95) ?? 0 });
        if (this.bad.length > this.k.windowS) this.bad.shift();
      }
      this.bin = []; this.binMs = []; this.binStart = now;
    }
    this.bin.push(lateness(intervalMs, fps)); this.binMs.push(intervalMs);
    const bad = this.bad.filter(second => second.bad);
    if (this.bad.length < this.k.windowS || bad.length < this.k.badS) return null;
    const verdict = { present: this.presentNow, p95Ms: Math.round(Math.max(...bad.map(second => second.p95Ms)) * 10) / 10, budgetMs: Math.round(1000 / fps * OVER_BUDGET * 10) / 10 };
    this.changed(now, this.presentNow); // one verdict per bad stretch; the host's answer sets who is left
    return verdict;
  }
}
