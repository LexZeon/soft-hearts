/**
 * Unbound U1: the body's dynamics layer (docs/claude/2026-11-12-unbound-system-design.md, "只给目标，不写骨头";
 * docs/claude/2026-11-12-unbound-u1-part2.md).
 *
 * Nothing in Unbound writes her bones or her place directly: a feature hands a *target* to a named channel, and only this layer
 * moves her, every channel a second-order system (critically damped by default: src/stage/procedural.ts dampCritical keeps its
 * velocity when the target changes, never starts at full speed, never overshoots from rest), or two in a row for big moves. So a
 * new target is met the way a keyframe animation passes between keys: every frame lands between where she was and where she is
 * going, at a speed that changes smoothly. Per-group frequencies follow Codex T-242 §3 (candidates, not human constants).
 *
 * Part 2 adds: damping ratios other than 1 (exact closed-form steps), the per-group table (eyes, head, neck, chest, arms,
 * fingers, pelvis), a rotation-vector spring for small residual rotations (exponential map, no Euler wrap), and finite eye
 * movements (a quintic that starts from the eye's current speed, so an interrupted look continues instead of restarting).
 */
import { Quaternion, Vector3 } from 'three';
import { dampCritical } from '../stage/procedural'; // direct, not via ../stage: the Unbound window does not take the stage page (docs/claude/2026-11-16-overhaul-parts-4.md)

/** Fixed sub-step: 30, 60 and 120 fps walk exactly the same path. */
export const SUBSTEPS_PER_SECOND = 120;
/** Every clock in Unbound takes at most this per frame (the stage's MAX_ANIMATION_DELTA). */
export const MAX_FRAME_DELTA = 0.1;

export const clampDelta = (delta: number) => Math.min(MAX_FRAME_DELTA, Math.max(0, Number.isFinite(delta) ? delta : 0));
/** Splits a frame into equal sub-steps of at most 1/120 s (a 1/60 frame is exactly two, a 1/30 frame exactly four). */
export function substeps(delta: number): { count: number; h: number } {
  const dt = clampDelta(delta);
  const count = Math.max(1, Math.ceil(dt * SUBSTEPS_PER_SECOND - 1e-9));
  return { count, h: dt / count };
}

/**
 * One exact step of x'' + 2ζωx' + ω²(x − g) = 0 with the target g held for `h` seconds. ζ = 1 is the stage's dampCritical;
 * other ratios use the closed form (no explicit integration, so a large step never blows up). Mutates `velocity.v`.
 */
export function dampSecondOrder(current: number, target: number, omega: number, zeta: number, h: number, velocity: { v: number }): number {
  if (!(Math.abs(zeta - 1) > 1e-6)) return dampCritical(current, target, omega, h, velocity, 'v');
  if (!Number.isFinite(current)) { velocity.v = 0; return Number.isFinite(target) ? target : 0; }
  if (!Number.isFinite(target) || !(omega > 0) || !Number.isFinite(omega) || !(zeta > 0)) { velocity.v = 0; return current; }
  const e = current - target, v = Number.isFinite(velocity.v) ? velocity.v : 0;
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta), decay = Math.exp(-zeta * omega * h), c = Math.cos(wd * h), s = Math.sin(wd * h);
    const b = (v + zeta * omega * e) / wd;
    velocity.v = decay * (v * c - (zeta * omega * v + omega * omega * e) / wd * s);
    return target + decay * (e * c + b * s);
  }
  const root = Math.sqrt(zeta * zeta - 1), r1 = -omega * (zeta - root), r2 = -omega * (zeta + root);
  const c1 = (v - r2 * e) / (r1 - r2), c2 = e - c1, e1 = Math.exp(r1 * h), e2 = Math.exp(r2 * h);
  velocity.v = r1 * c1 * e1 + r2 * c2 * e2;
  return target + c1 * e1 + c2 * e2;
}

export interface SpringSpec { hz: number; zeta?: number; eased?: boolean }

