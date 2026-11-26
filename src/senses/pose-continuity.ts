/**
 * R29 display continuity: the generalized "display transition bridge" of
 * docs/mood/action-composition.md (per-frame step 5, before local physics).
 *
 * Every writer still composes its own target pose exactly as before. Per
 * rendered frame the stage calls:
 *
 *   captureBase(trusted)  right after the mixer/helper (VMD + IK/grant). When the
 *                         mixer's actions, weights and clocks only advanced
 *                         (authored playback), base motion is trusted as-is:
 *                         a baked dance with 60-degree wrist frames is never
 *                         mistaken for a teleport.
 *   apply(dt, gap)        after every writer, before physics. Detects a jump in
 *                         the layer delta D = base^-1 * target (or in the full
 *                         target while the base itself is being handed off),
 *                         captures it as an offset and decays it with a
 *                         critically damped spring (inertialization). Steady
 *                         motion passes through untouched; successive jumps compose.
 *   remove()              right after render, writes the exact targets back. The
 *                         guard's output never survives into the next tick or
 *                         into an event-time restore -> mutate -> frame(0) path,
 *                         so existing layer contracts, captures and QA reads are unchanged.
 *   reset(reason)         hard reset: the next apply passes through and only learns.
 *
 * The guard owns no clock, clip, cue or source value. Physics-driven bones and
 * compositor-owned morphs (the eyelid) are excluded by the caller.
 */

export interface QuaternionLike { x: number; y: number; z: number; w: number; set(x: number, y: number, z: number, w: number): unknown }
export interface Vector3Like { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown }
export interface ContinuityBone { readonly name?: string; readonly quaternion: QuaternionLike; readonly position: Vector3Like }
export interface ContinuityMesh {
  readonly skeleton: { readonly bones: readonly ContinuityBone[] };
  morphTargetInfluences?: number[];
}

/** Tolerance for one detection space: error > (floor + acceleration·dt²)·scale + velocity·|v|·dt is a jump. */
export interface ContinuityTolerance {
  /** Prediction error always tolerated in one frame (rad, model heights, or morph weight). */
  readonly floor: number;
  /** Extra tolerance per unit of the signal's own per-frame motion; > 2 lets sharp stops and reversals through. */
  readonly velocity: number;
  /** Plausible acceleration per s²; the a·dt² tolerance covers eased starts at low FPS. */
  readonly acceleration: number;
}
export interface ContinuityKindTuning {
  /**
   * Full target, used while the base itself is being handed off (or absent):
   * it may carry authored content with sharp keys, so it is lenient.
   */
  readonly target: ContinuityTolerance;
  /**
   * Layer delta over trusted authored playback: only procedural layers, players'
   * own fades and bounded additives live here, all smooth by construction.
   */
  readonly delta: ContinuityTolerance;
  /** Half-life (s) of a captured offset. */
  readonly halfLife: number;
  /** Bound on velocity carried across a jump (per s), so a noisy estimate never flings. */
  readonly maxVelocity: number;
  /** Offset and offset velocity below this return the property to pass-through. */
  readonly settle: number;
}
export interface ContinuityTuning {
  readonly rotation: ContinuityKindTuning;
  /** Position values are in model heights; the guard scales them by `height`. */
  readonly position: ContinuityKindTuning;
  readonly morph: ContinuityKindTuning;
  /** A real frame gap longer than this (s) is a stale history: snap instead of blending. */
  readonly staleGap: number;
}

export const DEFAULT_CONTINUITY_TUNING: ContinuityTuning = Object.freeze({
  rotation: Object.freeze({ target: Object.freeze({ floor: 0.035, velocity: 2.25, acceleration: 60 }),
    delta: Object.freeze({ floor: 0.026, velocity: 1, acceleration: 12 }), halfLife: 0.09, maxVelocity: 2, settle: 2e-4 }),
  position: Object.freeze({ target: Object.freeze({ floor: 0.0025, velocity: 2.25, acceleration: 2.5 }),
    delta: Object.freeze({ floor: 0.0015, velocity: 1, acceleration: 1 }), halfLife: 0.09, maxVelocity: 0.5, settle: 2e-6 }),
  morph: Object.freeze({ target: Object.freeze({ floor: 0.1, velocity: 2.25, acceleration: 45 }),
    delta: Object.freeze({ floor: 0.06, velocity: 1, acceleration: 20 }), halfLife: 0.035, maxVelocity: 6, settle: 1e-3 }),
  staleGap: 0.25,
});

export interface PoseContinuityOptions {
  /** Bone indices driven by physics (or another per-frame owner after this guard). */
  readonly excludedBones?: Iterable<number>;
  /** Morph indices owned by a dedicated compositor that is already continuous by construction. */
  readonly excludedMorphs?: Iterable<number>;
  /** Model height in its own units; position tuning is relative to it. */
  readonly height?: number;
  readonly tuning?: ContinuityTuning;
}

