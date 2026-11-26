// I-088 item 2: recall by any of an entry's names. When the user's message names one of the names of an entry, the notes of that
// entry that do not themselves write that name are counted like a person name (knobs.recall.person) by electron/memory/memory-notes/core.ts.
// A note that writes the name itself is matched by its own terms as before. Nothing is added to the turn's text. Pure.

import { VAGUE_TERMS } from '../memory-notes/recall';
import type { PeopleThingsEntry } from './gather';

const LATIN = /^[\p{Script=Latin}\p{N}]+$/u;
/** The same rule as a note's own terms (shared/memory/memory-notes/recall.ts prepareNote): not a vague word, two characters or three Latin letters. */
export const usableName = (key: string): boolean => !!key && !VAGUE_TERMS.has(key) && (LATIN.test(key) ? key.length >= 3 : Array.from(key).length >= 2);

export interface AliasIndex {
  /** One row per usable name: its matching form, how it was written, the notes that write it, and every note of its entry. */
  readonly rows: readonly { readonly key: string; readonly text: string; readonly own: ReadonlySet<string>; readonly all: readonly string[] }[];
}

export function buildAliasIndex(entries: readonly PeopleThingsEntry[]): AliasIndex {
  const rows: { key: string; text: string; own: ReadonlySet<string>; all: readonly string[] }[] = [];
  for (const entry of entries) {
    if (entry.names.length < 2) continue; // one name only: the notes' own terms already cover it
    for (const name of entry.names) if (usableName(name.key)) rows.push({ key: name.key, text: name.text, own: new Set(name.notes), all: entry.notes });
  }
  return { rows };
}

/** Record id → the names of its entry the message used that this note does not itself write. Empty when nothing matches. */
export function aliasMatches(squashedMessage: string, index: AliasIndex): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!squashedMessage) return out;
  for (const row of index.rows) {
    if (!squashedMessage.includes(row.key)) continue;
    for (const id of row.all) {
      if (row.own.has(id)) continue;
      const list = out.get(id);
      if (!list) out.set(id, [row.text]); else if (!list.includes(row.text)) list.push(row.text);
    }
  }
  return out;
}
