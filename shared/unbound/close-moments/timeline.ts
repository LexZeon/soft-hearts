/**
 * I-184: the curves of a close moment (plan.ts), as plain numbers per beat. Pure: the page's performance asks them each frame and hands
 * them to her body as goals. Every curve is a quintic ease (S5: zero speed and acceleration at both ends) between key values; `back`
 * starts from wherever each channel is (a cancel never jumps), and `settle` fades the after-beat from where it is.
 *
 * The pucker never starts while she speaks (I-175's rule, shared/behaviors/part-mix closedMouthMayStart): PuckerGate keeps it at zero
 * until the mouth is free, then lets it rise; if she starts speaking again it eases back down and the voice is never cut.
 */
import type { AfterBeat } from './after-beat';
import type { CloseMomentPlan } from './plan';

export interface CloseChannels {
  lean: number; tilt: number;
  /** Eyes closed 0..1. */
  closed: number;
  /** How much pucker the act asks for (0..1); PuckerGate decides how much of it shows. */
  pucker: number;
  /** Both arms toward you (0..1, the reach's weight) and how far they wrap in (0 open … 1 wrapped). */
  arms: number; wrap: number;
  smile: number; laugh: number; shy: number; blush: number;
  /** Looking away from you (0..1) and the one-eye wink (0..1). */
  away: number; wink: number;
  /** Eyes softened half closed (0..1: pleased, a hug). */
  soft: number;
  /**
   * I-192: how far her face has come to its arrival point (0 where she stood after the walk … 1 at the point: the arrival loop's weight and
   * distance) and how far her head has turned to its side (0..1 of the plan's yaw: a hug's cheek toward you, a kiss's small turn).
   */
  reach: number; turn: number;
  /**
   * I-203, her own choice (extras.ts 'tuck'): tucking her hair behind her ear on the way back — the hand's weight (0 / 1: her arm reach's own
   * spring eases it) and how far it has slid from her temple to behind her ear (0..1).
   */
  tuck: number; slide: number;
}
export const REST_CHANNELS: Readonly<CloseChannels> = Object.freeze({ lean: 0, tilt: 0, closed: 0, pucker: 0, arms: 0, wrap: 0, smile: 0, laugh: 0, shy: 0, blush: 0, away: 0, wink: 0, soft: 0, reach: 0, turn: 0, tuck: 0, slide: 0 });
const ACT = ['lean', 'tilt', 'closed', 'pucker', 'arms', 'wrap', 'reach', 'turn'] as const;
const AFTER = ['smile', 'laugh', 'shy', 'blush', 'away', 'wink', 'soft'] as const;
const PULSE = ['tuck', 'slide'] as const;
/** I-203: in `back`, the face's arrival (the loop's hips and toes) is out within this share of backS: she steps back only off her toes. */
export const REACH_OUT_SHARE = 0.6;

export const S5 = (u: number): number => { const x = Math.min(1, Math.max(0, Number.isFinite(u) ? u : 0)); return x * x * x * (10 + x * (-15 + 6 * x)); };
/** 0 → 1 between `from` and `to` (s), eased. */
const ramp = (t: number, from: number, to: number) => to <= from ? (t >= to ? 1 : 0) : S5((t - from) / (to - from));

/** Has she chosen this extra (I-203; a plan from before extras: none)? */
const chose = (plan: CloseMomentPlan, extra: 'pucker' | 'tuck' | 'blush') => Array.isArray(plan.extras) && plan.extras.includes(extra);

/**
 * The act's channels at `t` s into the lean (they stay at their end values through the hold). I-203, the kiss storyboard: she starts at the
 * normal distance; the lean grows from the start (about half by 0.9 s, the step in), the face's arrival takes over in the second half, the head
 * tilts and turns and her eyes close as she arrives (`approachS`, about 1.7 s). A hug the same rhythm: her face turns outward, eyes close, a
 * small smile, arms open. Her own choices only when she chose them (extras.ts): the pucker, the blush. Never fixed here.
 */
