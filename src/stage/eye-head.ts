/**
 * E1 eye-head coordination (docs/claude/2026-11-14-eye-head-fix.md; docs/claude/2026-11-14-liveliness-research.md rule 2): one
 * place that decides how much of a look her eyes take and how much her head (and, past the head's reach, her upper body) takes.
 * Every gaze source goes through it: in Unbound the generator's aim and her look toward where she walks (src/unbound/figure.ts),
 * on the companion the final eye pose (MmdStage through eye-pose-limit.ts).
 *
 * People (the research note's numbers): looks under ~15-20° are eyes only; bigger ones bring the head in ~150 ms after the eyes,
 * and the head goes only part of the way (35° → ~21°); once it is there it keeps turning a little and the eyes come back toward
 * the middle; eyes rarely sit more than ~30° from the head. Anime eyes show white sooner (big iris, thin white), so the limits
 * here are tighter: horizontal soft 12° / hard 18°, up 9° / 14° (the research's lower ends: the bundled Gene's screenshots
 * at 14° across still showed a crescent of white), down 14° / 20° (looking down shows lid, not white; the companion's shy glance
 * reaches 13.5° and stays as it was).
 *
 *  - Eyes: whatever the head has not taken yet, up to the soft limit; past it a soft knee toward the hard limit that is only
 *    allowed briefly (it fades within ~0.08 s while the overflow lasts), so the pupils never rest at the edge. The limits bound
 *    the combined angle along an ellipse through the per-axis numbers (eyeLimitsAlong), so a diagonal look stays as tight
 *    (the coordinator; the companion's EyePoseLimiter keeps the per-axis box, see there).
 *  - Head: at first the overflow past the soft limit, or 60% of the look past 12° if more (so a look under 12° is eyes only and
 *    35° turns the head ~23°); once the look holds, 90% of it past 4° (the eyes then drift back toward the middle). Taken from the
 *    look as it was `headDelayS` ago (eyes lead). Past the head's own limit the rest goes to the upper body (yaw only).
 *  - A target too far round (more than `releaseFromDeg` from her body's forward, wholly past `releaseDeg`: behind her) is let go
 *    gradually: she looks where she is going (the caller's fallback). No twisting round to stare backward.
 *
 * Pure: plain numbers, radians in and out (yaw + = toward her left, pitch + = down), no Three.js. The caller's own dynamics (the
 * eye movements and springs) move the bones; this only sets their goals, so nothing here can jump.
 */

import { dampCritical } from './procedural';

const RAD = Math.PI / 180;

export interface EyeHeadParams {
  /** Eye-in-head limits (degrees). */
  eyeSoft: { yaw: number; up: number; down: number };
  eyeHard: { yaw: number; up: number; down: number };
  /**
   * How the per-axis limits join on a diagonal (eyeLimitsAlong): 2 = an ellipse through them, larger = squarer (toward the old
   * per-axis box, where a diagonal reached hypot of both).
   */
  eyeShape: number;
  /** How long the eyes may stay past the soft limit (s, time constant of the allowance fading while they are pushed). */
  eyeOverflowS: number;
  /** Looks smaller than this (degrees) are eyes only at first; the head's first share is headShare of the look past it. */
  eyeOnlyDeg: number;
  headShare: number;
  /** Once the look has held, the head takes recenterShare of it past recenterFromDeg (the eyes come back toward the middle). */
  recenterFromDeg: number;
  recenterShare: number;
  /** How quickly the head grows into its held share (s, time constant of the look's slow follower). */
  recenterS: number;
  /** The head starts after the eyes (s). */
  headDelayS: number;
  /** How far the head (neck and head together) turns at most (degrees); past it the upper body takes the yaw. */
  headLimit: { yaw: number; up: number; down: number };
  chestLimitYawDeg: number;
  /** A target further round than releaseFromDeg from her forward starts to be let go, and is wholly let go at releaseDeg (degrees). */
  releaseFromDeg: number;
  releaseDeg: number;
  /** How fast a target is let go or taken up (Hz of a critically damped follow: ~0.8 s to 90% at 0.8 Hz). */
  releaseHz: number;
  /** How fast the fallback look (where she is going) is followed (Hz, critically damped). */
  fallbackHz: number;
}

