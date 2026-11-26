// One chunk of a streamed chat or task reply, host to window (moved here from shared/contracts.ts, which re-exports it;
// wiring rewrite step 2, docs/claude/2026-11-16-wiring-steps-0-2.md). Types only.
import type { ChatOutageNotice } from './chat-availability';
import type { SpeechBeatsEvent } from '../behaviors/speech-beats/interface';

export interface StreamEvent {
  id: string;
  kind: "chat" | "agent";
  /** 'beats' (边说边演, docs/claude/2026-11-20-speech-beats-2-4.md): her beats for this reply, in `speechBeats`; `text` is empty. */
  type: "delta" | "status" | "done" | "error" | "beats";
  text: string;
  /** On a chat `error` that is Claude being unavailable (shared/brain/chat-availability.ts): what she says instead of a technical error. */
  outage?: ChatOutageNotice;
  /** On a chat `beats` event only. */
  speechBeats?: SpeechBeatsEvent;
}