export function leanChannels(plan: CloseMomentPlan, t: number): CloseChannels {
  const a = plan.approachS, u = ramp(t, 0, a), out: CloseChannels = { ...REST_CHANNELS, lean: plan.leanRad * u, tilt: plan.tiltRad * ramp(t, 0.3 * a, a) };
  if (plan.kind !== 'shy') { out.reach = ramp(t, 0.4 * a, a); out.turn = ramp(t, 0.35 * a, a); } // the face to its arrival point, the head to its side
  if (plan.kind === 'kiss') { out.closed = ramp(t, 0.55 * a, a); if (chose(plan, 'pucker')) out.pucker = ramp(t, 0.6 * a, a); }
  else if (plan.kind === 'hug') { out.arms = ramp(t, 0.1 * a, 0.8 * a); out.wrap = ramp(t, 0.45 * a, a); out.closed = ramp(t, 0.6 * a, a); out.smile = 0.3 * ramp(t, 0.5 * a, a); }
  else { out.away = 0.85 * ramp(t, 0.1 * a, a); out.blush = plan.show * 0.8 * u; out.shy = plan.show * 0.7 * u; }
  if (plan.kind !== 'shy' && chose(plan, 'blush')) out.blush = 0.7 * plan.show * ramp(t, 0.4 * a, a);
  return out;
}

/**
 * I-203, her own choice 'tuck': the hand on the way back, `x` s after it starts and `durS` long: up to her temple (~0.9 s), sliding behind her
 * ear (at least a second, as the showcase's own tuck: a quick slide cut through her hair), down again in the last 0.5 s. The hand's weight
 * eases in and out (and the arm reach's own spring smooths it again). 0 outside.
 */
export function tuckAt(x: number, durS: number): { tuck: number; slide: number } {
  if (!(x > 0) || x >= durS) return { tuck: 0, slide: 0 };
  return { tuck: S5(x / 0.4) * (1 - S5((x - (durS - 0.5)) / 0.5)), slide: S5((x - 0.9) / Math.max(1.0, durS - 2.0)) };
}
/** When the tuck starts in `back` (s) and how long it lasts: from the middle of the step back, ending before she walks home. */
export function tuckTiming(plan: CloseMomentPlan, cancelled: boolean): { startS: number; durS: number } | null {
  if (cancelled || !chose(plan, 'tuck') || plan.kind === 'shy') return null;
  const startS = 0.5 * plan.backS;
  return { startS, durS: Math.min(2.8, Math.max(2.0, backLength(plan, false) - startS - 0.2)) };
}

/** What the after-beat looks like once it is in (its wink is a pulse: winkAt). */
export function afterTargets(after: AfterBeat, show: number): CloseChannels {
  const s = Math.min(1, Math.max(0, show));
  switch (after) {
    case 'shy': return { ...REST_CHANNELS, blush: 0.9 * s, shy: 0.8 * s, away: 0.8, smile: 0.2 * s };
    case 'grin': return { ...REST_CHANNELS, smile: 0.7 * s, laugh: 0.45 * s };
    case 'wink': return { ...REST_CHANNELS, smile: 0.6 * s };
    case 'pleased': return { ...REST_CHANNELS, smile: 0.55 * s, soft: 0.35 * s };
    case 'cool': return { ...REST_CHANNELS, away: 0.35 };
  }
}
/** The wink's lid at `t` s into the after-beat: down quickly, a beat closed, up a little slower (0 outside). */
export function winkAt(t: number, start = 0.45): number {
  const x = t - start;
  if (x <= 0 || x >= 0.5) return 0;
  if (x < 0.12) return S5(x / 0.12);
  if (x < 0.24) return 1;
  return 1 - S5((x - 0.24) / 0.26);
}

/**
 * `back`: the act eases from `from` to rest over backS; the after-beat comes in from where it was over the second half of it and stays
 * until backS + afterS. `cancelled`: a cancel's back is quicker and its after-beat is smaller (half).
 */
