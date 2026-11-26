// The paid prewarm step (docs/claude/2026-11-23-prewarm-paid.md): the host's side. What the opening is made of at the moment a spare comes up for
// 'start' or 'switch': the same parts a first turn would open with (persona, relationship lines, her note, her archive's window), read from
// the places the turn reads them, with no turn in them (no mood, no memories, no current message). Reading never changes anything: the
// relationship lines are asked as for a later turn (no milestone is used up), and nothing here asks Claude.
import type { ChatMessage } from '../../../shared/foundation/chat';
import type { OpeningMemory, RelaxedChat } from '../i139-chat';
import type { StartOpeningInput } from './start-warm';

export interface StartOpeningPorts {
  /** The character's persona as a turn's session is told it (basePersona). */
  persona(): string | null | undefined;
  /** The relationship lines of a session already opened (no first-turn milestone). */
  relationship(): string | null | undefined;
  note(): string | null | undefined;
  /** Her archive's window right now (the next turn's window before its own message). */
  window(): readonly ChatMessage[] | null | undefined;
  relaxed(): RelaxedChat | null | undefined;
  openingMemory(): OpeningMemory | undefined;
}

/** The opening's parts for the character on stage, or null when there is no persona (nothing to warm). */
export function startOpeningInput(ports: StartOpeningPorts): StartOpeningInput | null {
  const basePersona = ports.persona();
  if (!basePersona) return null;
  const relaxed = ports.relaxed();
  const memory = relaxed ? ports.openingMemory() : undefined;
  return { basePersona, openingContext: ports.relationship() || null, openingNote: ports.note() || null, history: ports.window() ?? [],
    ...(relaxed ? { relaxed, ...(memory ? { openingMemory: memory } : {}) } : {}) };
}
