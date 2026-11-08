import { dampCritical } from './procedural';

/**
 * I-024 睡姿 (docs/claude/2026-11-04-i024-stage.md): her sleep posture as one separate additive layer.
 * Pure: in goes the fatigue phase, whether the layer may show this frame (the stage's owner gates), and
 * the frame time; out come small neck/head rotation offsets (x > 0 lowers the chin, z rolls the head to
 * her side), how her breath changes (lighter and slower), and one wake blink after she wakes up.
 *
 * Motion rules (R29): depth and the yield weight are critically damped springs, so a phase change or an
 * owner taking the head changes the speed smoothly instead of the pose. Falling asleep settles slowly;
 * waking (or stirring at micro-awake) lifts the head a little faster but still slowly. Nothing here
 * touches PMX/VMD data: the stage writes the offsets through its remembered/restored program layer.
 */

export type SleepPhase = 'awake' | 'light-drowsy' | 'drowsy' | 'falling-asleep' | 'asleep' | 'micro-awake';

/** How far into the sleep posture each phase is (0 upright, 1 asleep). Unknown or missing phase = 0. */
export const SLEEP_POSE_DEPTH: Readonly<Record<SleepPhase, number>> = Object.freeze({
  awake: 0, 'light-drowsy': 0, drowsy: 0, 'falling-asleep': 0.22, asleep: 1, 'micro-awake': 0.4,
});
/** Radians at depth 1 (trial values): chin down over neck and head, a slight roll to her side. */
export const SLEEP_POSE_ANGLES = Object.freeze({ neckX: 0.12, headX: 0.16, neckZ: 0.025, headZ: 0.085 });
/** At depth 1 the breath is this much lighter (amplitude) and slower (rate). */
export const SLEEP_BREATH = Object.freeze({ amplitude: 0.4, rate: 0.3 });
/** Spring rates (1/s): settling into sleep, rising out of it, the yield weight going out and coming back. */
export const SLEEP_POSE_RATES = Object.freeze({ settle: 0.8, rise: 1.4, yieldOut: 5, yieldIn: 2.5 });
/** The wake blink: after the lids have had time to open (s), and how long it lasts (s). */
export const WAKE_BLINK = Object.freeze({ delay: 0.9, duration: 0.24 });
/** Depth she must have reached for a wake to count (a short doze at falling-asleep is not a wake). */
export const WAKE_DEPTH = 0.6;
/** Below this depth/weight (and speed) a spring at its end is settled exactly: about 0.0003 rad at the head, not visible. */
const SETTLED = 2e-3;

export interface SleepPoseInput {
  /** The mesh: a new owner starts upright. */
  owner: object | null;
  /** The fatigue phase this frame (or the preview's); anything else counts as awake. */
  phase: string | null | undefined;
  /** The layer may show this frame (capability on, no higher owner of the head). */
  allowed: boolean;
  /** Spring speed multiplier (the 试一下 preview runs faster); default 1. */
  rate?: number;
  /** Her side for the head roll: +1 or -1; default +1. */
  side?: number;
}

export interface SleepPoseFrame {
  /** Spring depth 0..1 and the yield weight 0..1; amount = depth × weight is what is shown. */
  readonly depth: number;
  readonly weight: number;
  readonly amount: number;
  readonly neckX: number; readonly neckZ: number;
  readonly headX: number; readonly headZ: number;
  /** Multipliers for the breath amplitude and rate (1 = unchanged). */
  readonly breathScale: number;
  readonly breathRate: number;
  /** The wake blink pulse (0 open .. 1 closed) for the eyelid compositor. */
  readonly blink: number;
  /** Anything to write this frame. */
  readonly active: boolean;
}

export const NEUTRAL_SLEEP_FRAME: SleepPoseFrame = Object.freeze({ depth: 0, weight: 0, amount: 0, neckX: 0, neckZ: 0, headX: 0, headZ: 0,
  breathScale: 1, breathRate: 1, blink: 0, active: false });

const clamp01 = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const phaseDepth = (phase: unknown): number => typeof phase === 'string' && Object.hasOwn(SLEEP_POSE_DEPTH, phase) ? SLEEP_POSE_DEPTH[phase as SleepPhase] : 0;
/** Phases where she is (getting) asleep; leaving them after a deep sleep is a wake. */
const sleepish = (phase: unknown) => phase === 'asleep' || phase === 'micro-awake' || phase === 'falling-asleep';

