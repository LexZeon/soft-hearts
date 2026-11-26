// I-088 item 2 (docs/claude/2026-11-11-i088-people-and-things.md): what the user decided about her people and things, and the pure
// operations that change it. Only names (in matching form) and the user's own typed names are kept: no chat text, no note ids.
// Decisions always win over later automatic gathering (shared/memory/people-things/gather.ts): a joined pair is joined, a refused or
// split pair is never merged or suggested again, a deleted name is not an entry. Every list is bounded; the oldest goes first.
// Pure: no clock, no I/O.

export const PEOPLE_THINGS_LIMITS = Object.freeze({ joined: 2000, apart: 4000, removed: 4000, labels: 1000, keyChars: 64, nameChars: 24 });

export interface PeopleThingsDecisions {
  readonly v: 1;
  /** The user said these two names are the same (confirmed suggestion, manual merge, a rename that gave a new name). */
  readonly joined: readonly (readonly [string, string])[];
  /** The user said these two are not the same (refused suggestion, split). Never merged or suggested again. */
  readonly apart: readonly (readonly [string, string])[];
  /** Names the user deleted: not an entry, not used for recall. */
  readonly removed: readonly string[];
  /** The name the user gave an entry: `key` is one of its names (matching form); the last label in the list wins. */
  readonly labels: readonly { readonly key: string; readonly text: string }[];
}

export const emptyDecisions = (): PeopleThingsDecisions => ({ v: 1, joined: [], apart: [], removed: [], labels: [] });

/** Matching form of a name (the same as shared/memory/memory-notes/recall.ts squashText, kept here so this module stands alone). */
export const nameKey = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const CONTROL = /[\u0000-\u001f\u007f]/u;
const chars = (value: string) => Array.from(value).length;
export const okKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && chars(value) <= PEOPLE_THINGS_LIMITS.keyChars && !CONTROL.test(value);
/** The user's typed name: trimmed, one line, 1..24 characters, with something in matching form. Null when it is not usable. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').trim();
  return text && chars(text) <= PEOPLE_THINGS_LIMITS.nameChars && !CONTROL.test(text) && nameKey(text) ? text : null;
}

export const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
const orderedPair = (a: string, b: string): readonly [string, string] => (a < b ? [a, b] : [b, a]);
const tail = <T>(list: readonly T[], max: number): T[] => (list.length > max ? list.slice(list.length - max) : [...list]);
const dedupePairs = (pairs: readonly (readonly [string, string])[]) => {
  const seen = new Set<string>(), out: (readonly [string, string])[] = [];
  for (const [a, b] of pairs) { if (a === b) continue; const k = pairKey(a, b); if (!seen.has(k)) { seen.add(k); out.push(orderedPair(a, b)); } }
  return out;
};
const bounded = (d: PeopleThingsDecisions): PeopleThingsDecisions => ({ v: 1,
  joined: tail(dedupePairs(d.joined), PEOPLE_THINGS_LIMITS.joined), apart: tail(dedupePairs(d.apart), PEOPLE_THINGS_LIMITS.apart),
  removed: tail([...new Set(d.removed)], PEOPLE_THINGS_LIMITS.removed), labels: tail(d.labels, PEOPLE_THINGS_LIMITS.labels) });

/** Lenient: bad entries are dropped, a wrong top level is "nothing decided yet". */
export function readDecisions(value: unknown): PeopleThingsDecisions {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || v.v !== 1) return emptyDecisions();
  const pairs = (list: unknown) => (Array.isArray(list) ? list : []).filter((item): item is [string, string] =>
    Array.isArray(item) && item.length === 2 && okKey(item[0]) && okKey(item[1]) && item[0] !== item[1]).map(([a, b]) => [a, b] as const);
  const labels = (Array.isArray(v.labels) ? v.labels : []).filter((item): item is { key: string; text: string } =>
    !!item && typeof item === 'object' && okKey((item as { key?: unknown }).key) && cleanName((item as { text?: unknown }).text) !== null)
    .map(item => ({ key: item.key, text: cleanName(item.text)! }));
  return bounded({ v: 1, joined: pairs(v.joined), apart: pairs(v.apart), removed: (Array.isArray(v.removed) ? v.removed : []).filter(okKey), labels });
}

const without = (pairs: readonly (readonly [string, string])[], a: string, b: string) => pairs.filter(([x, y]) => pairKey(x, y) !== pairKey(a, b));

/** The user says these two names are the same. */
export function joinNames(d: PeopleThingsDecisions, a: string, b: string): PeopleThingsDecisions {
  if (!okKey(a) || !okKey(b) || a === b) return d;
  return bounded({ ...d, joined: [...d.joined, orderedPair(a, b)], apart: without(d.apart, a, b), removed: d.removed.filter(k => k !== a && k !== b) });
}
/** The user says these two names are not the same (also keeps the pair from being suggested again). */
export function keepApart(d: PeopleThingsDecisions, a: string, b: string): PeopleThingsDecisions {
  if (!okKey(a) || !okKey(b) || a === b) return d;
  return bounded({ ...d, apart: [...d.apart, orderedPair(a, b)], joined: without(d.joined, a, b) });
}
/** Give the entry holding `key` a name of the user's own. A name that is not one of its names yet becomes one (so it recalls too). */
export function renameEntry(d: PeopleThingsDecisions, key: string, text: string): PeopleThingsDecisions {
  const clean = cleanName(text);
  if (!clean || !okKey(key)) return d;
  const newKey = nameKey(clean);
  const joined = newKey === key ? d : joinNames(d, key, newKey);
  return bounded({ ...joined, removed: joined.removed.filter(k => k !== newKey), labels: [...joined.labels.filter(label => label.key !== newKey), { key: newKey, text: clean }] });
}
/**
 * Take one name out of its entry. `others` are the entry's other names: the name is kept apart from each (so no automatic merge
 * brings it back), and the names it was joined through stay joined with each other.
 */
export function splitName(d: PeopleThingsDecisions, key: string, others: readonly string[]): PeopleThingsDecisions {
  if (!okKey(key)) return d;
  const neighbours = d.joined.filter(([x, y]) => x === key || y === key).map(([x, y]) => (x === key ? y : x));
  let next: PeopleThingsDecisions = { ...d, joined: d.joined.filter(([x, y]) => x !== key && y !== key), labels: d.labels.filter(label => label.key !== key) };
  for (const other of neighbours.slice(1)) next = { ...next, joined: [...next.joined, orderedPair(neighbours[0]!, other)] };
  for (const other of others) if (okKey(other) && other !== key) next = keepApart(next, key, other);
  return bounded(next);
}
/** Delete an entry: every one of its names. */
export function removeNames(d: PeopleThingsDecisions, keys: readonly string[]): PeopleThingsDecisions {
  return bounded({ ...d, removed: [...d.removed, ...keys.filter(okKey)] });
}
/** Keep only what still refers to a name that exists (called after the user deleted notes, so no names outlive their notes). */
export function pruneDecisions(d: PeopleThingsDecisions, live: ReadonlySet<string>, seen: ReadonlySet<string>): PeopleThingsDecisions {
  return bounded({ v: 1, joined: d.joined.filter(([a, b]) => live.has(a) && live.has(b)), apart: d.apart.filter(([a, b]) => live.has(a) && live.has(b)),
    removed: d.removed.filter(k => seen.has(k)), labels: d.labels.filter(label => live.has(label.key)) });
}
export const decisionsEmpty = (d: PeopleThingsDecisions): boolean => !d.joined.length && !d.apart.length && !d.removed.length && !d.labels.length;
