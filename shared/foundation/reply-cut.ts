/**
 * The cut record (2026-11-24 about a kiss or hug cut short by a big pull or a face that cannot reach:
 * "直接算打断怎么样，角色知道打断，也知道原因，自己反应"). One small typed record per interrupted reply, whatever interrupted it:
 *   - where: offsets into the reply's archived text (the whole reply is archived once, read or not);
 *   - cause: a closed word;
 *   - what she had said and what she still meant to say follow from the offsets and the reply text (no words are stored here).
 * The record is metadata about the reply, never part of her words: not read aloud, not counted as said. It leaves and comes back with the
 * reply (electron/brain/speech-beats/archive.ts keeps it beside the beats). The facts for her next turn (shared/voice/call-cut-note.ts) and
 * the quiet marker the chat window and her history show at the cut point are made from it here. Pure; types and small functions only.
 */
import type { CardLanguage } from './character-card';

/** Why her words stopped. Closed words; the frames task (kiss / hug) adds nothing here, it uses `pulled-away` and `could-not-reach`. */
export const CUT_CAUSES = ['user-spoke', 'pulled-away', 'could-not-reach', 'other'] as const;
export type CutCause = (typeof CUT_CAUSES)[number];
export const isCutCause = (value: unknown): value is CutCause => typeof value === 'string' && (CUT_CAUSES as readonly string[]).includes(value);

export interface CutRecord {
  cause: CutCause;
  /** Her voice or her words were placed: false when where she stopped was not reported (then the marker sits at the end of the reply). */
  known: boolean;
  /** reply[0, saidEnd) was said in full. */
  saidEnd: number;
  /** reply[saidEnd, sentenceEnd) is the sentence being said when she stopped (empty: she stopped between two sentences). */
  sentenceEnd: number;
}

const MAX_OFFSET = 1_000_000;
const offset = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_OFFSET ? value : null;

/** A stored or received record as it may be kept (null when it is not one). Extra fields are dropped: nothing but the four values stays. */
export function cleanCut(value: unknown): CutRecord | null {
  const v = value as Partial<CutRecord> | null;
  if (!v || typeof v !== 'object' || !isCutCause(v.cause)) return null;
  const saidEnd = offset(v.saidEnd), sentenceEnd = offset(v.sentenceEnd);
  if (saidEnd === null || sentenceEnd === null || sentenceEnd < saidEnd) return null;
  return { cause: v.cause, known: v.known === true, saidEnd, sentenceEnd };
}

/** The same record with its offsets moved by `base` (a leg's text sits after what the reply already held), clamped to `length` when given. */
export function shiftCut(cut: CutRecord, base: number, length?: number): CutRecord {
  const at = (value: number) => Math.max(0, Math.min(length ?? MAX_OFFSET, value + Math.max(0, Math.floor(base) || 0)));
  const saidEnd = at(cut.saidEnd);
  return { cause: cut.cause, known: cut.known, saidEnd, sentenceEnd: Math.max(saidEnd, at(cut.sentenceEnd)) };
}

/** Where the marker sits in a reply of `length` characters, and whether she stopped inside a sentence. */
export function cutPlace(cut: CutRecord, length: number): { at: number; inSentence: boolean } {
  const size = Math.max(0, Math.floor(length) || 0);
  if (!cut.known) return { at: size, inSentence: false };
  const inSentence = cut.sentenceEnd > cut.saidEnd;
  return { at: Math.min(size, inSentence ? cut.sentenceEnd : cut.saidEnd), inSentence };
}

const MARKERS = {
  'zh-CN': { // ui-zh-ok: the quiet marker in the chat window and in her history
    'user-spoke': ['念到这里被打断', '念到这一句时被打断', '被打断了，念到哪里没有记录'], // ui-zh-ok: marker words
    'pulled-away': ['被拉开了，话停在这里', '被拉开时正说着这一句', '被拉开了，说到哪里没有记录'], // ui-zh-ok: marker words
    'could-not-reach': ['够不到，话停在这里', '够不到，当时正说着这一句', '够不到，说到哪里没有记录'], // ui-zh-ok: marker words
    other: ['话在这里被打断了', '话在这一句被打断了', '话被打断了，说到哪里没有记录'], // ui-zh-ok: marker words
  },
  en: {
    'user-spoke': ['interrupted here while reading aloud', 'interrupted while reading this sentence aloud', 'interrupted; where the reading stopped was not recorded'],
    'pulled-away': ['pulled away; the words stop here', 'pulled away while saying this sentence', 'pulled away; where the words stopped was not recorded'],
    'could-not-reach': ['could not reach; the words stop here', 'could not reach while saying this sentence', 'could not reach; where the words stopped was not recorded'],
    other: ['cut short here', 'cut short in this sentence', 'cut short; where was not recorded'],
  },
} as const;

/** The quiet marker's words, in her chat's language. Fixed words only: never any of her or the user's text. */
export function cutMarkerText(cut: CutRecord, language: CardLanguage | null | undefined): string {
  const words = (language === 'en' ? MARKERS.en : MARKERS['zh-CN'])[cut.cause];
  const text = !cut.known ? words[2] : cut.sentenceEnd > cut.saidEnd ? words[1] : words[0];
  return language === 'en' ? `(${text})` : `（${text}）`; // ui-zh-ok: the marker's brackets
}

/**
 * Her reply with the marker on its own line at the cut point: how her history reads it, so later turns know which part was heard. The
 * reply's own text is unchanged (the archive keeps it whole); nothing is inserted into an empty reply.
 */
export function withCutMarker(text: string, cut: CutRecord, language: CardLanguage | null | undefined): string {
  if (typeof text !== 'string' || !text.trim()) return typeof text === 'string' ? text : '';
  const { at } = cutPlace(cut, text.length);
  const before = text.slice(0, at).replace(/\s+$/u, ''), after = text.slice(at).replace(/^\s+/u, '');
  return [before, cutMarkerText(cut, language), after].filter(part => part).join('\n');
}
