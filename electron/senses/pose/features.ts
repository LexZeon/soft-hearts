/**
 * Keypoints over time → the pose signal (shared/senses/pose-signals.ts). Runs inside the inference process; the pixel keypoints
 * live only in this ring buffer (≤ 6 s). I-081: what leaves is the face centre and the 17 points normalised to the frame
 * (0..1), smoothed (time constant SMOOTH_S) and rounded to two decimals — never pixels, never the frame.
 *
 * COCO-17: 0 nose, 1/2 eyes, 3/4 ears, 5/6 shoulders, 7/8 elbows, 9/10 wrists, 11/12 hips, 13/14 knees.
 * All distances are in shoulder widths, so the rules do not depend on how far the user sits from the camera.
 * Thresholds are first guesses checked only on synthetic sequences (tests/pose-features.test.ts); no real person yet.
 */
import { eventConfidence, facingScore, meanScore, POSTURE_POINTS, STRETCH_POINTS, stretchClarity, voteConfidence, waveClarity, WAVE_POINTS, type Vote } from './confidence';
import { POSE_POINT_COUNT, type PoseCapability, type PoseEvent, type PoseFacing, type PoseHead, type PosePoint, type PosePosture, type PoseSignal } from '../../../shared/senses/pose-signals';
import { OneEuroFilter, type OneEuroSettings } from '../../../shared/behaviors/gaze-attention/one-euro';
import { headPoseOf } from '../../../shared/behaviors/gaze-attention/head-pose';
import { GAZE_ATTENTION_KNOBS } from '../../../shared/behaviors/gaze-attention/knobs';

export interface PoseSample {
  /** I-081: the frame's size in pixels (the keypoints are normalised by it); absent: no position is given. */
  width?: number;
  height?: number;
  /** Milliseconds (monotonic). */
  t: number;
  /** The detector found a person this frame (or the tracked crop is still confident). */
  detected: boolean;
  detScore: number;
  /** [17×2] frame pixels, or null when only the detector ran. */
  kpts: Float32Array | null;
  scores: Float32Array | null;
  /** I-189 #7: how many people this frame's detection counted (pipeline.ts countPeople); absent when only the crop was tracked. */
  people?: number;
}

const SEEN = 0.3, SURE = 0.4;
const WINDOW_MS = 6_000;
const ABSENT_AFTER_MS = 3_000;
/** I-081: a point not seen for longer than this is dropped. I-167: the face, the points and the head are smoothed by a One-Euro filter. */
const POINT_HOLD_MS = 1_000;
const round2 = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
const DEG = 180 / Math.PI;
const round2m = (value: number) => Math.round(value * 100) / 100;

/**
 * I-167: rounding that does not flicker. A value sitting near the edge between two rounding steps would otherwise jump one step back and
 * forth with the last bit of noise (and her look with it): the rounded value moves only once the value is 0.75 of a step away from it.
 */
class SteadyRound {
  private last: number | null = null;
  constructor(private readonly step: number, private readonly band = 0.75 * step) {}
  next(value: number): number {
    if (this.last !== null && Math.abs(value - this.last) <= this.band) return this.last;
    return this.last = Math.round(value / this.step) * this.step || 0;
  }
  reset(): void { this.last = null; }
}

/** I-167: one smoothed 2-D point (two One-Euro filters) and when it was last seen. */
class SmoothPoint {
  private readonly x: OneEuroFilter;
  private readonly y: OneEuroFilter;
  value: (PosePoint & { t: number }) | null = null;
  constructor(settings: OneEuroSettings) { this.x = new OneEuroFilter(settings); this.y = new OneEuroFilter(settings); }
  see(x: number, y: number, t: number): void {
    if (this.value && t - this.value.t > POINT_HOLD_MS) this.drop();
    this.value = { x: this.x.next(x, t / 1000), y: this.y.next(y, t / 1000), t };
  }
  /** Not seen this frame: kept a little while, then dropped. */
  miss(t: number): void { if (this.value && t - this.value.t > POINT_HOLD_MS) this.drop(); }
  drop(): void { this.value = null; this.x.reset(); this.y.reset(); }
}

