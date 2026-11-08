// I-049 step 2: the texts a keyword match shows, found by the id the keyword record is filed under. Listen notes are read from the
// listen core (memory); watch notes (descriptions and summaries) are held here per character, loaded once from disk and added as
// they are written. A local read: nothing is awaited on a turn. Gone notes (deleted, forgotten) find nothing.

import type { RecallTextPort } from '../memory-keywords/recall';
import { watchNoteKeywordId, type WatchNote, type WatchNotesStore } from './store';

export class RecallTexts implements RecallTextPort {
  private readonly watch = new Map<string, Map<string, string>>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(
    private readonly listen: { readNote(id: string): { gist: string; points: readonly string[]; characterId: string } | null },
    private readonly notes: Pick<WatchNotesStore, 'list'>,
  ) {}

  /** The character's watch notes are loaded (once). Never throws. */
  ensure(characterId: string | null): Promise<void> {
    if (!characterId || this.watch.has(characterId)) return Promise.resolve();
    let pending = this.loading.get(characterId);
    if (!pending) {
      pending = this.notes.list(characterId).then(list => {
        const map = this.watch.get(characterId) ?? new Map<string, string>();
        for (const note of list) if (!map.has(watchNoteKeywordId(note.id))) map.set(watchNoteKeywordId(note.id), note.text);
        this.watch.set(characterId, map);
      }, () => undefined).finally(() => this.loading.delete(characterId));
      this.loading.set(characterId, pending);
    }
    return pending;
  }

  added(characterId: string, note: Pick<WatchNote, 'id' | 'text'>): void {
    let map = this.watch.get(characterId);
    if (!map) { map = new Map(); this.watch.set(characterId, map); }
    map.set(watchNoteKeywordId(note.id), note.text);
  }
  /** Moves whenever watch notes were forgotten: a turn composed earlier asks `still` before it goes out. */
  epoch = 0;
  forget(characterId: string): void { this.watch.delete(characterId); this.epoch++; }

  text(characterId: string, noteId: string, source: 'listen' | 'watch'): string | null {
    if (source === 'watch') return this.watch.get(characterId)?.get(noteId) ?? null;
    const note = this.listen.readNote(noteId);
    return note && note.characterId === characterId ? [note.gist, ...note.points].filter(Boolean).join('；') : null;
  }
}
