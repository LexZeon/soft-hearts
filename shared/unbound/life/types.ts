/**
 * Unbound v1 step 4 「她自己的生活」 (docs/claude/2026-11-17-unbound-step4.md): the types her free time is made of. Pure: no Electron,
 * no Three.js, no clock of its own.
 *
 *   the host (electron/unbound/life.ts) ──LifeCommand──▶ the page (src/unbound/life/player.ts) ──LifeReport──▶ the host
 *
 * One arbiter (arbiter.ts) owns her free time and her gaze, by level (low → high):
 *   idle (a pause in her idle) < small (a weight shift, a glance) < place (walking somewhere) < peek (up to the lens) < user (you)
 * An action is a plan of key frames (`LifePlan`): the page plays every action with the same player, so a new action is one file
 * that writes its key frames (actions/*.ts) and one line in registry.ts. Nothing here knows which actions exist.
 */
import { DEPTH_RANGE_M } from '../world';

export const LIFE_LEVELS = ['idle', 'small', 'place', 'peek', 'user'] as const;
export type LifeLevel = (typeof LIFE_LEVELS)[number];
export const levelRank = (level: LifeLevel): number => LIFE_LEVELS.indexOf(level);
/** Levels at which an action is something you notice (the shared gap between two applies to them; idle pauses are texture). */
export const noticeable = (level: LifeLevel): boolean => levelRank(level) >= levelRank('small');

/**
 * The channels a key frame may set, and their rest values (an absent channel is at rest). The page maps them onto her body:
 *   hip    her weight over one foot, −1..1 (+ = her left), times LIFE_BODY.hipM of her height and the plan's amplitude
 *   look   0..1 of the way from where she looks to you (the lens): her eyes lead, the head follows (the eye-head coordinator)
 *   tilt   a head tilt (rad, + = toward her left shoulder)
 *   smile  0..1
 *   rate   the clock of her idle, 0..1 (1 = as it plays; 0 = held: T-248 B1, the pause slows the idle's phase, not its size)
 */
export const LIFE_CHANNELS = ['hip', 'look', 'tilt', 'smile', 'rate'] as const;
export type LifeChannel = (typeof LIFE_CHANNELS)[number];
export const LIFE_REST: Readonly<Record<LifeChannel, number>> = Object.freeze({ hip: 0, look: 0, tilt: 0, smile: 0, rate: 1 });
export const LIFE_CHANNEL_RANGES: Readonly<Record<LifeChannel, readonly [number, number]>> = Object.freeze({
  hip: [-1, 1], look: [0, 1], tilt: [-0.2, 0.2], smile: [0, 1], rate: [0, 1],
});
export type LifeKey = { t: number } & Partial<Record<LifeChannel, number>>;

/** One action, as the page plays it. */
export interface LifePlan {
  /** The action's id (registry.ts). */
  action: string;
  level: LifeLevel;
  /** Key frames, t in seconds from the start, ascending; between two keys each channel moves on a quintic ease (S5). */
  keys: LifeKey[];
  /** Walk to this place first (world m on her floor), at this speed; null: where she is. */
  walk: { xM: number; depthM: number; speedMps: number } | null;
  /** Size of the hip channel (0.5..1; tense → smaller). */
  amplitude: number;
  /** When cancelled: every channel goes back to rest over this long (s), from wherever it is. */
  easeS: number;
  /** T-248 B1: before it starts, wait up to this long (s) for a quick move of her idle to finish; still busy: skipped. 0: no wait. */
  waitQuickS: number;
}

export type LifeCancelReason = 'user' | 'higher' | 'quiet' | 'leave';
/** Host → page. `attend`: you are interacting with her: her gaze is yours (she turns to you) until it is off again. */
export type LifeCommand =
  | { type: 'start'; id: string; plan: LifePlan; trial: boolean }
  | { type: 'cancel'; id: string; reason: LifeCancelReason }
  | { type: 'attend'; on: boolean; why?: 'user' | 'facing' };
export const LIFE_PHASES = ['playing', 'easing', 'done'] as const;
export type LifePhase = (typeof LIFE_PHASES)[number];
/** Page → host. `at`: where she stands once a walk is over or stopped; `skipped`: it never started (a quick move did not end in time). */
export interface LifeReport { id: string; phase: LifePhase; at?: { xM: number; depthM: number }; skipped?: true }

