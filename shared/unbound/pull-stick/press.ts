/**
 * I-194 and I-196: what one press on her turns into, decided by the dead zone and the time and nothing else.
 *
 *   inside the dead zone, released quickly   a click (shared/unbound/click.ts reports it: it opens the chat box, it is not a touch);
 *   inside the dead zone, held `holdTouchMs`  a touch (once); after it the press is the touch's: moving on does not turn it into a pull;
 *   out of the dead zone at any time          a pull (the joystick); it is never also a touch, and a click is never reported for it.
 *
 * The dead zone is the same one the stick uses, so "held still" and "pulling" cannot both be true. No clock: the caller passes times.
 */
import { STICK_KNOBS, type StickKnobs } from './knobs';

export type PressPhase = 'idle' | 'pending' | 'stick' | 'touched';

export class PressJudge {
  private state: PressPhase = 'idle';
  private from: { x: number; y: number; at: number } | null = null;
  constructor(private readonly knobs: StickKnobs = STICK_KNOBS) {}

  get phase(): PressPhase { return this.state; }
  /** Where the press began (the stick's centre), or null. */
  get anchor(): { x: number; y: number } | null { return this.from ? { x: this.from.x, y: this.from.y } : null; }

  down(x: number, y: number, at: number): void {
    this.from = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(at) ? { x, y, at } : null;
    this.state = this.from ? 'pending' : 'idle';
  }

  /** The pointer moved. 'started' exactly once: on the move that left the dead zone of a press that was not already a touch. */
  move(x: number, y: number): 'idle' | 'pending' | 'started' | 'stick' | 'touched' {
    if (!this.from || !Number.isFinite(x) || !Number.isFinite(y)) return this.state;
    if (this.state !== 'pending') return this.state;
    if (Math.hypot(x - this.from.x, y - this.from.y) <= this.knobs.deadZonePx) return 'pending';
    this.state = 'stick';
    return 'started';
  }

  /** Time passes without leaving the dead zone: 'touch' once, when the hold reaches `holdTouchMs`. */
  tick(at: number): 'touch' | null {
    if (this.state !== 'pending' || !this.from || !Number.isFinite(at) || at - this.from.at < this.knobs.holdTouchMs) return null;
    this.state = 'touched';
    return 'touch';
  }

  /** The release: what the press ended as ('click' only when it stayed in the dead zone and was released before a touch). */
  up(): 'click' | 'stick' | 'touched' | 'none' {
    const was = this.state;
    this.cancel();
    return was === 'pending' ? 'click' : was === 'stick' ? 'stick' : was === 'touched' ? 'touched' : 'none';
  }

  cancel(): void { this.state = 'idle'; this.from = null; }
}
