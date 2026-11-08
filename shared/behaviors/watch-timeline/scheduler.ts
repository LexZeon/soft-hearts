// I-048 §2: the queue for haiku jobs while watching. A planner only: it never calls a model and never sets a timer. The caller asks
// `enqueue`, then `next` whenever a slot may be free, runs the job, and calls `finish`. Every time comes from the injected clock.
//
// Order: the look decision on a message first, then a frame description, then a summary. Frame descriptions have an hourly budget,
// summaries a minimum gap. Turning watch or screen off, or a refusal, cancels everything waiting and makes the results of what is
// running stale (`isCurrent` is false for them).

import type { HaikuJob, HaikuJobKind } from './interface';
import { WATCH_TIMELINE_KNOBS, type WatchTimelineKnobs } from './knobs';

export type EnqueueResult =
  | { readonly accepted: true; readonly job: HaikuJob }
  | { readonly accepted: false; readonly reason: 'watch-off' | 'screen-off' | 'frame-budget' | 'queue-full' | 'summary-gap' | 'already-queued' };

export type CancelReason = 'watch-off' | 'screen-off' | 'refused';

const PRIORITY: Readonly<Record<HaikuJobKind, number>> = { look: 0, frame: 1, summary: 2 };
const HOUR = 3_600_000;

export class HaikuPlanner {
  private watchOn = false;
  private screenOn = false;
  private epoch = 1;
  private nextId = 1;
  private queue: HaikuJob[] = [];
  private running = new Map<number, HaikuJob>();
  private frameStarts: number[] = [];
  private lastSummaryAt: number | null = null;

  constructor(
    private readonly now: () => number,
    private readonly knobs: WatchTimelineKnobs['haiku'] = WATCH_TIMELINE_KNOBS.haiku,
  ) {}

  /**
   * 和她一起看 / 屏幕读取 switched. Either one going off cancels everything. Returns the cancelled jobs (waiting and running), so the
   * caller can abort the running ones and remove placeholders.
   */
  setConditions(conditions: { watch: boolean; screen: boolean }): HaikuJob[] {
    const reason: CancelReason | null = this.watchOn && !conditions.watch ? 'watch-off' : this.screenOn && !conditions.screen ? 'screen-off' : null;
    this.watchOn = conditions.watch;
    this.screenOn = conditions.screen;
    return reason ? this.cancelAll() : [];
  }

  /** A refusal ("别看") or any other reason to drop all: waiting jobs are removed, running ones become stale. */
  cancelAll(): HaikuJob[] {
    const cancelled = [...this.running.values(), ...this.queue];
    this.queue = [];
    this.running.clear();
    this.epoch++;
    return cancelled;
  }

  /** The look decision on a message needs the screen; frames and summaries need watch on as well. */
  enqueue(kind: HaikuJobKind): EnqueueResult {
    const now = this.now();
    if (!this.screenOn) return { accepted: false, reason: 'screen-off' };
    if (kind !== 'look' && !this.watchOn) return { accepted: false, reason: 'watch-off' };
    if (kind === 'frame') {
      this.frameStarts = this.frameStarts.filter(at => at > now - HOUR);
      const queued = this.queue.filter(job => job.kind === 'frame').length;
      if (this.frameStarts.length + queued >= this.knobs.framesPerHour) return { accepted: false, reason: 'frame-budget' };
      if (queued >= this.knobs.queuedFrames) return { accepted: false, reason: 'queue-full' };
    }
    if (kind === 'summary') {
      const open = [...this.queue, ...this.running.values()].some(job => job.kind === 'summary');
      if (open) return { accepted: false, reason: 'already-queued' };
      if (this.lastSummaryAt !== null && now - this.lastSummaryAt < this.knobs.summaryGapMinutes * 60_000) return { accepted: false, reason: 'summary-gap' };
    }
    const job: HaikuJob = { id: this.nextId++, kind, epoch: this.epoch };
    this.queue.push(job);
    return { accepted: true, job };
  }

  /** The next job to run when a slot is free (highest priority, oldest first), or null. Starting it counts against the budgets. */
  next(): HaikuJob | null {
    if (this.running.size >= Math.max(1, this.knobs.parallel) || !this.queue.length) return null;
    let best = 0;
    for (let index = 1; index < this.queue.length; index++) if (PRIORITY[this.queue[index].kind] < PRIORITY[this.queue[best].kind]) best = index;
    const [job] = this.queue.splice(best, 1);
    this.running.set(job.id, job);
    const now = this.now();
    if (job.kind === 'frame') this.frameStarts.push(now);
    if (job.kind === 'summary') this.lastSummaryAt = now;
    return job;
  }

  /** The job ended (done, failed or aborted): its slot is free. */
  finish(job: HaikuJob): void {
    this.running.delete(job.id);
  }

  /** Is this job's result still wanted? False after a cancel, or when it was never running. */
  isCurrent(job: HaikuJob): boolean {
    return job.epoch === this.epoch && this.running.has(job.id);
  }

  get stats(): { queued: number; running: number; framesLastHour: number } {
    const now = this.now();
    return { queued: this.queue.length, running: this.running.size, framesLastHour: this.frameStarts.filter(at => at > now - HOUR).length };
  }
}
