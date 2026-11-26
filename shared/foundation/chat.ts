// Foundation (docs/claude/2026-11-15-overhaul-plan.md section 8, docs/claude/2026-11-16-overhaul-foundation.md): a chat message and what may be attached to it, moved out of shared/contracts.ts (ProactiveOrigin out of
// shared/brain/proactive-speech.ts); both re-export them.
// Types and fixed data only; it imports no part, so every part, the contract (shared/contracts.ts) and the wiring may use it.

/** `feed`: her line after the user fed her something she recognized (I-019, electron/senses/feed-recognition/). */
/** `greeting`: her card's greeting as the chat window showed it, archived only while I-134 new chat is on (electron/brain/long-chat/greeting.ts). */
export type ProactiveContentSource = 'screen' | 'camera' | 'ambient' | 'text' | 'inner' | 'feed' | 'greeting';

/** Metadata on an actual assistant message. Never manufacture a user message for it. */
export interface ProactiveOrigin {
  kind: 'proactive';
  id: string;
  at: number;
  sources: ProactiveContentSource[];
  /** Bounded display labels for the actual observations; no paths or provider identity. */
  labels: string[];
}
export interface Attachment {
  source: "screen" | "camera";
  dataUrl: string;
  /**
   * Set by the host on a frame it took from sharing for a message (electron/senses/look-attachments.ts); the window sends it back
   * unchanged. The host only trusts tickets it handed out itself. A snapshot the user attached by hand has none.
   */
  shareTicket?: string;
}
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  origin?: ProactiveOrigin;
}
