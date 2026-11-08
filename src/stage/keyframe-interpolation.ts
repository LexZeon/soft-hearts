/**
 * R29f: VMD playback as keyframe animation (docs/claude/2026-11-03-R29f-smoothness.md). The user's words
 * (2026-11-03): motion should go from one key to the next like K-frame animation, "not frame to frame,
 * stepping". Two things in three r170's MMDLoader (CubicBezierInterpolation) stood against that:
 *
 *  1. Keys less than 1.5 frames apart are not interpolated at all ("no interpolation if next key frame is in
 *     one frame in 30fps", from MMD's camera-cut rule). Every bundled motion-capture clip (chat gestures,
 *     automatic idles, conversation gestures, the dance) has a key on every frame, so they all played as a
 *     30 Hz staircase: at 60 fps each pose stood still for a frame and then jumped two frames' worth.
 *  2. A segment without an authored curve (the VMD default, a straight line) moves at constant speed and
 *     turns at the key: the Stand idle (a key every second) swayed as a triangle wave.
 *
 * KeyframeInterpolant samples the author's Bezier curves exactly as MMDLoader does, and passes through every
 * key of a straight segment; between keys:
 *  - every segment is interpolated, however short (the cut rule is dropped for bone and morph tracks);
 *  - a straight-line segment (captured motion or hand-set keys) becomes a cubic through its two keys with
 *    "clamped auto" tangents (what an animation editor does by default): the speed carries through a key that
 *    the motion passes on, and it eases to zero at a turn, a hold, and the clip's first and last keys.
 *    Quaternions use Shoemake's Bezier (De Casteljau of slerps); vectors and morph weights a cubic Hermite.
 * What holds, and where (Codex T-112 round-005 measured the edges):
 *  - Within its keys: each component of a vector or morph weight stays between the two keys of its straight
 *    segment (monotone per segment); so does a turn about one axis. A rotation that changes axis is limited per
 *    body-frame component, which keeps holds exactly still but is not a proof for every multi-axis turn.
 *  - Speed continuity (C1): at a key between two straight segments. Where a straight segment meets an authored
 *    curve, the authored curve keeps its own speed at the key (it is played as written), so the two sides differ.
 *  - Keys: a straight segment hits its keys exactly. An authored curve is MMD's bisection, so an extreme one can
 *    miss its key by MMD's own amount (x1 = x2 = 0, y1 = y2 = 1 over 40°: 1.85° at the key, as in MMD).
 * The VMD bytes and the parsed keys are untouched; only how the clip is sampled between keys changes.
 * No allocation per evaluation.
 */
import { Interpolant, NumberKeyframeTrack, Quaternion, type AnimationClip, type KeyframeTrack } from 'three';

/** MMDLoader's CubicBezierInterpolation._calculate: bisection on x, then y. */
function bezierRatio(x1: number, x2: number, y1: number, y2: number, x: number): number {
  let c = 0.5, t = c, s = 1 - t, sst3 = 0, stt3 = 0, ttt = 0;
  for (let i = 0; i < 15; i++) {
    sst3 = 3 * s * s * t; stt3 = 3 * s * t * t; ttt = t * t * t;
    const ft = sst3 * x1 + stt3 * x2 + ttt - x;
    if (Math.abs(ft) < 1e-5) break;
    c /= 2; t += ft < 0 ? c : -c; s = 1 - t;
  }
  return sst3 * y1 + stt3 * y2 + ttt;
}
/** A segment whose Bezier control points lie on the diagonal: the straight line (VMD's "no curve set"). */
const straight = (x1: number, x2: number, y1: number, y2: number) => Math.abs(x1 - y1) < 1e-6 && Math.abs(x2 - y2) < 1e-6;

/**
 * Monotone (Fritsch–Carlson with Hyman's limit) tangent from the two neighbouring segment slopes and durations: the
 * duration-weighted mean slope, limited to 3× the smaller neighbour, so each Hermite segment stays monotone (inside
 * its two keys' values); 0 when either neighbour is a hold or the key is a turn (an extremum). Also used by expression-show.ts.
 */
export function clampedTangent(d0: number, d1: number, h0: number, h1: number): number {
  if (!(d0 * d1 > 0)) return 0; // a turn or a hold: ease to rest at this key
  const m = (h1 * d0 + h0 * d1) / (h0 + h1);
  const limit = 3 * Math.min(Math.abs(d0), Math.abs(d1));
  return Math.abs(m) > limit ? Math.sign(m) * limit : m;
}

