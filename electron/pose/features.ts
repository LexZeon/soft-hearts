/**
 * Keypoints over time → the abstract pose signal (shared/pose-signals.ts). Runs inside the inference process;
 * keypoints live only in this ring buffer (≤ 6 s) and never leave the process.
 *
 * COCO-17: 0 nose, 1/2 eyes, 3/4 ears, 5/6 shoulders, 7/8 elbows, 9/10 wrists, 11/12 hips, 13/14 knees.
 * All distances are in shoulder widths, so the rules do not depend on how far the user sits from the camera.
 * Thresholds are first guesses checked only on synthetic sequences (tests/pose-features.test.ts); no real person yet.
 */
import type { PoseCapability, PoseEvent, PoseFacing, PosePosture, PoseSignal } from '../../shared/pose-signals';

export interface PoseSample {
  /** Milliseconds (monotonic). */
  t: number;
  /** The detector found a person this frame (or the tracked crop is still confident). */
  detected: boolean;
  detScore: number;
  /** [17×2] frame pixels, or null when only the detector ran. */
  kpts: Float32Array | null;
  scores: Float32Array | null;
}

const SEEN = 0.3, SURE = 0.4;
const WINDOW_MS = 6_000;
const ABSENT_AFTER_MS = 3_000;

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
  private energy = 0;
  private baselineWidth = 0;
  private facings: PoseFacing[] = [];
  private postures: PosePosture[] = [];
  private pending = new Set<PoseEvent>();
  private cooldown: Partial<Record<PoseEvent, number>> = {};
  private lastT = -Infinity;

  reset(): void {
    this.frames = []; this.positives = 0; this.lastPositive = -Infinity; this.presentFlag = false; this.confidence = 0;
    this.energy = 0; this.baselineWidth = 0; this.facings = []; this.postures = []; this.pending.clear(); this.cooldown = {}; this.lastT = -Infinity;
  }

  get present(): boolean { return this.presentFlag; }

  push(sample: PoseSample): void {
    if (!(sample.t > this.lastT)) return;
    const dt = Math.min(2, (sample.t - (Number.isFinite(this.lastT) ? this.lastT : sample.t - 200)) / 1000);
    this.lastT = sample.t;
    const visible = sample.scores ? sample.scores.reduce((n, s) => n + (s >= SEEN ? 1 : 0), 0) : 0;
    const positive = sample.detected && (!sample.kpts || visible >= 4);
    this.confidence += (Math.min(1, positive ? sample.detScore : 0) - this.confidence) * 0.3;
    if (positive) { this.positives++; this.lastPositive = sample.t; if (this.positives >= 2) this.presentFlag = true; }
    else { this.positives = 0; if (sample.t - this.lastPositive > ABSENT_AFTER_MS) this.presentFlag = false; }
    this.frames = this.frames.filter(frame => sample.t - frame.t <= WINDOW_MS);
    if (!positive || !sample.kpts || !sample.scores) { this.energy *= Math.exp(-dt / 1.5); return; }
    const k = sample.kpts, s = sample.scores;
    if (!(s[5] >= SEEN && s[6] >= SEEN)) { this.facings.push(this.facingOf(k, s, 0)); this.trim(); return; }
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
    this.facings.push(this.facingOf(k, s, sw));
    const posture = this.postureOf(frame);
    this.postures.push(posture);
    if (posture === 'sitting') this.baselineWidth = this.baselineWidth ? this.baselineWidth + (sw - this.baselineWidth) * Math.min(1, dt / 60) : sw;
    this.trim();
    this.detectEvents(sample.t);
  }

  private trim(): void {
    if (this.facings.length > 7) this.facings.splice(0, this.facings.length - 7);
    if (this.postures.length > 7) this.postures.splice(0, this.postures.length - 7);
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

  private emit(event: PoseEvent, t: number, cooldownMs: number): void {
    if ((this.cooldown[event] ?? -Infinity) > t) return;
    this.cooldown[event] = t + cooldownMs;
    this.pending.add(event);
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
    if (recent.length >= 3 && recent[0].t <= t - 600 && recent.every(overhead)) { this.emit('stretch', t, 8_000); return; }
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
      if (reversals >= 2) { this.emit('wave', t, 4_000); return; }
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

  /** The current signal; one-shot events are handed out once. */
  signal(capability: PoseCapability = 'full'): PoseSignal {
    const events = [...this.pending];
    this.pending.clear();
    const confidence = Math.round(Math.min(1, Math.max(0, this.confidence)) * 100) / 100;
    if (!this.presentFlag || capability === 'presence-only')
      return { present: this.presentFlag, confidence, facing: 'unknown', posture: 'unknown', energy: 0, rhythm: false, tempo: null,
        events: this.presentFlag && capability === 'full' ? events : [], hand: null, capability };
    const { rhythm, tempo } = this.rhythm();
    return { present: true, confidence, facing: mode(this.facings, 'unknown'), posture: mode(this.postures, 'unknown'),
      energy: Math.round(Math.min(1, Math.max(0, this.energy)) * 100) / 100, rhythm, tempo, events, hand: null, capability };
  }
}
