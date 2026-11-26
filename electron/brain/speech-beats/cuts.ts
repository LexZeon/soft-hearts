/**
 * The public door for a cut reply: whatever cut her words short files one
 * record here, with a cause. The voice call's barge-in does it now (electron/voice/voice-call/host.ts onCut -> the voice host's `cut` port);
 * the Unbound close moment calls the same function for a kiss or a hug cut short by a big pull or a face that cannot reach
 * (cause 'pulled-away' / 'could-not-reach'), and builds her next turn's facts with `cutRecordNote` (shared/voice/call-cut-note.ts).
 *
 * The record is metadata beside the reply (it leaves and comes back with it, see archive.ts): offsets into the reply's archived text and a closed
 * cause, no words. The reply itself is archived once, whole, as always; nothing here archives, rewards or reads anything.
 */
import type { MemoryScope } from '../../../shared/memory';
import { cleanCut, type CutRecord } from '../../../shared/foundation/reply-cut';
import { speechBeatsFor } from './host';

/**
 * Files `cut` for the reply archived as turn `turnId` of `scope` (offsets into that reply's archived text). Resolves when written; never
 * rejects, never throws into the caller's path; a record that is not valid is dropped.
 */
export function recordReplyCut(directory: string, scope: MemoryScope, turnId: string, cut: CutRecord): Promise<void> {
  try {
    const clean = cleanCut(cut);
    if (!clean || typeof directory !== 'string' || !directory) return Promise.resolve();
    return speechBeatsFor(directory).archive.recordCut(scope, turnId, clean).catch(() => undefined);
  } catch { return Promise.resolve(); }
}
