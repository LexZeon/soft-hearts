// I-208 step 3: a card's object and her margin notes as lines of the archive (docs/claude/2026-11-24-i208-archive-step3.md). Pure: the official entries come from the card
// (fixed), her own pages and her notes from her relationship file (hers, per character). The book reads in page order: the official entries and the pages she added
// herself together (hers tagged 'own', with the day she wrote it), each page's notes right under it (newest first); notes that name no page come first. The page number
// is in `title` ('' for a note without one); the ids of hers and her notes name them for the page's edit and delete. The entry's source and the words "margin note" /
// "批注" are search words only (not shown here: the window has its own).
import type { CardObject } from '../../../shared/foundation/character-card';
import type { ObjectNote } from '../../../shared/memory/relationship';
import type { RawArchiveItem } from './search';

export function objectArchiveItems(object: CardObject | undefined, notes: readonly ObjectNote[]): RawArchiveItem[] {
  if (!object) return [];
  // Sorted newest first by `sort`: page p's entry is at -10p and its notes just below it; a note naming no page is above everything.
  const entries = object.entries.map<RawArchiveItem>(entry => ({
    id: `object-entry:${entry.page}`, date: '', title: String(entry.page), text: entry.text, tag: 'entry', sort: -10 * entry.page,
    words: `${object.name} ${entry.source ?? ''} 第${entry.page}页 page ${entry.page}` }));
  const hers = notes.filter(note => note.own && note.page !== null).map<RawArchiveItem>(note => ({
    id: `object-note:${note.id}`, date: note.date, title: String(note.page), text: note.text, tag: 'own', sort: -10 * note.page!,
    words: `她添的 added by her 第${note.page}页 page ${note.page}` }));
  const seen = new Map<number | null, number>();
  const margin = [...notes.keys()].filter(index => !notes[index]!.own).reverse().map<RawArchiveItem>(index => { // newest first within a page
    const note = notes[index]!, rank = (seen.get(note.page) ?? 0) + 1;
    seen.set(note.page, rank);
    return { id: `object-note:${note.id}`, date: note.date, title: note.page === null ? '' : String(note.page), text: note.text, tag: 'note',
      sort: note.page === null ? Number.MAX_SAFE_INTEGER - rank : -10 * note.page - rank,
      words: `批注 margin note ${note.page === null ? '' : `第${note.page}页 page ${note.page}`}` };
  });
  return [...margin, ...hers, ...entries];
}
