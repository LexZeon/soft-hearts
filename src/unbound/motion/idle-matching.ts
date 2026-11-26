/**
 * Motion-model spike, group B (docs/claude/2026-11-14-motion-model-spike.md): motion matching over real idle takes. It plays a
 * stretch of a standing take; every second or so (sooner when the stretch is about to end) it looks for the frame in the whole
 * database whose pose and velocity are closest to what she is doing now and whose liveliness is closest to the knob, picks one of
 * the best few at random (so she does not repeat herself), and jumps there. The jump is never shown: the difference between the
 * old and the new pose (and their velocities) is carried as an offset that dies away like a critically damped spring
 * (inertialization), so the output is continuous in value and velocity.
 *
 * The database is plain arrays (the spike's scripts load the files the BVH reduction writes); no data ships with the app.
 */
import { IDLE_DIM, seededRandom, type IdleSource } from './idle-channels';

export interface IdleDatabase {
  /** frames × IDLE_DIM, 30 Hz. */
  frames: Float32Array;
  /** Liveliness 0..1 per frame. */
  activity: Float32Array;
  /** Standing stretches (frame index ranges, contiguous inside). */
  segments: readonly { start: number; length: number; style?: string }[];
  /** Per-channel spread (feature scaling for the search). */
  std: readonly number[];
}

export interface MatchingOptions {
  /** Seconds between searches (randomized ±30%). */
  searchEvery: number;
  /** Inertialization half-life (s). */
  halfLife: number;
  /** Weights: velocity against pose, liveliness. */
  velocityWeight: number;
  activityWeight: number;
  /** Pick at random among this many best candidates. */
  topK: number;
  seed: number;
}
export const MATCHING_DEFAULTS: Readonly<MatchingOptions> = Object.freeze({ searchEvery: 1.2, halfLife: 0.25, velocityWeight: 1.5, activityWeight: 2.5, topK: 6, seed: 7 });

const HZ = 30, DT = 1 / HZ;

export class MatchingIdle implements IdleSource {
  readonly id = 'matching';
  private readonly options: MatchingOptions;
  private random: () => number;
  /** Database frame being played. */
  private cursor = 0;
  private segmentEnd = 0;
  private untilSearch = 0;
  private readonly offset = new Float64Array(IDLE_DIM);
  private readonly offsetVelocity = new Float64Array(IDLE_DIM);
  private readonly prev = new Float64Array(IDLE_DIM);
  private readonly prevVelocity = new Float64Array(IDLE_DIM);
  private readonly out = new Float32Array(IDLE_DIM);
  private readonly segmentOf: Int32Array;
  private readonly inv: Float64Array;
  private started = false;
  /** How many jumps, and the frames visited (for the repetition measure). */
  jumps = 0;
  readonly visited: number[] = [];

  constructor(private readonly db: IdleDatabase, options: Partial<MatchingOptions> = {}) {
    this.options = { ...MATCHING_DEFAULTS, ...options };
    this.random = seededRandom(this.options.seed);
    const n = db.activity.length;
    this.segmentOf = new Int32Array(n).fill(-1);
    db.segments.forEach((s, i) => { for (let f = s.start; f < s.start + s.length; f++) this.segmentOf[f] = i; });
    this.inv = Float64Array.from(db.std, v => 1 / Math.max(1e-6, v));
  }

  reset(seed = this.options.seed): void {
    this.random = seededRandom(seed);
    this.started = false; this.jumps = 0; this.visited.length = 0;
    this.offset.fill(0); this.offsetVelocity.fill(0); this.prev.fill(0); this.prevVelocity.fill(0);
  }

  next(activity: number): Float32Array {
    const target = Math.max(0, Math.min(1, Number.isFinite(activity) ? activity : 0.5));
    if (!this.started) {
      this.started = true;
      // Start where the pose is nearest to rest (all zeros) at about this liveliness.
      this.jumpTo(this.search(new Float64Array(IDLE_DIM), new Float64Array(IDLE_DIM), target, -1), false);
    } else {
      this.cursor++;
      this.untilSearch -= DT;
      if (this.untilSearch <= 0 || this.cursor >= this.segmentEnd - Math.round(0.4 * HZ)) {
        const best = this.search(this.prev, this.prevVelocity, target, this.cursor);
        if (best >= 0 && best !== this.cursor) this.jumpTo(best, true);
        else this.untilSearch = this.options.searchEvery;
      }
      if (this.cursor >= this.segmentEnd) this.cursor = this.segmentEnd - 1; // no candidate at all: hold the last frame
    }
    // Inertialization: the offset decays as a critically damped spring toward zero.
    const w = 2 * Math.LN2 / Math.max(1e-3, this.options.halfLife), e = Math.exp(-w * DT);
    const f = this.db.frames, base = this.cursor * IDLE_DIM;
    for (let c = 0; c < IDLE_DIM; c++) {
      const j = this.offsetVelocity[c] + w * this.offset[c];
      this.offset[c] = e * (this.offset[c] + j * DT);
      this.offsetVelocity[c] = e * (this.offsetVelocity[c] - j * w * DT);
      const value = f[base + c] + this.offset[c];
      this.prevVelocity[c] = (value - this.prev[c]) * HZ;
      this.prev[c] = value;
      this.out[c] = value;
    }
    return this.out;
  }

