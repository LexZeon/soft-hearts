// I-208 step 3: a card's "object" (docs/claude/2026-11-24-i208-archive-step3.md): one thing she owns that has fixed entries (Gene: 《地球投递须知》, 32 pages of
// "facts" the quick-delivery station wrote from old TV signals). The card holds the name and the entries; they never change. What she adds herself or is
// corrected on is her margin notes: she writes one hidden closed marker `⟪note|12|…⟫` (or `⟪note|…⟫`, the page is optional) in her reply (the speech-beats
// filter takes it out of every path, shared/behaviors/speech-beats/choose.ts), the host stores it in her relationship file with the local date (never exported
// with a card). Each turn she reads ONE information line that she has it and how a note is written; when the user's words touch an entry or a note, a few of
// them come to her as material. Pure: no clock, no I/O, no model.
import type { CardLanguage, CardObject, CardObjectEntry } from '../foundation/character-card';

export const NOTE_MARK_WORD = 'note';
export const CARD_OBJECT_LIMITS = Object.freeze({ name: 24, entries: 64, entryChars: 240, sourceChars: 24, page: 999 });
/**
 * Her notes. `chars`: one note's length (a longer one is cut). `perReply`: how many one reply may add. `stored`: the most kept for one character (at the
 * limit a new one is not added; nothing of the user's or hers is dropped to make room). All of these are only a guard against an unbounded file and
 * prompt, not a character trait.
 */
/** The page she may name: any positive integer up to 9 digits (114514, anything); more digits is not a marker. */
export const NOTE_PAGE_MAX = 999_999_999;
export const NOTE_LIMITS = Object.freeze({ chars: 160, perReply: 2, stored: 300 });
/** What one turn's material may carry at most (entries, notes). */
export const RECALL_LIMITS = Object.freeze({ entries: 3, notes: 3 });

/** Characters that never belong in a declared word, an entry or a note: a line break, a control character, any marker or tag bracket, the marker's bar. */
const FORBIDDEN = /[\u0000-\u001f\u007f\u2028\u2029<>⟦⟧⟪⟫【】〖〗|[\]]/u;
const FORBIDDEN_ALL = new RegExp(FORBIDDEN.source, 'gu');

function line(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`物件的“${label}”必须是文字。`);
  const text = value.trim();
  if (!text || Array.from(text).length > max || FORBIDDEN.test(text)) throw new Error(`物件的“${label}”必须是 1～${max} 个字的一行普通文字（不含括号和竖线）。`);
  return text;
}

/** A card's declaration: `{ name, entries: [{ page, text, source? }] }`, nothing else. Throws on anything else; the entries come back in page order. */
export function validateCardObject(value: unknown): CardObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('物件的格式不正确。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'name' && key !== 'entries')) throw new Error('物件只能有名字和条目。');
  const name = line(input.name, '名字', CARD_OBJECT_LIMITS.name);
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > CARD_OBJECT_LIMITS.entries) throw new Error(`物件需要 1～${CARD_OBJECT_LIMITS.entries} 条条目。`);
  const seen = new Set<number>();
  const entries = input.entries.map((raw): CardObjectEntry => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('物件的条目格式不正确。');
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some(key => key !== 'page' && key !== 'text' && key !== 'source')) throw new Error('物件的条目只能有页码、内容和出处。');
    const page = entry.page;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > CARD_OBJECT_LIMITS.page || seen.has(page)) throw new Error(`物件的页码必须是 1～${CARD_OBJECT_LIMITS.page} 的整数，且不重复。`);
    seen.add(page);
    const text = line(entry.text, '条目内容', CARD_OBJECT_LIMITS.entryChars);
    return { page, text, ...(entry.source === undefined ? {} : { source: line(entry.source, '出处', CARD_OBJECT_LIMITS.sourceChars) }) };
  });
  return { name, entries: entries.sort((a, b) => a.page - b.page) };
}

// ---- her margin notes ----