export interface PoseContinuityState {
  /** Properties currently displaying a decaying offset. */
  active: number;
  /** Largest remaining offset per kind: degrees, model heights, morph weight. */
  maxAngleDeg: number;
  maxPosition: number;
  maxMorph: number;
  /** Jumps captured since the last reset, and the latest one for real-machine diagnosis. */
  jumps: number;
  lastJump: { property: string; size: number } | null;
  resets: number;
  lastReset: string;
  /** Whether this frame's base (mixer) motion was trusted as authored playback. */
  baseTrusted: boolean;
  /** Properties guarded (excluded ones are not counted). */
  properties: number;
}

const finite = Number.isFinite;
/** Streak states: 0 steady, 1-2 consecutive jump frames, ACQUIRE = history just (re)started. */
const ACQUIRE = 3;
/** Frame-level delta history: none, previous delta only, previous delta and its velocity. */
const D_NONE = 0, D_VALUE = 1, D_FULL = 2;
const SPACE_TARGET = 1, SPACE_DELTA = 2;

/*
 * Allocation-free math. Every helper reads and writes typed arrays at small
 * integer offsets: a double passed to (or returned from) a call V8 does not
 * inline is boxed, which on a Gene-sized rig measured ~220 B per frame.
 */
/** Quaternion result, log result, and operand scratches. */
const Q = new Float64Array(4), L = new Float64Array(3), A = new Float64Array(4), P = new Float64Array(4), E = new Float64Array(3);
/** Q = (A[a..] with its vector part scaled by `sign`) * B[b..]; B must not be Q. */
function qmul(Aq: Float64Array, a: number, sign: number, B: Float64Array, b: number): void {
  const ax = Aq[a] * sign, ay = Aq[a + 1] * sign, az = Aq[a + 2] * sign, aw = Aq[a + 3];
  const bx = B[b], by = B[b + 1], bz = B[b + 2], bw = B[b + 3];
  Q[0] = aw * bx + ax * bw + ay * bz - az * by;
  Q[1] = aw * by - ax * bz + ay * bw + az * bx;
  Q[2] = aw * bz + ax * by - ay * bx + az * bw;
  Q[3] = aw * bw - ax * bx - ay * by - az * bz;
}
/** Q = exp(V[v..v+2] * sign) as a unit quaternion. */
function qexp(V: Float64Array, v: number, sign: number): void {
  const vx = V[v] * sign, vy = V[v + 1] * sign, vz = V[v + 2] * sign;
  const angle = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (angle < 1e-12) { Q[0] = vx * 0.5; Q[1] = vy * 0.5; Q[2] = vz * 0.5; Q[3] = 1; return; }
  const k = Math.sin(angle * 0.5) / angle;
  Q[0] = vx * k; Q[1] = vy * k; Q[2] = vz * k; Q[3] = Math.cos(angle * 0.5);
}
/** L = shortest-path log of the unit quaternion in Q. */
function qlog(): void {
  let x = Q[0], y = Q[1], z = Q[2];
  const w = Math.abs(Q[3]);
  if (Q[3] < 0) { x = -x; y = -y; z = -z; }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-12) { L[0] = 2 * x; L[1] = 2 * y; L[2] = 2 * z; return; }
  const k = (2 * Math.atan2(s, w)) / s;
  L[0] = x * k; L[1] = y * k; L[2] = z * k;
}

/** Per-property bookkeeping shared by the three channels. */
abstract class Channel {
  readonly streak: Uint8Array; readonly space: Uint8Array;
  readonly active: Uint8Array; readonly wrote: Uint8Array;
  readonly guarded: Uint8Array;
  /** Offset (displayed - target) and its velocity, per component. */
  readonly off: Float64Array; protected readonly offVel: Float64Array;
  /** This frame's step (s), set once per frame instead of passed per call (see above). */
  dt = 0;
  /** Size of the jump the last step() reported (it returns only a 0/1 flag, see above). */
  jumpError = 0;
  constructor(readonly count: number, components: number, protected readonly kind: ContinuityKindTuning, protected readonly scale: number) {
    this.streak = new Uint8Array(count); this.space = new Uint8Array(count);
    this.active = new Uint8Array(count); this.wrote = new Uint8Array(count);
    this.guarded = new Uint8Array(count).fill(1);
    this.off = new Float64Array(count * components); this.offVel = new Float64Array(count * components);
  }
  clear(): void { this.active.fill(0); this.wrote.fill(0); this.streak.fill(ACQUIRE); this.off.fill(0); this.offVel.fill(0); }

  /** Error above which this frame is a jump: (floor + a·dt²)·scale + velocity·|v|·dt, widened right after a jump. */
  protected exceeds(error: number, speed: number, delta: boolean, streak: number): boolean {
    if (streak > 1) return false; // the frame right after a jump re-acquires motion
    const t = delta ? this.kind.delta : this.kind.target, dt = this.dt;
    const limit = (t.floor + t.acceleration * dt * dt) * this.scale + t.velocity * speed * dt;
    // One frame after a jump the velocity is not trustworthy yet: only a much larger step is another jump.
    return error > (streak === 1 ? limit * 4 : limit);
  }

