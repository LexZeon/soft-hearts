/**
 * Unbound U2 experiment E2: a fake mood port (writeback.ts AutonomyMoodPort). Never her real mood.
 *
 * Her mood = a given curve (the day simulation's synthetic day, or a fixed reading in tests) plus what her own movement wrote,
 * each write fading back toward the curve with a per-channel half-life (a stand-in for the real mood's return to baseline: N
 * fastest, E slowest; first picks, stated in the record). Every write is kept in `writes` so a test can look at each one.
 */
import type { MoodValues } from '../../foundation/mood';
import type { MoodReading } from '../director';
import type { AutonomyMoodPort, AutonomyWriteKind } from './writeback';

/** Half-life of a write (minutes), per channel; A is the fake sleep-pressure nudge. */
export const FAKE_HALF_LIFE_MIN = Object.freeze({ D: 30, O: 30, E: 45, N: 8, C: 20, A: 120 });

type Offsets = { D: number; O: number; E: number; N: number; C: number; A: number };

export class FakeMoodPort implements AutonomyMoodPort {
  private readonly offsets: Offsets = { D: 0, O: 0, E: 0, N: 0, C: 0, A: 0 };
  private now: number;
  readonly writes: { at: number; kind: AutonomyWriteKind | 'sleep-pressure'; delta: Partial<MoodValues> & { A?: number } }[] = [];
  /** The largest offset each channel reached (what her movement added on top of the curve at most). */
  readonly peak: Offsets = { D: 0, O: 0, E: 0, N: 0, C: 0, A: 0 };

  constructor(private readonly curve: (at: number) => MoodReading | null, start: number) { this.now = start; }

  /** Time passes: every offset fades toward 0. */
  advance(to: number): void {
    const minutes = (to - this.now) / 60_000;
    if (!(minutes > 0)) return;
    this.now = to;
    for (const key of Object.keys(this.offsets) as (keyof Offsets)[]) this.offsets[key] *= Math.pow(0.5, minutes / FAKE_HALF_LIFE_MIN[key]);
  }
  get offset(): Readonly<Offsets> { return this.offsets; }

  read(): MoodReading | null {
    const base = this.curve(this.now);
    if (!base) return null;
    const c = (v: number) => Math.min(100, Math.max(0, v));
    return { ...base, D: c(base.D + this.offsets.D), O: c(base.O + this.offsets.O), E: c(base.E + this.offsets.E), N: c(base.N + this.offsets.N), C: c(base.C + this.offsets.C),
      A: Math.min(1, Math.max(0, base.A + this.offsets.A)) };
  }

  lift(kind: AutonomyWriteKind, delta: Partial<MoodValues>, at: number): void {
    this.advance(at);
    for (const [key, amount] of Object.entries(delta) as [keyof MoodValues, number][]) {
      this.offsets[key] += amount;
      this.peak[key] = Math.max(this.peak[key], this.offsets[key]);
    }
    this.writes.push({ at, kind, delta: { ...delta } });
  }

  nudgeSleepPressure(amount: number, at: number): void {
    this.advance(at);
    this.offsets.A += amount;
    this.peak.A = Math.max(this.peak.A, this.offsets.A);
    this.writes.push({ at, kind: 'sleep-pressure', delta: { A: amount } });
  }
}