/** A note's words as they are kept: forbidden characters become spaces, runs of spaces one, cut to the limit. '' when nothing is left. */
export function cleanNoteText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(FORBIDDEN_ALL, ' ').replace(/\s+/gu, ' ').trim()).slice(0, NOTE_LIMITS.chars).join('').trim();
}

export interface NoteMarker { readonly page: number | null; readonly text: string }
/**
 * The marker body between the brackets: `note|12|words` or `note|words`. Anything else (another word, a page over NOTE_PAGE_MAX, no words) is not a note.
 * A page the book does not have (and she has not used) makes a NEW entry of hers; a page that exists makes a note on it (that is decided where it is kept).
 */
export function parseNoteMarker(body: unknown): NoteMarker | null {
  if (typeof body !== 'string') return null;
  const match = /^\s*note\s*\|([\s\S]*)$/iu.exec(body);
  if (!match) return null;
  let rest = match[1]!, page: number | null = null;
  const withPage = /^\s*(\d{1,12})\s*\|([\s\S]*)$/u.exec(rest);
  if (withPage) {
    page = Number(withPage[1]);
    if (page < 1 || page > NOTE_PAGE_MAX) return null;
    rest = withPage[2]!;
  }
  const text = cleanNoteText(rest);
  return text ? { page, text } : null;
}

const letters = (text: string): string => text.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const bigrams = (text: string): Set<string> => { const chars = Array.from(text), out = new Set<string>(); for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!); return out; };
/** The same thing said twice: equal letters, one contained in the other (6 letters or more), or nearly the same pairs of letters. */
export function isNearDuplicate(a: string, b: string): boolean {
  const x = letters(a), y = letters(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 6 && long.includes(short)) return true;
  if (short.length < 4) return false;
  const p = bigrams(x), q = bigrams(y);
  let both = 0; for (const gram of p) if (q.has(gram)) both++;
  return both / (p.size + q.size - both) >= 0.75;
}

/**
 * Which of the markers of one reply become notes: only valid ones, at most `perReply`, none that is already there or repeats another of the same reply,
 * and none once the character has `stored` notes. `existing` is every text she already has.
 */
export function planNewNotes(existing: readonly string[], markers: readonly (string | NoteMarker | null)[], limits: Readonly<{ perReply: number; stored: number }> = NOTE_LIMITS): NoteMarker[] {
  const out: NoteMarker[] = [], have = [...existing];
  for (const raw of markers) {
    const marker = typeof raw === 'string' ? parseNoteMarker(raw) : raw;
    if (!marker) continue;
    if (out.length >= limits.perReply || have.length >= limits.stored) break;
    if (have.some(text => isNearDuplicate(text, marker.text))) continue;
    out.push(marker); have.push(marker.text);
  }
  return out;
}

// ---- the turn: one fact line, and material when the words touch the book ----

/** A note as the turn and the page see it; `own`: an entry she added to the book herself (a page of hers), not a note on a page. */
export interface ObjectNoteView { readonly page: number | null; readonly date: string; readonly text: string; readonly own?: boolean }
/** An entry of the book as she looks things up: the official ones, and hers (with the day she wrote it). */
export type BookEntry = CardObjectEntry & { readonly ownDate?: string };

