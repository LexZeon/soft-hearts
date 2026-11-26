/**
 * The journal's 'speech' row for a paid reading that failed (2026-11-24, docs/claude/2026-11-24-voice-gaps.md): the closed failure
 * category it always had, plus the finer error kind, whether the sentence had been tried a second time, and which reply and sentence
 * it was (a counter, electron/voice/read-notes.ts). Pure; no text, no address, no server message ever reaches it.
 */
import type { VoiceJournalInput } from '../../shared/voice';
import type { SpeechErrorKind } from '../../shared/voice/voice-gaps-journal';
import { TtsError } from './tts';
import type { ReadNotes } from './read-notes';

/** What SpeechRuntime tells the failure callback besides the category. */
export interface SpeechFailureInfo { kind?: SpeechErrorKind; retried?: boolean; replyId?: string; segmentIndex?: number }

/** The kind of an error: the one the adapter set, else the closed kind its category implies. */
export function speechErrorKind(error: unknown): SpeechErrorKind {
  if (error instanceof TtsError) {
    if (error.kind) return error.kind;
    if (error.failure === 'network') return 'network';
    if (error.failure === 'timeout') return 'timeout';
  }
  return 'other';
}

export function failureInfo(error: unknown, replyId?: string, segmentIndex?: number): SpeechFailureInfo {
  return { kind: speechErrorKind(error), ...(error instanceof TtsError && error.retried ? { retried: true } : {}),
    ...(replyId ? { replyId } : {}), ...(segmentIndex === undefined ? {} : { segmentIndex }) };
}

export type SpeechFailureEntry = Extract<VoiceJournalInput, { type: 'speech' }>;

/** The speech row for one failure; notes the retried failure so the reply's reading row can say so. */
export function speechFailureEntry(characterId: string | null, provider: 'bailian' | 'fish', failure: SpeechFailureEntry['failure'], info: SpeechFailureInfo | undefined, notes: ReadNotes | null): SpeechFailureEntry {
  const reply = notes && info?.replyId ? notes.numberOf(info.replyId) : null;
  if (info?.retried) notes?.noteRetriedFailure(reply);
  return { type: 'speech', characterId, provider, failure, ...(info?.kind ? { kind: info.kind } : {}), ...(info?.retried ? { retried: true as const } : {}),
    ...(reply === null ? {} : { reply }), ...(info?.segmentIndex === undefined ? {} : { segment: info.segmentIndex }) };
}
