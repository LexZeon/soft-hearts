/**
 * R29f follow-up (Claude pretrial 2026-11-03, docs/claude/2026-11-03-pretrial-fixes-motion.md): motion-captured
 * rotations carry frame-to-frame jitter. In the chat gesture speaking-gesture-2 the right wrist (右手首) turns 9–16°
 * per 1/30 s with its turn axis swinging round from one key to the next (keys 86–101: a 125° path for a 49° net turn).
 * Keyframe interpolation (keyframe-interpolation.ts) plays every key faithfully and eases to rest wherever a
 * component turns back, so that jitter became a stop and a restart on nearly every key; the display guard caught
 * three of them a gesture (2.3–4.7°) and "一卡一卡" was in the source.
 *
 * Dense captured runs (a key on every capture frame) are low-passed once at load, in memory: a zero-phase [1, 2, 1] / 4
 * kernel in the tangent space of each key, applied PASSES times (each pass removes the frame-to-frame alternation
 * entirely and keeps slow motion: a 2 Hz stroke keeps ≥ 91 % of its amplitude with two passes, a 3 Hz one ≥ 82 %).
 * Each run's first and last key stay exactly where they were (the clip's start and end poses, and every key that
 * borders a hand-set or sparse part). Hand-set sparse keys and authored Bezier curves are not touched. The VMD
 * bytes are never changed; only the parsed key values of this clip in memory.
 */
import type { AnimationClip, KeyframeTrack } from 'three';

/** One capture frame (s). */
export const CAPTURE_FRAME = 1 / 30;
/**
 * Keys at most this far apart (s) belong to one captured run: one capture frame, or two, the stride the motion retarget bakes
 * re-posed bones at on a model that is not Gene (shared/motion-retarget.ts), with slack.
 */
export const CAPTURE_KEY_GAP = 2.5 / 30;
/**
 * Passes over a captured run (motion continuity: a fixed rule, not a tuning per character). Each pass is [a, 1 − 2a, a] about the key,
 * a = 1/4 for keys one capture frame apart ([1, 2, 1] / 4) and a = 1/4 × frame / spacing for wider keys (about the same response in time:
 * keys two frames apart get [1, 6, 1] / 8, which halves their fastest wobble per pass as [1, 2, 1] / 4 does at that frequency).
 */
export const CAPTURE_SMOOTHING_PASSES = 2;

const R = new Float64Array(3);
/** Body-frame log of a^-1 * b (shortest way) into R. */
function relativeLog(v: ArrayLike<number>, a: number, b: number): void {
  const ax = -v[a], ay = -v[a + 1], az = -v[a + 2], aw = v[a + 3];
  const bx = v[b], by = v[b + 1], bz = v[b + 2], bw = v[b + 3];
  let x = aw * bx + ax * bw + ay * bz - az * by;
  let y = aw * by - ax * bz + ay * bw + az * bx;
  let z = aw * bz + ax * by - ay * bx + az * bw;
  let w = aw * bw - ax * bx - ay * by - az * bz;
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) { R[0] = 2 * x; R[1] = 2 * y; R[2] = 2 * z; return; }
  const k = 2 * Math.atan2(s, w) / s;
  R[0] = x * k; R[1] = y * k; R[2] = z * k;
}

/**
 * Smooths the dense runs of one quaternion key list in place (`values`: x, y, z, w per key, as three stores them).
 * Returns how many keys moved. Runs shorter than three keys, and every run's two end keys, are left as they are.
 */
export function smoothCapturedRotations(times: ArrayLike<number>, values: { length: number; [index: number]: number }, passes = CAPTURE_SMOOTHING_PASSES): number {
  const n = times.length;
  if (n < 3 || values.length !== n * 4 || !(passes > 0)) return 0;
  const moved = new Uint8Array(n);
  let start = 0;
  for (let i = 1; i <= n; i++) {
    const breaks = i === n || !(times[i] - times[i - 1] <= CAPTURE_KEY_GAP) || !(times[i] - times[i - 1] > 1e-6);
    if (!breaks) continue;
    const end = i - 1; // run [start, end]
    if (end - start >= 2) smoothRun(times, values, start, end, passes, moved);
    start = i;
  }
  let count = 0;
  for (let i = 0; i < n; i++) count += moved[i];
  return count;
}