/** A stored local date key ('2026-11-23') as the lines say it: "11月23日" / "Nov 23". Anything else is ''. */
export function noteDateText(date: string, language: CardLanguage): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return '';
  const month = Number(match[1]), day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return language === 'en' ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]} ${day}` : `${month}月${day}日`;
}

/**
 * The one information line (no instruction about what to do or say): that she has it, how much, and how a note is written (she cannot write a marker
 * she was never shown). Not the book: the entries only come when the words touch one.
 */
export function objectFactLine(object: CardObject, noteCount: number, language: CardLanguage, ownCount = 0): string {
  const pages = object.entries.length + ownCount;
  return language === 'en'
    ? `You have a handbook, “${object.name}” (${pages} entries; ${noteCount} margin notes of yours). (Writing ⟪${NOTE_MARK_WORD}|12|your words⟫ in a reply puts a note in the margin; 12 stands for the page, and the page may be left out: ⟪${NOTE_MARK_WORD}|your words⟫. A page number the book does not have yet becomes a new page of yours. The marker is never shown.)`
    : `你有一本《${object.name}》（${pages} 条条目，你的批注 ${noteCount} 条）。（回复里写 ⟪${NOTE_MARK_WORD}|12|批注的话⟫ 就记进页边，12 换成页码，页码也可以不写：⟪${NOTE_MARK_WORD}|批注的话⟫；写的页码书里还没有，就是你新添的一页。这个记号不显示。）`;
}

/** An entry's own head word: what stands before the first colon (「鸽子：监视设备……」), when that is short; '' otherwise. */
export function entryHeadword(entry: Pick<CardObjectEntry, 'text'>): string {
  const match = /^([^：:]{1,12})[：:]/u.exec(entry.text);
  return match ? match[1]!.trim() : '';
}

// Small function words that join every sentence and so say nothing about what is being talked about; a pair of letters holding one is not a clue.
const FUNCTION_CHARS = new Set(Array.from('的了是我你他她它们吗呢啊吧在有不就也都和与这那么什一个可以没会要去来到说想很把被让给为对从而但还又么吗呀哦嗯哈'));
const CJK = /[㐀-鿿]/u;
/** The clues in some words: pairs of neighbouring CJK characters (none holding a function word) and Latin words of three letters or more. */
function clues(text: string): Set<string> {
  const folded = text.normalize('NFKC').toLocaleLowerCase(), out = new Set<string>();
  for (const run of folded.match(/[㐀-鿿]+/gu) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i++) if (!FUNCTION_CHARS.has(chars[i]!) && !FUNCTION_CHARS.has(chars[i + 1]!)) out.add(chars[i]! + chars[i + 1]!);
  }
  for (const word of folded.match(/[a-z]{3,}/gu) ?? []) out.add(word);
  return out;
}
const squash = (text: string): string => text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '');

export interface ObjectRecall { readonly entries: readonly BookEntry[]; readonly notes: readonly ObjectNoteView[] }

/**
 * What the user's words touch: entries whose head word they contain or whose page they name ("第12页"), and entries and notes sharing at least two rare clues
 * with them (a clue found in few of the book's lines counts more than a common one); her notes on the page of an entry that came along come with it. At most
 * RECALL_LIMITS of each, best first; an unrelated sentence touches nothing. Local and synchronous: the turn never waits on this.
 */
export function recallObject(object: CardObject, notesIn: readonly ObjectNoteView[], message: string): ObjectRecall {
  let notes = notesIn;
  const said = squash(message);
  if (!said) return { entries: [], notes: [] };
  const messageClues = clues(message);
  // Her own pages are part of the book, next to the official ones; what is left are her notes on pages.
  const book: BookEntry[] = [...object.entries, ...notes.filter(note => note.own && note.page !== null).map(note => ({ page: note.page!, text: note.text, ownDate: note.date }))];
  notes = notes.filter(note => !note.own);
  const docs: { clues: Set<string>; score: number }[] = [
    ...book.map(entry => ({ clues: clues(entry.text), score: 0 })),
    ...notes.map(note => ({ clues: clues(note.text), score: 0 })),
  ];
  const frequency = new Map<string, number>();
  for (const doc of docs) for (const clue of doc.clues) frequency.set(clue, (frequency.get(clue) ?? 0) + 1);
  const pagesNamed = new Set<number>();
  for (const match of message.normalize('NFKC').matchAll(/第\s*(\d{1,12})\s*页|\bpages?\s*(\d{1,12})\b|\bp\.?\s*(\d{1,12})\b/giu)) pagesNamed.add(Number(match[1] ?? match[2] ?? match[3]));
  const rare = (doc: { clues: Set<string> }): { shared: number; weight: number } => {
    let shared = 0, weight = 0;
    for (const clue of messageClues) if (doc.clues.has(clue)) { shared++; weight += Math.log(1 + docs.length / (frequency.get(clue) ?? 1)); }
    return { shared, weight };
  };
  const picked = <T>(items: readonly T[], at: (i: number) => number, score: (item: T, i: number) => number, limit: number): T[] =>
    items.map((item, i) => ({ item, i, score: score(item, i) })).filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || at(b.i) - at(a.i)).slice(0, limit).map(row => row.item);
  const entries = picked(book, i => i, (entry, i) => {
    const head = squash(entryHeadword(entry));
    const clue = rare(docs[i]!);
    return (head.length >= 2 && said.includes(head) ? 10 : 0) + (pagesNamed.has(entry.page) ? 10 : 0) + (clue.shared >= 2 ? clue.weight : 0);
  }, RECALL_LIMITS.entries);
  const offset = book.length, cameWith = new Set(entries.map(entry => entry.page));
  const found = picked(notes, i => i, (note, i) => {
    const clue = rare(docs[offset + i]!);
    return (note.page !== null && (pagesNamed.has(note.page) || cameWith.has(note.page)) ? 10 : 0) + (clue.shared >= 2 ? clue.weight : 0);
  }, RECALL_LIMITS.notes);
  return { entries, notes: found };
}

/** The recalled entries and notes as the lines she reads ('' when nothing was touched). Facts of the book and her own words, no instruction. */
export function objectMaterial(object: CardObject, recall: ObjectRecall, language: CardLanguage): string {
  if (!recall.entries.length && !recall.notes.length) return '';
  const en = language === 'en', lines: string[] = [en ? `From “${object.name}”:` : `《${object.name}》里翻到的：`];
  for (const entry of recall.entries)
    lines.push(entry.ownDate !== undefined ? (en ? `Page ${entry.page} (added by you${noteDateText(entry.ownDate, language) ? `, ${noteDateText(entry.ownDate, language)}` : ''}): ${entry.text}` : `第 ${entry.page} 页（你添的${noteDateText(entry.ownDate, language) ? `，${noteDateText(entry.ownDate, language)}` : ''}）${entry.text}`)
      : en ? `Page ${entry.page}: ${entry.text}${entry.source ? ` (source: ${entry.source})` : ''}` : `第 ${entry.page} 页 ${entry.text}${entry.source ? `（依据：${entry.source}）` : ''}`);
  for (const note of recall.notes) {
    const when = noteDateText(note.date, language), where = note.page === null ? '' : en ? `p. ${note.page}` : `第 ${note.page} 页`;
    const label = [when, where].filter(Boolean).join(en ? ', ' : '，');
    lines.push(en ? `Your margin note${label ? ` (${label})` : ''}: ${note.text}` : `你的批注${label ? `（${label}）` : ''}：${note.text}`);
  }
  return lines.join('\n');
}

// ---- the archive page's two writes (they ride the existing `herAlarms` window-to-host call: the preload may not grow) ----

/** Edit one of her notes' words, or delete it (the page confirms first; a delete goes into the recycle bin first). */
export type ObjectNoteRequest =
  | { readonly action: 'object-note-edit'; readonly characterId: string; readonly id: string; readonly text: string }
  | { readonly action: 'object-note-delete'; readonly characterId: string; readonly id: string };
const PLAIN = /^[\w.:-]{1,200}$/u;
export function isObjectNoteRequest(value: unknown): value is ObjectNoteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>, keys = Object.keys(input).sort().join(',');
  if (typeof input.characterId !== 'string' || !input.characterId || input.characterId.length > 200 || /[\u0000-\u001f]/u.test(input.characterId)) return false;
  if (typeof input.id !== 'string' || !PLAIN.test(input.id)) return false;
  return (input.action === 'object-note-delete' && keys === 'action,characterId,id') || (input.action === 'object-note-edit' && keys === 'action,characterId,id,text' && typeof input.text === 'string');
}
