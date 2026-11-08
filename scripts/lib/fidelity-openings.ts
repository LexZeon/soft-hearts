// Two numbers for the fidelity suite (real-chat findings F1 / R28, docs/claude/2026-11-07-care-openings-empty.md):
//   - the share of replies that open with an ellipsis (……, … or ...)
//   - how many replies contain one of the card's example lines word for word (a line of at least 8 characters)
// Pure functions over recorded reply text and the card's persona; no requests.

import { EXAMPLES_HEADING, OPENING_VARIETY_RULE } from '../../shared/character-cards';

/** A card's persona as it was compiled before this change (the "before" side of a measurement): plain 对话示例 heading, no variety rule. */
export function legacyPersona(persona: string): string {
  return persona.replace(EXAMPLES_HEADING, '对话示例：').replace('\n\n' + OPENING_VARIETY_RULE, '').replace(OPENING_VARIETY_RULE, '');
}

/** A reply opens with an ellipsis: after any leading spaces, quote marks or a speaker label, the first thing is …… / … / ... / 。。。. */
export function opensWithEllipsis(reply: string): boolean {
  const text = reply.replace(/^[\s"'“”‘’「」『』（(\[【*_~>]+/u, '');
  return /^(?:…+|\.{2,}|。{2,}|·{3,})/u.test(text);
}

export const MIN_EXAMPLE_CHARS = 8;
const SPEAKER = /^[^\n：:]{1,12}[：:]\s*/u;
const strip = (text: string): string => text.replace(/[\s…\.。！!？?，,、；;~～"'“”‘’「」『』（）()]+/gu, '');

/**
 * The example lines of a persona: the lines of its 对话示例 section that are the character's (not the user's), each whole and also
 * cut at sentence ends, kept when at least MIN_EXAMPLE_CHARS long once marks are stripped. Returned stripped of marks, ready for `containsExample`.
 */
export function exampleLines(persona: string): string[] {
  const start = persona.search(/(?:^|\n)对话示例[^\n]*：\s*\n/u);
  if (start < 0) return [];
  const body = persona.slice(start).replace(/^\n?对话示例[^\n]*：\s*\n/u, '');
  const section = body.split(/\n\s*\n/u)[0] ?? '';
  const found = new Set<string>();
  for (const raw of section.split('\n')) {
    const line = raw.trim();
    if (!line || /^用户[：:]/u.test(line)) continue;
    const said = line.replace(SPEAKER, '');
    for (const piece of [said, ...said.split(/[。！!？?\n]/u)]) {
      const key = strip(piece);
      if ([...key].length >= MIN_EXAMPLE_CHARS) found.add(key);
    }
  }
  return [...found];
}

/** The reply contains one of the example lines word for word (marks and spacing ignored). */
export function containsExample(reply: string, lines: readonly string[]): boolean {
  const key = strip(reply);
  return lines.some(line => key.includes(line));
}

export interface OpeningStats { replies: number; ellipsisOpenings: number; ellipsisShare: number | null; exampleCopies: number }

export function openingStats(replies: ReadonlyArray<{ reply: string; examples: readonly string[] }>): OpeningStats {
  const real = replies.filter(item => item.reply.trim());
  const ellipsisOpenings = real.filter(item => opensWithEllipsis(item.reply)).length;
  return {
    replies: real.length, ellipsisOpenings, ellipsisShare: real.length ? ellipsisOpenings / real.length : null,
    exampleCopies: real.filter(item => containsExample(item.reply, item.examples)).length,
  };
}

/** The stats of a run's cases, using each card's persona for its example lines. */
export function runOpeningStats(cases: ReadonlyArray<{ card: string; replies: ReadonlyArray<{ reply: string }> }>,
  personaOf: (card: string) => string | undefined): OpeningStats {
  const lines = new Map<string, string[]>();
  const items = cases.flatMap(item => {
    if (!lines.has(item.card)) lines.set(item.card, exampleLines(personaOf(item.card) ?? ''));
    return item.replies.map(reply => ({ reply: reply.reply, examples: lines.get(item.card)! }));
  });
  return openingStats(items);
}

export function openingLine(stats: OpeningStats): string {
  const share = stats.ellipsisShare === null ? '–' : `${Math.round(stats.ellipsisShare * 100)}%`;
  return `省略号开头的回复 ${stats.ellipsisOpenings} / ${stats.replies} 条（${share}）；原样含有卡里示例句（≥ ${MIN_EXAMPLE_CHARS} 字）的回复 ${stats.exampleCopies} 条`;
}
