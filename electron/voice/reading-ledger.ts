/**
 * 2026-11-24 12:26: a reply that was shown and then never read left no trace. The reading journal wrote a
 * row only when the voice produced a sentence record, so a reply the voice was never asked for (or was cancelled for before its first
 * sentence) was invisible, and nobody could tell which road dropped it. This is the promise instead: every reply the host expects to be read
 * ends in a reading row, or in a row that says why it was not.
 *
 * - `expect(replyId)`: the host handed the reply to her voice (it sent the 'speech' event, or the window's plan began).
 * - `asked(replyId)`: her voice asked for its first sentence: from there the segment records and the ordinary reading row take over.
 * - `notHanded(by)`: the host decided on the spot not to hand it over (a newer line, no mood reading, an incomplete passage): the row is
 *   written at once, with that reason.
 * - A reply expected but never asked for within `idleMs` (the journal's own reading idle time) is written as 'not-asked'; a cause a window
 *   noted meanwhile (the user stopped her, the window was hidden, a drop reported by the renderer) is used instead of the generic word.
 * Closed words only, a row has no text. Electron-free, injected timers; a failure here never touches her voice.
 */
import type { ReadingCancelBy } from '../../shared/voice';

export interface ReadingLedgerPorts {
  timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** How long a reply may wait for its first sentence to be asked for (the journal's READING_IDLE_MS). */
  idleMs: number;
  /** One row, 'unread' with this cause. `preferNoted`: a cause a window noted since is used when there is one. */
  write(by: ReadingCancelBy, preferNoted: boolean, replyId?: string): void;
}

const KEEP = 8;

export class ReadingLedger {
  private readonly open = new Map<string, unknown>();
  constructor(private readonly ports: ReadingLedgerPorts) {}

  expect(replyId: string): void {
    if (typeof replyId !== 'string' || !replyId || this.open.has(replyId)) return;
    if (this.open.size >= KEEP) this.fire(this.open.keys().next().value as string); // never more than KEEP waiting: the oldest is settled now
    this.open.set(replyId, this.ports.timers.set(() => { this.fire(replyId); }, this.ports.idleMs));
  }

  /** Her voice asked for the first sentence of this reply (true when it was one the ledger waited for). */
  asked(replyId: string | undefined): boolean {
    if (!replyId) return false;
    const timer = this.open.get(replyId);
    if (timer === undefined) return false;
    this.open.delete(replyId);
    try { this.ports.timers.clear(timer); } catch { /* journal only */ }
    return true;
  }

  /** The host did not hand the reply to her voice: the row now, for this reason. */
  notHanded(by: ReadingCancelBy): void {
    try { this.ports.write(by, false); } catch { /* journal only */ }
  }

  /** How many replies still wait for their first sentence (tests and the developer view). */
  get waiting(): number { return this.open.size; }

  private fire(replyId: string): void {
    const timer = this.open.get(replyId);
    if (timer === undefined) return;
    this.open.delete(replyId);
    try { this.ports.timers.clear(timer); } catch { /* journal only */ }
    try { this.ports.write('not-asked', true, replyId); } catch { /* journal only */ } // I-209 stage voice: the row is the reply's owner's
  }
}