interface Frame { t: number; sw: number; sx: number; sy: number; kpts: Float32Array; scores: Float32Array }

const mode = <T>(values: readonly T[], fallback: T): T => {
  const counts = new Map<T, number>();
  let best = fallback, top = 0;
  for (const value of values) { const n = (counts.get(value) ?? 0) + 1; counts.set(value, n); if (n > top) { top = n; best = value; } }
  return best;
};

/** Normalised autocorrelation peak of an evenly sampled series; lag in samples. */
export function periodicity(series: readonly number[], minLag: number, maxLag: number): { r: number; lag: number } {
  const n = series.length;
  const mean = series.reduce((a, b) => a + b, 0) / (n || 1);
  const x = series.map(v => v - mean);
  const energy = x.reduce((a, b) => a + b * b, 0);
  if (!(energy > 0)) return { r: 0, lag: 0 };
  const r = (lag: number) => { let s = 0; for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag]; return s / energy * n / (n - lag); };
  const from = Math.max(1, Math.floor(minLag)), to = Math.min(n - 2, Math.ceil(maxLag));
  const values: number[] = [];
  for (let lag = from; lag <= to; lag++) values.push(r(lag));
  const top = Math.max(-1, ...values);
  // The first local peak close to the highest one: multiples of the period correlate just as well (no sub-harmonics).
  let best = { r: -1, lag: 0 };
  for (let i = 0; i < values.length; i++) {
    const peak = (i === 0 || values[i] >= values[i - 1]) && (i === values.length - 1 || values[i] >= values[i + 1]);
    if (peak && values[i] >= 0.85 * top) { best = { r: values[i], lag: from + i }; break; }
  }
  if (best.lag > 1 && best.lag < n - 2) { // parabolic refinement
    const a = r(best.lag - 1), b = best.r, c = r(best.lag + 1), d = a - 2 * b + c;
    if (d < 0) best = { r: b, lag: best.lag + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d)) };
  }
  return best;
}

export class PoseFeatureTracker {
  private frames: Frame[] = [];
  private positives = 0;
  private lastPositive = -Infinity;
  private presentFlag = false;
  private confidence = 0;
  /** I-189 #7: the people counts of the last three detections (the signal says the lowest: one stray box never makes two). */
  private peopleSeen: number[] = [];
  private energy = 0;
  private baselineWidth = 0;
  /** 2026-11-17: the last 7 votes with the keypoint score behind each (confidence.ts). */
  private facings: Vote<PoseFacing>[] = [];
  private postures: Vote<PosePosture>[] = [];
  /** Events since the previous signal, with their confidence. */
  private pending = new Map<PoseEvent, number>();
  private cooldown: Partial<Record<PoseEvent, number>> = {};
  private lastT = -Infinity;
  /** I-081: smoothed face centre and points (normalised), with when each was last seen. I-167: One-Euro smoothing (knobs.filter.position). */
  private face = new SmoothPoint(GAZE_ATTENTION_KNOBS.filter.position);
  private points: SmoothPoint[] = Array.from({ length: POSE_POINT_COUNT }, () => new SmoothPoint(GAZE_ATTENTION_KNOBS.filter.position));
  /** I-167: the head's direction (rad) and distance (m), smoothed, and when it was last measured. */
  private readonly headYaw = new OneEuroFilter(GAZE_ATTENTION_KNOBS.filter.turn);
  private readonly headPitch = new OneEuroFilter(GAZE_ATTENTION_KNOBS.filter.turn);
  private readonly headDistance = new OneEuroFilter(GAZE_ATTENTION_KNOBS.filter.distance);
  private head: (PoseHead & { t: number }) | null = null;
  /** I-167: the rounded face position and head reading that go out (steady at a rounding edge). */
  private readonly steady = { x: new SteadyRound(0.01), y: new SteadyRound(0.01), yaw: new SteadyRound(1), pitch: new SteadyRound(1), distance: new SteadyRound(0.01, 0.03) };

