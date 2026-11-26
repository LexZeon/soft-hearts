/**
 * 三人同框别卡 (docs/claude/2026-11-24-stage-smooth.md): the frame times of one full-screen page, one row a minute for the experience journal
 * ('frame-time', shared/stage/smooth-journal.ts). Pure: the page feeds it the interval of every frame it drew, with whether she was drawn as an
 * idle extra; once a minute of the page's own clock has passed it hands back the numbers and starts again. Numbers only: no text can get in.
 */
import { STALL_MS, percentile } from '../perf-tiers';

export const FRAME_SAMPLER_KNOBS = Object.freeze({ minuteMs: 60_000 });

export interface FrameMinute { fps: number; medianMs: number; p95Ms: number; frames: number; idlePct: number }

export class FrameSampler {
  private started: number | null = null;
  private intervals: number[] = [];
  private frames = 0;
  private idleMs = 0;
  private totalMs = 0;

  /** A frame was drawn `intervalMs` after the one before; `idle`: she was drawn as an idle extra. A finished minute, or null. */
  feed(now: number, intervalMs: number, idle: boolean, knobs = FRAME_SAMPLER_KNOBS): FrameMinute | null {
    this.started ??= now;
    if (intervalMs > 0 && intervalMs < STALL_MS) { this.intervals.push(intervalMs); this.frames++; this.totalMs += intervalMs; if (idle) this.idleMs += intervalMs; }
    if (now - this.started < knobs.minuteMs) return null;
    const out: FrameMinute | null = this.frames < 2 || this.totalMs <= 0 ? null : {
      fps: this.frames * 1000 / this.totalMs, medianMs: percentile(this.intervals, 0.5) ?? 0, p95Ms: percentile(this.intervals, 0.95) ?? 0,
      frames: this.frames, idlePct: Math.round(100 * this.idleMs / this.totalMs) };
    this.reset(now);
    return out;
  }

  /** A load or a hidden window: what was measured is not a rate. */
  reset(now: number): void { this.started = now; this.intervals = []; this.frames = 0; this.idleMs = 0; this.totalMs = 0; }
}
