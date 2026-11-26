/**
 * Unbound v1 step 3 (docs/claude/2026-11-17-unbound-step3.md): her spoken replies (a voice call, or voice input) come to the windows as
 * `desk:voice-conversation` events, not as `desk:stream` chat events, so her Unbound bubble never saw them. This turns the few events
 * that show her reply into the bubble's own stream events (the same `{ id, kind, type, text }` electron/unbound/host.ts stream takes):
 * the visible text she has written (already through the reply filter: the voice host hands over exactly what it shows), its end, and
 * its retraction. Everything else (the user's own words, drafts, faults) is not hers and goes nowhere near the bubble.
 */
import type { SpeechBeatsEvent } from '../../shared/brain';

export interface BubbleStreamEvent { id: string; kind: 'chat'; type: 'delta' | 'done' | 'error' | 'beats'; text: string; speechBeats?: SpeechBeatsEvent }

const ID = /^[A-Za-z0-9_-]{1,100}$/;

export function voiceReplyBubbleEvent(channel: string, value: unknown): BubbleStreamEvent | null {
  if (channel !== 'desk:voice-conversation' || !value || typeof value !== 'object') return null;
  const event = value as { type?: unknown; replyId?: unknown; text?: unknown; complete?: unknown; superseded?: unknown };
  if (typeof event.replyId !== 'string' || !ID.test(event.replyId)) return null;
  const id = event.replyId;
  if (event.type === 'delta') return typeof event.text === 'string' && event.text ? { id, kind: 'chat', type: 'delta', text: event.text } : null;
  // A reply stopped to merge the user's addition keeps what it showed (as on the companion); one that failed leaves the screen.
  if (event.type === 'terminal') return { id, kind: 'chat', type: event.complete === true || event.superseded === true ? 'done' : 'error', text: '' };
  if (event.type === 'cancelled') return { id, kind: 'chat', type: 'error', text: '' };
  // 边说边演 in a call: her beats go to her as they are (no text); the host's stream() sends them on without a read-aloud revision.
  if (event.type === 'beats') { const speechBeats = (event as { speechBeats?: unknown }).speechBeats; return speechBeats && typeof speechBeats === 'object' ? { id, kind: 'chat', type: 'beats', text: '', speechBeats: speechBeats as SpeechBeatsEvent } : null; }
  return null;
}
