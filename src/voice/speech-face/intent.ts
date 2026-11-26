import { INTENT_TABLE_EN, INTENT_TABLE_ZH, type IntentRow, type SpeechIntent } from './intent-table';

/**
 * I-073 part 3, layer 1 ("意图"): a reply's text → clauses → one intent and a weight per clause, by the data tables in
 * intent-table.ts. Pure, no model call. Later this layer can be replaced (her own sparse marks, option C; or a haiku judge,
 * option B) without touching the layers below: they only see { intent, weight } per clause.
 */
export interface Clause {
  /** Character range in the text it was split from ([start, end)). */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly lang: 'zh' | 'en';
  readonly intent: SpeechIntent;
  /** 0..1: how clear the intent is (calm = 0). */
  readonly weight: number;
}

/** A clause ends after these (kept with it); runs of them stay together ("？？", "！？", "……"). */
const CLAUSE_END = /[，,。．！!？?；;：:…\n～~]+["'”’」』）)]*\s*/g;

/** Mostly CJK → 'zh'; mostly Latin letters → 'en' (ties and neither: 'zh', the product's language). */
export function clauseLanguage(text: string): 'zh' | 'en' {
  let cjk = 0, latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x3040 && code <= 0x9fff || code >= 0xf900 && code <= 0xfaff) cjk++;
    else if (code >= 65 && code <= 90 || code >= 97 && code <= 122) latin++;
  }
  return latin > cjk * 2 && latin >= 3 ? 'en' : 'zh';
}

const CLOSERS = /["'”’」』）)\s]+$/;
function score(text: string, table: readonly IntentRow[]): { intent: SpeechIntent; weight: number } {
  const body = text.replace(CLOSERS, '').trim();
  if (!body) return { intent: 'calm', weight: 0 };
  const sums = new Map<SpeechIntent, number>();
  for (const row of table) {
    row.match.lastIndex = 0;
    if (!row.match.test(body)) continue; // each row once: "？？？" is no stronger than "？"
    sums.set(row.intent, (sums.get(row.intent) ?? 0) + row.weight);
  }
  let best: SpeechIntent = 'calm', weight = 0;
  for (const [intent, sum] of sums) if (sum > weight + 1e-9) { best = intent; weight = sum; }
  return { intent: best, weight: Math.min(1, weight) };
}

/** One clause's intent and weight (calm, 0 when nothing in the table speaks for anything). */
export function clauseIntent(text: string, lang: 'zh' | 'en' = clauseLanguage(text)): { intent: SpeechIntent; weight: number } {
  return score(text, lang === 'en' ? INTENT_TABLE_EN : INTENT_TABLE_ZH);
}

/** Splits `text` into clauses at punctuation (kept with the clause before it) and scores each. Empty pieces are dropped. */
export function splitClauses(text: string): Clause[] {
  const out: Clause[] = [];
  if (typeof text !== 'string' || !text) return out;
  let start = 0;
  const push = (end: number) => {
    const piece = text.slice(start, end);
    if (piece.trim()) {
      const lang = clauseLanguage(piece), { intent, weight } = clauseIntent(piece, lang);
      out.push(Object.freeze({ start, end, text: piece, lang, intent, weight }));
    }
    start = end;
  };
  CLAUSE_END.lastIndex = 0;
  for (let m = CLAUSE_END.exec(text); m; m = CLAUSE_END.exec(text)) {
    if (m[0].length === 0) { CLAUSE_END.lastIndex++; continue; }
    // A decimal point or an English apostrophe-free comma inside a number ("3,000", "1.5") is not a boundary.
    if (/^[,.．]$/.test(m[0]) && /\d/.test(text[m.index - 1] ?? '') && /\d/.test(text[m.index + 1] ?? '')) continue;
    push(m.index + m[0].length);
  }
  push(text.length);
  return out;
}
