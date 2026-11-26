/**
 * I-209 step 3: what the chat turn reads about whose turn it is, in one place (the chat handler names only `stageTurn`): who (the one you
 * clicked on stage, else the desktop companion), her card's persona, and whether the history handed to Claude is her own archive's.
 */
import { compileCharacterPersona } from '../../../shared/cards';
import { turnOwnerFor } from '../handed-line-gate';
import { ownHistory, ownerSettings } from './persona';

type Card = Parameters<typeof compileCharacterPersona>[0];

export const stageTurn = Object.freeze({
  /** Whose turn: the one whose box the line came from (or, without a number, the one you clicked last); else `current`. */
  owner: (line: number | undefined, current: string | undefined): string | undefined => turnOwnerFor(line) ?? current,
  /** The settings copy with her own card's persona when the turn is someone else's (throws when her card cannot be read). */
  settings: <T extends { persona: string }>(settings: T, owner: string | undefined, current: string | undefined, card: (id: string) => Card): T =>
    ownerSettings(settings, owner, current, id => compileCharacterPersona(card(id))),
  /** Whether the history comes from her own archive (with others on stage, or her turn), else the control window's list as before. */
  ownHistory: (longChat: boolean, owner: string | undefined, current: string | undefined, onStage: (() => readonly string[]) | undefined): boolean => {
    let others = 0;
    try { others = onStage?.().length ?? 0; } catch { others = 0; }
    return ownHistory(longChat, owner, current, others);
  },
});