  /** Critically damped decay of components [o, o+n) toward zero; returns whether they settled (only when allowed). */
  protected decay(o: number, n: number, canSettle: boolean): boolean {
    const dt = this.dt, y = (2 * Math.LN2) / Math.max(1e-4, this.kind.halfLife), e = Math.exp(-y * dt);
    const settle = this.kind.settle * this.scale;
    let settled = canSettle;
    for (let k = o; k < o + n; k++) {
      const x = this.off[k], v = this.offVel[k], j = v + x * y;
      const nx = e * (x + j * dt), nv = e * (v - j * y * dt);
      this.off[k] = nx; this.offVel[k] = nv;
      if (Math.abs(nx) > settle || Math.abs(nv) * dt > settle) settled = false;
    }
    if (settled) for (let k = o; k < o + n; k++) { this.off[k] = 0; this.offVel[k] = 0; }
    return settled;
  }
}

/**
 * Positions (stride 3) and morph weights (stride 1): target = base + delta,
 * displayed = target + offset.
 */
class LinearChannel extends Channel {
  readonly target: Float64Array; readonly base: Float64Array; readonly written: Float64Array;
  private readonly x: Float64Array; private readonly xVel: Float64Array;
  private readonly d: Float64Array; private readonly dVel: Float64Array;
  private readonly pre: Float64Array;
  constructor(count: number, readonly stride: number, kind: ContinuityKindTuning, scale: number) {
    super(count, stride, kind, scale);
    const n = count * stride, f = () => new Float64Array(n);
    this.target = f(); this.base = f(); this.written = f();
    this.x = f(); this.xVel = f(); this.d = f(); this.dVel = f(); this.pre = f();
  }
  override clear(): void { super.clear(); this.xVel.fill(0); this.dVel.fill(0); }

  /**
   * `target[i]` is filled. Returns 1 when a jump was captured (size in `jumpError`), else 0. `judge` false: this frame's
   * step belongs to a dedicated owner that is continuous by construction (see PoseContinuity.apply `ownedMorphs`): history
   * and speed follow it, any offset already shown keeps decaying, but it is never taken for a jump.
   */
  step(i: number, learn: boolean, withBase: boolean, trusted: boolean, dState: number, judge = true): number {
    const dt = this.dt;
    const s = this.stride, o = i * s, T = this.target, X = this.x, D = this.d, B = this.base;
    for (let k = 0; k < s; k++) if (!finite(T[o + k])) { this.active[i] = 0; return 0; }
    if (learn) {
      for (let k = 0; k < s; k++) {
        X[o + k] = T[o + k]; this.xVel[o + k] = 0; this.dVel[o + k] = 0; this.off[o + k] = 0; this.offVel[o + k] = 0;
        if (withBase) D[o + k] = T[o + k] - B[o + k];
      }
      this.streak[i] = ACQUIRE; this.active[i] = 0;
      return 0;
    }
    if (dt === 0) return 0; // no elapsed time: keep history, the caller redisplays the offset
    const useDelta = withBase && trusted && dState === D_FULL;
    const deltaStep = withBase && dState >= D_VALUE;
    let error2 = 0, speed2 = 0;
    for (let k = 0; k < s; k++) {
      const stepX = T[o + k] - X[o + k];
      const e = useDelta ? (T[o + k] - B[o + k] - D[o + k]) - this.dVel[o + k] * dt : stepX - this.xVel[o + k] * dt;
      const v = useDelta ? this.dVel[o + k] : this.xVel[o + k];
      error2 += e * e; speed2 += v * v;
    }
    const error = Math.sqrt(error2), streak = this.streak[i];
    let jumped = 0;
    if (judge && this.exceeds(error, Math.sqrt(speed2), useDelta, streak)) {
      for (let k = 0; k < s; k++) {
        const stepX = T[o + k] - X[o + k], stepD = deltaStep ? (T[o + k] - B[o + k]) - D[o + k] : 0;
        this.off[o + k] -= useDelta ? stepD - this.dVel[o + k] * dt : stepX - this.xVel[o + k] * dt;
        if (streak === 0) { this.pre[o + k] = useDelta ? this.dVel[o + k] : this.xVel[o + k]; this.xVel[o + k] = 0; this.dVel[o + k] = 0; }
        else { this.xVel[o + k] = stepX / dt; this.dVel[o + k] = deltaStep && trusted ? stepD / dt : 0; }
      }
      if (streak === 0) this.space[i] = useDelta ? SPACE_DELTA : SPACE_TARGET;
      this.streak[i] = Math.min(2, streak + 1);
      this.active[i] = 1;
      jumped = 1; this.jumpError = error;
    } else {
      let carry = 0;
      if (streak === 1 || streak === 2) carry = this.space[i] === (useDelta ? SPACE_DELTA : SPACE_TARGET) ? 1 : 0;
      let t2 = 0;
      for (let k = 0; k < s; k++) {
        const nx = (T[o + k] - X[o + k]) / dt, nd = deltaStep ? ((T[o + k] - B[o + k]) - D[o + k]) / dt : 0;
        if (carry) { const t = this.pre[o + k] - (useDelta ? nd : nx); this.pre[o + k] = t; t2 += t * t; }
        this.xVel[o + k] = nx; this.dVel[o + k] = trusted ? nd : 0;
      }
      if (carry) {
        // First steady frame after a jump: carry the pre-jump velocity into the offset (bounded).
        const limit = this.kind.maxVelocity * this.scale, t = Math.sqrt(t2), g = t > limit ? limit / t : 1;
        for (let k = 0; k < s; k++) this.offVel[o + k] += this.pre[o + k] * g;
        this.active[i] = 1;
      }
      if (streak) this.streak[i] = 0;
    }
    for (let k = 0; k < s; k++) { X[o + k] = T[o + k]; if (withBase) D[o + k] = T[o + k] - B[o + k]; }
    if (!this.active[i]) return jumped;
    if (this.decay(o, s, this.streak[i] === 0)) this.active[i] = 0;
    return jumped;
  }