/** The page's own body numbers for the channels (not knobs). */
export const LIFE_BODY = Object.freeze({
  /** hip = 1: the pelvis this far over one foot, per meter of her height (inside the idle's soft knee of 1.6 %). */
  hipM: 0.011,
  /** The torso leans back over the hips by this much per meter of hip shift (rad/m), the head stays level. */
  torsoRollPerM: 1.2,
  /** How long the idle rate takes to reach a new key value at most, for the pause curve (s); the S5 between keys sets the rest. */
  rateRampS: 0.35,
});

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const inRange = (value: unknown, lo: number, hi: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;
const ID = /^[A-Za-z0-9-]{1,40}$/;

/** Plain bounds on a plan that crossed IPC (the page trusts nothing it did not compute). `known`: the registered action ids. */
export function parseLifePlan(value: unknown, known: readonly string[]): LifePlan | null {
  if (!record(value)) return null;
  const v = value;
  if (typeof v.action !== 'string' || !known.includes(v.action)) return null;
  if (typeof v.level !== 'string' || !(LIFE_LEVELS as readonly string[]).includes(v.level) || v.level === 'user' || v.level === 'peek') return null;
  if (!Array.isArray(v.keys) || v.keys.length < 1 || v.keys.length > 24) return null;
  const keys: LifeKey[] = [];
  let last = -1;
  for (const raw of v.keys) {
    if (!record(raw) || !inRange(raw.t, 0, 600) || raw.t < last) return null;
    if (Object.keys(raw).some(key => key !== 't' && !(LIFE_CHANNELS as readonly string[]).includes(key))) return null;
    const key: LifeKey = { t: raw.t };
    for (const channel of LIFE_CHANNELS) {
      if (!(channel in raw)) continue;
      const [lo, hi] = LIFE_CHANNEL_RANGES[channel];
      if (!inRange(raw[channel], lo, hi)) return null;
      key[channel] = raw[channel] as number;
    }
    last = raw.t;
    keys.push(key);
  }
  let walk: LifePlan['walk'] = null;
  if (v.walk !== null && v.walk !== undefined) {
    if (!record(v.walk) || !inRange(v.walk.xM, -50, 50) || !inRange(v.walk.depthM, DEPTH_RANGE_M[0], DEPTH_RANGE_M[1]) || !inRange(v.walk.speedMps, 0.2, 0.8)) return null;
    walk = { xM: v.walk.xM, depthM: v.walk.depthM, speedMps: v.walk.speedMps };
  }
  if (!inRange(v.amplitude, 0.5, 1) || !inRange(v.easeS, 0.2, 3) || !inRange(v.waitQuickS, 0, 2)) return null;
  return { action: v.action, level: v.level as LifeLevel, keys, walk, amplitude: v.amplitude, easeS: v.easeS, waitQuickS: v.waitQuickS };
}

/** A host command, checked again on the page (`known`: the registered action ids). */
export function parseLifeCommand(value: unknown, known: readonly string[]): LifeCommand | null {
  if (!record(value)) return null;
  if (value.type === 'attend') {
    if (typeof value.on !== 'boolean') return null;
    return value.on ? { type: 'attend', on: true, why: value.why === 'facing' ? 'facing' : 'user' } : { type: 'attend', on: false };
  }
  if (typeof value.id !== 'string' || !ID.test(value.id)) return null;
  if (value.type === 'cancel') return ['user', 'higher', 'quiet', 'leave'].includes(value.reason as string) ? { type: 'cancel', id: value.id, reason: value.reason as LifeCancelReason } : null;
  if (value.type !== 'start') return null;
  const plan = parseLifePlan(value.plan, known);
  return plan ? { type: 'start', id: value.id, plan, trial: value.trial === true } : null;
}

/** The page's report, checked on the host. */
export function parseLifeReport(value: unknown): LifeReport | null {
  if (!record(value) || Object.keys(value).some(key => !['id', 'phase', 'at', 'skipped'].includes(key))) return null;
  if (typeof value.id !== 'string' || !ID.test(value.id)) return null;
  if (typeof value.phase !== 'string' || !(LIFE_PHASES as readonly string[]).includes(value.phase)) return null;
  const report: LifeReport = { id: value.id, phase: value.phase as LifePhase };
  if (value.at !== undefined) {
    if (!record(value.at) || !inRange(value.at.xM, -50, 50) || !inRange(value.at.depthM, DEPTH_RANGE_M[0], DEPTH_RANGE_M[1])) return null;
    report.at = { xM: value.at.xM, depthM: value.at.depthM };
  }
  if (value.skipped !== undefined) { if (value.skipped !== true) return null; report.skipped = true; }
  return report;
}

/** S5: 0 → 1 with zero speed and acceleration at both ends. */
export const S5 = (u: number): number => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 + x * (-15 + 6 * x)); };

/** A channel's value at time t from the key frames (S5 between the two keys around t; before the first / after the last: held). */
export function sampleKeys(keys: readonly LifeKey[], channel: LifeChannel, t: number): number {
  const rest = LIFE_REST[channel];
  const at = (key: LifeKey) => key[channel] ?? rest;
  if (!keys.length) return rest;
  if (t <= keys[0].t) return at(keys[0]);
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t <= b.t) { const span = b.t - a.t; return span <= 1e-9 ? at(b) : at(a) + (at(b) - at(a)) * S5((t - a.t) / span); }
  }
  return at(keys[keys.length - 1]);
}
/** When a plan's key frames end (s). */
export const planEnd = (plan: Pick<LifePlan, 'keys'>): number => plan.keys.length ? plan.keys[plan.keys.length - 1].t : 0;
