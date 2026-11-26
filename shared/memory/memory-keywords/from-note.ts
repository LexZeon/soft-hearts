// I-049 step 1, old notes: the people, things and tags a chat note already has become keywords locally, with no model call.
// People weigh the most, tags the least. The note's own format is not touched.

import type { MemoryNoteBody } from '../memory-notes/interface';
import { MEMORY_KEYWORDS_KNOBS, type MemoryKeywordsKnobs } from './knobs';
import { mergeKeywords, usableName, type Keyword } from './keyword';

export function keywordsFromNote(note: Pick<MemoryNoteBody, 'people' | 'things' | 'tags'>, knobs: MemoryKeywordsKnobs = MEMORY_KEYWORDS_KNOBS): Keyword[] {
  const out: Keyword[] = [];
  const add = (names: readonly string[], kind: Keyword['kind'], weight: number) => {
    for (const name of names ?? []) {
      const term = usableName(name, knobs.write.termChars);
      if (term) out.push({ term, kind, weight, aliases: [] });
    }
  };
  add(note.people, 'person', knobs.write.fromPerson);
  add(note.things, 'object', knobs.write.fromThing);
  add(note.tags, 'topic', knobs.write.fromTag);
  return mergeKeywords(out, knobs);
}