  magnitude(i: number): number {
    let sum = 0;
    for (let k = 0; k < this.stride; k++) sum += this.off[i * this.stride + k] ** 2;
    return Math.sqrt(sum);
  }

  /** R29f: the composed target's own rate (per second) at the last frame, when it is known and steady. */
  rate(i: number, out: number[]): boolean {
    if (!this.guarded[i] || this.streak[i] !== 0) return false;
    for (let k = 0; k < this.stride; k++) out[k] = this.xVel[i * this.stride + k];
    return out.every(finite);
  }
}

/**
 * Bone rotations: delta D = base^-1 * target (bone-local, like rotateBone's
 * right multiplication), displayed = target * exp(offset).
 */
class RotationChannel extends Channel {
  readonly target: Float64Array; readonly base: Float64Array; readonly written: Float64Array;
  private readonly x: Float64Array; private readonly xVel: Float64Array;
  private readonly d: Float64Array; private readonly dVel: Float64Array;
  private readonly pre: Float64Array;
  /** Normalized current target and current layer delta, as qmul operands. */
  private readonly cur = new Float64Array(4); private readonly dl = new Float64Array(4);
  constructor(count: number, kind: ContinuityKindTuning) {
    super(count, 3, kind, 1);
    const f = (n: number) => new Float64Array(count * n);
    this.target = f(4); this.base = f(4); this.written = f(4);
    this.x = f(4); this.xVel = f(3); this.d = f(4); this.dVel = f(3); this.pre = f(3);
  }
  override clear(): void { super.clear(); this.xVel.fill(0); this.dVel.fill(0); }

