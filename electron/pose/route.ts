/**
 * GPU-or-CPU choice and the slow-computer ladder for the pose process (I-001 stage 1; feasibility doc §4.2).
 * Pure: the engine feeds it measured milliseconds and asks what to do. Nothing here is ever shown to the user.
 */
import type { PoseLevel } from '../../shared/pose-signals';

export type RouteName = 'dml' | 'cpu';
export interface LadderStep {
  level: PoseLevel;
  /** Frame rate while somebody is there / while nobody is. */
  presentFps: number;
  absentFps: number;
  /** Short higher rate for waving and rhythm, only on the top step. */
  burstFps?: number;
  /** Run the detector every N frames (the pose keypoints give the next crop in between). */
  detectEvery: number;
  /** false: detector only ("presence-only"). */
  pose: boolean;
}

/**
 * 降帧 → 换轻模型 → 只留检测 → 暂停. Stage 1 ships only the body model, so the "lighter model" rung is
 * empty; when the whole-body model arrives, its steps go first and a switch to the body model is inserted here.
 */
export const LADDER: readonly LadderStep[] = Object.freeze([
  { level: 'normal', presentFps: 5, absentFps: 2, burstFps: 10, detectEvery: 5, pose: true },
  { level: 'reduced', presentFps: 2, absentFps: 1, detectEvery: 4, pose: true },
  { level: 'minimal', presentFps: 1, absentFps: 1, detectEvery: 3, pose: true },
  { level: 'presence-only', presentFps: 1, absentFps: 0.5, detectEvery: 1, pose: false },
] satisfies LadderStep[]);

/** Half the frame interval: the other half stays free for the pet's own rendering. */
export const budgetMs = (fps: number) => 500 / fps;

export function p90(values: readonly number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.9 * sorted.length) - 1))];
}

export interface SelfTest { dml: number | null; cpu: number | null; dmlDetect: number | null; cpuDetect: number | null }

/** Fastest working route; the first ladder step its p90 fits. null when nothing fits (sensing pauses). */
export function chooseRoute(test: SelfTest, ladder: readonly LadderStep[] = LADDER): { route: RouteName; index: number } | null {
  const routes = (['dml', 'cpu'] as const).filter(route => test[route] !== null && Number.isFinite(test[route]))
    .sort((a, b) => test[a]! - test[b]!);
  for (const route of routes) {
    const full = test[route]!, detect = test[route === 'dml' ? 'dmlDetect' : 'cpuDetect'] ?? full;
    const index = ladder.findIndex(step => (step.pose ? full : detect) <= budgetMs(step.presentFps));
    if (index >= 0) return { route, index };
  }
  return null;
}

/** Rolling 30-frame p90 against the current step; down when over budget, back up after holding comfortably. */
export class DegradeLadder {
  private samples: number[] = [];
  private changedAt: number;
  private upHoldMs = 10_000;
  private lastUpAt = -Infinity;
  index: number;
  paused = false;

  constructor(start: number, now: number, private readonly ladder: readonly LadderStep[] = LADDER) {
    this.index = Math.min(Math.max(0, start), ladder.length - 1);
    this.changedAt = now;
  }
  get step(): LadderStep { return this.ladder[this.index]; }

  /** Milliseconds one frame took at the current step. Returns true when the step changed. */
  record(ms: number, now: number, pressure = false): boolean {
    if (this.paused) return false;
    this.samples.push(ms);
    if (this.samples.length > 30) this.samples.shift();
    const budget = budgetMs(this.step.presentFps);
    if (this.samples.length >= 10 && p90(this.samples) > budget) return this.move(+1, now);
    if (pressure && this.index === 0) return this.move(+1, now);
    const above = this.ladder[this.index - 1];
    if (!above || pressure) return false;
    // From presence-only the pose cost is unknown: try a step up only after a long, growing wait.
    const hold = above.pose && !this.step.pose ? Math.max(60_000, this.upHoldMs * 6) : this.upHoldMs;
    const comfortable = this.step.pose === above.pose ? this.samples.length >= 10 && p90(this.samples) < 0.7 * budgetMs(above.presentFps) : true;
    if (now - this.changedAt >= hold && comfortable) return this.move(-1, now);
    return false;
  }

  private move(delta: number, now: number): boolean {
    if (delta > 0 && now - this.lastUpAt < 30_000) this.upHoldMs = Math.min(10 * 60_000, this.upHoldMs * 2); // the last step up did not hold
    if (delta < 0) this.lastUpAt = now;
    const next = this.index + delta;
    this.samples = [];
    this.changedAt = now;
    if (next >= this.ladder.length) { this.paused = true; return true; }
    this.index = Math.max(0, next);
    return true;
  }
}

/** DirectML that keeps running far over budget is treated like a DirectML error (the CPU is tried instead). */
export class SlowGpuWatch {
  private strikes = 0;
  /** true when DirectML should be abandoned. */
  record(ms: number, budget: number): boolean {
    this.strikes = ms > 3 * budget ? this.strikes + 1 : 0;
    return this.strikes >= 3;
  }
}