export class SleepPose {
  private owner: object | null = null;
  private depth = 0;
  private weight = 0;
  private readonly velocity = { depth: 0, weight: 0 };
  /** She reached WAKE_DEPTH since the last wake. */
  private deep = false;
  private wasSleepish = false;
  /** Seconds until the scheduled wake blink starts (-1: none). */
  private blinkIn = -1;
  /** Seconds into the running wake blink (-1: none). */
  private blinkAt = -1;
  private blinks = 0;

  /** Upright at once: model change, character change, scope loss. */
  reset(): void {
    this.depth = this.weight = this.velocity.depth = this.velocity.weight = 0;
    this.deep = this.wasSleepish = false; this.blinkIn = this.blinkAt = -1;
  }

  /** Wake blinks started so far (diagnostics, tests). */
  get wakeBlinks(): number { return this.blinks; }

  frame(delta: number, input: SleepPoseInput): SleepPoseFrame {
    if (input.owner !== this.owner) { this.owner = input.owner; this.reset(); }
    const dt = Number.isFinite(delta) ? Math.min(0.1, Math.max(0, delta)) : 0;
    const rate = Number.isFinite(input.rate) && input.rate! > 0 ? Math.min(4, input.rate!) : 1;
    const target = phaseDepth(input.phase);
    const omega = (target > this.depth ? SLEEP_POSE_RATES.settle : SLEEP_POSE_RATES.rise) * rate;
    this.depth = dampCritical(this.depth, target, omega, dt, this.velocity, 'depth');
    const allowed = input.allowed === true;
    this.weight = dampCritical(this.weight, allowed ? 1 : 0, allowed ? SLEEP_POSE_RATES.yieldIn : SLEEP_POSE_RATES.yieldOut, dt, this.velocity, 'weight');
    // Upright and released: settle exactly (the last ~0.0003 rad), so nothing is written any more.
    if (target === 0 && this.depth < SETTLED && Math.abs(this.velocity.depth) < SETTLED) this.depth = this.velocity.depth = 0;
    if (!allowed && this.weight < SETTLED && Math.abs(this.velocity.weight) < SETTLED) this.weight = this.velocity.weight = 0;
    if (allowed && this.weight > 1 - SETTLED && Math.abs(this.velocity.weight) < SETTLED) { this.weight = 1; this.velocity.weight = 0; }

    // Wake: leaving the sleep phases after a deep sleep schedules one blink, once the lids have opened.
    const now = sleepish(input.phase);
    if (this.depth >= WAKE_DEPTH && now) this.deep = true;
    if (this.wasSleepish && !now && this.deep) { this.deep = false; if (this.blinkAt < 0) this.blinkIn = WAKE_BLINK.delay; }
    if (now) this.blinkIn = -1; // she went back to sleep before it came
    this.wasSleepish = now;
    if (this.blinkIn >= 0) {
      this.blinkIn -= dt;
      if (this.blinkIn <= 0) { this.blinkIn = -1; if (allowed) { this.blinkAt = 0; this.blinks++; } }
    } else if (this.blinkAt >= 0) this.blinkAt += dt;
    let blink = 0;
    if (this.blinkAt >= 0) {
      if (this.blinkAt >= WAKE_BLINK.duration) this.blinkAt = -1;
      else blink = Math.sin(this.blinkAt / WAKE_BLINK.duration * Math.PI) ** 2;
    }

    const amount = clamp01(this.depth) * clamp01(this.weight);
    if (amount === 0 && blink === 0) return NEUTRAL_SLEEP_FRAME;
    const side = input.side === -1 ? -1 : 1, a = SLEEP_POSE_ANGLES;
    return { depth: this.depth, weight: this.weight, amount,
      neckX: a.neckX * amount, neckZ: a.neckZ * amount * side, headX: a.headX * amount, headZ: a.headZ * amount * side,
      breathScale: 1 - SLEEP_BREATH.amplitude * amount, breathRate: 1 - SLEEP_BREATH.rate * amount, blink, active: true };
  }
}
