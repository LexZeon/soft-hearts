import type { AudioReadingTally } from '../voice';

/**
 * 陪听的一分钟: sums what became of each clip of the played sound, so the experience journal can
 * say, with numbers only, whether clips arrived, were skipped because listening was paused, or came back with or without words.
 * I-187: also the clips turned away because the recognizer's queue was full (skippedBusy, written only when not zero).
 */
export interface ListenTallyCounts { received: number; skippedPaused: number; withText: number; empty: number; failed: number; skippedBusy?: number }

const empty = (): ListenTallyCounts => ({ received: 0, skippedPaused: 0, withText: 0, empty: 0, failed: 0 });

export class ListenTally {
  private counts: ListenTallyCounts = empty();
  add(kind: AudioReadingTally): void {
    if (kind === 'received') this.counts.received++;
    else if (kind === 'skipped-paused') this.counts.skippedPaused++;
    else if (kind === 'skipped-busy') this.counts.skippedBusy = (this.counts.skippedBusy ?? 0) + 1;
    else if (kind === 'with-text') this.counts.withText++;
    else if (kind === 'empty') this.counts.empty++;
    else if (kind === 'failed') this.counts.failed++;
  }
  /** The counts since the last take, or null when nothing happened (a quiet minute writes no line). */
  take(): ListenTallyCounts | null {
    const counts = this.counts;
    this.counts = empty();
    return Object.values(counts).some(value => (value ?? 0) > 0) ? counts : null;
  }
}
