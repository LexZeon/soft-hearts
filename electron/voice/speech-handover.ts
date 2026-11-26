/**
 * 2026-11-24 12:26: when a spoken utterance settles, the voice host hands the reply to her voice (the
 * 'speech' event) only if a list of things all hold. Until now a reply that failed any of them was simply not read, and nothing said
 * which one failed. This is that list as one pure answer: 'hand' (read it), null (nothing to read: empty), or the closed reason (the reading
 * journal's cancel causes, shared/voice/journal-entries.ts) the reply was shown but not read.
 */
import type { ReadingCancelBy } from '../../shared/voice';

export interface HandoverFacts {
  /** The utterance was answered in full (every sentence reached her); a partial one keeps its text but not a reading. */
  status: 'complete' | 'partial';
  /** The session's verdict at the reply's end: no newer line of yours arrived while it was written (electron/voice/voice-conversation-session.ts). */
  allowSpeech: boolean;
  /** Her mood reading of the reply (the voice's tone comes from it); null when there was none. */
  mood: unknown;
  /** The reply the settlement chose for the appraisal (null: the group has one reply); the voice reads that one only. */
  appraisalReplyId: string | null;
  replyId: string;
  text: string;
}

export function handoverVerdict(facts: HandoverFacts): 'hand' | ReadingCancelBy | null {
  if (!facts.text.trim()) return null;
  if (facts.status !== 'complete') return 'not-complete';
  if (!facts.allowSpeech) return 'newer-line';
  if (!facts.mood) return 'no-appraisal';
  if (facts.appraisalReplyId !== null && facts.replyId !== facts.appraisalReplyId) return 'superseded';
  return 'hand';
}