/** A scalar second-order follower (state: value and velocity, kept across frames; a new target never resets the speed). */
export class Spring {
  value: number;
  target: number;
  readonly velocity = { v: 0 };
  private omega: number;
  private zeta: number;
  private readonly ease: { value: number; velocity: { v: number } } | null;
  constructor(spec: SpringSpec, start = 0) {
    this.value = this.target = Number.isFinite(start) ? start : 0;
    this.omega = 2 * Math.PI * spec.hz;
    this.zeta = spec.zeta ?? 1;
    this.ease = spec.eased ? { value: this.value, velocity: { v: 0 } } : null;
  }
  /** Back at rest at `value` (an appearance, not a move). */
  reset(value: number): void {
    if (!Number.isFinite(value)) return;
    this.value = this.target = value; this.velocity.v = 0;
    if (this.ease) { this.ease.value = value; this.ease.velocity.v = 0; }
  }
  /**
   * U2: a new frequency / damping from now on (a tempo: calm, brisk, a little startle). Value and velocity are kept, so a retune
   * changes how she goes on, never where she is.
   */
  retune(spec: SpringSpec): void {
    if (Number.isFinite(spec.hz) && spec.hz > 0) this.omega = 2 * Math.PI * spec.hz;
    if (spec.zeta !== undefined && Number.isFinite(spec.zeta) && spec.zeta > 0) this.zeta = spec.zeta;
  }
  /** One sub-step (callers split frames with `substeps`). */
  advance(h: number): number {
    const goal = this.ease ? (this.ease.value = dampCritical(this.ease.value, this.target, this.omega, h, this.ease.velocity, 'v')) : this.target;
    return this.value = dampSecondOrder(this.value, goal, this.omega, this.zeta, h, this.velocity);
  }
  moving(epsilon = 1e-4): boolean {
    return Math.abs(this.value - this.target) > epsilon || Math.abs(this.velocity.v) > epsilon || Math.abs(this.ease?.velocity.v ?? 0) > epsilon;
  }
}

/**
 * Her part-1 channels. Hz is the spring's natural frequency f (ω = 2πf; one spring is 90% there after ≈ 0.62 / f s).
 * `eased`: two springs in a row (the target first passes a spring of the same f), so a big move also starts with no jump in
 * acceleration, the way a keyframe curve eases out of a key (one spring alone starts at zero speed but full acceleration).
 */
export const BODY_CHANNELS = Object.freeze({
  /** Where she stands across her floor (m). Part 2: her place is walked by the gait (gait.ts); kept for small glides. */
  x: { hz: 0.4, eased: true },
  /** How far behind the screen she stands (m). */
  depth: { hz: 0.4, eased: true },
  /** The breath residual (-1..1 times the breath setting). */
  breath: { hz: 1.4, eased: false },
  /** Arms down from the model's T/A pose when no motion owns them (0..1). */
  armsDown: { hz: 1.1, eased: true },
} as const);
export type BodyChannel = keyof typeof BODY_CHANNELS;

/**
 * Per-group dynamics (Codex T-242 §3 candidate ranges; the values are this project's first picks inside them, tuned by eye in
 * the preview, not measured on people). Eyes do not use a spring: finite movements (EyeMovement). Pelvis is ours (the centre
 * offsets from balance and gait), stiffer than the chest so the hips lead and the upper body follows.
 */
export const MOTION_GROUPS = Object.freeze({
  eyes: { kind: 'finite' as const, minMs: 35, maxMs: 100, msPerDegree: 3 },
  head: { hz: 1.6, zeta: 1.05 },
  neck: { hz: 1.3, zeta: 1.05 },
  chest: { hz: 0.85, zeta: 1.1 },
  arms: { hz: 1.4, zeta: 1.0 },
  fingers: { hz: 2.0, zeta: 1.1 },
  pelvis: { hz: 2.2, zeta: 1.0 },
});
export type SpringGroup = Exclude<keyof typeof MOTION_GROUPS, 'eyes'>;

export class BodyDynamics {
  private readonly channels = new Map<BodyChannel, Spring>();

  /** Starts a channel at rest at `value` (her first appearance: no glide in from somewhere else). */
  begin(channel: BodyChannel, value: number): void {
    const v = Number.isFinite(value) ? value : 0;
    const existing = this.channels.get(channel);
    if (existing) existing.reset(v); else this.channels.set(channel, new Spring(BODY_CHANNELS[channel], v));
  }

  /** The only input: where this channel should go. A channel never begun starts at rest there. */
  target(channel: BodyChannel, value: number): void {
    if (!Number.isFinite(value)) return;
    const state = this.channels.get(channel);
    if (!state) this.begin(channel, value);
    else state.target = value;
  }

  /**
   * Advances every channel by `delta` seconds (at most 0.1 s, like every stage clock). Fixed 1/120 s sub-steps, so 30, 60 and
   * 120 fps walk exactly the same path (one spring is exact for any step; two in a row are exact only per sub-step).
   */
  step(delta: number): void {
    const { count, h } = substeps(delta);
    for (let i = 0; i < count; i++) for (const state of this.channels.values()) state.advance(h);
  }

