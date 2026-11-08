/**
 * R29f smoothness measures (docs/claude/2026-11-03-R29f-smoothness.md). The user's words: motion should go from
 * one key pose to the next like keyframe animation, "not frame-to-frame jumps": every frame lands smoothly
 * between two keys and the speed is continuous too.
 *
 * Per bone, from the displayed world rotations (gene-stage-harness):
 *  - ω: the angular velocity between two consecutive samples (deg/s), a vector;
 *  - Δω ("速度突变"): |ω_i − ω_{i−1}|, how much the speed changed from one sample to the next (deg/s).
 *    Smooth motion has small Δω that halves when the frame rate doubles; a speed kink stays the same size;
 *  - spikes: samples whose Δω is well above both an absolute floor and its neighbourhood (a lone kink);
 *  - holds ("停顿后追上"): the speed collapses for one sample and comes straight back (the pose stood still for a
 *    sample and then caught up), the screen-side picture of a frame shown twice and then a double step.
 * Measured on two streams:
 *  - rendered: every frame the stage rendered, at its own times (what the motion curves themselves do);
 *  - display: every refresh of a 60 Hz screen, showing the latest rendered frame (what the user sees).
 */
import { Quaternion, Vector3 } from 'three';
import { TRACKED_BONES, type GeneStage, type ShownFrame } from './gene-stage-harness';

const DEG = 180 / Math.PI;
export interface StreamPoint { t: number; q: Quaternion }

/** World angular velocity (deg/s) from points[i−1] to points[i]; index i−1 in the result. */
export function angularVelocities(points: readonly StreamPoint[]): Vector3[] {
  const out: Vector3[] = [], step = new Quaternion(), inverse = new Quaternion();
  for (let i = 1; i < points.length; i++) {
    step.copy(points[i].q).multiply(inverse.copy(points[i - 1].q).invert());
    if (step.w < 0) step.set(-step.x, -step.y, -step.z, -step.w);
    const s = Math.hypot(step.x, step.y, step.z), angle = 2 * Math.atan2(s, step.w), dt = points[i].t - points[i - 1].t;
    const k = s > 1e-12 && dt > 0 ? angle / s / dt * DEG : 0;
    out.push(new Vector3(step.x * k, step.y * k, step.z * k));
  }
  return out;
}

export interface SmoothnessThresholds {
  /** A spike must exceed this Δω (deg/s)… */
  spikeFloor: number;
  /** …and this multiple of the median Δω of the 3 samples on each side. */
  spikeRatio: number;
  /** A hold: speed below holdDrop × the previous speed, then back to ≥ holdBack × it, the previous speed above holdMin (deg/s). */
  holdDrop: number;
  holdBack: number;
  holdMin: number;
}
export const THRESHOLDS: SmoothnessThresholds = Object.freeze({ spikeFloor: 4, spikeRatio: 3, holdDrop: 0.35, holdBack: 0.8, holdMin: 3 });

export interface StreamMeasure {
  /** Largest and 99th-percentile Δω (deg/s). */
  maxDv: number;
  p99Dv: number;
  spikes: number;
  holds: number;
  /** Time (s) of the largest Δω, for finding its source. */
  maxAt: number;
  samples: number;
}

const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : 0;
}

export function measureStream(points: readonly StreamPoint[], limits: SmoothnessThresholds = THRESHOLDS): StreamMeasure {
  const w = angularVelocities(points), speed = w.map(value => value.length());
  const dv = w.slice(1).map((value, i) => value.distanceTo(w[i])); // dv[i] belongs to points[i + 2]
  let spikes = 0, holds = 0, maxDv = 0, maxAt = NaN;
  for (let i = 0; i < dv.length; i++) {
    if (dv[i] > maxDv) { maxDv = dv[i]; maxAt = points[i + 2].t; }
    const around = [...dv.slice(Math.max(0, i - 3), i), ...dv.slice(i + 1, i + 4)];
    if (dv[i] > limits.spikeFloor && dv[i] > limits.spikeRatio * median(around)) spikes++;
  }
  for (let i = 1; i + 1 < speed.length; i++) {
    const before = speed[i - 1];
    if (before > limits.holdMin && speed[i] < limits.holdDrop * before && speed[i + 1] >= limits.holdBack * before) holds++;
  }
  return { maxDv, p99Dv: percentile(dv, 0.99), spikes, holds, maxAt, samples: points.length };
}

export type BoneSource = 'world' | 'extra';
/** Rendered frames in [from, to] for one bone. */
export function renderedStream(frames: readonly ShownFrame[], bone: number, from: number, to: number, set: BoneSource = 'world'): StreamPoint[] {
  return frames.filter(frame => frame.t >= from - 1e-9 && frame.t <= to + 1e-9).map(frame => ({ t: frame.t, q: frame[set][bone] }));
}
/** What a screen refreshing at the harness's refreshHz shows in [from, to] for one bone: the latest rendered frame per refresh. */
export function displayStream(h: Pick<GeneStage, 'shown' | 'refreshes'>, bone: number, from: number, to: number, set: BoneSource = 'world'): StreamPoint[] {
  return h.refreshes.filter(refresh => refresh.frame >= 0 && refresh.t >= from - 1e-9 && refresh.t <= to + 1e-9)
    .map(refresh => ({ t: refresh.t, q: h.shown[refresh.frame][set][bone] }));
}

export interface WindowMeasure {
  /** Worst bone by display-stream Δω, and per-bone numbers. */
  worstBone: string;
  rendered: StreamMeasure;
  display: StreamMeasure;
  /** Sums over all measured bones. */
  renderedSpikes: number;
  displayHolds: number;
  /** Display guard catches in the window. */
  guard: number;
  perBone: { bone: string; rendered: StreamMeasure; display: StreamMeasure }[];
}

/** All tracked bones (plus extra bones, named by `extraNames`) over [from, to]. */
export function measureWindow(h: Pick<GeneStage, 'shown' | 'refreshes'>, from: number, to: number, extraNames: readonly string[] = []): WindowMeasure {
  const bones: { name: string; index: number; set: BoneSource }[] = [
    ...TRACKED_BONES.map((name, index) => ({ name, index, set: 'world' as const })),
    ...extraNames.map((name, index) => ({ name, index, set: 'extra' as const })),
  ];
  const perBone = bones.map(({ name, index, set }) => ({ bone: name,
    rendered: measureStream(renderedStream(h.shown, index, from, to, set)), display: measureStream(displayStream(h, index, from, to, set)) }));
  const worst = perBone.reduce((a, b) => b.display.maxDv > a.display.maxDv ? b : a);
  const inWindow = h.shown.filter(frame => frame.t >= from - 1e-9 && frame.t <= to + 1e-9);
  // The guard's counter restarts at a reset: count increments only.
  let guard = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const a = inWindow[i - 1].guardJumps, b = inWindow[i].guardJumps;
    guard += b >= a ? b - a : b;
  }
  return { worstBone: worst.bone, rendered: worst.rendered, display: worst.display,
    renderedSpikes: perBone.reduce((sum, value) => sum + value.rendered.spikes, 0),
    displayHolds: perBone.reduce((sum, value) => sum + value.display.holds, 0), guard, perBone };
}
