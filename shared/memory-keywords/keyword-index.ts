// I-049 step 1: the keyword index of one character, and the local match (0 ms, no model): the user's text and the lines before it
// against terms and aliases, scored weight x kind x source x recency. The index is its own file next to the note files; the note
// formats are not touched, so an older build still reads its notes. Pure: the clock is passed in.

import { DEFAULT_MEMORY_CONFIG } from '../memory';
import { squashText } from '../memory-notes/recall';
import { KEYWORD_SOURCES, MEMORY_KEYWORDS_KNOBS, type KeywordSource, type MemoryKeywordsKnobs } from './knobs';
import { mergeKeywords, sanitizeKeyword, type Keyword } from './keyword';

export interface KeywordRecord {
  readonly noteId: string;
  readonly source: KeywordSource;
  /** When the note's content happened (used for recency). */
  readonly at: number;
  readonly keywords: readonly Keyword[];
}

export interface KeywordMatch {
  readonly noteId: string;
  readonly source: KeywordSource;
  readonly score: number;
  /** The terms that matched (their written form). */
  readonly terms: readonly string[];
}

export const KEYWORD_INDEX_VERSION = 1;
export interface KeywordIndexFile { readonly version: 1; readonly records: readonly KeywordRecord[] }

interface Compiled { readonly record: KeywordRecord; readonly names: readonly (readonly string[])[] }
const DAY = 86_400_000;

export class KeywordIndex {
  private readonly compiled = new Map<string, Compiled>();

  constructor(private readonly knobs: MemoryKeywordsKnobs = MEMORY_KEYWORDS_KNOBS) {}

  get size(): number { return this.compiled.size; }
  has(noteId: string): boolean { return this.compiled.has(noteId); }
  get(noteId: string): KeywordRecord | null { return this.compiled.get(noteId)?.record ?? null; }
  records(): KeywordRecord[] { return [...this.compiled.values()].map(item => item.record); }

  /** Add or replace one note's keywords. Nothing usable removes the note's entry. */
  set(noteId: string, source: KeywordSource, at: number, keywords: readonly Keyword[]): void {
    const clean = mergeKeywords(keywords.flatMap(keyword => sanitizeKeyword(keyword, this.knobs) ?? []), this.knobs);
    if (!noteId || !clean.length || !(KEYWORD_SOURCES as readonly string[]).includes(source) || !Number.isFinite(at)) { this.compiled.delete(noteId); return; }
    const names = clean.map(keyword => [keyword.term, ...keyword.aliases].map(squashText).filter(Boolean));
    this.compiled.set(noteId, { record: { noteId, source, at, keywords: clean }, names });
  }

  /** Forget a note: its keywords go with it. */
  remove(noteId: string): boolean { return this.compiled.delete(noteId); }

  /** Forget every note of one source (for example all watch notes of this character). Returns how many. */
  removeSource(source: KeywordSource): number {
    let removed = 0;
    for (const [id, item] of this.compiled) if (item.record.source === source) { this.compiled.delete(id); removed++; }
    return removed;
  }

  /**
   * `lines[0]` is what the user just said, then the lines before it (newest first; only `previousLines` of them are used, at
   * `previousShare` of the weight). The best `limit` notes at or above `minScore`, never more than the chat memory's own record limit.
   */
  match(lines: readonly string[], now: number, limit: number = this.knobs.match.top): KeywordMatch[] {
    const m = this.knobs.match;
    const queries = lines.slice(0, 1 + Math.max(0, m.previousLines))
      .map((line, index) => ({ text: squashText(typeof line === 'string' ? line.normalize('NFKC') : ''), share: index === 0 ? 1 : m.previousShare }))
      .filter(query => query.text);
    const cap = Math.max(0, Math.min(limit, DEFAULT_MEMORY_CONFIG.recallRecords));
    if (!queries.length || !cap) return [];
    const found: KeywordMatch[] = [];
    for (const { record, names } of this.compiled.values()) {
      let sum = 0;
      const terms: string[] = [];
      record.keywords.forEach((keyword, index) => {
        let share = 0;
        for (const query of queries) if (query.share > share && names[index].some(name => query.text.includes(name))) share = query.share;
        if (!share) return;
        sum += keyword.weight * this.knobs.kinds[keyword.kind] * share;
        terms.push(keyword.term);
      });
      if (!sum) continue;
      const age = Math.max(0, now - record.at) / DAY;
      const recency = Math.max(m.oldestShare, 0.5 ** (age / Math.max(0.01, m.halfLifeDays)));
      const score = sum * this.knobs.sources[record.source] * recency;
      if (score >= m.minScore) found.push({ noteId: record.noteId, source: record.source, score, terms });
    }
    return found.sort((a, b) => b.score - a.score || a.noteId.localeCompare(b.noteId)).slice(0, cap);
  }

  toFile(): KeywordIndexFile { return { version: KEYWORD_INDEX_VERSION, records: this.records() }; }

  /** Lenient read: a bad record is skipped, a bad file is an empty index. */
  static fromFile(raw: unknown, knobs: MemoryKeywordsKnobs = MEMORY_KEYWORDS_KNOBS): KeywordIndex {
    const index = new KeywordIndex(knobs);
    const records = raw && typeof raw === 'object' && (raw as KeywordIndexFile).version === KEYWORD_INDEX_VERSION ? (raw as KeywordIndexFile).records : null;
    if (!Array.isArray(records)) return index;
    for (const item of records) {
      if (!item || typeof item !== 'object' || typeof item.noteId !== 'string' || !Array.isArray(item.keywords)) continue;
      index.set(item.noteId, item.source, item.at, item.keywords as Keyword[]);
    }
    return index;
  }
}
