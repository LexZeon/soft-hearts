// P-001 steps 2 and 3: asks about a remembered plan once its time has come. Two doors, one memory of what was asked:
//  - step 2, askTurn(): the user came to her and wrote. If a plan's time has come, this turn's private context gets one line about it
//    (shared/behaviors/upcoming/ask.ts askLine); she decides whether and how to ask. The plan becomes "asked" when that reply completes (done()).
//    If the user's own message already touches the plan (or says "别问了"), it becomes "user-said" and nothing is carried.
//  - step 3, topic(): offered to the impulse path as one of her topics when she may speak first (electron/initiative/impulse/host.ts), once per plan.
// Both follow the same floor (no asking in the dead of night, asleep, or when the user is low or irritated) and a small rest between asks
// (drawn from a range each time, so it is never a beat). Step 3 never offers a tender plan. Only closed events and counts reach the journal.
// Nothing here reads anything but the plan's own short form and the current message in memory; nothing is stored beyond the book's state change.

import type { UpcomingBook } from '../../../shared/behaviors/upcoming/interface';
import { UPCOMING_KNOBS, type UpcomingKnobs } from '../../../shared/behaviors/upcoming/knobs';
import { askFloor, askLine, isTenderPlan, mentionsPlan, topicText, wantsNoAsk } from '../../../shared/behaviors/upcoming/ask';
import type { UpcomingJournalEvent } from '../../../shared/memory/journal-entries';

export interface UpcomingAskDeps {
  book: Pick<UpcomingBook, 'due' | 'mark'>;
  /** The recording switch with a ready profile (nothing is read, carried or marked while it is off). */
  recording(): boolean;
  /** The user's local hour 0-23. */
  hour(): number;
  /** Her sleep (the inner loop's quietNow().asleep). */
  asleep(): boolean;
  /** The user state she read (companion.userState.current(...).state), or null. */
  userState(): string | null;
  journal?(event: UpcomingJournalEvent, count: number): void;
  changed?(): void;
  now?(): number;
  random?(): number;
  knobs?: UpcomingKnobs;
}

/** A line carried in one chat turn. `done()` after her reply completed (the plan is then "asked"); never carried twice for the same plan. */
export interface AskTicket { readonly line: string; done(): void }

const MINUTE = 60_000;

export class UpcomingAsk {
  private readonly knobs: UpcomingKnobs;
  /** Plans a turn or an opening is carrying right now (id -> when it lets go if nobody calls done). */
  private readonly carrying = new Map<string, number>();
  private restUntil = 0;
  /** User turns since a line was last carried in chat, and how many must pass before the next one (drawn after each). */
  private turns = Number.POSITIVE_INFINITY;
  private needTurns = 0;
  constructor(private readonly deps: UpcomingAskDeps) { this.knobs = deps.knobs ?? UPCOMING_KNOBS; }

  private now(): number { try { return (this.deps.now ?? Date.now)(); } catch { return Date.now(); } }
  private random(): number { try { const value = (this.deps.random ?? Math.random)(); return Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0.5; } catch { return 0.5; } }
  private draw([low, high]: readonly [number, number]): number { return low + (high - low) * this.random(); }
  private recording(): boolean { try { return this.deps.recording() === true; } catch { return false; } }
  private due() {
    const now = this.now();
    for (const [id, until] of this.carrying) if (until <= now) this.carrying.delete(id);
    try { return this.deps.book.due().filter(item => !this.carrying.has(item.id)); } catch { return []; }
  }
  private held(): boolean {
    try {
      return askFloor({ hour: this.deps.hour(), asleep: this.deps.asleep(), userState: this.deps.userState() }, this.knobs) !== null;
    } catch { return true; }
  }
  private journal(event: UpcomingJournalEvent, count: number): void { try { this.deps.journal?.(event, count); } catch { /* never changes what she does */ } }

  private close(ids: readonly string[], to: 'asked' | 'user-said'): void {
    if (!ids.length) return;
    // Until the book has saved the change, the plan still reads as due: keep it out of the way meanwhile.
    for (const id of ids) this.carrying.set(id, this.now() + 60 * MINUTE);
    void this.deps.book.mark(ids, to).then(changed => {
      if (changed > 0) { this.journal(to, changed); this.deps.changed?.(); }
    }).catch(() => undefined);
  }

  private rest(): void { this.restUntil = this.now() + this.draw(this.knobs.ask.restMinutes) * MINUTE; }

  /**
   * Step 2. Call once per user message, before the turn's context is composed. Returns the line to add (or null) and the callback for when
   * her reply has completed. Does the "user said it first" check on every call, even when it will not carry anything.
   */
  askTurn(userText: string): AskTicket | null {
    try {
      if (!this.recording()) return null;
      let due = this.due();
      if (!due.length) { this.turns += 1; return null; }
      // The user brought it up (or asked not to be asked): those plans are closed, nothing is carried for them.
      const text = String(userText ?? '');
      const closed = wantsNoAsk(text) ? due : due.filter(item => mentionsPlan(text, item.what));
      this.close(closed.map(item => item.id), 'user-said');
      due = due.filter(item => !closed.includes(item));
      this.turns += 1;
      // He is already on the subject of a plan this turn: she asks nothing else on top of it.
      if (closed.length || !due.length || this.held() || this.now() < this.restUntil || this.turns < this.needTurns) return null;
      const plan = due[0];
      this.carrying.set(plan.id, this.now() + this.knobs.ask.holdMinutes * MINUTE);
      let finished = false;
      return {
        line: askLine(plan),
        done: () => {
          if (finished) return;
          finished = true;
          this.turns = 0; this.needTurns = Math.round(this.draw(this.knobs.ask.gapTurns)); this.rest();
          this.close([plan.id], 'asked');
        },
      };
    } catch { return null; }
  }

  /** Step 3. The earliest plan she may open with now (not a tender one), or null. Read-only: a plan is only marked by asked(). */
  topic(): { id: string; text: string } | null {
    try {
      if (!this.recording() || this.held() || this.now() < this.restUntil) return null;
      const plan = this.due().find(item => !isTenderPlan(item.what, item.said));
      return plan ? { id: plan.id, text: topicText(plan) } : null;
    } catch { return null; }
  }

  /** Step 3: her own line that came out of the plan topic was shown. */
  asked(id: string): void {
    try {
      if (!this.recording()) return;
      this.rest();
      this.close([id], 'asked');
    } catch { /* nothing */ }
  }
}
