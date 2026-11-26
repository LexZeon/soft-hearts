/**
 * 2026-11-24 12:26: the window's roads that drop a reply's reading without ever asking the host for its
 * first sentence (the window was not showing, a new turn had begun, the bubble was not ready, the switch was off). Each used to return
 * silently, so the journal could not say which one it was. They now tell the host one closed word (noteJournalFact 'reading-dropped'); the
 * host files it as the cause if that reply never gets asked for (electron/voice/reading-ledger.ts). A word, never a text; never blocks.
 */
export const READING_DROP_WHYS = ['not-shown', 'chat-busy', 'not-ready', 'switch'] as const;
export type ReadingDropWhy = (typeof READING_DROP_WHYS)[number];

export interface ReadingDropTarget { noteJournalFact(kind: 'reading-dropped', value: unknown): Promise<boolean> }

/** Tell the host why this window dropped a reading before it began. */
export function reportReadingDropped(api: ReadingDropTarget | null | undefined, why: ReadingDropWhy): void {
  try { void api?.noteJournalFact('reading-dropped', { why }).catch(() => {}); } catch { /* journal only */ }
}

/** The reason the voice reply's 'speech' event is not read in this window now, or null when it can be (the order the checks are made in). */
export function speechDropWhy(state: { chatBusy: boolean; shown: boolean; voiceOn: boolean }): ReadingDropWhy | null {
  if (state.chatBusy) return 'chat-busy';
  if (!state.shown) return 'not-shown';
  if (!state.voiceOn) return 'switch';
  return null;
}