// Scratch (module-level, never reallocated).
const Q0 = new Float64Array(4), Q1 = new Float64Array(4), C0 = new Float64Array(4), C1 = new Float64Array(4);
const A = new Float64Array(4), B = new Float64Array(4), C = new Float64Array(4), D = new Float64Array(4), E = new Float64Array(4);
const R = new Float64Array(4);
/** out = q * exp(v * scale) (body-frame increment). */
function rightExp(out: Float64Array, q: Float64Array, vx: number, vy: number, vz: number, scale: number): void {
  const x = vx * scale, y = vy * scale, z = vz * scale, angle = Math.sqrt(x * x + y * y + z * z);
  let ex: number, ey: number, ez: number, ew: number;
  if (angle < 1e-12) { ex = x * 0.5; ey = y * 0.5; ez = z * 0.5; ew = 1; }
  else { const k = Math.sin(angle * 0.5) / angle; ex = x * k; ey = y * k; ez = z * k; ew = Math.cos(angle * 0.5); }
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  out[0] = qw * ex + qx * ew + qy * ez - qz * ey;
  out[1] = qw * ey - qx * ez + qy * ew + qz * ex;
  out[2] = qw * ez + qx * ey - qy * ex + qz * ew;
  out[3] = qw * ew - qx * ex - qy * ey - qz * ez;
}
/** Body-frame log of a^-1 * b along the shortest way, into R[0..2]. */
function relativeLog(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number): void {
  const ax = -a[ao], ay = -a[ao + 1], az = -a[ao + 2], aw = a[ao + 3];
  const bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  let x = aw * bx + ax * bw + ay * bz - az * by;
  let y = aw * by - ax * bz + ay * bw + az * bx;
  let z = aw * bz + ax * by - ay * bx + az * bw;
  let w = aw * bw - ax * bx - ay * by - az * bz;
  const n = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-12) { R[0] = 2 * x; R[1] = 2 * y; R[2] = 2 * z; return; }
  const k = 2 * Math.atan2(s, w) / s;
  R[0] = x * k; R[1] = y * k; R[2] = z * k;
}

export class KeyframeInterpolant extends Interpolant {
  /** MMD Bezier parameters per key (as CubicBezierInterpolation), or null: every segment is a straight line. */
  private readonly params: ArrayLike<number> | null;
  /** Clamped tangent per key: 3 body-frame components (rad/s) for a quaternion, one per component otherwise. */
  private readonly slopes: Float32Array;
  private readonly width: number;

  constructor(times: ArrayLike<number>, values: ArrayLike<number>, valueSize: number, resultBuffer?: ArrayLike<number> | null, params: ArrayLike<number> | null = null) {
    super(times as any, values as any, valueSize, resultBuffer as any);
    this.params = params;
    const n = times.length, quaternion = valueSize === 4;
    this.width = quaternion ? 3 : valueSize;
    const width = this.width, slopes = this.slopes = new Float32Array(n * width);
    if (n < 3) return; // two keys or fewer: both ends at rest
    // Segment slopes (per second): body-frame angular velocity for a quaternion, the difference quotient otherwise.
    const d = new Float64Array((n - 1) * width);
    for (let j = 0; j < n - 1; j++) {
      const h = times[j + 1] - times[j];
      if (!(h > 1e-9)) continue;
      if (quaternion) { relativeLog(values, j * 4, values, (j + 1) * 4); for (let c = 0; c < 3; c++) d[j * 3 + c] = R[c] / h; }
      else for (let c = 0; c < width; c++) d[j * width + c] = (values[(j + 1) * width + c] - values[j * width + c]) / h;
    }
    for (let k = 1; k < n - 1; k++) {
      const h0 = times[k] - times[k - 1], h1 = times[k + 1] - times[k];
      if (!(h0 > 1e-9) || !(h1 > 1e-9)) continue;
      // Captured motion (a key on every frame) and hand-set keys alike: clamped. Codex T-112 round-005 measured the
      // plain centred tangent R29f first used for captured motion overshooting at a hold or a turn ([0,1,1] → 1.0625,
      // [0,0,1] → −0.0625, a rotation [0°,10°,10°] → 10.625°); where the motion passes a key it is unchanged.
      // The body frames of keys k−1 and k differ by a turn about d[k−1]'s own axis, so both slopes read in key k's frame.
      for (let c = 0; c < width; c++) slopes[k * width + c] = clampedTangent(d[(k - 1) * width + c], d[k * width + c], h0, h1);
    }
  }

  /** Whether the segment ending at key i1 (component c of a vector) is a straight line, i.e. gets the keyframe cubic. */
  private straightAt(i1: number, component: number): boolean {
    const p = this.params;
    if (!p) return true;
    const o = this.valueSize === 3 ? i1 * 12 + component * 4 : i1 * 4;
    return straight(p[o], p[o + 1], p[o + 2], p[o + 3]);
  }
  private ratio(i1: number, component: number, s: number): number {
    const p = this.params!, o = this.valueSize === 3 ? i1 * 12 + component * 4 : i1 * 4;
    return bezierRatio(p[o], p[o + 1], p[o + 2], p[o + 3], s);
  }

