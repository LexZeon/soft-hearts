import type { VoiceCaptureBinding } from './voice-segments';
import type { ChatMessage } from '../foundation/chat';
import type { SpeechBeatsEvent } from '../brain';
/** 'no-sound' (2026-11-06): the window found its microphone delivering only silence; the host journals it and changes nothing else. */
export type VoiceInputSignal = 'speech-start' | 'endpoint' | 'finish-speaking' | 'cancel' | 'no-sound' | 'pause-stuck';

/**
 * How a settled voice utterance appears in chat history: one user message with
 * the whole utterance, then each reply that showed text (a reply stopped to
 * merge an addition included). The renderer builds exactly this as events
 * arrive (src/brain/reply-history.ts appendVoiceReply); the host gives the same
 * shape to the Claude session, which received the utterance sentence by
 * sentence, so the next message still lines up with the warm process.
 */
export function voiceUtteranceMessages(userText: string, replies: readonly string[]): ChatMessage[] {
  return [{ role: 'user', content: userText },
    ...replies.filter(reply => reply.trim()).map(reply => ({ role: 'assistant' as const, content: reply }))];
}
/**
 * request: the first sentence was sent; queued: an addition waits for the next
 * reply; merging (R33): the reply being generated is being stopped so the
 * addition can be merged in; merged: a reply that answers the merged addition
 * is being generated; continuation: an explicit follow-up after a finished reply.
 */
export type VoiceContinuationState = 'queued' | 'request' | 'continuation' | 'merging' | 'merged' | 'unconfirmed' | 'settled' | 'partial';
export type VoiceConversationPayload =
  | { type: 'row'; groupId: string; seq: number; text: string }
  | { type: 'start'; groupId: string; replyId: string }
  | { type: 'delta'; groupId: string; replyId: string; text: string }
  /**
   * superseded: stopped on purpose to merge the user's addition; what was shown stays, nothing is read aloud. dropped (I-197, a call): the
   * user added a line before her voice started; nothing of this reply was heard, so it is not kept on screen either (nor archived).
   */
  | { type: 'terminal'; groupId: string; replyId: string; complete: boolean; superseded?: boolean; dropped?: boolean }
  | { type: 'speech'; groupId: string; replyId: string; text: string }
  /** 边说边演 in a call: beats that fall before the words just shown, and at the end the reply's final (electron/voice/voice-call/beats.ts). Played when her reading reaches them. */
  | { type: 'beats'; groupId: string; replyId: string; speechBeats: SpeechBeatsEvent }
  | { type: 'cancelled'; groupId: string; replyId: string | null }
  | { type: 'draft'; groupId: string | null; text: string }
  | { type: 'revoked' }
  /** Speech was heard but no words came out (the capture stays open); the owner window says so in her words. */
  | { type: 'unheard'; failure: 'empty' }
  /** I-177 batch 2: a recognized clip was held (a filler, a fragment, her echo; never the words): the owner window lets her voice come back up. */
  | { type: 'held' }
  /** `failure`: why recognition failed, by closed category; every window says it in her words. */
  | { type: 'fault'; message?: string; failure?: import('./speech-failure').VoiceInputFailure }
  | { type: 'continuation'; groupId: string; replyId: string; state: VoiceContinuationState }
;
export type VoiceConversationEvent = { epoch: string; owner: 'controls' | 'pet' } & VoiceConversationPayload;
export type VoiceCaptureSession = VoiceCaptureBinding;
