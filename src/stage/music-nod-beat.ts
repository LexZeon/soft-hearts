/**
 * 2026-11-24: the nod's own beat. Before this the nod's
 * phase ran free at the dance engine's tempo (music-dance.ts: "a comfortable loop ... without estimating a song's BPM"), so its chin-down
 * moments sat wherever the loop happened to be, not on the kicks. Here a phase runs at the beat and is pulled onto the kicks it hears (a
 * phase-locked loop, the idea of music-react/beat-clock.ts, own code): a kick on the beat moves the phase by a share of its error, spread
 * over a few frames (never a jump); kicks that keep agreeing raise the lock, and the nod shows only as far as it is locked, so she starts
 * nodding once she has found the beat and keeps the remembered beat a while through a passage without kicks.
 *
 * Pure: no clock of its own (the caller advances it by the frame's delta and tells it when a kick came), no allocation per frame.
 */

export const NOD_BEAT = Object.freeze({
  /** The beat period assumed before two kicks agreed (s). */
  startPeriod: 0.55,
  /** The nod's period is folded into this range (s): a fast song nods every other beat. */
  minNod: 0.4, maxNod: 1.0,
  /** Kick intervals taken as one beat (s). */
  minInterval: 0.25, maxInterval: 1.2,
  /** How far (share of the beat) a kick may sit from a predicted beat and still count as on it. */
  match: 0.22,
  /** Share of a matched kick's error corrected, and the fastest a correction is spread (cycles of the nod per second). */
  gain: 0.5, slew: 0.8,
  /** The lock: added per kick on the beat, taken per kick off it, its fade without kicks (s), and how fast the shown share follows it (per s). */
  lockUp: 0.34, lockDown: 0.25, lockFadeS: 8, shareRate: 1.5,
});

const wrapHalf = (x: number) => x - Math.round(x);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export class NodBeat {
  private clock = 0;
  private lastKick = Number.NaN;
  private period = 0;
  private pendingInterval = 0;
  /** 0..1, one cycle per nod; the beat is at 0. */
  private phase = 0;
  private pendingShift = 0;
  private lock = 0;
  private shown = 0;
  private kicks = 0;
  private matched = 0;

  /** The beat period (s), or the start value before two kicks agreed. */
  get beatPeriod(): number { return this.period || NOD_BEAT.startPeriod; }
  /** The nod's period (s): the beat, or two beats for a fast song. */
  get nodPeriod(): number { const p = this.beatPeriod; return p < NOD_BEAT.minNod ? p * 2 : p > NOD_BEAT.maxNod ? p / 2 : p; }
  /** 0..1: how much of the nod shows (eased toward the lock). */
  get share(): number { return this.shown; }
  get locked(): number { return this.lock; }

  /** A kick (the dance engine's pulse) now. */
  kick(): void {
    const t = this.clock, interval = t - this.lastKick;
    this.lastKick = t; this.kicks++;
    if (Number.isFinite(interval) && interval >= NOD_BEAT.minInterval && interval <= NOD_BEAT.maxInterval) this.notePeriod(interval);
    const perNod = Math.max(1, Math.round(this.nodPeriod / this.beatPeriod));
    const error = wrapHalf(this.phase * perNod) / perNod; // in nod cycles; + = the phase is past the beat
    if (this.kicks > 1 && Math.abs(error) * this.nodPeriod <= NOD_BEAT.match * this.beatPeriod) {
      this.pendingShift = -NOD_BEAT.gain * error;
      this.lock = Math.min(1, this.lock + NOD_BEAT.lockUp); this.matched++;
    } else if (this.shown < 0.02) { this.phase = 0; this.pendingShift = 0; this.lock = 0; } // nothing shows yet: this kick is the beat (no jump on screen)
    else this.lock = Math.max(0, this.lock - NOD_BEAT.lockDown);
  }

  /** One frame. */
  advance(delta: number): void {
    const dt = Number.isFinite(delta) ? Math.max(0, Math.min(0.25, delta)) : 0;
    if (dt === 0) return;
    this.clock += dt;
    const slew = Math.sign(this.pendingShift) * Math.min(Math.abs(this.pendingShift), NOD_BEAT.slew * dt);
    this.pendingShift -= slew;
    this.phase = ((this.phase + dt / this.nodPeriod + slew) % 1 + 1) % 1;
    this.lock *= Math.exp(-dt / NOD_BEAT.lockFadeS);
    const target = this.lock * this.lock * (3 - 2 * this.lock), step = NOD_BEAT.shareRate * dt;
    this.shown = clamp01(this.shown + Math.max(-step, Math.min(step, target - this.shown)));
  }

  /**
   * 0..1: how far the chin is down now, 1 on the beat. `lagCycles`: how late the caller's follower shows it (in nod cycles), so after
   * that lag the lowest point lands on the kick.
   */
  dip(lagCycles = 0): number { return 0.5 + 0.5 * Math.cos(2 * Math.PI * (this.phase + lagCycles)); }

  reset(): void {
    this.clock = 0; this.lastKick = Number.NaN; this.period = 0; this.pendingInterval = 0; this.phase = 0; this.pendingShift = 0;
    this.lock = 0; this.shown = 0; this.kicks = 0; this.matched = 0;
  }

  getState() { return { period: this.beatPeriod, nodPeriod: this.nodPeriod, phase: this.phase, lock: this.lock, share: this.shown, kicks: this.kicks, matched: this.matched }; }

  private notePeriod(interval: number): void {
    const p = this.period;
    if (!p) { this.period = interval; return; }
    // A missed kick (two beats) counts as two; an off-beat kick (half a beat) is not a tempo.
    const value = Math.abs(interval - 2 * p) <= 0.15 * p ? interval / 2 : interval;
    if (Math.abs(value - p) <= 0.3 * p) { this.period = p + (value - p) * 0.3; this.pendingInterval = 0; return; }
    if (Math.abs(interval - p / 2) <= 0.15 * p) return;
    // A new tempo: taken once two intervals in a row agree on it.
    if (this.pendingInterval && Math.abs(interval - this.pendingInterval) <= 0.1 * this.pendingInterval) { this.period = (interval + this.pendingInterval) / 2; this.pendingInterval = 0; }
    else this.pendingInterval = interval;
  }
}

/** How late (in cycles) a critically damped follower of rate `omega` (1/s) shows a sine of period `periodS`: its phase lag. */
export function followerLagCycles(omega: number, periodS: number): number {
  if (!(omega > 0) || !(periodS > 0)) return 0;
  return 2 * Math.atan((2 * Math.PI / periodS) / omega) / (2 * Math.PI);
}