export const EYE_HEAD_DEFAULTS: Readonly<EyeHeadParams> = Object.freeze({
  eyeSoft: Object.freeze({ yaw: 12, up: 9, down: 14 }),
  eyeHard: Object.freeze({ yaw: 18, up: 14, down: 20 }),
  eyeShape: 2,
  eyeOverflowS: 0.08,
  eyeOnlyDeg: 12,
  headShare: 0.6,
  recenterFromDeg: 4,
  recenterShare: 0.9,
  recenterS: 0.45,
  headDelayS: 0.15,
  headLimit: Object.freeze({ yaw: 50, up: 20, down: 30 }),
  chestLimitYawDeg: 25,
  releaseFromDeg: 80,
  releaseDeg: 110,
  releaseHz: 0.8,
  fallbackHz: 1.5,
});

export interface Look { yaw: number; pitch: number }
export interface EyeHeadInput {
  /** Where she wants to look (rad, from her body's forward: where her head points with no turn of its own); null: no target. */
  target: Look | null;
  /** Where she looks without a target, or when it is let go: where she is going, or straight ahead. */
  fallback: Look;
  /** The head turn this coordinator asked for, as actually shown now (head + neck + upper body, after the caller's springs). */
  headNow: Look;
}
export interface EyeHeadOutput {
  /** Eye-in-head goal (rad). */
  eyes: Look;
  /** Head (neck + head) goal and upper-body yaw goal (rad), from her body's forward. */
  head: Look;
  chestYaw: number;
  /** The target is mostly let go (too far round). */
  released: boolean;
  /** The look actually used (rad). */
  gaze: Look;
}

const finite = (v: number, fallback = 0) => Number.isFinite(v) ? v : fallback;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (u: number) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
/** Toward a goal with time constant tau (exact for any step). */
const approach = (value: number, goal: number, tau: number, dt: number) => tau > 0 ? goal + (value - goal) * Math.exp(-dt / tau) : goal;

/**
 * Eyes past `soft` (rad, magnitude) bend toward `hard` with a tanh knee, scaled by `allow` (0..1): at 1 the full knee, at 0 the eyes
 * stay at the soft limit. Continuous in the angle and in `allow`.
 */
export function kneeLimit(angle: number, soft: number, hard: number, allow = 1): number {
  const a = Math.abs(angle);
  if (a <= soft || !(hard > soft)) return a <= soft ? angle : Math.sign(angle) * soft;
  return Math.sign(angle) * (soft + (hard - soft) * Math.tanh((a - soft) / (hard - soft)) * clamp(allow, 0, 1));
}

/**
 * The eye limits along a direction (rad, magnitudes of the combined eye-in-head angle). Round 8 of the lapwing showcase
 * (docs/claude/2026-11-14-lapwing-showcase-iterations.md): the limits used to bound each axis on its own, a box, so a look down
 * and to the side could leave the pupils hypot(12°, 14°) ≈ 18.4° off the middle at the soft limit. Now an ellipse through the
 * same per-axis limits (yaw across; up or down by the pitch's sign): straight across, up or down nothing changes; on a diagonal the
 * soft limit is ~13° instead of ~18°.
 */
export function eyeLimitsAlong(p: Pick<EyeHeadParams, 'eyeSoft' | 'eyeHard' | 'eyeShape'>, yaw: number, pitch: number): { soft: number; hard: number } {
  const m = Math.hypot(yaw, pitch), n = Math.max(1, finite(p.eyeShape, 2));
  const along = (limits: { yaw: number; up: number; down: number }) => {
    const vertical = pitch < 0 ? limits.up : limits.down;
    if (!(m > 1e-12)) return Math.min(limits.yaw, vertical) * RAD;
    return RAD / ((Math.abs(yaw) / m / limits.yaw) ** n + (Math.abs(pitch) / m / vertical) ** n) ** (1 / n);
  };
  return { soft: along(p.eyeSoft), hard: along(p.eyeHard) };
}

/** Eyes held inside the ellipse: the combined angle through the knee, the direction kept (rad in, rad out). */
function limitAlong(p: EyeHeadParams, yaw: number, pitch: number, allow: number): Look {
  const m = Math.hypot(yaw, pitch);
  if (!(m > 1e-12)) return { yaw, pitch };
  const { soft, hard } = eyeLimitsAlong(p, yaw, pitch);
  if (m <= soft) return { yaw, pitch };
  const k = kneeLimit(m, soft, hard, allow) / m;
  return { yaw: yaw * k, pitch: pitch * k };
}

