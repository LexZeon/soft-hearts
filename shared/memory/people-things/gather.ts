// I-088 item 2 (docs/claude/2026-11-11-i088-people-and-things.md): the people and things her notes name, gathered into entries
// ("你生活里的人和事"), each with every name it goes by. The idea (one person under several names; sure merges are automatic, unsure
// ones wait for the user) comes from BaiShou-Next's life-relationship graph; only its public description was read, the code here is
// our own. Local string work only: no model call. Pure: no clock, no I/O.
//
// Sure merges (automatic):
//  1. the same name after normalisation (NFKC, lower case, no spaces or punctuation);
//  2. "我的X" and "X" (X of two or more characters);
//  3. the same relative under its common names (KINSHIP below, a small closed list), with or without 我 / 我的 / "my" in front.
// Unsure ones become suggestions (never merged without the user):
//  - the same core once the pointer ("那家", "那个"), "我的", a leading 小/老/阿 or a trailing 哥/姐/总/同学/老师… is taken off
//    ("小明" and "明哥", "拉面店" and "那家拉面店");
//  - one name inside another ("拉面" in "拉面店"), except "X的Y" forms and very common words.
// A suggestion is skipped when the two names stand side by side in one note (a writer who lists both means two different people).
// The user's decisions (shared/memory/people-things/decisions.ts) win: joined pairs are joined, refused or split pairs are never merged or
// suggested, deleted names are not entries, a given name is the entry's name.

import type { PeopleThingsDecisions } from './decisions';
import { nameKey, pairKey } from './decisions';
import { VAGUE_TERMS } from '../memory-notes/recall';

export interface PeopleNoteInput {
  readonly recordId: string;
  /** The segment's own time (ms). */
  readonly at: number;
  readonly people: readonly string[];
  readonly things: readonly string[];
}

export interface EntryName {
  /** Matching form. */
  readonly key: string;
  /** How it was written (the most used spelling). */
  readonly text: string;
  /** The notes that wrote this name. Empty for a name only the user gave. */
  readonly notes: readonly string[];
}

export interface PeopleThingsEntry {
  /** The first of its names' keys, in order: a handle for tests only; the page works with name keys. */
  readonly id: string;
  readonly kind: 'person' | 'thing';
  /** The name shown: the user's own if given, else the most used. */
  readonly name: string;
  readonly names: readonly EntryName[];
  /** Every note that names it (record ids), newest first. */
  readonly notes: readonly string[];
  readonly firstAt: number;
  readonly lastAt: number;
}

export interface PendingSide { readonly key: string; readonly name: string; readonly names: readonly string[]; readonly chats: number }
export interface PendingMerge { readonly a: PendingSide; readonly b: PendingSide; readonly reason: 'core' | 'contain' }

export interface Gathered {
  readonly entries: readonly PeopleThingsEntry[];
  readonly pending: readonly PendingMerge[];
  /** Every name key that is part of an entry (for pruning decisions). */
  readonly live: ReadonlySet<string>;
  /** Every name key the notes wrote, including deleted ones. */
  readonly seen: ReadonlySet<string>;
}

export const GATHER_LIMITS = Object.freeze({ pending: 50, names: 6000 });

/** The small closed list of relatives and the names they go by (matching form). Each row is one relative. */
export const KINSHIP: readonly (readonly string[])[] = Object.freeze([
  ['妈', '妈妈', '老妈', '母亲', '妈咪', '家母', 'mom', 'mum', 'mother', 'mama', 'mommy'],
  ['爸', '爸爸', '老爸', '父亲', '爸比', '家父', 'dad', 'father', 'papa', 'daddy'],
  ['奶奶', '祖母'], ['爷爷', '祖父'], ['外婆', '姥姥', '外祖母'], ['外公', '姥爷', '外祖父'],
  ['哥', '哥哥'], ['姐', '姐姐'], ['弟', '弟弟'], ['妹', '妹妹'],
  ['女朋友', '女友', 'girlfriend'], ['男朋友', '男友', 'boyfriend'],
  ['老婆', '妻子', '媳妇', 'wife'], ['老公', '丈夫', 'husband'],
]);
const KIN_CLASS = new Map<string, string>(KINSHIP.flatMap((row, index) => row.map(name => [name, `kin${index}`] as const)));
const OWN_PREFIXES = ['我的', '我', 'my'] as const;

/** The key two names share when they are surely the same (see the list above). */
export function sureKey(key: string): string {
  const direct = KIN_CLASS.get(key);
  if (direct) return direct;
  for (const prefix of OWN_PREFIXES) {
    if (!key.startsWith(prefix) || key.length <= prefix.length) continue;
    const rest = key.slice(prefix.length), kin = KIN_CLASS.get(rest);
    if (kin) return kin;
  }
  if (key.startsWith('我的') && Array.from(key).length - 2 >= 2) return key.slice(2);
  return key;
}

