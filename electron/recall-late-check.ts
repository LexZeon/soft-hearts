import type { MemoryRecall } from '../shared/memory';
import { companionMemoryBlock, replaceMemoryBlock } from './conversation-context';

export interface RecallLateCheckOptions {
  /** The memories the turn's persona was built with. */
  recalled: readonly MemoryRecall[];
  /** MemoryStore.recallRevision() when `recalled` was made (read with no await in between). */
  revision: string;
  /** MemoryStore.recallRevision() now. */
  currentRevision(): string;
  /** The same recall made now: the same store, scope, text and exclusions as `recalled`. */
  recallNow(): MemoryRecall[];
  /** Told the memories that still go out, each time something was dropped or changed. */
  changed?(kept: MemoryRecall[]): void;
}

/**
 * I-021 删除一致性, the late window (Codex T-222 phase 2, E04; docs/claude/2026-11-05-recall-late-window.md).
 *
 * A turn recalls its memories once, while it is put together; its message may then wait (the Claude process starting, the
 * previous turn draining) before it is written. When the user took something back meanwhile (a note deleted, a memory
 * removed: MemoryStore.recallRevision moved), the returned function checks the memories against the store once more, where
 * the message is written: the same recall made now, and of those only the ones the turn had already selected. Nothing is
 * added late. When nothing moved (every ordinary turn) it is one string comparison and returns the persona it was given,
 * so the first word is not slower. When the store cannot be read it sends no memories rather than stale ones.
 */
export function recallLateCheck(options: RecallLateCheckOptions): (persona: string) => string {
  const built = companionMemoryBlock(options.recalled);
  let checkedAt = options.revision, kept: readonly MemoryRecall[] = options.recalled, block = built;
  return persona => {
    // Nothing was recalled: nothing can be taken back, and nothing is added late.
    if (!built) return persona;
    let revision: string;
    try { revision = options.currentRevision(); } catch { revision = ''; }
    if (!revision || revision !== checkedAt) {
      checkedAt = revision;
      let now: MemoryRecall[];
      try { now = options.recallNow(); } catch { now = []; }
      const next = now.filter(memory => kept.some(old => old.id === memory.id));
      const nextBlock = companionMemoryBlock(next);
      if (nextBlock !== block) {
        kept = next; block = nextBlock;
        try { options.changed?.(next); } catch { /* Bookkeeping never stops the message. */ }
      }
    }
    return block === built ? persona : replaceMemoryBlock(persona, built, block);
  };
}