  reset(): void {
    this.frames = []; this.positives = 0; this.lastPositive = -Infinity; this.presentFlag = false; this.confidence = 0; this.peopleSeen = [];
    this.energy = 0; this.baselineWidth = 0; this.facings = []; this.postures = []; this.pending.clear(); this.cooldown = {}; this.lastT = -Infinity;
    this.face.drop(); for (const point of this.points) point.drop(); this.dropHead(); for (const value of Object.values(this.steady)) value.reset();
  }

  private dropHead(): void { this.head = null; this.headYaw.reset(); this.headPitch.reset(); this.headDistance.reset(); }

  /** I-081: one frame's face centre and points, normalised by the frame size and smoothed. */
  private track(t: number, k: Float32Array, s: Float32Array, width: number, height: number): void {
    for (let i = 0; i < POSE_POINT_COUNT; i++) {
      if (s[i] >= SEEN && Number.isFinite(k[i * 2]) && Number.isFinite(k[i * 2 + 1])) this.points[i].see(k[i * 2] / width, k[i * 2 + 1] / height, t);
      else this.points[i].miss(t);
    }
    // The face (I-167): between the eyes when both are surely seen (where her look should land, and steady when an ear comes and goes);
    // else the nose, eyes and ears that are surely seen; else the shoulders' middle raised by about a shoulder width.
    const sure = (i: number) => s[i] >= SURE && Number.isFinite(k[i * 2]) && Number.isFinite(k[i * 2 + 1]);
    let sx = 0, sy = 0, n = 0;
    for (const i of sure(1) && sure(2) ? [1, 2] : [0, 1, 2, 3, 4]) if (sure(i)) { sx += k[i * 2]; sy += k[i * 2 + 1]; n++; }
    if (!n && s[5] >= SEEN && s[6] >= SEEN) {
      const sw = Math.hypot(k[10] - k[12], k[11] - k[13]);
      sx = (k[10] + k[12]) / 2; sy = (k[11] + k[13]) / 2 - 0.9 * sw; n = 1;
    }
    if (n && Number.isFinite(sx) && Number.isFinite(sy)) this.face.see(sx / n / width, sy / n / height, t);
    else this.face.miss(t);
    // I-167: the head's direction and distance from this frame's full-precision face points (head-pose.ts), then smoothed.
    const pose = headPoseOf(k, s, width, height, SURE, GAZE_ATTENTION_KNOBS.camera.hfov);
    if (pose) {
      if (this.head && t - this.head.t > POINT_HOLD_MS) this.dropHead();
      this.head = { yaw: this.headYaw.next(pose.yaw, t / 1000), pitch: this.headPitch.next(pose.pitch, t / 1000), distance: this.headDistance.next(pose.distance, t / 1000), t };
    } else if (this.head && t - this.head.t > POINT_HOLD_MS) this.dropHead();
  }

