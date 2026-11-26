// I-164 reading map: part of a character's voice. What she shows can differ from what the voice reads: a name that must
// be read one way (オネ, never English "one"), a tic ("切", "啧", "huh?") that a voice would read letter by letter. Each entry is
// { shown text -> spoken text }, optionally for one provider only because each provider reads differently. docs/claude/2026-11-20-reading-map.md.
// Foundation: pure data rules, no imports but types. Applying the map to text is shared/voice/reading-map.ts; only the text sent to the voice
// changes, never the bubble, the chat record, the memory or the journal.
import type { TtsProvider } from './tts-config';

export interface ReadingEntry {
  /** The text as shown (matched as written; Latin letters ignore case and need a word edge). */
  from: string;
  /** What the voice reads instead. Never empty (a silent entry is not a reading). */
  to: string;
  /** Only for this provider; absent = every provider that has no entry of its own for the same text. */
  provider?: TtsProvider;
  /** A tic: read as mapped only when it stands alone (between marks or at an edge), not inside a longer word ("关切" stays). A single character is always alone. */
  alone?: true;
}

export const READING_FROM_MAX = 40;
export const READING_TO_MAX = 80;
export const READING_ENTRIES_MAX = 24;
const PROVIDERS: readonly TtsProvider[] = ['system', 'bailian', 'fish'];
const CONTROL = /[\u0000-\u001f\u007f]+/gu;
// Drama 3 reads brackets as directions; a spoken form never carries one.
const BRACKETS = /[\[\]<>{}]/gu;
const KEY_LIKE = /\b(?:sk|ak|pk|key|token|bearer)[-_ ]?[A-Za-z0-9_-]{12,}|\b[A-Za-z0-9_-]{32,}\b/iu;
const PATH_LIKE = /(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?:Users|home|var|etc|tmp|mnt|opt)\/)/u;
const LINK_LIKE = /\b(?:https?|file|mmd-asset):\/\//iu;

const clip = (text: string, max: number): string => Array.from(text).slice(0, max).join('').trim();
const tidy = (value: unknown, max: number, brackets: boolean): string =>
  typeof value === 'string' ? clip((brackets ? value.replace(BRACKETS, '') : value).replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim(), max) : '';

/** A single letter, digit or CJK character (after marks are ignored): such a text only counts when it stands alone. */
export function isSingleLetter(text: string): boolean { return Array.from(text.replace(/[^\p{L}\p{N}]/gu, '')).length === 1; }

/** One stored or imported entry made safe; undefined when it is not one. */
export function normalizeReadingEntry(value: unknown): ReadingEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const from = tidy(input.from, READING_FROM_MAX, false), to = tidy(input.to, READING_TO_MAX, true);
  // A shown text with no letter or digit ("，", "……") would change every sentence; an entry that changes nothing is not one.
  if (!from || !to || from === to || !/[\p{L}\p{N}]/u.test(from)) return undefined;
  const provider = PROVIDERS.find(item => item === input.provider);
  return { from, to, ...(provider ? { provider } : {}), ...(input.alone === true ? { alone: true as const } : {}) };
}

/** A stored or imported list made safe, never throwing: unusable entries are left out, the same text for the same provider keeps the first, at most 24 stay. */
export function normalizeReadingEntries(value: unknown): ReadingEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(), out: ReadingEntry[] = [];
  for (const item of value) {
    const entry = normalizeReadingEntry(item);
    if (!entry) continue;
    const key = `${entry.provider ?? ''}\u0000${entry.from.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(entry);
    if (out.length >= READING_ENTRIES_MAX) break;
  }
  return out;
}

/** What a card export carries: the normalized entries, minus any that hold a key, a path or a link (such an entry is dropped whole, not cut). */
export function portableReadingEntries(value: unknown): ReadingEntry[] {
  return normalizeReadingEntries(value).filter(entry => ![entry.from, entry.to].some(text => LINK_LIKE.test(text) || PATH_LIKE.test(text) || KEY_LIKE.test(text)));
}