const POINTERS = ['那家', '那个', '那间', '那位', '这家', '这个', '这位'];
const LEADING = ['小', '老', '阿'];
const TRAILING = ['哥哥', '姐姐', '同学', '老师', '先生', '女士', '哥', '姐', '总', '君', '酱'];
/** The core of a name with pointers, "我的", honorifics and small suffixes off; used only to suggest. */
function looseKey(key: string): string {
  let core = key;
  for (const prefix of POINTERS) if (core.startsWith(prefix) && core.length > prefix.length) { core = core.slice(prefix.length); break; }
  if (core.startsWith('我的') && core.length > 2) core = core.slice(2);
  for (const prefix of LEADING) if (core.startsWith(prefix) && core.length > prefix.length) { core = core.slice(prefix.length); break; }
  for (const suffix of TRAILING) if (core.endsWith(suffix) && core.length > suffix.length) { core = core.slice(0, core.length - suffix.length); break; }
  return core;
}
const LATIN = /^[\p{Script=Latin}\p{N}]+$/u;
const unusableCore = (core: string) => !core || VAGUE_TERMS.has(core) || (LATIN.test(core) ? core.length < 3 : false);
const COMMON = new Set(['朋友', '同学', '老师', '老板', '家人', '孩子', '东西', '地方', '时候', '事情', '问题', '电影', '游戏', '工作', '学校', '公司', '家里']);

class Sets {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    for (let node = x; node !== root;) { const next = this.parent.get(node)!; this.parent.set(node, root); node = next; }
    return root;
  }
  add(x: string): void { if (!this.parent.has(x)) this.parent.set(x, x); }
  union(a: string, b: string): void { this.add(a); this.add(b); const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(rb, ra); }
}

interface Raw { key: string; texts: Map<string, number>; notes: Set<string>; kinds: Set<'person' | 'thing'>; first: number; last: number; virtual: boolean }

/** Gather the entries and the suggestions. Never throws on odd input; the same input always gives the same answer. */
export function gatherPeopleThings(notes: readonly PeopleNoteInput[], decisions: PeopleThingsDecisions): Gathered {
  const removed = new Set(decisions.removed);
  const raw = new Map<string, Raw>(), seen = new Set<string>();
  const sawName = (text: unknown, kind: 'person' | 'thing', note: PeopleNoteInput) => {
    if (typeof text !== 'string') return;
    const trimmed = text.normalize('NFKC').trim(), key = nameKey(trimmed);
    if (!key) return;
    seen.add(key);
    if (removed.has(key)) return;
    let item = raw.get(key);
    if (!item) {
      if (raw.size >= GATHER_LIMITS.names) return;
      item = { key, texts: new Map(), notes: new Set(), kinds: new Set(), first: note.at, last: note.at, virtual: false };
      raw.set(key, item);
    }
    item.texts.set(trimmed, (item.texts.get(trimmed) ?? 0) + 1);
    item.notes.add(note.recordId); item.kinds.add(kind);
    item.first = Math.min(item.first, note.at); item.last = Math.max(item.last, note.at);
  };
  for (const note of notes) {
    for (const text of note.people) sawName(text, 'person', note);
    for (const text of note.things) sawName(text, 'thing', note);
  }

  // Names only the user gave (a rename's new name, a manual join with a typed name) count when the other side is a real name.
  const labelText = new Map(decisions.labels.map(label => [label.key, label.text] as const));
  for (let round = 0; round < 2; round++) for (const [a, b] of decisions.joined) {
    for (const [here, there] of [[a, b], [b, a]] as const) {
      if (raw.has(here) || removed.has(here) || !raw.has(there)) continue;
      const base = raw.get(there)!;
      raw.set(here, { key: here, texts: new Map([[labelText.get(here) ?? here, 0]]), notes: new Set(), kinds: new Set(base.kinds), first: base.first, last: base.last, virtual: true });
    }
  }

  const sets = new Sets();
  for (const key of raw.keys()) sets.add(key);
  // The user's joins first (they win), then the sure merges unless the user kept the two apart.
  for (const [a, b] of decisions.joined) if (raw.has(a) && raw.has(b)) sets.union(a, b);
  const apart = new Set(decisions.apart.map(([a, b]) => pairKey(a, b)));
  const members = (root: string) => [...raw.keys()].filter(key => sets.find(key) === root);
  const crosses = (ra: string, rb: string): boolean => {
    if (!apart.size) return false;
    const left = members(ra), right = members(rb);
    return left.some(x => right.some(y => apart.has(pairKey(x, y))));
  };
  const bySure = new Map<string, string[]>();
  for (const key of [...raw.keys()].sort()) { const s = sureKey(key); (bySure.get(s) ?? bySure.set(s, []).get(s)!).push(key); }
  for (const group of bySure.values()) for (let i = 1; i < group.length; i++) {
    const ra = sets.find(group[0]!), rb = sets.find(group[i]!);
    if (ra !== rb && !crosses(ra, rb)) sets.union(group[0]!, group[i]!);
  }

  const groups = new Map<string, string[]>();
  for (const key of [...raw.keys()].sort()) { const root = sets.find(key); (groups.get(root) ?? groups.set(root, []).get(root)!).push(key); }
  const entries: PeopleThingsEntry[] = [];
  const noteTimes = new Map(notes.map(note => [note.recordId, note.at] as const));
  for (const keys of groups.values()) {
    const names: EntryName[] = keys.map(key => {
      const item = raw.get(key)!;
      const text = [...item.texts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]![0];
      return { key, text, notes: [...item.notes].sort() };
    });
    const everyNote = new Set<string>(names.flatMap(name => name.notes));
    if (!everyNote.size) continue;
    const label = [...decisions.labels].reverse().find(item => keys.includes(item.key));
    const top = [...names].sort((x, y) => y.notes.length - x.notes.length || x.key.localeCompare(y.key))[0]!;
    const kinds = new Set<'person' | 'thing'>(keys.flatMap(key => [...raw.get(key)!.kinds].filter(() => !raw.get(key)!.virtual)));
    const times = [...everyNote].map(id => noteTimes.get(id) ?? 0);
    const id = names[0]!.key;
    entries.push({ id, kind: kinds.has('person') ? 'person' : 'thing', name: label?.text ?? top.text, names,
      notes: [...everyNote].sort((x, y) => (noteTimes.get(y) ?? 0) - (noteTimes.get(x) ?? 0) || x.localeCompare(y)), firstAt: Math.min(...times), lastAt: Math.max(...times) });
  }
  entries.sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id));

  const live = new Set<string>(entries.flatMap(entry => entry.names.map(name => name.key)));
  return { entries, pending: suggest(entries, apart), live, seen };
}

