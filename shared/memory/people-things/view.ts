// I-088 item 2: what the control window's page "你生活里的人和事" shows and may ask for. Names, counts and times only: no chat text, no note
// ids. The window can only name an entry by one of its names (matching form), and the host checks that the name still exists.

import type { PeopleThingsEntry, PendingMerge } from './gather';

export const PEOPLE_THINGS_VIEW_ROWS = 300;

export interface PeopleThingsRow {
  readonly kind: 'person' | 'thing';
  /** The name shown. */
  readonly name: string;
  /** A name of the entry in matching form: what the page sends back to name this row. */
  readonly key: string;
  readonly names: readonly { readonly key: string; readonly text: string }[];
  /** In how many chats she wrote it down. */
  readonly chats: number;
  readonly firstAt: number;
  readonly lastAt: number;
}
export interface PeopleThingsPending {
  readonly a: { readonly key: string; readonly name: string; readonly names: readonly string[]; readonly chats: number };
  readonly b: { readonly key: string; readonly name: string; readonly names: readonly string[]; readonly chats: number };
}
export interface PeopleThingsView {
  readonly rows: readonly PeopleThingsRow[];
  /** All entries; `rows` shows the newest PEOPLE_THINGS_VIEW_ROWS. */
  readonly total: number;
  readonly pending: readonly PeopleThingsPending[];
}
export const EMPTY_PEOPLE_THINGS_VIEW: PeopleThingsView = Object.freeze({ rows: [], total: 0, pending: [] });

export type PeopleThingsOp =
  | { readonly kind: 'rename'; readonly key: string; readonly text: string }
  | { readonly kind: 'merge' | 'confirm' | 'refuse'; readonly key: string; readonly other: string }
  | { readonly kind: 'split' | 'delete'; readonly key: string };

export function peopleThingsView(entries: readonly PeopleThingsEntry[], pending: readonly PendingMerge[]): PeopleThingsView {
  return {
    total: entries.length,
    rows: entries.slice(0, PEOPLE_THINGS_VIEW_ROWS).map(entry => ({ kind: entry.kind, name: entry.name, key: entry.names[0]!.key,
      names: entry.names.map(name => ({ key: name.key, text: name.text })), chats: entry.notes.length, firstAt: entry.firstAt, lastAt: entry.lastAt })),
    pending: pending.map(item => ({ a: { key: item.a.key, name: item.a.name, names: [...item.a.names], chats: item.a.chats },
      b: { key: item.b.key, name: item.b.name, names: [...item.b.names], chats: item.b.chats } })),
  };
}

/** The window's request, checked: exactly the fields of its kind, strings of sane length. Null when it is not one. */
export function readPeopleThingsOp(value: unknown): PeopleThingsOp | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>, keys = Object.keys(v).sort().join(',');
  const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200;
  switch (v.kind) {
    case 'rename': return keys === 'key,kind,text' && text(v.key) && text(v.text) ? { kind: 'rename', key: v.key, text: v.text } : null;
    case 'merge': case 'confirm': case 'refuse': return keys === 'key,kind,other' && text(v.key) && text(v.other) ? { kind: v.kind, key: v.key, other: v.other } : null;
    case 'split': case 'delete': return keys === 'key,kind' && text(v.key) ? { kind: v.kind, key: v.key } : null;
    default: return null;
  }
}