  step(i: number, learn: boolean, withBase: boolean, trusted: boolean, dState: number): number {
    const dt = this.dt;
    const o4 = i * 4, o3 = i * 3, T = this.target, X = this.x, D = this.d, B = this.base, C = this.cur, U = this.dl;
    const n = Math.sqrt(T[o4] * T[o4] + T[o4 + 1] * T[o4 + 1] + T[o4 + 2] * T[o4 + 2] + T[o4 + 3] * T[o4 + 3]);
    if (!finite(n) || n < 1e-9) { this.active[i] = 0; return 0; }
    C[0] = T[o4] / n; C[1] = T[o4 + 1] / n; C[2] = T[o4 + 2] / n; C[3] = T[o4 + 3] / n;
    const changed = C[0] !== X[o4] || C[1] !== X[o4 + 1] || C[2] !== X[o4 + 2] || C[3] !== X[o4 + 3];
    // Delta (bone-local): D = B^-1 * X; identity when no layer touched this bone.
    U[0] = 0; U[1] = 0; U[2] = 0; U[3] = 1;
    if (withBase && (C[0] !== B[o4] || C[1] !== B[o4 + 1] || C[2] !== B[o4 + 2] || C[3] !== B[o4 + 3])) {
      qmul(B, o4, -1, C, 0); U[0] = Q[0]; U[1] = Q[1]; U[2] = Q[2]; U[3] = Q[3];
    }
    if (learn) {
      for (let k = 0; k < 4; k++) { X[o4 + k] = C[k]; if (withBase) D[o4 + k] = U[k]; }
      for (let k = 0; k < 3; k++) { this.xVel[o3 + k] = 0; this.dVel[o3 + k] = 0; this.off[o3 + k] = 0; this.offVel[o3 + k] = 0; }
      this.streak[i] = ACQUIRE; this.active[i] = 0;
      return 0;
    }
    if (dt === 0) return 0;
    const useDelta = withBase && trusted && dState === D_FULL;
    const deltaStep = withBase && dState >= D_VALUE;
    // Local steps: prev^-1 * current (skipped for unchanged values, the common case).
    let sx = 0, sy = 0, sz = 0;
    if (changed) { qmul(X, o4, -1, C, 0); qlog(); sx = L[0]; sy = L[1]; sz = L[2]; }
    let ux = 0, uy = 0, uz = 0;
    if (deltaStep && (U[0] !== D[o4] || U[1] !== D[o4 + 1] || U[2] !== D[o4 + 2] || U[3] !== D[o4 + 3])) {
      qmul(D, o4, -1, U, 0); qlog(); ux = L[0]; uy = L[1]; uz = L[2];
    }
    // Prediction error in the chosen space, first order in the tangent space
    // (per-frame steps are small; the absorption below stays exact).
    const V = useDelta ? this.dVel : this.xVel;
    const vx = V[o3], vy = V[o3 + 1], vz = V[o3 + 2];
    const ex = (useDelta ? ux : sx) - vx * dt, ey = (useDelta ? uy : sy) - vy * dt, ez = (useDelta ? uz : sz) - vz * dt;
    const error = Math.sqrt(ex * ex + ey * ey + ez * ez), streak = this.streak[i];
    let jumped = 0;
    if (this.exceeds(error, Math.sqrt(vx * vx + vy * vy + vz * vz), useDelta, streak)) {
      // Absorb the unexpected part (local): exp(o') = exp(-error) * exp(o).
      qexp(this.off, o3, 1); A[0] = Q[0]; A[1] = Q[1]; A[2] = Q[2]; A[3] = Q[3];
      E[0] = ex; E[1] = ey; E[2] = ez; qexp(E, 0, -1); P[0] = Q[0]; P[1] = Q[1]; P[2] = Q[2]; P[3] = Q[3];
      qmul(P, 0, 1, A, 0); qlog();
      this.off[o3] = L[0]; this.off[o3 + 1] = L[1]; this.off[o3 + 2] = L[2];
      if (streak === 0) {
        this.pre[o3] = vx; this.pre[o3 + 1] = vy; this.pre[o3 + 2] = vz; this.space[i] = useDelta ? SPACE_DELTA : SPACE_TARGET;
        for (let k = 0; k < 3; k++) { this.xVel[o3 + k] = 0; this.dVel[o3 + k] = 0; }
      } else {
        this.xVel[o3] = sx / dt; this.xVel[o3 + 1] = sy / dt; this.xVel[o3 + 2] = sz / dt;
        const keep = deltaStep && trusted ? 1 / dt : 0;
        this.dVel[o3] = ux * keep; this.dVel[o3 + 1] = uy * keep; this.dVel[o3 + 2] = uz * keep;
      }
      this.streak[i] = Math.min(2, streak + 1);
      this.active[i] = 1;
      jumped = 1; this.jumpError = error;
    } else {
      const keep = trusted ? 1 / dt : 0;
      if (streak === 1 || streak === 2) {
        if (this.space[i] === (useDelta ? SPACE_DELTA : SPACE_TARGET)) {
          // First steady frame after a jump: carry the pre-jump velocity into the offset (bounded).
          let tx = this.pre[o3] - (useDelta ? ux : sx) / dt, ty = this.pre[o3 + 1] - (useDelta ? uy : sy) / dt, tz = this.pre[o3 + 2] - (useDelta ? uz : sz) / dt;
          const t = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (t > this.kind.maxVelocity) { const g = this.kind.maxVelocity / t; tx *= g; ty *= g; tz *= g; }
          this.offVel[o3] += tx; this.offVel[o3 + 1] += ty; this.offVel[o3 + 2] += tz;
          this.active[i] = 1;
        }
      }
      if (streak) this.streak[i] = 0;
      this.xVel[o3] = sx / dt; this.xVel[o3 + 1] = sy / dt; this.xVel[o3 + 2] = sz / dt;
      this.dVel[o3] = ux * keep; this.dVel[o3 + 1] = uy * keep; this.dVel[o3 + 2] = uz * keep;
    }
    for (let k = 0; k < 4; k++) { X[o4 + k] = C[k]; if (withBase) D[o4 + k] = U[k]; }
    if (!this.active[i]) return jumped;
    if (this.decay(o3, 3, this.streak[i] === 0)) this.active[i] = 0;
    return jumped;
  }

  /** Displayed quaternion (target * exp(offset)) into Q, in the target's hemisphere. */
  shown(i: number): void {
    const o4 = i * 4, o3 = i * 3, T = this.target, C = this.cur;
    const n = Math.sqrt(T[o4] * T[o4] + T[o4 + 1] * T[o4 + 1] + T[o4 + 2] * T[o4 + 2] + T[o4 + 3] * T[o4 + 3]) || 1;
    C[0] = T[o4] / n; C[1] = T[o4 + 1] / n; C[2] = T[o4 + 2] / n; C[3] = T[o4 + 3] / n;
    qexp(this.off, o3, 1); A[0] = Q[0]; A[1] = Q[1]; A[2] = Q[2]; A[3] = Q[3];
    qmul(C, 0, 1, A, 0);
    const m = Math.sqrt(Q[0] * Q[0] + Q[1] * Q[1] + Q[2] * Q[2] + Q[3] * Q[3]) || 1;
    Q[0] /= m; Q[1] /= m; Q[2] /= m; Q[3] /= m;
    if (Q[0] * C[0] + Q[1] * C[1] + Q[2] * C[2] + Q[3] * C[3] < 0) { Q[0] = -Q[0]; Q[1] = -Q[1]; Q[2] = -Q[2]; Q[3] = -Q[3]; }
  }

  magnitude(i: number): number { return Math.hypot(this.off[i * 3], this.off[i * 3 + 1], this.off[i * 3 + 2]); }

  /** R29f: the composed target's own angular velocity at the last frame (bone-local, rad/s), when known and steady. */
  rate(i: number, out: number[]): boolean {
    if (!this.guarded[i] || this.streak[i] !== 0) return false;
    out[0] = this.xVel[i * 3]; out[1] = this.xVel[i * 3 + 1]; out[2] = this.xVel[i * 3 + 2];
    return out.every(finite);
  }
}

/**
 * Inertialization over the composed display pose. Construct once per mesh.
 * See the module comment for the per-frame call order.
 */
