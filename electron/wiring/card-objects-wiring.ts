// I-208 step 3 a card's object and her margin notes (docs/claude/2026-11-24-i208-archive-step3.md, shared/cards/card-objects.ts): the chat turn's one information line
// plus the few entries and notes her words touch, her hidden `⟪note|…⟫` markers read once her reply is done, and the archive page's two writes (edit a note, delete
// one after its own confirm; a delete goes into the recycle bin first). The functions take their ports as arguments so a test drives them without Electron; the live
// end is card-objects-call-wiring.ts. No module-level side effects.
// The notes live in the character's own relationship file (electron/memory/relationship/), keyed by the character id: another character never reads them. A card
// without an object gets '' / 0 / null from every function here: not a byte in her prompt, nothing read, nothing written.
import { cardLanguageOf, objectFactLine, objectMaterial, recallObject, type ObjectNoteRequest } from '../../shared/cards';
import type { CardObject } from '../../shared/foundation/character-card';
import type { ObjectNote } from '../../shared/memory/relationship';

/** What this needs of a card. */
export interface ObjectCard { readonly id: string; readonly object?: CardObject; readonly language?: unknown }
/** What this needs of the relationship host. */
export interface ObjectRelationship {
  objectNotes(characterId: string): Promise<ObjectNote[]>;
  addObjectNotes(characterId: string, markers: readonly (string | null)[], officialPages?: readonly number[]): Promise<number>;
  editObjectNote(characterId: string, id: string, text: string): Promise<boolean>;
  removeObjectNote(characterId: string, id: string): Promise<ObjectNote | null>;
}

/**
 * The chat turn's text for her object: one information line (that she has it and how a note is written), and below it the entries and notes the user's words
 * touch (at most a few of each). '' for a card without an object, and when her file cannot be read: her chat never waits on this.
 */
export async function objectTurnText(card: ObjectCard, relationship: ObjectRelationship, userText: unknown): Promise<string> {
  if (!card.object) return '';
  try {
    const notes = await relationship.objectNotes(card.id), language = cardLanguageOf(card);
    const material = typeof userText === 'string' && userText ? objectMaterial(card.object, recallObject(card.object, notes, userText), language) : '';
    const own = notes.filter(note => note.own).length;
    return [objectFactLine(card.object, notes.length - own, language, own), material].filter(Boolean).join('\n');
  } catch { return ''; }
}

/** Her finished reply's marker bodies (the filter already took them out of her text): how many notes this reply added. Other markers are not notes and are left alone. */
export async function objectReplyDone(card: ObjectCard, relationship: ObjectRelationship, markers: readonly string[] | undefined): Promise<number> {
  if (!card.object || !markers?.length) return 0;
  try { return await relationship.addObjectNotes(card.id, markers, card.object.entries.map(entry => entry.page)); } catch { return 0; }
}

/**
 * The page's edit and delete of one of her notes (the page confirmed a delete). `cardOf` finds the card the request names; a card without an object has no notes to
 * change. A delete takes the note into the bin first (`recycled`), then removes it. Answers whether something changed.
 */
export async function objectNoteRequest(request: ObjectNoteRequest, cardOf: (characterId: string) => ObjectCard | undefined, relationship: ObjectRelationship,
  recycled: (take: () => Promise<unknown>, remove: () => Promise<unknown>) => Promise<unknown>, take: (id: string) => Promise<unknown>): Promise<{ changed: boolean }> {
  if (!cardOf(request.characterId)?.object) return { changed: false };
  if (request.action === 'object-note-edit') return { changed: await relationship.editObjectNote(request.characterId, request.id, request.text) };
  const had = (await relationship.objectNotes(request.characterId)).some(note => note.id === request.id);
  if (!had) return { changed: false };
  await recycled(() => take(request.id), () => relationship.removeObjectNote(request.characterId, request.id));
  return { changed: true };
}
