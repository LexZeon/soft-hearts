// Foundation (docs/claude/2026-11-15-overhaul-plan.md section 8, docs/claude/2026-11-16-overhaul-foundation.md): the companion window's reply bubble on the wire (written by chat, shown by the stage, read by the voice), moved out
// of shared/contracts.ts, which re-exports it.
// Types and fixed data only; it imports no part, so every part, the contract (shared/contracts.ts) and the wiring may use it.

export interface PetReplyAnchor { x: number; y: number; visible: boolean; radius?: number; }
export interface PetReplyUpdate {
  text?: string;
  state?: 'waiting' | 'streaming' | 'complete' | 'hidden';
  anchor?: PetReplyAnchor;
  /** Visual interaction fade only; never renews or pauses the reply lifetime. */
  interactionOpacity?: number;
  /** Ordinary completed reply only; proactive and ambient presentation keep their original mode. */
  segmented?: boolean;
  /** Ordinary chat only, sent with `text`: display-only layout of that exact text (R27). */
  pieces?: PetReplyPieces;
}
/** End offsets into the reply text (last = text.length). 'paragraphs' keeps one bubble; 'bubbles' gives each piece its own. */
export interface PetReplyPieces { mode: 'paragraphs' | 'bubbles'; ends: number[] }