export class PoseContinuity {
  readonly mesh: ContinuityMesh;
  private readonly tuning: ContinuityTuning;
  private readonly height: number;
  private readonly boneCount: number;
  private readonly morphCount: number;
  private readonly rotations: RotationChannel;
  private readonly positions: LinearChannel;
  private readonly morphs: LinearChannel;
  private primed = false;
  private applied = false;
  private baseCaptured = false;
  private baseTrusted = false;
  private lastBaseTrusted = false;
  private deltaState = D_NONE;
  private jumps = 0;
  private lastJumpKind = -1; private lastJumpIndex = -1; private lastJumpSize = 0;
  private resets = 0;
  private lastReset = 'created';
  /** Morphs whose step this frame belongs to a dedicated owner (apply's `ownedMorphs`); cleared after each frame. */
  private readonly owned: Uint8Array;

  constructor(mesh: ContinuityMesh, options: PoseContinuityOptions = {}) {
    this.mesh = mesh;
    this.tuning = options.tuning ?? DEFAULT_CONTINUITY_TUNING;
    this.height = finite(options.height) && options.height! > 0 ? options.height! : 1;
    this.boneCount = mesh.skeleton.bones.length;
    this.morphCount = mesh.morphTargetInfluences?.length ?? 0;
    this.rotations = new RotationChannel(this.boneCount, this.tuning.rotation);
    this.positions = new LinearChannel(this.boneCount, 3, this.tuning.position, this.height);
    this.morphs = new LinearChannel(this.morphCount, 1, this.tuning.morph, 1);
    this.owned = new Uint8Array(this.morphCount);
    for (const index of options.excludedBones ?? []) if (Number.isInteger(index) && index >= 0 && index < this.boneCount) {
      this.rotations.guarded[index] = 0; this.positions.guarded[index] = 0;
    }
    for (const index of options.excludedMorphs ?? []) if (Number.isInteger(index) && index >= 0 && index < this.morphCount) this.morphs.guarded[index] = 0;
  }

  /** Hard reset: forget history and offsets. Never writes; the next apply passes through. */
  reset(reason = 'reset'): void {
    if (this.applied) this.remove();
    this.primed = false; this.baseCaptured = false; this.deltaState = D_NONE;
    this.rotations.clear(); this.positions.clear(); this.morphs.clear();
    this.jumps = 0; this.lastJumpKind = -1; this.lastJumpIndex = -1; this.lastJumpSize = 0;
    this.resets++; this.lastReset = reason;
  }

  /**
   * Snapshot the base pose right after the mixer/helper. `trusted` means the
   * mixer only advanced its existing actions (see BaseSourceWatch).
   */
  captureBase(trusted: boolean): void {
    if (this.applied) this.remove();
    const bones = this.mesh.skeleton.bones, influences = this.mesh.morphTargetInfluences;
    if (bones.length !== this.boneCount || (influences?.length ?? 0) !== this.morphCount) return;
    const R = this.rotations.base, P = this.positions.base, M = this.morphs.base;
    for (let i = 0; i < this.boneCount; i++) {
      if (!this.rotations.guarded[i]) continue;
      const q = bones[i].quaternion, p = bones[i].position;
      const n = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1;
      R[i * 4] = q.x / n; R[i * 4 + 1] = q.y / n; R[i * 4 + 2] = q.z / n; R[i * 4 + 3] = q.w / n;
      P[i * 3] = p.x; P[i * 3 + 1] = p.y; P[i * 3 + 2] = p.z;
    }
    if (influences) for (let i = 0; i < this.morphCount; i++) if (this.morphs.guarded[i]) M[i] = influences[i];
    this.baseCaptured = true;
    this.baseTrusted = trusted === true;
  }