const lengthOf = (text: string) => Array.from(text).length;
/** Substrings of a name worth checking as another name (two or more Han characters, three or more Latin letters). */
function pieces(key: string): string[] {
  const list = Array.from(key), out = new Set<string>();
  for (let size = 2; size < list.length; size++) for (let from = 0; from + size <= list.length; from++) {
    const piece = list.slice(from, from + size).join('');
    if (!(LATIN.test(piece) && piece.length < 3)) out.add(piece);
  }
  return [...out];
}

function suggest(entries: readonly PeopleThingsEntry[], apart: ReadonlySet<string>): PendingMerge[] {
  if (entries.length < 2) return [];
  const holder = new Map<string, number>();
  entries.forEach((entry, index) => { for (const name of entry.names) holder.set(name.key, index); });
  const noteOf = new Map<string, ReadonlySet<string>>();
  for (const entry of entries) for (const name of entry.names) noteOf.set(name.key, new Set(name.notes));
  const entryApart = new Set<string>();
  for (const pair of apart) { const [a, b] = pair.split('\u0000'); const x = holder.get(a!), y = holder.get(b!); if (x !== undefined && y !== undefined && x !== y) entryApart.add(`${Math.min(x, y)}|${Math.max(x, y)}`); }
  const found = new Map<string, { x: number; y: number; keyX: string; keyY: string; reason: 'core' | 'contain' }>();
  const consider = (keyA: string, keyB: string, reason: 'core' | 'contain') => {
    const x = holder.get(keyA), y = holder.get(keyB);
    if (x === undefined || y === undefined || x === y) return;
    const slot = `${Math.min(x, y)}|${Math.max(x, y)}`;
    if (entryApart.has(slot) || found.has(slot)) return;
    const left = noteOf.get(keyA)!, right = noteOf.get(keyB)!;
    for (const id of left) if (right.has(id)) return; // written side by side in one note: two different ones
    if (entries[x]!.kind !== entries[y]!.kind) return;
    found.set(slot, { x, y, keyX: keyA, keyY: keyB, reason });
  };
  const byCore = new Map<string, string[]>();
  for (const key of holder.keys()) { const core = looseKey(key); if (!unusableCore(core)) (byCore.get(core) ?? byCore.set(core, []).get(core)!).push(key); }
  for (const keys of byCore.values()) for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) consider(keys[i]!, keys[j]!, 'core');
  for (const key of holder.keys()) {
    if (key.includes('的') || lengthOf(key) < 3) continue;
    for (const piece of pieces(key)) {
      if (!holder.has(piece) || VAGUE_TERMS.has(piece) || COMMON.has(piece)) continue;
      consider(piece, key, 'contain');
    }
  }
  const side = (index: number, key: string): PendingSide => ({ key, name: entries[index]!.name, names: entries[index]!.names.map(name => name.text), chats: entries[index]!.notes.length });
  return [...found.values()].sort((p, q) => Math.min(entries[q.x]!.notes.length, entries[q.y]!.notes.length) - Math.min(entries[p.x]!.notes.length, entries[p.y]!.notes.length)
    || p.keyX.localeCompare(q.keyX) || p.keyY.localeCompare(q.keyY))
    .slice(0, GATHER_LIMITS.pending).map(item => ({ a: side(item.x, item.keyX), b: side(item.y, item.keyY), reason: item.reason }));
}
