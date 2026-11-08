/**
 * X-343 (docs/claude/2026-11-07-x343-shy-extend.md): an E1 show's own clock, so 害羞 asked again while it comes in or holds keeps
 * her in the hold and ends about a full show after the latest ask — without replaying its startle and without a pop.
 *
 * Before: a repeat while the show held only raised its strength (show-blend.ts `showRequest` → 'keep'); it still ended on the
 * first ask's schedule (a second shy 1 s in ended at 3 s, Codex X-343), and the next ask after its release restarted it.
 *
 * Now the show's time runs at a rate of 1 against the wall clock until a repeat; then the rate eases (smoothstep) down to 0 so the
 * show comes to rest in its hold — at SHOW_HOLD.pauseMs, where every track is flattest (the head tracks turn there), or, when
 * the ask comes later in the hold, a little after where it is — waits there, and eases back up to 1, so it ends SHOW_MS after
 * the latest ask (never sooner than one ease later). Every track's value is continuous and so is its speed (the rate is), so
 * there is no snap and no speed kink. A single show without a repeat is exactly the wall clock (byte-identical frames).
 *
 * Show time never goes backwards (procedural-life.ts treats a show clock that goes back as a restart and carries the old one out).
 * 惊喜 has no hold (it is a quick 1.9 s reaction), so it is not extended: a repeat while it comes in still only raises its strength.
 * Cap: an ask later than SHOW_HOLD_LATEST_ASK_MS after the show began changes nothing (so a show lasts at most 15 s).
 */
import { SHOW_MS } from './expression-show';
import type { ExpressionRecipe } from '../../shared/expression-preview';

/** Where a recipe rests when asked again (show ms): `pauseMs` the flattest point, `releaseMs` where it starts to let go. */
export const SHOW_HOLD: Readonly<Partial<Record<ExpressionRecipe, { readonly pauseMs: number; readonly releaseMs: number }>>> =
  Object.freeze({ shy: Object.freeze({ pauseMs: 1600, releaseMs: 2200 }) });
/** How long the clock takes to come to rest and to start again (wall ms), and the shortest stop late in the hold. */
export const SHOW_CLOCK_EASE_MS = 300;
export const SHOW_CLOCK_MIN_EASE_MS = 100;
export const SHOW_HOLD_LATEST_ASK_MS = 12_000;

const smooth = (t: number) => t * t * (3 - 2 * t);
/** One piece of the clock from wall `w0`: the rate eases r0 → r1 over `dur` (smoothstep), or stays r0 when they are equal. */
interface Segment { w0: number; s0: number; r0: number; r1: number; dur: number; w1: number; s1: number }

function value(seg: Segment, w: number): number {
  if (seg.r0 === seg.r1) return seg.s0 + seg.r0 * (w - seg.w0);
  const u = Math.min(1, Math.max(0, (w - seg.w0) / seg.dur));
  // ∫ (r0 + (r1 − r0)·smoothstep) = r0·u + (r1 − r0)·(u³ − u⁴/2), times the duration.
  return seg.s0 + seg.dur * (seg.r0 * u + (seg.r1 - seg.r0) * (u * u * u - u * u * u * u / 2));
}
function rate(seg: Segment, w: number): number {
  return seg.r0 === seg.r1 ? seg.r0 : seg.r0 + (seg.r1 - seg.r0) * smooth(Math.min(1, Math.max(0, (w - seg.w0) / seg.dur)));
}

export class ShowClock {
  private readonly segments: Segment[] = [];
  constructor(readonly recipe: ExpressionRecipe) {}
  /** Whether a repeat has moved the end. */
  get extended(): boolean { return this.segments.length > 0; }

  private index(wallMs: number): number {
    for (let i = this.segments.length - 1; i >= 0; i--) if (wallMs >= this.segments[i].w0) return i;
    return -1;
  }
  /** The show's time (ms) `wallMs` after its first frame: the wall time itself until a repeat. Never decreases. */
  at(wallMs: number): number {
    const i = this.index(wallMs);
    if (i < 0) return wallMs;
    const seg = this.segments[i];
    return Math.min(seg.s1, Math.max(seg.s0, value(seg, wallMs)));
  }
  /** The clock's rate (show ms per wall ms) at `wallMs`. */
  rateAt(wallMs: number): number { const i = this.index(wallMs); return i < 0 ? 1 : rate(this.segments[i], wallMs); }

  private push(w0: number, s0: number, r0: number, r1: number, dur: number): Segment {
    const seg: Segment = { w0, s0, r0, r1, dur, w1: Infinity, s1: Infinity };
    if (Number.isFinite(dur)) { seg.w1 = w0 + dur; seg.s1 = value(seg, seg.w1); }
    this.segments.push(seg);
    return seg;
  }

  /**
   * Asked again `wallMs` after the show's first frame (the last frame shown): if the recipe has a hold and the show has not begun
   * to let go, it comes to rest in the hold and ends SHOW_MS after this ask. False (nothing changes) otherwise.
   */
  extend(wallMs: number): boolean {
    const hold = SHOW_HOLD[this.recipe];
    if (!hold || !Number.isFinite(wallMs) || wallMs <= 0 || wallMs > SHOW_HOLD_LATEST_ASK_MS) return false;
    const now = this.at(wallMs);
    if (!(now < hold.releaseMs)) return false;
    const ask = wallMs, ease = SHOW_CLOCK_EASE_MS;
    const i = this.index(wallMs), current = i >= 0 ? this.segments[i] : null;
    let stopW: number, stopS: number;
    if (current && current.r1 === 0 && current.r0 > 0 && wallMs < current.w1) {
      // Already coming to rest: let it, and plan from where it stops.
      this.segments.length = i + 1; stopW = current.w1; stopS = current.s1;
    } else {
      const r = this.rateAt(wallMs);
      this.segments.length = i + 1;
      if (current) { current.w1 = wallMs; current.s1 = now; }
      let w = wallMs, s = now;
      if (r > 0) {
        // On at rate r until an ease brings it to rest exactly at the pause point (if that is still ahead) ...
        if (s + ease * r / 2 < hold.pauseMs) { const cruise = this.push(w, s, r, r, (hold.pauseMs - ease * r / 2 - s) / r); w = cruise.w1; s = cruise.s1; }
        // ... or, later in the hold, to rest by where it starts to let go (a shorter ease, never shorter than the minimum).
        const dur = Math.min(ease, Math.max(SHOW_CLOCK_MIN_EASE_MS, 2 * (hold.releaseMs - s) / r));
        const stop = this.push(w, s, r, 0, dur); w = stop.w1; s = stop.s1;
      }
      stopW = w; stopS = s;
    }
    // Rest, then ease back to the wall's pace: ends at ask + SHOW_MS (resume + ease + SHOW_MS − stopS − ease/2).
    const resume = Math.max(stopW, ask + stopS - ease / 2);
    if (resume > stopW) this.push(stopW, stopS, 0, 0, resume - stopW);
    const start = this.push(resume, stopS, 0, 1, ease);
    this.push(start.w1, start.s1, 1, 1, Infinity);
    return true;
  }
}

/** The wall time (ms after the first frame) at which a clock reaches the end of its show. */
export function showEndWallMs(clock: ShowClock): number {
  const end = SHOW_MS[clock.recipe];
  let lo = 0, hi = end;
  while (clock.at(hi) < end) hi *= 2;
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (clock.at(mid) < end) lo = mid; else hi = mid; }
  return hi;
}