export class EyeHeadCoordinator {
  readonly params: EyeHeadParams;
  private time = 0;
  private released = false; // reporting only
  private round = 0;
  private hadTarget = false;
  private kept = 0;
  private readonly keptVelocity = { v: 0 };
  private lastTarget: Look = { yaw: 0, pitch: 0 };
  private readonly fallback: Look = { yaw: 0, pitch: 0 };
  private readonly fallbackVelocity = { yaw: 0, pitch: 0 };
  private readonly history: { t: number; yaw: number; pitch: number }[] = [];
  private readonly held = { yaw: 0, pitch: 0 };
  private allow = 1;
  private started = false;

  constructor(params: Partial<EyeHeadParams> = {}) {
    this.params = { ...EYE_HEAD_DEFAULTS, ...params };
  }

  /** Whether the last target was let go. */
  get isReleased(): boolean { return this.released; }

  /** One step of `dt` seconds (call per frame or per sub-step; any rate gives the same goals). */
  step(dt: number, input: EyeHeadInput): EyeHeadOutput {
    const p = this.params, h = clamp(finite(dt), 0, 0.1);
    this.time += h;
    const target = input.target && Number.isFinite(input.target.yaw) && Number.isFinite(input.target.pitch) ? input.target : null;
    // Let go of a target too far round, gradually: fully kept up to releaseFromDeg, fully let go from releaseDeg (smoothstep between),
    // so a target sweeping round as she turns away hands over to her fallback without a jump (and its wrap at 180° never shows).
    // The target's yaw is followed continuously (no wrap at 180°), so one sweeping round behind her stays on its side.
    if (target) {
      const yaw = wrap(target.yaw);
      this.round = this.hadTarget && Math.abs(yaw) > Math.PI / 2 ? this.round + wrap(yaw - wrap(this.round)) : yaw;
    }
    this.hadTarget = !!target;
    const keep = target ? 1 - smooth((Math.abs(this.round) - p.releaseFromDeg * RAD) / ((p.releaseDeg - p.releaseFromDeg) * RAD)) : 0;
    // Taking a target up is at once (the eyes dart to it; the head follows on its own delay and spring). Letting it go moves at a
    // head's pace, however fast her body turns it round.
    if (keep >= this.kept) { this.kept = keep; this.keptVelocity.v = 0; }
    else this.kept = clamp(dampCritical(this.kept, keep, 2 * Math.PI * p.releaseHz, h, this.keptVelocity, 'v'), 0, 1);
    this.released = !!target && this.kept < 0.5;
    // The fallback is a slow intention (where she is going): followed at a head's pace, so a new walk does not snap her look.
    const wanted = { yaw: wrap(finite(input.fallback.yaw)), pitch: finite(input.fallback.pitch) }, omega = 2 * Math.PI * p.fallbackHz;
    if (!this.started) { this.fallback.yaw = wanted.yaw; this.fallback.pitch = wanted.pitch; }
    this.fallback.yaw = dampCritical(this.fallback.yaw, wanted.yaw, omega, h, this.fallbackVelocity, 'yaw');
    this.fallback.pitch = dampCritical(this.fallback.pitch, wanted.pitch, omega, h, this.fallbackVelocity, 'pitch');
    const fallback = this.fallback;
    const from = target ? { yaw: clamp(this.round, -p.releaseDeg * RAD, p.releaseDeg * RAD), pitch: target.pitch } : this.lastTarget;
    if (target) this.lastTarget = from;
    const raw = { yaw: fallback.yaw + (from.yaw - fallback.yaw) * this.kept, pitch: fallback.pitch + (from.pitch - fallback.pitch) * this.kept };
    const reach = (p.headLimit.yaw + p.chestLimitYawDeg + p.eyeSoft.yaw) * RAD;
    const gaze = { yaw: clamp(wrap(finite(raw.yaw)), -reach, reach), pitch: clamp(finite(raw.pitch), -60 * RAD, 60 * RAD) };

    // The look as it was headDelayS ago: the head follows the eyes.
    this.started = true;
    this.history.push({ t: this.time, yaw: gaze.yaw, pitch: gaze.pitch });
    const cut = this.time - p.headDelayS;
    while (this.history.length > 1 && this.history[1].t <= cut + 1e-9) this.history.shift();
    const delayed = this.history[0]; // the newest sample at least headDelayS old (the oldest there is, at the start)

    // Held: a slow follower of the delayed look; the head's held share counts only as much of the look as it has stayed for (a new
    // look starts from its first share and grows into the held one; a smaller one drops back at once).
    this.held.yaw = approach(this.held.yaw, delayed.yaw, p.recenterS, h); this.held.pitch = approach(this.held.pitch, delayed.pitch, p.recenterS, h);

    // The eyes' room along each axis for this look's direction (the ellipse's soft limit, projected): what they cannot hold the
    // head takes at once.
    const room = eyeLimitsAlong(p, delayed.yaw, delayed.pitch).soft, size = Math.hypot(delayed.yaw, delayed.pitch);
    const share = (angle: number, axis: 'yaw' | 'pitch') => {
      const m = Math.abs(angle), soft = size > 1e-12 ? room * m / size : room, stayed = this.held[axis] * Math.sign(angle);
      const first = Math.max(0, m - soft, p.headShare * (m - p.eyeOnlyDeg * RAD));
      const held = p.recenterShare * (Math.min(m, Math.max(0, stayed)) - p.recenterFromDeg * RAD);
      return Math.sign(angle) * Math.max(first, held);
    };
    const headYawWanted = share(delayed.yaw, 'yaw'), headPitchWanted = share(delayed.pitch, 'pitch');
    const head = { yaw: clamp(headYawWanted, -p.headLimit.yaw * RAD, p.headLimit.yaw * RAD), pitch: clamp(headPitchWanted, -p.headLimit.up * RAD, p.headLimit.down * RAD) };
    const chestYaw = clamp(headYawWanted - head.yaw, -p.chestLimitYawDeg * RAD, p.chestLimitYawDeg * RAD);

    // Eyes: what the head has not taken yet (as shown now), within the limits; past soft only briefly.
    const want = { yaw: gaze.yaw - finite(input.headNow.yaw), pitch: gaze.pitch - finite(input.headNow.pitch) };
    this.allow = Math.hypot(want.yaw, want.pitch) > eyeLimitsAlong(p, want.yaw, want.pitch).soft ? approach(this.allow, 0, p.eyeOverflowS, h) : approach(this.allow, 1, 0.3, h);
    return { eyes: limitAlong(p, want.yaw, want.pitch, this.allow), head, chestYaw, released: this.released, gaze };
  }
}

