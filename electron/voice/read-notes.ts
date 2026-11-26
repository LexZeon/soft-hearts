/**
 * Two small host-side notes the reading journal needs (2026-11-24):
 *
 * - A number for each reply of this run (1, 2, 3 ...), given at the first sentence the voice is asked for. The speech row of a failed
 *   sentence and the reading rows of that reply carry the same number, so they line up without any id or text. Only a counter: the
 *   reply id is looked up and never kept past the last 64 replies, never written anywhere.
 * - (also) the start of a new reply, which forgets a cancel cause noted for an older one (electron/voice/read-cancel-cause.ts).
 * - Which reply's last failed sentence had been tried a second time (the retry in electron/voice/fish-retry.ts), so that reply's reading
 *   row can say "failed after a retry". The failure is noted before the reply's first reading record arrives, so it is matched by the reply's
 *   number, not cleared when a reply starts; taken once.
 *
 * - I-209 stage voice: whose reply it is when it is not the desktop companion's (someone else on the full-screen stage), so her reading rows
 *   carry her id: the reply the voice was last offered or asked for, looked up through `whose` (the reply styles' owners; null: the companion).
 *
 * Electron-free, no clock, no text.
 */
const KEEP = 64;

export class ReadNotes {
  /** `onNewReply` runs when a reply is seen for the first time: a cancel cause noted before this reply began is stale and goes (a cause noted after it began, even before its first reading record arrives, stays). */
  constructor(private readonly onNewReply?: (replyId: string) => void) {}
  private readonly numbers = new Map<string, number>();
  private count = 0;
  private lastNumber: number | null = null;
  private retriedFor: number | null = null;
  private owners: ((replyId: string) => string | null) | null = null;
  private lastOwner: string | null = null;

  /** I-209 stage voice: how to tell whose reply an id is (null: the desktop companion's). */
  whose(read: (replyId: string) => string | null): void { this.owners = read; }
  /** Whose reply `replyId` is (null: the desktop companion's, or not known). */
  ownerOf(replyId: string | undefined): string | null { try { return replyId && this.owners ? this.owners(replyId) ?? null : null; } catch { return null; } }
  /** The reply was handed to her voice (its first sentence is about to be asked for): its rows are its owner's. */
  offered(replyId: string): void { this.lastOwner = this.ownerOf(replyId); }
  /** Whose reply the voice was last offered or asked to read (null: the desktop companion's). */
  latestOwner(): string | null { return this.lastOwner; }

  /** The number of this reply (given at first sight); null when the sentence belongs to no reply. */
  numberOf(replyId: string | undefined): number | null {
    if (!replyId) return null;
    let n = this.numbers.get(replyId);
    if (n === undefined) {
      n = ++this.count;
      this.numbers.set(replyId, n);
      try { this.onNewReply?.(replyId); } catch { /* journal only */ }
      if (this.numbers.size > KEEP) this.numbers.delete(this.numbers.keys().next().value as string);
    }
    this.lastNumber = n;
    this.lastOwner = this.ownerOf(replyId);
    return n;
  }

  /** The number of the reply the voice was last asked to read (the reading row of a reply takes it when its first record arrives). */
  latest(): number | null { return this.lastNumber; }

  /** A sentence of this reply (null: no number) failed even after the second try. */
  noteRetriedFailure(reply: number | null): void { this.retriedFor = reply; }
  /** Whether a retried failure was noted for this reply (and forget it). */
  takeRetriedFailure(reply: number | null): boolean { const hit = reply !== null && this.retriedFor === reply; if (hit) this.retriedFor = null; return hit; }
}
