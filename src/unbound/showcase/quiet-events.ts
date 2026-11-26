/**
 * Unbound showcase, round 9 (docs/claude/2026-11-14-lapwing-showcase-iterations.md): small quick head events while she quietly
 * holds your look — a little flick aside and back, a tiny nod, a change of tilt, a re-glance (eyes off you a moment and back).
 * People do these all the time (the motion-model spike's human data: head speed p95 14.4°/s; our quiet holds were ~4–8°/s).
 *
 * How often and how big follow her liveliness (shared/unbound/showcase.ts, from the mood): lively, one every ~3 s; calm or
 * sleepy, one every ~10 s and smaller. Every event is a smooth bump (S5 in and out, zero speed at both ends) or an eased change
 * of a held offset, so nothing jumps; an event that has started finishes even if the hold ends (it is short), and a new one
 * starts only inside a quiet hold.
 */

const DEG = Math.PI / 180;
const S5 = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 + x * (-15 + 6 * x)); };
/** Out and back: 0 at both ends with zero speed, 1 in the middle. */
const bump = (u: number) => Math.sin(Math.PI * S5(u));

export type QuietEventKind = 'flick' | 'nod' | 'tilt' | 'reglance';
export interface QuietEventFrame {
  /** Head turn (rad, + = her left), extra nod (rad, + = down), extra tilt (rad, + = toward her left shoulder). */
  yaw: number; pitch: number; roll: number;
  /** A re-glance: where her eyes go off you for a moment (rad, added to the look at you). */
  glance: { yaw: number; pitch: number };
  /** The event playing now (null between events). */
  kind: QuietEventKind | null;
  /**
   * Round 10: how much of the learned idle to keep (0.15..1). People hold still between small moves (14.7% of the time in the
   * motion-model spike's human data, ours 4%): in a still window the idle eases down to 15% within ~0.15 s and back over ~0.35 s.
   */
  idleScale: number;
  /** In a still window now. */
  still: boolean;
}

/** Events per second at liveliness g (0..1). */
export const quietEventRate = (g: number) => 0.08 + 0.7 * Math.max(0, Math.min(1, g)) ** 1.5;
/** Round 10: still windows per second that start on their own (calmer: more), besides the one that often follows an event. */
export const quietStillRate = (g: number) => 0.1 + 0.6 * (1 - Math.max(0, Math.min(1, g)));
/** The idle kept in a still window; how fast it goes down and comes back (s): quick for a lively mood, slower for a calm one (whose
 * settling should not itself read as a move). */
const STILL_KEEP = 0.15, STILL_IN_S = (g: number) => 0.15 + 0.35 * (1 - g), STILL_OUT_S = (g: number) => 0.35 + 0.5 * (1 - g);

export class QuietHeadEvents {
  private t = 0;
  private next: number;
  private current: { kind: QuietEventKind; at: number; dur: number; amp: number; side: 1 | -1; pitch: number } | null = null;
  private readonly tilt = { from: 0, to: 0, at: -10 };
  private readonly random: () => number;
  /** Events started (for tests and the log). */
  readonly started: { kind: QuietEventKind; at: number }[] = [];
  /** Round 10: still windows (start, length; for tests and the log). */
  readonly stills: { at: number; dur: number }[] = [];
  private stillWin: { at: number; dur: number; from: number } | null = null;
  private stillEnded = -10;
  private nextStill: number;
  private readonly stillRandom: () => number;