  /** Jumps the cursor to `frame`, keeping what is shown continuous (the old pose and velocity become the offset). */
  private jumpTo(frame: number, inertialize: boolean): void {
    const f = this.db.frames;
    if (inertialize) {
      // What she shows now = prev; what the new frame would show next = f[frame]. Offset so that the next output continues prev.
      for (let c = 0; c < IDLE_DIM; c++) {
        const newVelocity = (f[frame * IDLE_DIM + c] - f[Math.max(this.segStart(frame), frame - 1) * IDLE_DIM + c]) * HZ;
        // Value at the next tick should be prev + prevVelocity·dt; the new source gives f[frame].
        this.offset[c] = this.prev[c] + this.prevVelocity[c] * DT - f[frame * IDLE_DIM + c];
        this.offsetVelocity[c] = this.prevVelocity[c] - newVelocity;
      }
      // The decay in next() is applied once before this frame is shown; undo it for this first frame so the step stays exact.
      const w = 2 * Math.LN2 / Math.max(1e-3, this.options.halfLife), e = Math.exp(-w * DT);
      for (let c = 0; c < IDLE_DIM; c++) {
        // Solve backwards one step of the decay: x' = e(x + jDT), v' = e(v − jwDT), j = v + wx.
        const x1 = this.offset[c], v1 = this.offsetVelocity[c];
        // Inverse of [[e(1+wDT), eDT], [−e w² DT, e(1−wDT)]] applied to (x1, v1).
        const a = e * (1 + w * DT), b = e * DT, cc = -e * w * w * DT, d = e * (1 - w * DT), det = a * d - b * cc;
        this.offset[c] = (d * x1 - b * v1) / det;
        this.offsetVelocity[c] = (-cc * x1 + a * v1) / det;
      }
      this.jumps++;
    }
    this.cursor = frame;
    const s = this.db.segments[this.segmentOf[frame]];
    this.segmentEnd = s.start + s.length;
    const r = this.random();
    this.untilSearch = this.options.searchEvery * (0.7 + 0.6 * r);
    this.visited.push(frame);
  }

  private segStart(frame: number): number { return this.db.segments[this.segmentOf[frame]].start; }

  /** Best few candidates by pose + velocity + liveliness; returns one of them at random (−1 when none). */
  private search(pose: ArrayLike<number>, velocity: ArrayLike<number>, activity: number, current: number): number {
    const { frames, activity: act } = this.db, n = act.length, k = Math.max(1, this.options.topK);
    const vw = this.options.velocityWeight * DT * 3, aw = this.options.activityWeight;
    const best: { i: number; cost: number }[] = [];
    const currentSeg = current >= 0 ? this.segmentOf[current] : -1;
    const q = new Float64Array(IDLE_DIM), qv = new Float64Array(IDLE_DIM);
    for (let c = 0; c < IDLE_DIM; c++) { q[c] = pose[c] * this.inv[c]; qv[c] = velocity[c] * this.inv[c] * vw; }
    for (const s of this.db.segments) {
      // Leave room to play at least 1.5 s; skip a window around where she is now (variety).
      const last = s.start + s.length - Math.round(1.5 * HZ);
      for (let i = s.start + 1; i < last; i += 2) {
        if (this.segmentOf[i] === currentSeg && Math.abs(i - current) < 3 * HZ) continue;
        let cost = aw * Math.abs(act[i] - activity);
        if (best.length === k && cost >= best[k - 1].cost) continue;
        const o = i * IDLE_DIM, p = (i - 1) * IDLE_DIM;
        for (let c = 0; c < IDLE_DIM && (best.length < k || cost < best[k - 1].cost); c++) {
          const dp = frames[o + c] * this.inv[c] - q[c], dv = (frames[o + c] - frames[p + c]) * HZ * this.inv[c] * vw - qv[c];
          cost += dp * dp + dv * dv;
        }
        if (best.length < k || cost < best[k - 1].cost) {
          best.push({ i, cost }); best.sort((a, b) => a.cost - b.cost); if (best.length > k) best.pop();
        }
      }
    }
    if (!best.length) return -1;
    return best[Math.min(best.length - 1, Math.floor(this.random() * best.length))].i;
  }
}