  protected interpolate_(i1: number, t0: number, t: number, t1: number): ArrayLike<number> {
    const result = this.resultBuffer as unknown as Float64Array, values = this.sampleValues, stride = this.valueSize;
    const h = t1 - t0, s = h > 0 ? Math.min(1, Math.max(0, (t - t0) / h)) : 0;
    const o1 = i1 * stride, o0 = o1 - stride, slopes = this.slopes, width = this.width;
    if (stride === 4) {
      if (!this.straightAt(i1, 0)) { Quaternion.slerpFlat(result as any, 0, values as any, o0, values as any, o1, this.ratio(i1, 0, s)); return result; }
      for (let c = 0; c < 4; c++) { Q0[c] = values[o0 + c]; Q1[c] = values[o1 + c]; }
      // One hemisphere for the whole curve, so each slerp of the De Casteljau chain takes the short way.
      if (Q0[0] * Q1[0] + Q0[1] * Q1[1] + Q0[2] * Q1[2] + Q0[3] * Q1[3] < 0) for (let c = 0; c < 4; c++) Q1[c] = -Q1[c];
      const a = (i1 - 1) * 3, b = i1 * 3, third = h / 3;
      rightExp(C0, Q0, slopes[a], slopes[a + 1], slopes[a + 2], third);
      rightExp(C1, Q1, slopes[b], slopes[b + 1], slopes[b + 2], -third);
      Quaternion.slerpFlat(A as any, 0, Q0 as any, 0, C0 as any, 0, s);
      Quaternion.slerpFlat(B as any, 0, C0 as any, 0, C1 as any, 0, s);
      Quaternion.slerpFlat(C as any, 0, C1 as any, 0, Q1 as any, 0, s);
      Quaternion.slerpFlat(D as any, 0, A as any, 0, B as any, 0, s);
      Quaternion.slerpFlat(E as any, 0, B as any, 0, C as any, 0, s);
      Quaternion.slerpFlat(result as any, 0, D as any, 0, E as any, 0, s);
      return result;
    }
    // Cubic Hermite per component (vectors, morph weights).
    const s2 = s * s, s3 = s2 * s, h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    for (let c = 0; c < stride; c++) {
      const v0 = values[o0 + c], v1 = values[o1 + c];
      if (!this.straightAt(i1, c)) { const r = this.ratio(i1, c, s); result[c] = v0 * (1 - r) + v1 * r; continue; }
      result[c] = h00 * v0 + h10 * h * slopes[(i1 - 1) * width + c] + h01 * v1 + h11 * h * slopes[i1 * width + c];
    }
    return result;
  }
}

type FactoryTrack = KeyframeTrack & { createInterpolant(result?: ArrayLike<number>): Interpolant };
/** Gives one track keyframe interpolation, keeping its MMD Bezier parameters (read once from its own factory). */
export function keyframeTrack<T extends KeyframeTrack>(track: T): T {
  const factory = track as unknown as FactoryTrack;
  if ((factory as { keyframeInterpolation?: boolean }).keyframeInterpolation) return track;
  let params: ArrayLike<number> | null = null;
  if (!(track instanceof NumberKeyframeTrack)) {
    try { params = (factory.createInterpolant.call(track, undefined) as unknown as { interpolationParams?: ArrayLike<number> }).interpolationParams ?? null; }
    catch { params = null; }
    // Not a VMD bone track (no MMD parameters): leave it exactly as it was.
    if (!params) return track;
  }
  factory.createInterpolant = function (this: KeyframeTrack, result?: ArrayLike<number>) {
    return new KeyframeInterpolant(this.times, this.values, this.getValueSize(), result, params);
  } as FactoryTrack['createInterpolant'];
  (factory as { keyframeInterpolation?: boolean }).keyframeInterpolation = true;
  return track;
}

/** Every VMD bone and morph track of a built clip (MMDLoader's AnimationBuilder output). */
export function keyframeClip<T extends AnimationClip>(clip: T): T {
  for (const track of clip.tracks) keyframeTrack(track);
  return clip;
}

interface BuilderLike { build(vmd: unknown, mesh: unknown): AnimationClip }
/** The stage's MMDLoader: its animation builder gives every clip keyframe interpolation. Returns the same loader. */
export function withKeyframeInterpolation<T extends object>(loader: T): T {
  const builder = (loader as unknown as { animationBuilder?: BuilderLike & { keyframeInterpolation?: boolean } }).animationBuilder;
  if (!builder || builder.keyframeInterpolation) return loader;
  const build = builder.build.bind(builder);
  builder.build = (vmd: unknown, mesh: unknown) => keyframeClip(build(vmd, mesh));
  builder.keyframeInterpolation = true;
  return loader;
}
