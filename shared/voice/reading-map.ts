// I-164 reading map: applying a character's { shown text -> spoken text } entries (shared/foundation/character-voice-reading.ts) to the text that
// goes to a voice. docs/claude/2026-11-20-reading-map.md. Pure. It is the LAST step before a voice engine, after speakableText (stage directions are
// already gone) and after every check that matched the text against what the bubble shows: the bubble, the chat record, the memory and the
// journal never see the spoken form, and the segments, speech beats and reading progress (which count shown characters) are unchanged.
// Two ends use it: the host for cloud voices (electron/voice/speech-runtime.ts), the window for the system voice (src/voice/speech.ts).
// A character without entries gets the very same string back (identity), so nothing changes for her.
import { isSingleLetter, type ReadingEntry } from '../foundation/character-voice-reading';
import type { TtsProvider } from '../foundation/tts-config';

const keyOf = (entry: ReadingEntry): string => entry.from.toLowerCase();

/**
 * The entries this provider uses: its own, and the ones for every provider unless it has its own entry for the same text (each provider reads
 * differently, so a provider's own wording wins). Entries of another provider are never used.
 */
export function readingFor(entries: readonly ReadingEntry[] | undefined, provider: TtsProvider): ReadingEntry[] {
  if (!entries?.length) return [];
  const own = entries.filter(entry => entry.provider === provider), taken = new Set(own.map(keyOf));
  return [...entries.filter(entry => !entry.provider && !taken.has(keyOf(entry))), ...own];
}

/** One replacement: where it stood in the text before (`from`) and where it stands in the text after (`to`). Half-open ranges of UTF-16 offsets. */
export interface ReadingEdit { fromStart: number; fromEnd: number; toStart: number; toEnd: number }
export interface ReadingApplied { text: string; edits: ReadingEdit[] }

const WORD = /[\p{L}\p{N}]/u;
const LATIN = /[A-Za-z0-9À-ɏ]/u;
const before = (text: string, at: number): string => Array.from(text.slice(Math.max(0, at - 2), at)).at(-1) ?? '';
const after = (text: string, at: number): string => Array.from(text.slice(at, at + 2))[0] ?? '';

/**
 * An entry written with a capital letter is a name ("One"): it matches only that exact case, so the English word "one" ("no one", "one more")
 * is read as written. An entry written all in lower case ("huh?") matches any case.
 */
const exactCase = (from: string): boolean => /\p{Lu}/u.test(from);

/** Marks that may stand between a sentence's end and its first word: spaces and opening quotes or brackets. */
const OPENERS = /[\s"'“‘«「『(（\[]/u;
/** What ends a sentence (or a line) before a capitalized word. */
const SENTENCE_END = /[.!?。！？…\n]/u;
/** Whether `at` begins a sentence: only spaces and opening marks between it and the text's start or a sentence end. */
function sentenceStart(text: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const ch = text[i];
    if (SENTENCE_END.test(ch)) return true;
    if (!OPENERS.test(ch)) return false;
  }
  return true;
}
/**
 * A capitalized Latin name at a sentence's start is only her name when no English word follows it ("One." "One," "One说" are her;
 * "One more thing" is the number): at a sentence's start English capitalizes every word (approving "她的名字在句首，
 * 只有后面紧跟标点时才按名字念").
 */
function numberAtSentenceStart(text: string, at: number, end: number, from: string): boolean {
  if (!exactCase(from) || !LATIN.test(from[0] ?? '') || !sentenceStart(text, at)) return false;
  let i = end;
  if (!/\s/u.test(text[i] ?? '')) return false;
  while (i < text.length && /\s/u.test(text[i])) i++;
  return LATIN.test(text[i] ?? '');
}

/** Whether `entry` matches at `at` (case per exactCase; a Latin edge needs a non-Latin neighbour; a tic needs no letter beside it). */
function matches(text: string, at: number, entry: ReadingEntry, alone: boolean): boolean {
  const end = at + entry.from.length;
  if (end > text.length) return false;
  const shown = text.slice(at, end);
  if (exactCase(entry.from) ? shown !== entry.from : shown.toLowerCase() !== entry.from.toLowerCase()) return false;
  if (numberAtSentenceStart(text, at, end, entry.from)) return false;
  const first = entry.from[0] ?? '', last = Array.from(entry.from).at(-1) ?? '';
  const prev = before(text, at), next = after(text, end);
  // An edge that is itself a mark ("切……", "huh?") needs no check on that side: the mark already ends the word.
  if (WORD.test(first) && prev && (alone ? WORD.test(prev) : LATIN.test(first) && LATIN.test(prev))) return false;
  if (WORD.test(last) && next && (alone ? WORD.test(next) : LATIN.test(last) && LATIN.test(next))) return false;
  return true;
}

/** The text as the voice reads it, with the replacements made (left to right, the longest shown text first) and where each one stands. */
export function applyReadingMapped(text: string, entries: readonly ReadingEntry[] | undefined): ReadingApplied {
  if (!entries?.length || !text) return { text, edits: [] };
  const ordered = [...entries].sort((a, b) => b.from.length - a.from.length)
    .map(entry => ({ entry, alone: entry.alone === true || isSingleLetter(entry.from) }));
  let out = '';
  const edits: ReadingEdit[] = [];
  let at = 0;
  while (at < text.length) {
    const hit = ordered.find(item => matches(text, at, item.entry, item.alone));
    if (!hit) { out += text[at]; at += 1; continue; }
    edits.push({ fromStart: at, fromEnd: at + hit.entry.from.length, toStart: out.length, toEnd: out.length + hit.entry.to.length });
    out += hit.entry.to; at += hit.entry.from.length;
  }
  return edits.length ? { text: out, edits } : { text, edits: [] };
}

/** Just the spoken text. No entries (or none that match) returns `text` itself, byte for byte. */
export function applyReading(text: string, entries: readonly ReadingEntry[] | undefined): string {
  return applyReadingMapped(text, entries).text;
}

/** The text a 试听 reads to let her hear the map: the shown texts of the entries one after another, each as its own sentence (so a tic stands alone). */
export function readingSample(entries: readonly ReadingEntry[] | undefined, limit = 6): string {
  const seen = new Set<string>(), texts: string[] = [];
  for (const entry of entries ?? []) {
    const key = entry.from.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); texts.push(entry.from);
    if (texts.length >= limit) break;
  }
  return texts.length ? `${texts.join('。')}。` : '';
}

/** An offset in the spoken text mapped back to the text before the replacements: inside a replacement it is where that replacement began. */
export function spokenToShownOffset(edits: readonly ReadingEdit[], offset: number): number {
  let shift = 0;
  for (const edit of edits) {
    if (offset < edit.toStart) break;
    if (offset < edit.toEnd) return edit.fromStart;
    shift += (edit.toEnd - edit.toStart) - (edit.fromEnd - edit.fromStart);
  }
  return offset - shift;
}

/** An offset in the text before the replacements mapped forward to the spoken text: inside a replaced piece it is where its spoken form began. */
export function shownToSpokenOffset(edits: readonly ReadingEdit[], offset: number): number {
  let shift = 0;
  for (const edit of edits) {
    if (offset < edit.fromStart) break;
    if (offset < edit.fromEnd) return edit.toStart;
    shift += (edit.toEnd - edit.toStart) - (edit.fromEnd - edit.fromStart);
  }
  return offset + shift;
}
