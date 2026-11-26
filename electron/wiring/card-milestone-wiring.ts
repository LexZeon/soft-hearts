// I-207 a card's milestone (docs/claude/2026-11-23-card-milestone.md, shared/cards/card-milestone.ts): the chat turn's one information line, her hidden marker
// read once her reply is done, and the user's page (read it, clear it after its own confirm; clearing goes into the recycle bin first). The functions take
// their ports as arguments so a test drives them without Electron; the live end is card-milestone-call-wiring.ts. No module-level side effects.
// The state is a date in the character's relationship file (electron/memory/relationship/); the words are on the card. A card without a milestone gets
// '' / false / null from every function here: not a byte in her prompt, nothing read, nothing written.
import { cardLanguageOf, cardMilestoneView, isMilestoneMarker, milestoneLine, type CardMilestoneRequest, type CardMilestoneView } from '../../shared/cards';
import type { CardMilestone } from '../../shared/foundation/character-card';

/** What this needs of a card (the active one). */
export interface MilestoneCard { readonly id: string; readonly milestone?: CardMilestone; readonly language?: unknown }
/** What this needs of the relationship host. */
export interface MilestoneRelationship {
  ensureCardMilestone(characterId: string): Promise<string | null>;
  reachCardMilestone(characterId: string): Promise<boolean>;
  clearCardMilestone(characterId: string): Promise<string | null>;
}

/** The chat turn's line ('' for a card without a milestone, and when the file cannot be read: her chat never waits on this). */
export async function milestoneTurnLine(card: MilestoneCard, relationship: MilestoneRelationship): Promise<string> {
  if (!card.milestone) return '';
  try { return milestoneLine(card.milestone, await relationship.ensureCardMilestone(card.id), cardLanguageOf(card)); } catch { return ''; }
}

/** Her finished reply's marker bodies (the filter already took them out of her text). True when this reply is the one that recorded it. */
export async function milestoneReplyDone(card: MilestoneCard, relationship: MilestoneRelationship, markers: readonly string[] | undefined): Promise<boolean> {
  if (!card.milestone || !markers?.some(isMilestoneMarker)) return false;
  try { return await relationship.reachCardMilestone(card.id); } catch { return false; }
}

/** The page's clear (reading moved to the archive's read-only call, I-208). Null view: the card declares none. Clear takes the date into the bin first (`recycled`), and answers with the view after. */
export async function cardMilestoneRequest(request: CardMilestoneRequest, card: MilestoneCard, relationship: MilestoneRelationship,
  recycled: (take: () => Promise<unknown>, remove: () => Promise<unknown>) => Promise<unknown>, take: () => Promise<unknown>): Promise<CardMilestoneView | null> {
  if (!card.milestone || request.action !== 'milestone-clear') return null;
  await recycled(take, () => relationship.clearCardMilestone(card.id));
  return cardMilestoneView(card.milestone, await relationship.ensureCardMilestone(card.id));
}
