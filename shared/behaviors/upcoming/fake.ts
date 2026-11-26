// P-001: the in-memory UpcomingBook (tests, and what a build without the profile file would use). It follows the same rules as the real one
// (the pure functions in state.ts) and the same gate: nothing is written while recording is off. tests/p001-upcoming-contract.test.ts runs
// the same contract against this and against the profile-file book.

import type { UpcomingBook, UpcomingCandidate, UpcomingShown, UpcomingStored } from './interface';
import {
  addUpcoming, clearUpcoming, dropUpcomingSegments, dueUpcoming, emptyUpcoming, keepUpcomingSegments, makeUpcomingDue, markUpcomingMany, removeUpcoming, settleUpcoming, shownUpcoming,
} from './state';
import { UPCOMING_KNOBS, type UpcomingKnobs } from './knobs';

export class FakeUpcomingBook implements UpcomingBook {
  state: UpcomingStored = emptyUpcoming();
  /** The recording switch (default off, like the real one): off means every write is refused. */
  recording = false;
  private counter = 0;
  constructor(private readonly now: () => number, private readonly knobs: UpcomingKnobs = UPCOMING_KNOBS) {}

  private change(next: UpcomingStored): void { this.state = next; }
  async add(input: { from: string; items: readonly UpcomingCandidate[]; scope?: string }): Promise<number> {
    if (!this.recording) return 0;
    const settled = settleUpcoming(this.state, this.now(), this.knobs).state;
    const result = addUpcoming(settled, input, this.now(), () => `fake-${++this.counter}`, this.knobs);
    this.change(result.state);
    return result.added;
  }
  list(): readonly UpcomingShown[] { return this.recording ? shownUpcoming(this.state, this.now(), this.knobs) : []; }
  async remove(id: string): Promise<boolean> {
    if (!this.recording) return false;
    const result = removeUpcoming(this.state, id, this.knobs); this.change(result.state); return result.removed > 0;
  }
  async clear(): Promise<number> {
    if (!this.recording) return 0;
    const result = clearUpcoming(this.state, this.knobs); this.change(result.state); return result.removed;
  }
  async dropSegments(ids: readonly string[]): Promise<number> { const result = dropUpcomingSegments(this.state, ids); this.change(result.state); return result.removed; }
  async keepSegments(ids: ReadonlySet<string>): Promise<number> { const result = keepUpcomingSegments(this.state, ids); this.change(result.state); return result.removed; }
  async settle(): Promise<number> {
    if (!this.recording) return 0;
    const result = settleUpcoming(this.state, this.now(), this.knobs); this.change(result.state); return result.expired;
  }
  async makeDue(): Promise<boolean> {
    if (!this.recording) return false;
    const result = makeUpcomingDue(this.state, this.now(), this.knobs); this.change(result.state); return result.changed;
  }
  due(): readonly UpcomingShown[] {
    return this.recording ? dueUpcoming(this.state, this.now()).map(({ id, what, said, dueAt, state }) => ({ id, what, said, dueAt, state })) : [];
  }
  async mark(ids: readonly string[], to: 'asked' | 'user-said'): Promise<number> {
    if (!this.recording) return 0;
    const result = markUpcomingMany(this.state, ids, to, this.now()); this.change(result.state); return result.changed;
  }
  /** Turning the switch off by hand: everything goes at once. */
  switchOff(): void { this.recording = false; this.state = emptyUpcoming(); }
}
