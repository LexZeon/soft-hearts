// I-049 / I-048: what a keyword is, and the strict check on what a small model hands back. Keywords come only from what the source
// text really says; an invented one is dropped. Pure: no clock, no I/O.

import { squashText, VAGUE_TERMS } from '../memory-notes/recall';
import { KEYWORD_KINDS, MEMORY_KEYWORDS_KNOBS, type KeywordKind, type MemoryKeywordsKnobs } from './knobs';

export interface Keyword {
  readonly term: string;
  readonly kind: KeywordKind;
  /** 0..1: how much "this piece is about it". */
  readonly weight: number;
  /** Other names for the same thing (a Chinese and an English title, "那家拉面店" for "一兰"). */
  readonly aliases: readonly string[];
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const LATIN = /^[\p{Script=Latin}\p{N}]+$/u;
const length = (value: string) => Array.from(value).length;

/** A name usable for matching: not vague, two characters at least (three for Latin words), within the length bound. */
export function usableName(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string' || CONTROL.test(value)) return null;
  const trimmed = value.trim(), key = squashText(trimmed);
  if (!key || VAGUE_TERMS.has(key) || length(trimmed) > maxChars) return null;
  if (LATIN.test(key) ? key.length < 3 : length(key) < 2) return null;
  return trimmed;
}

/** Shape and bounds only (no source check): used for what is read back from the index file too. */
export function sanitizeKeyword(raw: unknown, knobs: MemoryKeywordsKnobs = MEMORY_KEYWORDS_KNOBS): Keyword | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const term = usableName(item.term, knobs.write.termChars);
  if (!term || !(KEYWORD_KINDS as readonly unknown[]).includes(item.kind)) return null;
  if (typeof item.weight !== 'number' || !Number.isFinite(item.weight)) return null;
  const aliases: string[] = [], seen = new Set([squashText(term)]);
  for (const entry of Array.isArray(item.aliases) ? item.aliases : []) {
    const alias = usableName(entry, knobs.write.aliasChars);
    if (!alias || seen.has(squashText(alias)) || aliases.length >= knobs.write.aliases) continue;
    seen.add(squashText(alias)); aliases.push(alias);
  }
  return { term, kind: item.kind as KeywordKind, weight: Math.min(1, Math.max(0, item.weight)), aliases };
}

/** Same thing under two spellings: keep the higher weight, join the aliases. */
export function mergeKeywords(list: readonly Keyword[], knobs: MemoryKeywordsKnobs = MEMORY_KEYWORDS_KNOBS): Keyword[] {
  const byKey = new Map<string, Keyword>();
  for (const keyword of list) {
    const key = squashText(keyword.term), found = byKey.get(key);
    if (!found) { byKey.set(key, keyword); continue; }
    const aliases = [...found.aliases];
    for (const alias of keyword.aliases) if (!aliases.some(old => squashText(old) === squashText(alias)) && aliases.length < knobs.write.aliases) aliases.push(alias);
    byKey.set(key, keyword.weight > found.weight ? { ...keyword, aliases } : { ...found, aliases });
  }
  return [...byKey.values()].sort((a, b) => b.weight - a.weight).slice(0, knobs.write.perNote);
}

/**
 * What the writer returned, kept only as far as the source text supports it: the term (or one of its aliases) must occur in
 * `source`. Anything else (wrong shape, unknown kind, too long, vague, not in the text) is dropped, never repaired.
 */
export function validateKeywords(raw: unknown, source: string, knobs: MemoryKeywordsKnobs = MEMORY_KEYWORDS_KNOBS): Keyword[] {
  if (!Array.isArray(raw) || typeof source !== 'string') return [];
  const text = squashText(source);
  const shown = (name: string) => { const key = squashText(name); return !!key && text.includes(key); };
  const kept: Keyword[] = [];
  for (const item of raw.slice(0, knobs.write.perNote * 3)) {
    const keyword = sanitizeKeyword(item, knobs);
    if (keyword && [keyword.term, ...keyword.aliases].some(shown)) kept.push(keyword);
  }
  return mergeKeywords(kept, knobs);
}

/** The writer's text (one JSON array, a code fence allowed) → checked keywords. Not JSON → none. */
export function parseKeywordsText(value: string, source: string, knobs: MemoryKeywordsKnobs = MEMORY_KEYWORDS_KNOBS): Keyword[] {
  if (typeof value !== 'string' || value.length > 8_000) return [];
  try { return validateKeywords(JSON.parse(value.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')), source, knobs); } catch { return []; }
}

/**
 * A note writer's whole answer (one JSON object) → the keywords it carries in an optional `keywords` field, checked against `source`.
 * The note formats do not hold keywords (an older build must still read its notes): they go to the separate keyword index. No such
 * field, bad JSON or bad keywords → none; the note itself is never affected.
 */
export function extractKeywordsField(answer: string, source: string, knobs: MemoryKeywordsKnobs = MEMORY_KEYWORDS_KNOBS): Keyword[] {
  if (typeof answer !== 'string' || answer.length > 8_000) return [];
  try {
    const data = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
    return data && typeof data === 'object' && !Array.isArray(data) ? validateKeywords((data as Record<string, unknown>).keywords, source, knobs) : [];
  } catch { return []; }
}