/** -π..π. */
export function wrap(angle: number): number {
  const a = finite(angle);
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

/**
 * The companion's last word on the eyes (MmdStage): the eye pose every writer left (the pointer gaze, the mood frame, life's looks, a
 * motion) is held within the same limits, a knee past soft that fades if it lasts. The companion's head already takes the bigger part of
 * a look (procedural.ts gazeTargets), so this only guards; under the soft limit it returns the pose untouched (null).
 *
 * It keeps the per-axis box on purpose (round 8 of the lapwing showcase): the companion's shy show glances down and aside past the
 * ellipse, and the ellipse changed that show frame by frame (the I-038 pins). Moving the companion to the ellipse is the user's call.
 */
export class EyePoseLimiter {
  private readonly allow = { yaw: 1, pitch: 1 };
  constructor(readonly params: EyeHeadParams = EYE_HEAD_DEFAULTS) {}
  /** Yaw / pitch (rad) of the eyes against the head this frame → the limited pair, or null when nothing needs to change. */
  limit(yaw: number, pitch: number, dt: number): Look | null {
    const p = this.params, h = clamp(finite(dt), 0, 0.1);
    const one = (axis: 'yaw' | 'pitch', angle: number) => {
      const soft = (axis === 'yaw' ? p.eyeSoft.yaw : angle < 0 ? p.eyeSoft.up : p.eyeSoft.down) * RAD;
      const hard = (axis === 'yaw' ? p.eyeHard.yaw : angle < 0 ? p.eyeHard.up : p.eyeHard.down) * RAD;
      this.allow[axis] = Math.abs(angle) > soft ? approach(this.allow[axis], 0, p.eyeOverflowS, h) : approach(this.allow[axis], 1, 0.3, h);
      return kneeLimit(angle, soft, hard, this.allow[axis]);
    };
    const y = one('yaw', finite(yaw)), x = one('pitch', finite(pitch));
    return y === yaw && x === pitch ? null : { yaw: y, pitch: x };
  }
}