export function backChannels(plan: CloseMomentPlan, from: CloseChannels, t: number, cancelled = false, velocity: Readonly<Partial<CloseChannels>> | null = null): CloseChannels {
  const backS = cancelled ? Math.min(plan.backS, 0.8) : plan.backS, out = { ...from };
  const down = 1 - ramp(t, 0, backS);
  for (const key of ACT) out[key] = from[key] * down;
  // I-203: her face's arrival (hips, toes) eases out in the first part, so she is down off her toes before she steps back.
  out.reach = from.reach * (1 - ramp(t, 0, REACH_OUT_SHARE * backS));
  const target = afterTargets(plan.after, plan.show * (cancelled ? 0.5 : 1)), up = ramp(t, 0.35 * backS, backS);
  for (const key of AFTER) out[key] = from[key] + (target[key] - from[key]) * up;
  // A cancel mid-move: the speed each channel had carries on and dies away (Hermite h10: its speed at t = 0, nothing left at the end), so
  // the turn back is a curve, not a corner. A planned back starts from a hold (no speed).
  if (velocity) {
    const u = Math.min(1, Math.max(0, t / backS)), h10 = u * u * u - 2 * u * u + u;
    for (const key of [...ACT, ...AFTER]) {
      const v = velocity[key];
      if (typeof v === 'number' && Number.isFinite(v)) out[key] += v * backS * h10;
      if (key !== 'lean' && key !== 'tilt') out[key] = Math.min(1, Math.max(0, out[key]));
    }
  }
  if (plan.after === 'wink' && !cancelled) out.wink = Math.max(out.wink, winkAt(t - 0.35 * backS));
  // I-203: her hair tucked behind her ear, if she chose it (never after a cancel: you pulled her away). Otherwise whatever hand was up eases down.
  const tuck = tuckTiming(plan, cancelled);
  if (tuck) Object.assign(out, tuckAt(t - tuck.startS, tuck.durS)); else { out.tuck = 0; out.slide = from.slide * (1 - ramp(t, 0, backS)); }
  return out;
}
/** How long `back` lasts (s). */
export const backLength = (plan: CloseMomentPlan, cancelled = false): number => (cancelled ? Math.min(plan.backS, 0.8) : plan.backS) + (cancelled ? 0.6 : plan.afterS);
/** `settle`: every channel fades from `from` to rest over fadeS while she walks back. */
export const SETTLE_FADE_S = 1.4;
export function settleChannels(from: CloseChannels, t: number, fadeS = SETTLE_FADE_S): CloseChannels {
  const k = 1 - ramp(t, 0, fadeS), out = { ...from };
  for (const key of [...ACT, ...AFTER, ...PULSE]) out[key] = from[key] * k;
  out.tuck = 0; // a tuck still up goes down (the arm reach's spring eases it), its slide fades with the rest
  return out;
}

/**
 * The pucker as shown. `want` is what the act asks (0..1); `mayStart` is I-175's closedMouthMayStart (the held "she is speaking" off, not
 * mid-sentence, nothing else owns her mouth); `speaking` is the held "she is speaking". It never starts while she speaks: progress only
 * rises when it may (or once started, while she stays quiet), and falls back while she speaks. The output is want × S5(progress).
 */
export class PuckerGate {
  private progress = 0;
  private started = false;
  /** Seconds to come in fully, to go back fully. */
  constructor(private readonly riseS = 0.42, private readonly fallS = 0.3) {} // I-203: 0.35 → 0.42 s (the pucker's own ask now comes in later and quicker)
  frame(dt: number, want: number, mayStart: boolean, speaking: boolean): number {
    const step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    if (speaking || want <= 1e-4) { this.progress = Math.max(0, this.progress - step / this.fallS); if (this.progress === 0) this.started = false; }
    else if (this.started || mayStart) { this.started = true; this.progress = Math.min(1, this.progress + step / this.riseS); }
    return Math.max(0, Math.min(1, want)) * S5(this.progress);
  }
  /** Shown at all now (for the tests and the record). */
  get on(): boolean { return this.progress > 0; }
}
