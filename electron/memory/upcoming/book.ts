// P-001: the real UpcomingBook: the lists live in their own files (electron/memory/upcoming/store.ts), one per character, under the user's
// recording switch. The rules are the pure functions of shared/behaviors/upcoming/state.ts (the fake book uses the same ones).
// add / list / remove / clear / makeDue work on the character shown now (`current`), or on the one `add` is told about (the segment's own
// character); dropSegments / keepSegments / settle go over every character's list. Nothing here throws to the caller.

import { randomUUID } from 'node:crypto';
import type { UpcomingBook, UpcomingCandidate, UpcomingShown, UpcomingStored } from '../../../shared/behaviors/upcoming/interface';
import { UPCOMING_KNOBS, type UpcomingKnobs } from '../../../shared/behaviors/upcoming/knobs';
import {
  addUpcoming, clearUpcoming, dropUpcomingSegments, keepUpcomingSegments, makeUpcomingDue, markUpcomingMany, removeUpcoming, settleUpcoming,
} from '../../../shared/behaviors/upcoming/state';
import type { UpcomingStore } from './store';

export class ProfileUpcomingBook implements UpcomingBook {
  constructor(private readonly store: UpcomingStore, private readonly current: () => string | null, private readonly now: () => number = Date.now,
    private readonly ids: () => string = randomUUID, private readonly knobs: UpcomingKnobs = UPCOMING_KNOBS) {}

  /** Runs one pure change on a character's list; resolves to what it reports (0 when nothing was saved). */
  private async run(scope: string | null, change: (state: UpcomingStored, at: number) => { state: UpcomingStored | null; count: number }): Promise<number> {
    if (!scope) return 0;
    let count = 0;
    const saved = await this.store.change(scope, (state, at) => { const result = change(state, at); count = result.count; return result.state; });
    return saved ? count : 0;
  }

  add(input: { from: string; items: readonly UpcomingCandidate[]; scope?: string }): Promise<number> {
    return this.run(input.scope ?? this.current(), (state, at) => {
      const settled = settleUpcoming(state, at, this.knobs).state;
      const result = addUpcoming(settled, input, at, this.ids, this.knobs);
      return { state: result.added ? result.state : settled !== state ? settled : null, count: result.added };
    });
  }
  list(): readonly UpcomingShown[] { const scope = this.current(); return scope ? this.store.shown(scope, this.now()) : []; }
  /** Step 2 and 3: the current character's plans whose time has come (read from memory; nothing is changed). */
  due(): readonly UpcomingShown[] { const scope = this.current(); return scope ? this.store.due(scope, this.now()) : []; }
  mark(ids: readonly string[], to: 'asked' | 'user-said'): Promise<number> {
    return this.run(this.current(), (state, at) => { const result = markUpcomingMany(state, ids, to, at); return { state: result.changed ? result.state : null, count: result.changed }; });
  }
  /** I-087: the current character's plans noted since `since` (a pinky promise marks them). */
  recentIds(since: number): readonly string[] { const scope = this.current(); return scope ? this.store.recent(scope, since) : []; }
  remove(id: string): Promise<boolean> { return this.run(this.current(), state => { const result = removeUpcoming(state, id, this.knobs); return { state: result.removed ? result.state : null, count: result.removed }; }).then(count => count > 0); }
  clear(): Promise<number> { return this.run(this.current(), state => { const result = clearUpcoming(state, this.knobs); return { state: result.removed ? result.state : null, count: result.removed }; }); }
  dropSegments(ids: readonly string[]): Promise<number> {
    return this.store.changeAll(state => { const result = dropUpcomingSegments(state, ids); return { state: result.state === state ? null : result.state, count: result.removed }; });
  }
  keepSegments(ids: ReadonlySet<string>): Promise<number> {
    return this.store.changeAll(state => { const result = keepUpcomingSegments(state, ids); return { state: result.state === state ? null : result.state, count: result.removed }; });
  }
  settle(): Promise<number> {
    return this.store.changeAll((state, at) => { const result = settleUpcoming(state, at, this.knobs); return { state: result.state === state ? null : result.state, count: result.expired }; });
  }
  async makeDue(): Promise<boolean> {
    return (await this.run(this.current(), (state, at) => { const result = makeUpcomingDue(state, at, this.knobs); return { state: result.changed ? result.state : null, count: result.changed ? 1 : 0 }; })) > 0;
  }
}