function smoothRun(times: ArrayLike<number>, values: { [index: number]: number }, first: number, last: number, passes: number, moved: Uint8Array): void {
  const count = last - first + 1, source = new Float64Array(count * 4), out = new Float64Array(count * 4);
  for (let k = 0; k < count * 4; k++) source[k] = values[first * 4 + k];
  // One hemisphere along the run, so neighbours are compared the short way.
  for (let k = 1; k < count; k++) {
    const o = k * 4, p = o - 4;
    if (source[o] * source[p] + source[o + 1] * source[p + 1] + source[o + 2] * source[p + 2] + source[o + 3] * source[p + 3] < 0)
      for (let c = 0; c < 4; c++) source[o + c] = -source[o + c];
  }
  for (let pass = 0; pass < passes; pass++) {
    out.set(source.subarray(0, 4), 0); out.set(source.subarray((count - 1) * 4), (count - 1) * 4);
    for (let k = 1; k < count - 1; k++) {
      const o = k * 4;
      relativeLog(source, o, o - 4); const px = R[0], py = R[1], pz = R[2];
      relativeLog(source, o, o + 4);
      // q · exp(a · (log(q⁻¹ q₋) + log(q⁻¹ q₊))): the [a, 1 − 2a, a] mean, taken about q itself.
      const spacing = (times[first + k + 1] - times[first + k - 1]) / 2, a = 0.25 * Math.min(1, CAPTURE_FRAME / spacing);
      const vx = (px + R[0]) * a, vy = (py + R[1]) * a, vz = (pz + R[2]) * a, angle = Math.hypot(vx, vy, vz);
      let ex: number, ey: number, ez: number, ew: number;
      if (angle < 1e-12) { ex = vx * 0.5; ey = vy * 0.5; ez = vz * 0.5; ew = 1; }
      else { const s = Math.sin(angle * 0.5) / angle; ex = vx * s; ey = vy * s; ez = vz * s; ew = Math.cos(angle * 0.5); }
      const qx = source[o], qy = source[o + 1], qz = source[o + 2], qw = source[o + 3];
      let x = qw * ex + qx * ew + qy * ez - qz * ey, y = qw * ey - qx * ez + qy * ew + qz * ex;
      let z = qw * ez + qx * ey - qy * ex + qz * ew, w = qw * ew - qx * ex - qy * ey - qz * ez;
      const m = Math.hypot(x, y, z, w) || 1;
      x /= m; y /= m; z /= m; w /= m;
      out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w;
    }
    source.set(out);
  }
  for (let k = 1; k < count - 1; k++) {
    const o = k * 4, i = first + k;
    let changed = false;
    for (let c = 0; c < 4; c++) {
      // Keep the stored hemisphere of the original key (three's slerp takes the short way either way).
      const original = values[i * 4 + c];
      if (source[o + c] !== original) changed = true;
    }
    const dot = source[o] * values[i * 4] + source[o + 1] * values[i * 4 + 1] + source[o + 2] * values[i * 4 + 2] + source[o + 3] * values[i * 4 + 3];
    const sign = dot < 0 ? -1 : 1;
    for (let c = 0; c < 4; c++) values[i * 4 + c] = sign * source[o + c];
    if (changed) moved[i] = 1;
  }
}

/**
 * Smooths every dense captured quaternion track of `clip` that `accept(name)` admits (in place; the tracks keep their
 * own interpolant factories). Idempotence guard: a clip is smoothed once, whoever loads it again from a cache.
 */
export function smoothCapturedClip(clip: AnimationClip, accept: (name: string) => boolean, passes = CAPTURE_SMOOTHING_PASSES): number {
  const marked = clip as AnimationClip & { captureSmoothed?: boolean };
  if (marked.captureSmoothed) return 0;
  marked.captureSmoothed = true;
  let keys = 0;
  for (const track of clip.tracks as KeyframeTrack[]) {
    if (track.getValueSize() !== 4 || !accept(track.name)) continue;
    keys += smoothCapturedRotations(track.times, track.values as unknown as { length: number; [index: number]: number }, passes);
  }
  return keys;
}
