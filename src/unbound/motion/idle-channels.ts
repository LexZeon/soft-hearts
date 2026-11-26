/**
 * Motion-model spike (docs/claude/2026-11-14-motion-model-spike.md): the idle channels a layer-2 source hands the body, and the
 * one generator that turns any idle source into PoseTargets ("生成器只交目标": the intent layer's springs and the contact owner
 * still decide how her body gets there).
 *
 * Twelve numbers per frame, deviations from her own stand pose (the data's mean posture is removed, so they ride on Gene's):
 *   0..2  pelvis lateral / forward / vertical, per meter of body height (her frame: + = her left, forward, up)
 *   3..5  torso pitch / yaw / roll (rad), 6..8 neck, 9..11 head (PoseTargets' conventions, generator.ts `Rot`)
 *
 * A source runs at its own rate (30 Hz for the data-driven ones); `Resampled30` plays it at any display rate with a uniform
 * Catmull-Rom (one 30 Hz frame of look-ahead), so 60 fps and 30 fps show the same curve and no frame-pair kinks.
 * Off by default: nothing in the app asks for the 'idle' intent yet (only the spike's preview and comparison scripts).
 */
import { REST_TARGETS, type MotionGenerator, type MotionIntent, type MotionRequest, type PoseTargets } from './generator';

export const IDLE_CHANNELS = ['pelvis_lateral', 'pelvis_forward', 'pelvis_vertical', 'torso_pitch', 'torso_yaw', 'torso_roll',
  'neck_pitch', 'neck_yaw', 'neck_roll', 'head_pitch', 'head_yaw', 'head_roll',
  // Round 2: the hips' own turn, and each arm's upper arm and elbow, about her body axes relative to the parent (limb-residual.ts).
  'hips_pitch', 'hips_yaw', 'hips_roll', 'l_arm_pitch', 'l_arm_yaw', 'l_arm_roll', 'l_elbow_pitch', 'l_elbow_yaw', 'l_elbow_roll',
  'r_arm_pitch', 'r_arm_yaw', 'r_arm_roll', 'r_elbow_pitch', 'r_elbow_yaw', 'r_elbow_roll'] as const;
/** Left-right mirror per channel (lateral, yaws and rolls change sign; the arm channels also swap sides: see `mirrorFrame`). */
export const IDLE_MIRROR_SIGN: readonly number[] = [-1, 1, 1, ...Array.from({ length: 8 }, () => [1, -1, -1]).flat()];
export const IDLE_DIM = IDLE_CHANNELS.length;
export const IDLE_HZ = 30;

/** Anything that makes idle frames. `activity` 0..1 is the liveliness knob (docs/claude/2026-11-14-liveliness-research.md 规则 11). */
export interface IdleSource {
  readonly id: string;
  /** The next frame at the source's own rate (1 / IDLE_HZ s later than the previous one). */
  next(activity: number): Float32Array;
  reset(seed?: number): void;
}

/** A continuous source (a function of time): sampled directly at the display's own times. */
export interface ContinuousIdleSource {
  readonly id: string;
  at(t: number, activity: number): Float32Array;
  reset(seed?: number): void;
}

/** Plays a 30 Hz source at any rate: uniform Catmull-Rom between frames k and k+1 (needs k-1 and k+2). */
export class Resampled30 {
  private readonly frames: Float32Array[] = [];
  private phase = 0; // 0..1 between frames[1] and frames[2]
  readonly out = new Float32Array(IDLE_DIM);
  constructor(private readonly source: IdleSource) {}
  reset(seed?: number): void { this.source.reset(seed); this.frames.length = 0; this.phase = 0; }
  sample(dt: number, activity: number): Float32Array {
    while (this.frames.length < 4) this.frames.push(Float32Array.from(this.source.next(activity)));
    this.phase += Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0)) * IDLE_HZ;
    while (this.phase >= 1) { this.phase -= 1; this.frames.shift(); this.frames.push(Float32Array.from(this.source.next(activity))); }
    const [p0, p1, p2, p3] = this.frames, u = this.phase, u2 = u * u, u3 = u2 * u;
    for (let c = 0; c < IDLE_DIM; c++) {
      this.out[c] = 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * u + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * u3);
    }
    return this.out;
  }
}

/** A frame mirrored left-right (for augmentation and tests): signs per channel, and the two arms swap. */
export function mirrorFrame(frame: ArrayLike<number>, out = new Float32Array(IDLE_DIM)): Float32Array {
  for (let c = 0; c < IDLE_DIM; c++) {
    const from = c >= 15 && c < 21 ? c + 6 : c >= 21 ? c - 6 : c;
    out[c] = (frame[from] ?? 0) * IDLE_MIRROR_SIGN[c];
  }
  return out;
}

/** `limbs: false` leaves the hips and arms to the body (round 1's twelve channels only). */
export interface IdleMapping { heightM: number; gain?: number; limbs?: boolean }

/** Idle channels → PoseTargets (everything else at rest: eyes, face, breath and place stay the director's / the body's). */
export function idleTargets(frame: ArrayLike<number>, mapping: IdleMapping): PoseTargets {
  const g = Number.isFinite(mapping.gain) ? Math.max(0, Math.min(3, mapping.gain!)) : 1, h = Math.max(0.5, Math.min(3, mapping.heightM)) * g;
  const v = (i: number) => (Number.isFinite(frame[i]) ? Math.max(-1, Math.min(1, frame[i])) : 0);
  const rot = (i: number) => ({ pitch: v(i) * g, yaw: v(i + 1) * g, roll: v(i + 2) * g });
  const targets: PoseTargets = { ...REST_TARGETS, pelvis: { lateral: v(0) * h, forward: v(1) * h, vertical: v(2) * h }, torso: rot(3), neck: rot(6), head: rot(9) };
  if (mapping.limbs !== false && frame.length >= IDLE_DIM) {
    targets.hips = rot(12);
    targets.armRot = { left: { upper: rot(15), elbow: rot(18) }, right: { upper: rot(21), elbow: rot(24) } };
  }
  return targets;
}

/** Seeded uniform [0, 1) (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Standard normal from a uniform source (Box-Muller). */
export function gaussian(random: () => number): number {
  const u = Math.max(1e-12, random()), w = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
}

/**
 * Layer 2 for the 'idle' intent: one idle source, played at the display rate and mapped onto PoseTargets. Supports only 'idle', so
 * in a GeneratorChain anything else falls through to the procedural generator.
 */
export class IdleGenerator implements MotionGenerator {
  readonly id: string;
  private readonly resampled: Resampled30 | null;
  private clock = 0;
  /** The last frame handed out (for measurements). */
  readonly last = new Float32Array(IDLE_DIM);
  constructor(private readonly source: IdleSource | ContinuousIdleSource, private readonly mapping: IdleMapping) {
    this.id = `idle:${source.id}`;
    this.resampled = 'next' in source ? new Resampled30(source) : null;
  }
  supports(kind: MotionIntent['kind']): boolean { return kind === 'idle'; }
  reset(): void { this.clock = 0; if (this.resampled) this.resampled.reset(); else (this.source as ContinuousIdleSource).reset(); }
  generate({ intent, dt }: MotionRequest): PoseTargets {
    if (intent.kind !== 'idle') return { ...REST_TARGETS };
    const activity = Math.max(0, Math.min(1, Number.isFinite(intent.activity) ? intent.activity : 0.5));
    const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
    this.clock += step;
    const frame = this.resampled ? this.resampled.sample(step, activity) : (this.source as ContinuousIdleSource).at(this.clock, activity);
    this.last.set(frame);
    return idleTargets(frame, this.mapping);
  }
}
