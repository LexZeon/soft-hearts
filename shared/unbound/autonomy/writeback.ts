/**
 * Unbound U2 experiment E2: what moving does to her mood (the WRITE half; READ is choose.ts). docs/claude/2026-11-14-unbound-night-e2-autonomy.md.
 *
 * Only through a port (AutonomyMoodPort). The experiment's port is fake (fake-mood.ts); nothing here touches her real mood. The
 * rules are the mood moments' own (shared/foundation/mood-moments.ts): small amounts (1–3 points before the card's sensitivity, a fraction
 * of one chat tail), each family with a cooldown and a day count (MoodMomentGate), and relative scaling (a channel already far
 * past her baseline in the same direction gets less, then nothing: relativeMomentDelta). So a hop that makes her happier cannot
 * make her hop forever: the lift shrinks as D climbs, the family is capped, and N (the one that rises fastest) decays in minutes.
 *
 * WRITE (the design doc's table):
 *   moving hard (exertion)         → N up while she moves               act-exert     N +2.5 × exertion
 *   after she stops                → E slowly up (the after-exercise ease) act-afterglow E +2 × exertion, 60–120 s later
 *                                  → A a little up (tired)              fake port only: +0.01 × exertion (see the record: the real
 *                                                                        fatigue model has no such input, and the mood moments never write A)
 *   a hop landed / a dance done    → D a little up                      act-done      D +1
 *   nearly lost her balance        → N spikes, C a little up            act-wobble    N +3, C +1
 * Never O (answering her is the interaction's own lift), never B or M.
 */
import { MoodMomentGate, relativeMomentDelta, type MoodMomentSpec } from '../../foundation/mood-moments';
import type { MoodValues } from '../../foundation/mood';
import type { MoodReading } from '../director';
import { ACTS, type AutonomyAct } from './choose';

export const AUTONOMY_WRITE_KINDS = ['act-exert', 'act-afterglow', 'act-done', 'act-wobble'] as const;
export type AutonomyWriteKind = (typeof AUTONOMY_WRITE_KINDS)[number];

const MINUTE = 60_000;
/** Mood-moment specs (delta at full exertion; the writer scales exert and afterglow by the act's exertion). */
export const AUTONOMY_WRITES: Readonly<Record<AutonomyWriteKind, MoodMomentSpec & { readonly scaleByExertion: boolean }>> = Object.freeze({
  'act-exert': { delta: { N: 2.5 }, group: 'unbound-exert', cooldownMs: 10 * MINUTE, perDay: 12, keepReason: true, scaleByExertion: true },
  'act-afterglow': { delta: { E: 2 }, group: 'unbound-afterglow', cooldownMs: 20 * MINUTE, perDay: 8, keepReason: true, scaleByExertion: true },
  'act-done': { delta: { D: 1 }, group: 'unbound-done', cooldownMs: 15 * MINUTE, perDay: 8, keepReason: false, context: 'positive', scaleByExertion: false },
  'act-wobble': { delta: { N: 3, C: 1 }, group: 'unbound-wobble', cooldownMs: 10 * MINUTE, perDay: 6, keepReason: true, scaleByExertion: false },
});
export const AUTONOMY_WRITE_KNOBS = Object.freeze({
  /** Acts below this exertion write nothing (a sway or a fidget is not exercise). */
  minExertion: 0.2,
  /** The afterglow comes this long after she stops (ms, random within). */
  afterglowDelayMs: [60_000, 120_000] as const,
  /** Fake port only: sleep pressure per unit of exertion, and at most this much a day. */
  fatiguePerExertion: 0.01,
  fatiguePerDay: 0.05,
});

/** Where the writes go. The experiment's is fake; a real one would call the mood moments (MoodHost.lift) with these kinds. */
export interface AutonomyMoodPort {
  /** Her mood now (levels relative to the card's baseline, as the peek reads it). */
  read(): MoodReading | null;
  /** A lift already gated and scaled here. */
  lift(kind: AutonomyWriteKind, delta: Partial<MoodValues>, at: number): void;
  /** Experiment only: a nudge to sleep pressure (the real fatigue model has no input for it; not wired anywhere real). */
  nudgeSleepPressure?(amount: number, at: number): void;
}

