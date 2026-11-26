/**
 * Who cancelled a reading (the 16:55 reading cuts: the journal only said "cancelled"). The host notes a closed word where it
 * cancels a reading (a new reply began, she was interrupted, the call hung up, the user stopped her, an error, the reply was replaced); the
 * reading-time line (electron/memory/journal/extras.ts ReadingJournal) takes it when the reading it writes was cancelled. The first word
 * noted since the last take wins, so the outermost cause (an interrupt) is not overwritten by the plain "replaced" of the inner cancel it
 * triggers. A word is never a text; nothing here reads or keeps words of chat. Electron-free, no clock.
 */
import { READING_CANCEL_BYS, type ReadingCancelBy } from '../../shared/voice';

export class ReadCancelCauses {
  private cause: ReadingCancelBy | null = null;

  /** A reading is being cancelled for this reason (a value outside the closed list is ignored; the first one since the last take is kept). */
  note(by: unknown): void {
    if (this.cause !== null || !(READING_CANCEL_BYS as readonly unknown[]).includes(by)) return;
    this.cause = by as ReadingCancelBy;
  }

  /** The reason noted since the last take (and forget it), or null when nothing noted one. */
  take(): ReadingCancelBy | null { const cause = this.cause; this.cause = null; return cause; }

  /** A new reply's reading begins: a cause noted for an older one does not carry over. */
  clear(): void { this.cause = null; }
}
