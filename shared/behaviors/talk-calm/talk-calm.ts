/**
 * I-170 (docs/claude/2026-11-21-i170-calm-head-talking.md): how much of the idle's own head motion stays while you two are talking.
 * Each idle layer that moves her head by itself owns one (Unbound's learned idle, src/unbound/motion/unbound-idle.ts; procedural life's
 * head drift and casual tilts, src/stage/procedural-life.ts) and scales only that part by `value`. Whoever feeds it says, each frame,
 * whether a talk signal is on (typing, thinking, preparing, speaking or reading aloud, her reply arriving); it keeps the talk on for
 * `lingerS` after the last one. The value moves on a critically damped spring stepped exactly (any frame rate, the same curve): it
 * starts and stops with zero speed and never jumps. Pure: no clock of its own, only the frames' dt.
 */
import { TALK_CALM_KNOBS, type TalkCalmKnobs } from './knobs';

/** A critically damped spring rises 10–90 % in about 3.36 / ω. */
const OMEGA_PER_RISE = 3.36;

export class TalkCalm {
  private x = 1;
  private v = 0;
  private quietS = Infinity;

  constructor(private readonly knobs: TalkCalmKnobs = TALK_CALM_KNOBS) {}

  /** The idle head scale now (knobs.head while talking .. 1). */
  get value(): number { return this.x; }
  /** Talking now (a signal on, or within the linger after one). */
  get talking(): boolean { return this.quietS <= this.knobs.lingerS; }

  /** One frame: `dt` seconds; `talking`: a talk signal is on this frame. Returns the head scale. */
  frame(dt: number, talking: boolean): number {
    const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
    if (talking) this.quietS = 0; else this.quietS += step;
    const goal = this.talking ? clamp01(this.knobs.head) : 1;
    if (step > 0) {
      const omega = OMEGA_PER_RISE / Math.max(0.05, goal < this.x ? this.knobs.inS : this.knobs.outS);
      const x0 = this.x - goal, j = this.v + omega * x0, e = Math.exp(-omega * step);
      this.x = goal + (x0 + j * step) * e;
      this.v = (this.v - omega * j * step) * e;
      if (Math.abs(this.x - goal) < 1e-5 && Math.abs(this.v) < 1e-4) { this.x = goal; this.v = 0; }
    }
    return this.x;
  }

  /** A new model or owner: back to no talk, full idle. */
  reset(): void { this.x = 1; this.v = 0; this.quietS = Infinity; }
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));

/** The talk signals a stage has (each optional): any one on is talking; the linger after the last one is TalkCalm's. */
export interface TalkSignals { typing?: boolean; thinking?: boolean; preparing?: boolean; speaking?: boolean; waiting?: boolean; reply?: boolean }
export function talkSignal(s: TalkSignals): boolean {
  return s.typing === true || s.thinking === true || s.preparing === true || s.speaking === true || s.waiting === true || s.reply === true;
}
