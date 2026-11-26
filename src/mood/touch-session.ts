/**
 * Touching her: what the touch input's phases and events become as mood inputs for the host (a pat's session opening, its measured doses,
 * a pinch, a snack waited for, accepted and eaten, the session ending). Moved out of MoodCompanion.ts unchanged (I-154 follow-up,
 * docs/claude/2026-11-20-unbound-full-shares.md) so the companion window and full-screen Unbound send exactly the same inputs from the same
 * touch input (the same tracker): the companion window through its mood companion, full-screen through src/unbound/her/out-touch.ts.
 *
 * Rules kept as they were:
 *  - a local dwell (rua-hover, cheek-hover) never opens a host session;
 *  - the end of a session waits 220 ms, so the tracker's 5 Hz flush can still send the tail it measured, then sends "idle" once;
 *    a reset (lifecycle) drops that pending end;
 *  - an accepted snack waits for its "food" event, which goes first, then "food-eating".
 */
import type { MoodInput } from '../../shared/mood/mood-runtime';
import type { PetInteractionEvent as TouchEvent, PetInteractionState as TouchState } from './PetInteraction'; // no-pet-ok: the touch input's old type names

/** A mood input before the queue adds the token. */
export type LocalMoodInput = MoodInput extends infer T ? T extends MoodInput ? Omit<T, 'token'> : never : never;

export interface TouchSessionTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
const REAL_TIMERS: TouchSessionTimers = { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
/** How long the end of a session waits for the tracker's last flush (ms). */
export const TOUCH_SESSION_TAIL_MS = 220;

export class MoodTouchSession {
  private last = '';
  private lifecycle = 0;
  private idleTimer: unknown = null;

  constructor(private readonly push: (input: LocalMoodInput) => void, private readonly timers: TouchSessionTimers = REAL_TIMERS) {}

  /** The session the host knows now ('' for none). */
  get lastSession(): string { return this.last; }

  /** A phase of the touch input (the caller has checked it may send: a view, not disposed, not resetting). */
  state(state: TouchState): void {
    // Cheek hover starts only the existing visual contact clock; the early return below prevents it from opening a host session or earning input.
    // Local dwell keeps the ordinary UI and must never open a host rua session. A previous real session's bounded tail/idle timer may still drain normally.
    if (state.phase === 'rua-hover' || state.phase === 'cheek-hover') return;
    if (state.phase === 'idle' && this.idleTimer !== null) return;
    this.clearIdleTimer();
    if (state.phase === 'idle') {
      const sessionId = this.last;
      if (!sessionId) return;
      const lifecycle = this.lifecycle;
      // The tracker's 5 Hz flush gets one chance to send already measured tail time.
      this.idleTimer = this.timers.set(() => {
        this.idleTimer = null;
        if (lifecycle !== this.lifecycle) return;
        this.push({ type: 'phase', phase: 'idle', sessionId });
        if (this.last === sessionId) this.last = '';
      }, TOUCH_SESSION_TAIL_MS);
      return;
    }
    this.last = state.sessionId!;
    if (state.phase === 'feeding-accepted') return; // food acceptance must reach the host first.
    const phase = state.phase === 'feeding-wait' ? 'food-wait' : state.phase === 'feeding-ready' ? 'food-ready' : state.phase === 'cheek' ? 'cheek' : 'rua';
    this.push({ type: 'phase', phase, sessionId: this.last });
  }

  /** A measured dose of a pat or a pinch, or the snack accepted at her mouth (then "food-eating"). */
  event(event: TouchEvent): void {
    if (event.type === 'rua' || event.type === 'cheek') this.push(event);
    else {
      this.push(event);
      this.push({ type: 'phase', phase: 'food-eating', sessionId: event.sessionId });
    }
  }

  /** Forget the session locally (a new scope, a reset): a pending end is dropped. */
  resetLocal(): void { this.lifecycle++; this.clearIdleTimer(); this.last = ''; }
  /** The pending end is cancelled without forgetting the session (the owner went away). */
  dispose(): void { this.lifecycle++; this.clearIdleTimer(); }

  private clearIdleTimer(): void { if (this.idleTimer !== null) this.timers.clear(this.idleTimer); this.idleTimer = null; }
}