  constructor(seed: number, private readonly liveliness: number) {
    const stream = (salt: number) => {
      let s = (Math.floor(seed * 2 ** 31) ^ salt) >>> 0;
      return () => { s = (s + 0x6d2b79f5) >>> 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    };
    this.random = stream(0x5bd1e995);
    this.stillRandom = stream(0x27d4eb2f); // its own stream: the events stay as they were drawn
    this.next = 1.5 + this.gap();
    this.nextStill = 1.5 + this.stillGap();
  }

  private gap(): number { return -Math.log(1 - this.random() * 0.98) / quietEventRate(this.liveliness); }
  private stillGap(): number { return -Math.log(1 - this.stillRandom() * 0.98) / quietStillRate(this.liveliness); }
  private startStill(): void {
    const g = Math.max(0, Math.min(1, this.liveliness));
    const from = this.idleScale();
    this.stillWin = { at: this.t, dur: 0.5 + 0.6 * (1 - g) + this.stillRandom() * (0.7 + 0.9 * (1 - g)), from }; // lively ~0.6–1.5 s, calm ~1–2.4 s
    this.stills.push({ at: this.stillWin.at, dur: this.stillWin.dur });
  }
  private endStill(): void { this.stillLow = this.idleScale(); this.stillWin = null; this.stillEnded = this.t; }
  /** The idle kept now: from where it was down to STILL_KEEP within STILL_IN_S of a window's start; back to 1 over STILL_OUT_S after. */
  private idleScale(): number {
    const w = this.stillWin;
    const g = Math.max(0, Math.min(1, this.liveliness));
    if (w) return w.from + (STILL_KEEP - w.from) * S5((this.t - w.at) / STILL_IN_S(g));
    return this.stillLow + (1 - this.stillLow) * S5((this.t - this.stillEnded) / STILL_OUT_S(g));
  }
  /** Where the idle was when the last still window ended (a window cut short comes back from there). */
  private stillLow = 1;

  private tiltNow(): number { return this.tilt.from + (this.tilt.to - this.tilt.from) * S5((this.t - this.tilt.at) / 0.6); }

  /** One frame: `quiet` says she is in a quiet hold (only then does a new event start; a held tilt eases back outside it). */
  frame(dt: number, quiet: boolean, stills = true): QuietEventFrame {
    this.t += Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    const g = Math.max(0, Math.min(1, this.liveliness)), size = 0.6 + 0.6 * g;
    if (!quiet && this.tilt.to !== 0 && this.t - this.tilt.at > 0.6) { this.tilt.from = this.tiltNow(); this.tilt.to = 0; this.tilt.at = this.t; }
    // Round 10: still windows. One ends on its own time, or as soon as the quiet hold does; a new one starts on its own clock or
    // right after a small move (move, then still), never during a move.
    if (this.stillWin && (!quiet || !stills || this.t - this.stillWin.at >= this.stillWin.dur)) this.endStill();
    if (stills && !this.stillWin && !this.current && quiet && this.t >= this.nextStill) { this.startStill(); this.nextStill = this.t + this.stillWin!.dur + this.stillGap(); }
    if (!this.current && this.t >= this.next && this.stillWin) this.next = this.stillWin.at + this.stillWin.dur + 0.05; // a move comes after the stillness
    if (!this.current && this.t >= this.next) {
      if (!quiet) this.next = this.t + 0.4; // wait for the next quiet moment
      else {
        const r = this.random(), kind: QuietEventKind = r < 0.35 ? 'flick' : r < 0.6 ? 'nod' : r < 0.8 ? 'tilt' : 'reglance';
        const side: 1 | -1 = this.random() < 0.5 ? 1 : -1, amp = this.random();
        const dur = kind === 'flick' ? 0.55 - 0.15 * g : kind === 'nod' ? 0.6 - 0.1 * g : kind === 'tilt' ? 0.6 : 0.75;
        this.current = { kind, at: this.t, dur, amp, side, pitch: this.random() * 2 - 1 };
        this.started.push({ kind, at: this.t });
        if (kind === 'tilt') {
          // A new resting tilt, to the other side from the last one more often than not.
          const away = this.tilt.to !== 0 && this.random() < 0.7 ? -Math.sign(this.tilt.to) : side;
          this.tilt.from = this.tiltNow(); this.tilt.to = away * (3 + 3 * amp) * size * DEG; this.tilt.at = this.t;
        }
      }
    }
    const out: QuietEventFrame = { yaw: 0, pitch: 0, roll: this.tiltNow(), glance: { yaw: 0, pitch: 0 }, kind: this.current?.kind ?? null, idleScale: this.idleScale(), still: !!this.stillWin };
    const e = this.current;
    if (e) {
      const u = (this.t - e.at) / e.dur;
      if (e.kind === 'flick') out.yaw = e.side * (4 + 4 * e.amp) * size * DEG * bump(u);
      else if (e.kind === 'nod') out.pitch = (3 + 2.5 * e.amp) * size * DEG * bump(u);
      else if (e.kind === 'reglance') {
        // Quick off, a moment away, back: a flat-topped bump.
        const v = S5(u / 0.25) * (1 - S5((u - 0.65) / 0.35));
        out.glance = { yaw: e.side * (6 + 3 * e.amp) * DEG * v, pitch: 3 * e.pitch * DEG * v };
        out.yaw = 0.25 * out.glance.yaw; // the head goes a little way with the eyes
      }
      if (u >= 1) {
        this.current = null; this.next = this.t + this.gap();
        // Move, then still: after a small move she often holds (a lively mood a little less often).
        if (stills && quiet && this.stillRandom() < 0.75 - 0.25 * g) this.startStill();
      }
    }
    return out;
  }
}