  /**
   * One display frame. `dt` is the animation delta; `gap` the real time since
   * the previous rendered frame (defaults to dt). `ownedMorphs`: morphs whose motion this frame is a dedicated
   * owner's by construction (pretrial 2026-11-03: the lid shapes that give way to a natural blink move at the
   * blink's own speed, ~0.16 s; catching them blunted the blink and left both lid morphs up at once). They are
   * followed, not judged, for this frame only.
   */
  apply(dt: number, gap = dt, ownedMorphs: readonly number[] | null = null): void {
    if (this.applied) this.remove();
    const bones = this.mesh.skeleton.bones, influences = this.mesh.morphTargetInfluences;
    if (bones.length !== this.boneCount || (influences?.length ?? 0) !== this.morphCount) { this.reset('topology-changed'); return; }
    const step = finite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    if (this.primed && (!finite(gap) || gap > this.tuning.staleGap)) this.reset('stale-gap');
    const learn = !this.primed, withBase = this.baseCaptured, trusted = withBase && this.baseTrusted, dState = this.deltaState;
    const R = this.rotations, P = this.positions, M = this.morphs;
    R.dt = P.dt = M.dt = step;
    for (let i = 0; i < this.boneCount; i++) {
      if (!R.guarded[i]) continue;
      const bone = bones[i], q = bone.quaternion, p = bone.position;
      R.target[i * 4] = q.x; R.target[i * 4 + 1] = q.y; R.target[i * 4 + 2] = q.z; R.target[i * 4 + 3] = q.w;
      if (R.step(i, learn, withBase, trusted, dState)) this.noteJump(R, 0, i);
      if (R.active[i]) {
        R.shown(i); q.set(Q[0], Q[1], Q[2], Q[3]);
        R.written[i * 4] = q.x; R.written[i * 4 + 1] = q.y; R.written[i * 4 + 2] = q.z; R.written[i * 4 + 3] = q.w;
        R.wrote[i] = 1;
      }
      P.target[i * 3] = p.x; P.target[i * 3 + 1] = p.y; P.target[i * 3 + 2] = p.z;
      if (P.step(i, learn, withBase, trusted, dState)) this.noteJump(P, 1, i);
      if (P.active[i]) {
        const o = i * 3;
        p.set(P.target[o] + P.off[o], P.target[o + 1] + P.off[o + 1], P.target[o + 2] + P.off[o + 2]);
        P.written[o] = p.x; P.written[o + 1] = p.y; P.written[o + 2] = p.z;
        P.wrote[i] = 1;
      }
    }
    const owned = this.owned;
    if (ownedMorphs) for (const index of ownedMorphs) if (Number.isInteger(index) && index >= 0 && index < this.morphCount) owned[index] = 1;
    if (influences) for (let i = 0; i < this.morphCount; i++) {
      if (!M.guarded[i]) continue;
      const target = influences[i];
      M.target[i] = target;
      if (M.step(i, learn, withBase, trusted, dState, owned[i] !== 1)) this.noteJump(M, 2, i);
      if (M.active[i]) {
        // An offset must not push a morph outside [0, 1] (inverted or overdriven
        // shape); a target that is itself outside that range is never clamped here.
        influences[i] = Math.min(Math.max(1, target), Math.max(Math.min(0, target), target + M.off[i]));
        M.written[i] = influences[i];
        M.wrote[i] = 1;
      }
    }
    if (ownedMorphs) for (const index of ownedMorphs) if (Number.isInteger(index) && index >= 0 && index < this.morphCount) owned[index] = 0;
    this.primed = true;
    this.applied = true;
    this.lastBaseTrusted = trusted;
    this.deltaState = !withBase ? D_NONE : !trusted ? D_VALUE : Math.min(D_FULL, dState + 1);
    this.baseCaptured = false; this.baseTrusted = false;
  }

  /** Write the exact composed targets back, unless something else replaced the displayed value meanwhile. */
  remove(): void {
    if (!this.applied) return;
    this.applied = false;
    const bones = this.mesh.skeleton.bones, influences = this.mesh.morphTargetInfluences;
    const R = this.rotations, P = this.positions, M = this.morphs;
    for (let i = 0; i < this.boneCount; i++) {
      const bone = bones[i];
      if (R.wrote[i]) {
        R.wrote[i] = 0;
        const q = bone.quaternion, o = i * 4, w = R.written;
        if (q.x === w[o] && q.y === w[o + 1] && q.z === w[o + 2] && q.w === w[o + 3]) q.set(R.target[o], R.target[o + 1], R.target[o + 2], R.target[o + 3]);
      }
      if (P.wrote[i]) {
        P.wrote[i] = 0;
        const p = bone.position, o = i * 3, w = P.written;
        if (p.x === w[o] && p.y === w[o + 1] && p.z === w[o + 2]) p.set(P.target[o], P.target[o + 1], P.target[o + 2]);
      }
    }
    if (influences) for (let i = 0; i < this.morphCount; i++) {
      if (!M.wrote[i]) continue;
      M.wrote[i] = 0;
      if (influences[i] === M.written[i]) influences[i] = M.target[i];
    }
  }

  /**
   * R29f: how fast the composed pose of one bone property was moving at the last frame (bone-local, per second:
   * a body-frame angular velocity for a rotation, per axis for a position), or null when unknown: not primed yet,
   * excluded, or the last frames were a jump. A hand-off bridge starts from the shown pose at this speed.
   */
  rate(boneIndex: number, kind: 'quaternion' | 'position'): number[] | null {
    if (!this.primed || !Number.isInteger(boneIndex) || boneIndex < 0 || boneIndex >= this.boneCount) return null;
    const out = [0, 0, 0];
    return (kind === 'quaternion' ? this.rotations.rate(boneIndex, out) : this.positions.rate(boneIndex, out)) ? out : null;
  }

  /** True while any property shows an offset. */
  get active(): boolean {
    for (let i = 0; i < this.boneCount; i++) if (this.rotations.active[i] || this.positions.active[i]) return true;
    for (let i = 0; i < this.morphCount; i++) if (this.morphs.active[i]) return true;
    return false;
  }