/** What the body reports when an act ends. */
export interface ActOutcome {
  act: AutonomyAct;
  /** It ran to its end (a hop landed, a stretch finished); false when it wound down early (cancelled, afraid). */
  completed: boolean;
  /** Her COM went out of (or within a hair of) her support at some point: she nearly lost her balance. */
  wobble: boolean;
}

const BASELINE: MoodValues = Object.freeze({ D: 50, O: 50, E: 50, N: 50, C: 50 }) as MoodValues;

export class AutonomyWriter {
  private readonly gate = new MoodMomentGate();
  private readonly pending: { at: number; kind: AutonomyWriteKind; act: AutonomyAct }[] = [];
  private fatigueDay = '';
  private fatigueToday = 0;
  /** Every write that went through (for the simulation's tables and the tests). */
  readonly log: { at: number; kind: AutonomyWriteKind; act: AutonomyAct; delta: Partial<MoodValues> }[] = [];
  constructor(private readonly port: AutonomyMoodPort, private readonly characterId = 'experiment', private readonly knobs = AUTONOMY_WRITE_KNOBS) {}

  /** She starts an act: moving hard brings N up now. */
  started(act: AutonomyAct, now: number): void {
    if (ACTS[act].exertion >= this.knobs.minExertion) this.write('act-exert', act, now);
  }

  /** The act ended (`random` places the afterglow inside its window). */
  ended(outcome: ActOutcome, now: number, random: () => number): void {
    const spec = ACTS[outcome.act];
    if (outcome.wobble) this.write('act-wobble', outcome.act, now);
    if (outcome.completed && spec.achievement && !outcome.wobble) this.write('act-done', outcome.act, now);
    if (spec.exertion >= this.knobs.minExertion) {
      const [lo, hi] = this.knobs.afterglowDelayMs;
      this.pending.push({ at: now + lo + (hi - lo) * Math.min(1, Math.max(0, random())), kind: 'act-afterglow', act: outcome.act });
      this.fatigue(spec.exertion, now);
    }
  }

  /** Delayed writes that are due (call it as time passes). */
  advance(now: number): void {
    for (let i = 0; i < this.pending.length;) {
      const p = this.pending[i];
      if (p.at <= now) { this.pending.splice(i, 1); this.write(p.kind, p.act, now); } else i++;
    }
  }

  private write(kind: AutonomyWriteKind, act: AutonomyAct, now: number): void {
    const spec = AUTONOMY_WRITES[kind], mood = this.port.read();
    if (!mood || !this.gate.allows(this.characterId, spec, now)) return;
    const scale = spec.scaleByExertion ? ACTS[act].exertion : 1;
    const raw: Partial<MoodValues> = {};
    for (const [key, amount] of Object.entries(spec.delta) as [keyof MoodValues, number][]) raw[key] = amount * scale;
    // Levels (50 = her baseline) read as values over a 50 baseline: relativeMomentDelta's own scaling, unchanged.
    const levels: MoodValues = { D: mood.D, O: mood.O, E: mood.E, N: mood.N, C: mood.C };
    const delta = relativeMomentDelta(raw, levels, BASELINE);
    if (!Object.keys(delta).length) return;
    this.gate.take(this.characterId, spec, now);
    this.port.lift(kind, delta, now);
    this.log.push({ at: now, kind, act, delta });
  }

  private fatigue(exertion: number, now: number): void {
    if (!this.port.nudgeSleepPressure) return;
    const day = new Date(now).toDateString();
    if (day !== this.fatigueDay) { this.fatigueDay = day; this.fatigueToday = 0; }
    const amount = Math.min(this.knobs.fatiguePerExertion * exertion, this.knobs.fatiguePerDay - this.fatigueToday);
    if (amount <= 0) return;
    this.fatigueToday += amount;
    this.port.nudgeSleepPressure(amount, now);
  }
}