  /** I-081: the position part of the signal (nothing while nobody is there or only presence is measured). */
  private where(): { face: PosePoint | null; points: (PosePoint | null)[]; head: PoseHead | null } {
    const face = this.face.value;
    if (!face || !Number.isFinite(face.x) || !Number.isFinite(face.y)) return { face: null, points: [], head: null };
    const points: (PosePoint | null)[] = [];
    for (let i = 0; i < POSE_POINT_COUNT; i++) {
      const point = this.points[i].value;
      points.push(point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: round2(point.x), y: round2(point.y) } : null);
    }
    const h = this.head, s = this.steady;
    const head = h && [h.yaw, h.pitch, h.distance].every(Number.isFinite)
      ? { yaw: s.yaw.next(h.yaw * DEG), pitch: s.pitch.next(h.pitch * DEG), distance: round2m(s.distance.next(Math.min(5, Math.max(0.1, h.distance)))) } : null;
    return { face: { x: round2(s.x.next(face.x)), y: round2(s.y.next(face.y)) }, points, head };
  }

  /** I-081: how far the face moved since `since` (normalised), for the engine's "send now" check; 0 without a face. */
  faceMoved(since: PosePoint | null): number {
    const face = this.face.value;
    if (!face) return since ? 1 : 0;
    return since ? Math.hypot(face.x - since.x, face.y - since.y) : 1;
  }

  get present(): boolean { return this.presentFlag; }
  /** I-167: somebody is here and the last frames mostly say they face the screen (the engine looks more often then). */
  get attending(): boolean { return this.presentFlag && mode(this.facings.map(v => v.value), 'unknown') === 'toward'; }

  push(sample: PoseSample): void {
    if (!(sample.t > this.lastT)) return;
    const dt = Math.min(2, (sample.t - (Number.isFinite(this.lastT) ? this.lastT : sample.t - 200)) / 1000);
    this.lastT = sample.t;
    if (typeof sample.people === 'number' && Number.isInteger(sample.people)) { this.peopleSeen.push(Math.min(4, Math.max(0, sample.people))); if (this.peopleSeen.length > 3) this.peopleSeen.shift(); }
    const visible = sample.scores ? sample.scores.reduce((n, s) => n + (s >= SEEN ? 1 : 0), 0) : 0;
    const positive = sample.detected && (!sample.kpts || visible >= 4);
    this.confidence += (Math.min(1, positive ? sample.detScore : 0) - this.confidence) * 0.3;
    if (positive) { this.positives++; this.lastPositive = sample.t; if (this.positives >= 2) this.presentFlag = true; }
    else { this.positives = 0; if (sample.t - this.lastPositive > ABSENT_AFTER_MS) this.presentFlag = false; }
    this.frames = this.frames.filter(frame => sample.t - frame.t <= WINDOW_MS);
    if (!positive || !sample.kpts || !sample.scores) { this.energy *= Math.exp(-dt / 1.5); return; }
    const k = sample.kpts, s = sample.scores;
    const width = sample.width ?? 0, height = sample.height ?? 0;
    if (width >= 16 && height >= 16 && Number.isFinite(width) && Number.isFinite(height)) this.track(sample.t, k, s, width, height);
    if (!(s[5] >= SEEN && s[6] >= SEEN)) { this.facings.push(this.facingVote(k, s, 0)); this.trim(); return; }
    const sw = Math.max(1, Math.hypot(k[10] - k[12], k[11] - k[13]));
    const frame: Frame = { t: sample.t, sw, sx: (k[10] + k[12]) / 2, sy: (k[11] + k[13]) / 2, kpts: k, scores: s };
    const previous = this.frames.at(-1);
    this.frames.push(frame);
    if (previous && sample.t - previous.t < 1500) {
      let sum = 0, n = 0;
      for (const i of [0, 5, 6, 7, 8, 9, 10]) {
        if (!(s[i] >= SEEN && previous.scores[i] >= SEEN)) continue;
        sum += Math.hypot(k[i * 2] - previous.kpts[i * 2], k[i * 2 + 1] - previous.kpts[i * 2 + 1]) / sw; n++;
      }
      if (n) {
        const speed = Math.max(0, sum / n / Math.max(0.05, (sample.t - previous.t) / 1000) - 0.08);
        const target = 1 - Math.exp(-speed / 0.8), alpha = 1 - Math.exp(-dt / 1.5);
        this.energy += (target - this.energy) * alpha;
      }
    }
    this.facings.push(this.facingVote(k, s, sw));
    const posture = this.postureOf(frame);
    this.postures.push({ value: posture, score: meanScore(s, posture === 'unknown' ? [] : POSTURE_POINTS[posture]) });
    if (posture === 'sitting') this.baselineWidth = this.baselineWidth ? this.baselineWidth + (sw - this.baselineWidth) * Math.min(1, dt / 60) : sw;
    this.trim();
    this.detectEvents(sample.t);
  }

  private trim(): void {
    if (this.facings.length > 7) this.facings.splice(0, this.facings.length - 7);
    if (this.postures.length > 7) this.postures.splice(0, this.postures.length - 7);
  }

  private facingVote(k: Float32Array, s: Float32Array, sw: number): Vote<PoseFacing> {
    const value = this.facingOf(k, s, sw);
    return { value, score: facingScore(value, s) };
  }

  private facingOf(k: Float32Array, s: Float32Array, sw: number): PoseFacing {
    const nose = s[0] >= SURE, le = s[1] >= SURE, re = s[2] >= SURE;
    if (nose && le && re) {
      const eyeDistance = Math.abs(k[2] - k[4]), offset = Math.abs(k[0] - (k[2] + k[4]) / 2) / Math.max(1, eyeDistance);
      return offset < 0.5 && (!sw || eyeDistance > 0.12 * sw) ? 'toward' : 'side';
    }
    if (nose && (le || re)) return 'side';
    if (!nose && !le && !re && s[5] >= SURE && s[6] >= SURE) return 'away';
    return 'unknown';
  }

  private postureOf(f: Frame): PosePosture {
    const k = f.kpts, s = f.scores;
    if (s[0] >= SURE && k[1] > f.sy - 0.25 * f.sw) return 'slumped';
    if (s[11] >= SURE && s[12] >= SURE && s[13] >= SURE && s[14] >= SURE) {
      const hipY = (k[23] + k[25]) / 2, kneeY = (k[27] + k[29]) / 2, torso = hipY - f.sy;
      if (torso > 0 && kneeY - hipY > 0.6 * torso) return 'standing';
    }
    if (this.baselineWidth && f.sw < 0.8 * this.baselineWidth && s[0] >= SURE) return 'leaning-back';
    return 'sitting';
  }

  private emit(event: PoseEvent, t: number, cooldownMs: number, confidence: number): void {
    if ((this.cooldown[event] ?? -Infinity) > t) return;
    this.cooldown[event] = t + cooldownMs;
    this.pending.set(event, Math.max(this.pending.get(event) ?? 0, confidence));
  }

  private detectEvents(t: number): void {
    // Stretch: both wrists well above the head (or the shoulders when the face is hidden) for ≥ 0.8 s.
    const recent = this.frames.filter(f => t - f.t <= 800);
    const overhead = (f: Frame) => {
      const k = f.kpts, s = f.scores;
      if (!(s[9] >= 0.35 && s[10] >= 0.35)) return false;
      const top = s[0] >= SURE ? k[1] - 0.25 * f.sw : f.sy - 0.8 * f.sw;
      return k[19] < top && k[21] < top;
    };
    if (recent.length >= 3 && recent[0].t <= t - 600 && recent.every(overhead)) {
      // Clarity: the lowest wrist-over-head-line gap seen in the window (shoulder widths), the same line `overhead` tests.
      let margin = Infinity, score = 0;
      for (const f of recent) {
        const top = f.scores[0] >= SURE ? f.kpts[1] - 0.25 * f.sw : f.sy - 0.8 * f.sw;
        margin = Math.min(margin, (top - Math.max(f.kpts[19], f.kpts[21])) / f.sw);
        score += meanScore(f.scores, STRETCH_POINTS) / recent.length;
      }
      this.emit('stretch', t, 8_000, eventConfidence(score, stretchClarity(margin)));
      return;
    }
    // Wave: one wrist raised above its shoulder, swinging side to side (≥ 2 reversals of ≥ 0.2 shoulder widths in 2.5 s).
    for (const [wrist, elbow] of [[9, 7], [10, 8]] as const) {
      const raised = this.frames.filter(f => t - f.t <= 2_500 && f.scores[wrist] >= 0.35
        && f.kpts[wrist * 2 + 1] < f.sy - 0.1 * f.sw && !overhead(f));
      if (raised.length < 5) continue;
      const xs = raised.map(f => (f.kpts[wrist * 2] - (f.scores[elbow] >= SEEN ? f.kpts[elbow * 2] : f.sx)) / f.sw);
      let reversals = 0, direction = 0, extreme = xs[0];
      for (const x of xs.slice(1)) {
        if (direction === 0) { if (Math.abs(x - extreme) >= 0.2) { direction = Math.sign(x - extreme); extreme = x; } continue; }
        if ((x - extreme) * direction > 0) { extreme = x; continue; }
        if (Math.abs(x - extreme) >= 0.2) { reversals++; direction = -direction; extreme = x; }
      }
      if (reversals >= 2) {
        const score = raised.reduce((sum, f) => sum + meanScore(f.scores, WAVE_POINTS(wrist, elbow)), 0) / raised.length;
        this.emit('wave', t, 4_000, eventConfidence(score, waveClarity(reversals, Math.max(...xs) - Math.min(...xs))));
        return;
      }
    }
  }

  /** Bobbing or swaying with a steady beat over the last ≥ 4 s (head, else shoulders; vertical or horizontal). */
  private rhythm(): { rhythm: boolean; tempo: number | null } {
    const frames = this.frames;
    if (frames.length < 15 || frames.at(-1)!.t - frames[0].t < 4_000 || this.energy < 0.12) return { rhythm: false, tempo: null };
    const t0 = frames[0].t, t1 = frames.at(-1)!.t, step = 100;
    let best = { r: 0, lag: 0 };
    for (const axis of [1, 0]) {
      const value = (f: Frame) => (f.scores[0] >= SURE ? f.kpts[axis] : axis ? f.sy : f.sx) / f.sw;
      const series: number[] = [];
      let j = 0;
      for (let t = t0; t <= t1; t += step) {
        while (j < frames.length - 2 && frames[j + 1].t < t) j++;
        const a = frames[j], b = frames[Math.min(j + 1, frames.length - 1)];
        const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
        series.push(value(a) + (value(b) - value(a)) * u);
      }
      const mean = series.reduce((x, y) => x + y, 0) / series.length;
      const spread = Math.sqrt(series.reduce((x, y) => x + (y - mean) ** 2, 0) / series.length);
      if (spread < 0.02) continue;
      const found = periodicity(series, 60_000 / 180 / step, 60_000 / 40 / step);
      if (found.r > best.r) best = found;
    }
    if (best.r < 0.45 || !best.lag) return { rhythm: false, tempo: null };
    return { rhythm: true, tempo: Math.max(40, Math.min(180, Math.round(60_000 / (best.lag * step)))) };
  }

  /** True when a short higher frame rate would help (a raised hand, or lots of movement). */
  wantsBurst(): boolean {
    const f = this.frames.at(-1);
    if (!f || !this.presentFlag) return false;
    const raised = [9, 10].some(w => f.scores[w] >= 0.35 && f.kpts[w * 2 + 1] < f.sy - 0.1 * f.sw);
    return raised || this.energy > 0.35;
  }

  /** I-189 #7: people in the frame: 0 while nobody is present; the lowest of the last three detections (fewer than three: at most 1). */
  private people(): number {
    if (!this.presentFlag || !this.peopleSeen.length) return 0;
    const low = Math.min(...this.peopleSeen);
    return this.peopleSeen.length >= 3 ? low : Math.min(1, low);
  }

  /** The current signal; one-shot events are handed out once. */
  signal(capability: PoseCapability = 'full'): PoseSignal {
    const taken = [...this.pending];
    this.pending.clear();
    const events = taken.map(([event]) => event);
    const confidence = round2(this.confidence);
    if (!this.presentFlag || capability === 'presence-only') {
      const kept = this.presentFlag && capability === 'full';
      return { present: this.presentFlag, confidence, facing: 'unknown', facingConfidence: 0, posture: 'unknown', postureConfidence: 0, energy: 0, rhythm: false, tempo: null,
        events: kept ? events : [], eventConfidence: kept ? Object.fromEntries(taken) : {}, hand: null, capability, face: null, points: [], head: null, people: this.people() };
    }
    const { rhythm, tempo } = this.rhythm();
    const facing = mode(this.facings.map(v => v.value), 'unknown'), posture = mode(this.postures.map(v => v.value), 'unknown');
    return { present: true, confidence, facing, facingConfidence: voteConfidence(this.facings, facing), posture, postureConfidence: voteConfidence(this.postures, posture),
      energy: Math.round(Math.min(1, Math.max(0, this.energy)) * 100) / 100, rhythm, tempo, events, eventConfidence: Object.fromEntries(taken), hand: null, capability, ...this.where(), people: this.people() };
  }
}
