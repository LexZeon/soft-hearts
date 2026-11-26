// I-144 回收站 (electron/memory/recycle/ports.ts): a character's part of a shared store, copied with its place so it can go back exactly where
// it was (the shared file then reads byte for byte as before). In the foundation because stores of several parts use it. No I/O.

/** A key's value and its place among the object's keys. */
export interface KeyedPart<V = unknown> { at: number; value: V }

/** Her part of a keyed object (a copy), or null. */
export function takeKeyed<V>(object: Record<string, V>, key: string): KeyedPart<V> | null {
  if (!Object.hasOwn(object, key)) return null;
  return { at: Object.keys(object).indexOf(key), value: structuredClone(object[key]!) };
}

/** A new object with `key` = value at its old place (other keys keep their order). */
export function putKeyed<V>(object: Record<string, V>, key: string, part: KeyedPart<V>): Record<string, V> {
  const entries = Object.entries(object).filter(([name]) => name !== key);
  const at = Number.isInteger(part.at) ? Math.max(0, Math.min(entries.length, part.at)) : entries.length;
  entries.splice(at, 0, [key, part.value]);
  return Object.fromEntries(entries);
}

/** Items of a list that are hers, each with its place. */
export interface ListedPart<V = unknown> { items: { at: number; value: V }[] }

export function takeListed<V>(list: readonly V[], mine: (item: V) => boolean): ListedPart<V> | null {
  const items = list.flatMap((value, at) => mine(value) ? [{ at, value: structuredClone(value) }] : []);
  return items.length ? { items } : null;
}

/** A new list with her items back at their places (in the order they were taken, so the places line up again). */
export function putListed<V>(list: readonly V[], part: ListedPart<V>, same: (a: V, b: V) => boolean = () => false): V[] {
  if (!part || !Array.isArray(part.items) || part.items.some(item => !item || !Number.isInteger(item.at))) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
  const out = list.filter(item => !part.items.some(taken => same(taken.value, item)));
  for (const { at, value } of [...part.items].sort((a, b) => a.at - b.at)) out.splice(Math.max(0, Math.min(out.length, at)), 0, value);
  return out;
}

/** The keys of an object that are hers (say, every `${characterId}|…` key), each entry with its place. */
export function takeEntries<V>(object: Record<string, V>, mine: (key: string) => boolean): ListedPart<[string, V]> | null {
  return takeListed(Object.entries(object), ([key]) => mine(key));
}

/** A new object with her entries back at their places (a key present now is replaced by the one taken). */
export function putEntries<V>(object: Record<string, V>, part: ListedPart<[string, V]>): Record<string, V> {
  if (!part || !Array.isArray(part.items) || part.items.some(item => !Array.isArray(item?.value) || typeof item.value[0] !== 'string')) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
  return Object.fromEntries(putListed(Object.entries(object), part, (a, b) => a[0] === b[0]));
}

/** The object without the keys that are hers. */
export function dropEntries<V>(object: Record<string, V>, mine: (key: string) => boolean): Record<string, V> {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !mine(key)));
}