  getState(): PoseContinuityState {
    let active = 0, angle = 0, position = 0, morph = 0, properties = 0;
    for (let i = 0; i < this.boneCount; i++) {
      if (!this.rotations.guarded[i]) continue;
      properties += 2;
      if (this.rotations.active[i]) { active++; angle = Math.max(angle, this.rotations.magnitude(i)); }
      if (this.positions.active[i]) { active++; position = Math.max(position, this.positions.magnitude(i) / this.height); }
    }
    for (let i = 0; i < this.morphCount; i++) {
      if (!this.morphs.guarded[i]) continue;
      properties++;
      if (this.morphs.active[i]) { active++; morph = Math.max(morph, this.morphs.magnitude(i)); }
    }
    const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
    let lastJump: PoseContinuityState['lastJump'] = null;
    if (this.lastJumpKind >= 0) {
      const property = this.lastJumpKind === 2 ? `.morphTargetInfluences[${this.lastJumpIndex}]`
        : `.bones[${this.mesh.skeleton.bones[this.lastJumpIndex]?.name ?? this.lastJumpIndex}].${this.lastJumpKind === 0 ? 'quaternion' : 'position'}`;
      const size = this.lastJumpKind === 0 ? this.lastJumpSize * 180 / Math.PI : this.lastJumpKind === 1 ? this.lastJumpSize / this.height : this.lastJumpSize;
      lastJump = { property, size: round(size, 4) };
    }
    return { active, maxAngleDeg: round(angle * 180 / Math.PI, 3), maxPosition: round(position, 5), maxMorph: round(morph, 4),
      jumps: this.jumps, lastJump, resets: this.resets, lastReset: this.lastReset, baseTrusted: this.lastBaseTrusted, properties };
  }

  private noteJump(channel: Channel, kind: number, index: number): void {
    this.jumps++; this.lastJumpKind = kind; this.lastJumpIndex = index; this.lastJumpSize = channel.jumpError;
  }
}

/** Pinned three r170 AnimationMixer/AnimationAction surface read by BaseSourceWatch. */
export interface WatchedAction {
  readonly enabled: boolean; readonly paused: boolean; readonly time: number; readonly loop: number;
  getClip(): { readonly duration: number }; getEffectiveWeight(): number; getEffectiveTimeScale(): number;
}
export interface WatchedMixer { readonly _actions?: readonly WatchedAction[]; readonly _nActiveActions?: number; readonly timeScale?: number }
const LOOP_ONCE = 2200;
/**
 * Whether `time` is `previous + expected` wrapped into [0, duration) by a
 * repeating (or ping-pong) loop, either direction, measured around the loop so
 * a landing just below the end and one just past zero are the same place.
 */
export function wrappedBy(previous: number, expected: number, time: number, duration: number, loop: number, tolerance: number): boolean {
  if (loop === LOOP_ONCE || !finite(duration) || duration <= 0 || !finite(previous) || !finite(expected) || !finite(time)) return false;
  const next = previous + expected;
  if (next >= 0 && next < duration) return false; // no loop boundary crossed: only `advanced` can explain it
  const landed = next - duration * Math.floor(next / duration);
  const gap = Math.abs(time - landed) % duration;
  return Math.min(gap, duration - gap) <= tolerance;
}

/**
 * Decides whether this frame's mixer output is authored playback: the same
 * active actions, clips and weights as last frame, each clock advanced by the
 * frame delta (or wrapped by its own loop). Anything else — an action added,
 * stopped, re-weighted, faded or seeked — is a hand-off on the base, which the
 * guard then watches like any other writer. Allocation-free after warm-up.
 */
export class BaseSourceWatch {
  private actions: WatchedAction[] = [];
  private clips: object[] = [];
  private readonly weights: number[] = [];
  private readonly times: number[] = [];
  private primed = false;

  reset(): void { this.primed = false; this.actions.length = 0; this.clips.length = 0; }

  observe(mixer: WatchedMixer | null | undefined, dt: number): boolean {
    const list = mixer?._actions;
    if (!list) { this.reset(); return false; }
    const count = Math.min(list.length, Number.isInteger(mixer!._nActiveActions) ? mixer!._nActiveActions! : list.length);
    const scale = finite(mixer!.timeScale) ? mixer!.timeScale! : 1;
    let trusted = this.primed && count === this.actions.length;
    for (let i = 0; i < count; i++) {
      const action = list[i], clip = action.getClip(), weight = action.getEffectiveWeight(), time = action.time;
      if (trusted) {
        if (action !== this.actions[i] || clip !== this.clips[i] || !finite(weight) || Math.abs(weight - this.weights[i]) > 1e-6 || !action.enabled) trusted = false;
        else {
          const expected = dt * scale * action.getEffectiveTimeScale(), moved = time - this.times[i];
          const tolerance = 1e-4 + Math.abs(expected) * 1e-3;
          const advanced = Math.abs(moved - expected) <= tolerance;
          const held = Math.abs(moved) <= 1e-9 && (action.paused || expected === 0 || action.loop === LOOP_ONCE);
          // X-089: only the action's own loop is a wrap: the clock lands where the frame delta, wrapped by
          // the clip duration, puts it (three r170 AnimationAction._updateTime). Any other jump, backwards
          // included, is a seek on the base and is watched like every other hand-off.
          if (!advanced && !held && !wrappedBy(this.times[i], expected, time, clip.duration, action.loop, tolerance)) trusted = false;
        }
      }
      this.actions[i] = action; this.clips[i] = clip; this.weights[i] = weight; this.times[i] = time;
    }
    this.actions.length = count; this.clips.length = count;
    this.primed = true;
    return trusted;
  }
}
