import { normalizeTestText } from '../../shared/test-command';

/** What the matcher and the help list need to know about an entry (the registry adds the function that runs it). */
export interface TestEntryMeta {
  /** Stable id: feature code and variant, e.g. "L2.daydream". Typing the id itself always works. */
  readonly id: string;
  /** Short Chinese name. */
  readonly name: string;
  /** Other ways to say it; compared after normalizeTestText. */
  readonly aliases: readonly string[];
  /** One sentence: what it does. */
  readonly summary: string;
}

export type TestMatch<E extends TestEntryMeta = TestEntryMeta> =
  | { kind: 'help' }
  | { kind: 'entry'; entry: E; how: 'id' | 'exact' | 'contains' }
  | { kind: 'ambiguous'; entries: E[] }
  | { kind: 'none' };

/** Said alone (or inside a longer sentence when nothing else matches) these ask for the list. */
const HELP_WORDS = ['帮助', '有哪些', '有什么', '列表', '清单', '菜单', '入口', '能测什么', 'help', 'list', 'commands'];
const HELP_EXACT = new Set(['', '全部', '所有', '都有什么', ...HELP_WORDS].map(normalizeTestText));
/** A word right before an alias that turns it round ("别发呆", "不开心", "没累"): not a hit. */
const NEGATORS = '不别没无勿莫未';

interface Hit { length: number; at: number }

function containsHit(text: string, alias: string): Hit | null {
  let from = 0, found: Hit | null = null;
  for (;;) {
    const at = text.indexOf(alias, from);
    if (at < 0) return found;
    const before = text[at - 1];
    if (!(before !== undefined && NEGATORS.includes(before))) found = { length: alias.length, at };
    from = at + 1;
  }
}

/**
 * Local matching, no model. The body is normalised first. Order of trust:
 *  1. the entry's own id, its name or an alias, said in full (exact);
 *  2. an alias inside a longer sentence, the longest alias wins, a tie goes to the one said last ("熟悉度设成初识");
 *  3. a tie that is still a tie is ambiguous (the caller may ask the model).
 * Help words alone ask for the list; inside a sentence they only count when no entry matched.
 */
export function matchTestEntry<E extends TestEntryMeta>(entries: readonly E[], body: string): TestMatch<E> {
  const text = normalizeTestText(body);
  if (HELP_EXACT.has(text)) return { kind: 'help' };
  for (const entry of entries) {
    if (normalizeTestText(entry.id) === text) return { kind: 'entry', entry, how: 'id' };
  }
  const exact = entries.filter(entry => [entry.name, ...entry.aliases].some(alias => normalizeTestText(alias) === text));
  if (exact.length === 1) return { kind: 'entry', entry: exact[0], how: 'exact' };
  if (exact.length > 1) return { kind: 'ambiguous', entries: exact };
  const scored: { entry: E; length: number; at: number }[] = [];
  for (const entry of entries) {
    let best: Hit | null = null;
    for (const raw of [entry.id, entry.name, ...entry.aliases]) {
      const alias = normalizeTestText(raw);
      if (!alias) continue;
      const hit = containsHit(text, alias);
      if (hit && (!best || hit.length > best.length || (hit.length === best.length && hit.at > best.at))) best = hit;
    }
    if (best) scored.push({ entry, ...best });
  }
  if (scored.length) {
    scored.sort((a, b) => b.length - a.length || b.at - a.at);
    const top = scored[0], tied = scored.filter(item => item.length === top.length && item.at === top.at);
    if (tied.length === 1) return { kind: 'entry', entry: top.entry, how: 'contains' };
    return { kind: 'ambiguous', entries: tied.map(item => item.entry) };
  }
  if (HELP_WORDS.some(word => text.includes(normalizeTestText(word)))) return { kind: 'help' };
  return { kind: 'none' };
}

/** The list the user sees for "测试：帮助": one line per entry. `translate` is the host's t(). */
export function testHelpLines(entries: readonly TestEntryMeta[], translate: (key: string) => string = key => key): string[] {
  return entries.map(entry => `${entry.id} · ${translate(entry.name)}：${translate(entry.summary)}`);
}

/** Cheap guard on anything a late timer or a model hands back: a closed set of ids. */
export function entryById<E extends TestEntryMeta>(entries: readonly E[], id: unknown): E | null {
  return typeof id === 'string' ? entries.find(entry => entry.id === id) ?? null : null;
}
