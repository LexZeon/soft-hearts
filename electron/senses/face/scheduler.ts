/**
 * I-135: when to look. Pure; the host ticks it only while the feature is on, the camera is on and a face is enrolled.
 *
 * User decision.
 *  - continuous: every `continuousMs` while active (less often after several checks found nobody);
 *  - return: after the user went away (在→不在, or pose sensing's "leave"), someone appearing or typing starts a short burst;
 *  - photo: a camera picture about to be sent is checked by the host directly (not scheduled here).
 * Inactive → nothing is ever due.
 */
import type { CheckClass } from './decision';
import { FACE_KNOBS, type FaceKnobs } from './knobs';

export type ScheduledReason = 'continuous' | 'return';

export class FaceCheckScheduler {
  private active = false;
  private lastAt = -Infinity;
  private noFace = 0;
  private away = false;
  private burst = 0;
  private busy = false;

  constructor(private readonly knobs: FaceKnobs = FACE_KNOBS) {}

  get isActive(): boolean { return this.active; }
  get isAway(): boolean { return this.away; }

  /** Feature on + camera on + enrolled + model ready. Turning off forgets everything. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.lastAt = -Infinity; this.noFace = 0; this.burst = 0; this.busy = false;
    if (!on) this.away = false;
  }

  /** The user went away (在→不在, pose "leave", the screen locked). Remembered even while inactive. */
  noteLeave(): void { this.away = true; this.burst = 0; }

  /** Someone is back in front of the computer or started typing / talking: after a leave, a burst of checks. */
  noteReturn(): void {
    if (!this.away) return;
    this.away = false;
    if (this.active) this.burst = this.knobs.schedule.burstChecks;
  }

  /** What to check now, if anything. */
  due(now: number): ScheduledReason | null {
    if (!this.active || this.busy) return null;
    const s = this.knobs.schedule;
    if (this.burst > 0) return now - this.lastAt >= s.burstGapMs ? 'return' : null;
    const gap = this.noFace >= s.idleAfterNoFace ? s.idleMs : s.continuousMs;
    return now - this.lastAt >= gap ? 'continuous' : null;
  }

  started(now: number): void { this.busy = true; this.lastAt = now; }

  /** A check finished (any class; null = it could not run). */
  finished(result: CheckClass | null, reason: ScheduledReason): void {
    this.busy = false;
    if (result === 'no-face') this.noFace++;
    else if (result && result !== 'skipped') this.noFace = 0;
    if (reason === 'return' && this.burst > 0) this.burst = result === 'match' ? 0 : this.burst - 1;
  }
}