  value(channel: BodyChannel, fallback = 0): number { return this.channels.get(channel)?.value ?? fallback; }
  velocity(channel: BodyChannel): number { return this.channels.get(channel)?.velocity.v ?? 0; }
  /** Still moving toward its target (more than `epsilon` away or not yet at rest). */
  moving(channel: BodyChannel, epsilon = 1e-4): boolean { return !!this.channels.get(channel)?.moving(epsilon); }
}

/**
 * A small residual rotation that follows its target in rotation-vector space (axis × angle, radians) and is turned into a
 * quaternion with the exponential map: no Euler angles, so nothing wraps at ±π (Codex T-242 §3).
 */
export class RotationSpring {
  private readonly axes: [Spring, Spring, Spring];
  private readonly vector = new Vector3();
  constructor(spec: SpringSpec) { this.axes = [new Spring(spec), new Spring(spec), new Spring(spec)]; }
  target(x: number, y: number, z: number): void { this.axes[0].target = x; this.axes[1].target = y; this.axes[2].target = z; }
  advance(h: number): void { for (const axis of this.axes) axis.advance(h); }
  retune(spec: SpringSpec): void { for (const axis of this.axes) axis.retune(spec); }
  /** True when the residual is exactly nothing (at rest at zero): callers skip the write, so the bone is left as the motion had it. */
  get idle(): boolean { return this.axes.every(axis => axis.value === 0 && axis.target === 0 && axis.velocity.v === 0); }
  get value(): Vector3 { return this.vector.set(this.axes[0].value, this.axes[1].value, this.axes[2].value); }
  /** exp(v): the rotation by |v| about v / |v|. */
  quaternion(out: Quaternion): Quaternion { return expMap(this.value, out); }
}

export function expMap(vector: Vector3, out: Quaternion): Quaternion {
  const angle = vector.length();
  if (angle < 1e-12) return out.identity();
  const s = Math.sin(angle / 2) / angle;
  return out.set(vector.x * s, vector.y * s, vector.z * s, Math.cos(angle / 2));
}

/**
 * Finite eye movements (Codex T-242 §2, an original synthesis, not fitted to people): a look of A degrees takes
 * clamp(35 + 3A, 35, 100) ms on a quintic. A new look starts from where the eye is and how fast it is moving (the quintic's
 * start velocity), so an interruption continues; the end has zero speed and acceleration (no ringing).
 */
export class EyeMovement {
  private from = 0;
  private to = 0;
  private startVelocity = 0;
  private duration = 0;
  private time = 0;
  value = 0;
  velocity = 0;
  look(angle: number): void {
    if (!Number.isFinite(angle) || Math.abs(angle - this.to) < 1e-6) return;
    const spec = MOTION_GROUPS.eyes;
    const degrees = Math.abs(angle - this.value) * 180 / Math.PI;
    this.from = this.value; this.to = angle; this.startVelocity = this.velocity; this.time = 0;
    this.duration = Math.min(spec.maxMs, Math.max(spec.minMs, spec.minMs + spec.msPerDegree * degrees)) / 1000;
  }
  advance(h: number): number {
    if (this.duration <= 0) return this.value;
    this.time = Math.min(this.duration, this.time + h);
    const T = this.duration, u = this.time / T, distance = this.to - this.from, v0 = this.startVelocity * T;
    // Quintic Hermite: p(0) = 0, p'(0) = v0, p''(0) = 0, p(1) = distance, p'(1) = p''(1) = 0 (in units of the normalized time).
    const u2 = u * u, u3 = u2 * u, u4 = u3 * u, u5 = u4 * u;
    const position = v0 * (u - 6 * u3 + 8 * u4 - 3 * u5) + distance * (10 * u3 - 15 * u4 + 6 * u5);
    const speed = v0 * (1 - 18 * u2 + 32 * u3 - 15 * u4) + distance * (30 * u2 - 60 * u3 + 30 * u4);
    this.value = this.from + position;
    this.velocity = speed / T;
    if (this.time >= this.duration) { this.duration = 0; this.velocity = 0; this.value = this.to; }
    return this.value;
  }
}

/**
 * A slow oscillator: phase-continuous (a change of rate or depth never jumps the phase, Codex T-242 §3). The breath runs at the
 * stage's own rate (src/stage/MmdStage.ts: sin(t · 0.48π), 0.24 Hz); her standing weight shift uses the same class, slower.
 */
export class BreathOscillator {
  private phase = 0;
  constructor(private hz = 0.24, phase = 0) { this.phase = phase; }
  setRate(hz: number): void { if (Number.isFinite(hz) && hz > 0.01 && hz < 1) this.hz = hz; }
  step(delta: number): number {
    const dt = clampDelta(delta);
    this.phase = (this.phase + dt * 2 * Math.PI * this.hz) % (2 * Math.PI);
    return Math.sin(this.phase);
  }
}
