// P-001: the list of things she remembers, as pure functions over `UpcomingStored` (shared/behaviors/upcoming/interface.ts). Both the real
// book (profile file) and the fake book (memory) use these, so they cannot disagree. No clock, no I/O: the caller passes `now`.

import {
  UPCOMING_STATES, type UpcomingCandidate, type UpcomingItem, type UpcomingShown, type UpcomingState, type UpcomingStored,
} from './interface';
import { UPCOMING_KNOBS, type UpcomingKnobs } from './knobs';

const DAY = 86_400_000;
/** The `from` of an item the developer test command made (no chat segment behind it). */
export const DEV_SEGMENT_PREFIX = 'dev:';
export const emptyUpcoming = (): UpcomingStored => ({ items: [], blockedFrom: [] });
export const isEmptyUpcoming = (state: UpcomingStored | undefined | null): boolean => !state || (!state.items.length && !state.blockedFrom.length);
/** What a file keeps: undefined (the key is not written) when there is nothing at all. */
export const compactUpcoming = (state: UpcomingStored): UpcomingStored | undefined => isEmptyUpcoming(state) ? undefined : state;

const squash = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const length = (value: string) => Array.from(value).length;

/** Expired plans and long-closed ones go: waiting items past `expiresAt` become expired; asked / user-said / expired items older than purgeDays leave. */
export function settleUpcoming(state: UpcomingStored, now: number, knobs: UpcomingKnobs = UPCOMING_KNOBS): { state: UpcomingStored; expired: number } {
  let expired = 0;
  const items: UpcomingItem[] = [];
  for (const item of state.items) {
    if (item.state === 'waiting' && now > item.expiresAt) { expired++; items.push({ ...item, state: 'expired', changedAt: now }); continue; }
    if (item.state !== 'waiting' && now - item.changedAt > knobs.keep.purgeDays * DAY) continue;
    items.push(item);
  }
  const changed = expired > 0 || items.length !== state.items.length;
  return { state: changed ? { items, blockedFrom: state.blockedFrom } : state, expired };
}

/**
 * New candidates from one segment's note. Nothing is added when the segment was blocked (the user deleted something that came from it),
 * when the same thing (same segment and moment, or same words and moment) is already there, or when the list is full (it never pushes an
 * older one out). `ids` gives each new item its id. Returns the new state and how many were added.
 */
export function addUpcoming(state: UpcomingStored, input: { from: string; items: readonly UpcomingCandidate[] }, now: number, ids: () => string,
  knobs: UpcomingKnobs = UPCOMING_KNOBS): { state: UpcomingStored; added: number } {
  if (state.blockedFrom.includes(input.from)) return { state, added: 0 };
  const items = [...state.items];
  let added = 0;
  for (const candidate of input.items.slice(0, knobs.text.perNote)) {
    if (items.length >= knobs.keep.maxPerCharacter) break;
    const key = squash(candidate.what);
    if (items.some(item => (item.from === input.from && item.dueAt === candidate.dueAt) || (squash(item.what) === key && item.dueAt === candidate.dueAt))) continue;
    items.push({ id: ids(), from: input.from, what: candidate.what, said: candidate.said, dueAt: candidate.dueAt,
      expiresAt: candidate.dueAt + knobs.keep.expireDays * DAY, state: 'waiting', createdAt: now, changedAt: now });
    added++;
  }
  return { state: added ? { items, blockedFrom: state.blockedFrom } : state, added };
}

const block = (blocked: readonly string[], from: readonly string[], knobs: UpcomingKnobs): string[] =>
  [...new Set([...blocked, ...from])].slice(-knobs.keep.maxBlockedSegments);

/** The user deleted one: gone, and its segment's note adds nothing more. */
export function removeUpcoming(state: UpcomingStored, id: string, knobs: UpcomingKnobs = UPCOMING_KNOBS): { state: UpcomingStored; removed: number } {
  const item = state.items.find(entry => entry.id === id);
  if (!item) return { state, removed: 0 };
  return { state: { items: state.items.filter(entry => entry.id !== id), blockedFrom: block(state.blockedFrom, [item.from], knobs) }, removed: 1 };
}

/** The user cleared the list: every segment it came from is blocked. */
export function clearUpcoming(state: UpcomingStored, knobs: UpcomingKnobs = UPCOMING_KNOBS): { state: UpcomingStored; removed: number } {
  if (!state.items.length) return { state, removed: 0 };
  return { state: { items: [], blockedFrom: block(state.blockedFrom, state.items.map(item => item.from), knobs) }, removed: state.items.length };
}

/** Those chat memories (or their notes) went: what came from them goes, and they leave the blocked list (nothing is left to block). */
export function dropUpcomingSegments(state: UpcomingStored, ids: readonly string[]): { state: UpcomingStored; removed: number } {
  const gone = new Set(ids);
  const items = state.items.filter(item => !gone.has(item.from));
  const blockedFrom = state.blockedFrom.filter(id => !gone.has(id));
  const removed = state.items.length - items.length;
  return { state: removed || blockedFrom.length !== state.blockedFrom.length ? { items, blockedFrom } : state, removed };
}

/** Keeps only what came from a segment that still exists (the host reconciles with the chat archive now and then). */
export function keepUpcomingSegments(state: UpcomingStored, existing: ReadonlySet<string>): { state: UpcomingStored; removed: number } {
  // 'dev:' ids are the developer test commands' own (no chat segment stands behind them).
  const there = (id: string) => existing.has(id) || id.startsWith(DEV_SEGMENT_PREFIX);
  const items = state.items.filter(item => there(item.from));
  const blockedFrom = state.blockedFrom.filter(there);
  const removed = state.items.length - items.length;
  return { state: removed || blockedFrom.length !== state.blockedFrom.length ? { items, blockedFrom } : state, removed };
}

/** Step 2 and 3 use these: a plan that is due now (waiting, due time passed, not expired), earliest first. */
export function dueUpcoming(state: UpcomingStored, now: number): UpcomingItem[] {
  return state.items.filter(item => item.state === 'waiting' && item.dueAt <= now && now <= item.expiresAt).sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
}
export function markUpcoming(state: UpcomingStored, id: string, to: 'asked' | 'user-said', now: number): UpcomingStored {
  if (!state.items.some(item => item.id === id && item.state === 'waiting')) return state;
  return { items: state.items.map(item => item.id === id ? { ...item, state: to, changedAt: now } : item), blockedFrom: state.blockedFrom };
}

/** Several plans at once (those still waiting only). Returns the new state and how many changed. */
export function markUpcomingMany(state: UpcomingStored, ids: readonly string[], to: 'asked' | 'user-said', now: number): { state: UpcomingStored; changed: number } {
  const wanted = new Set(ids);
  let changed = 0;
  const items = state.items.map(item => { if (!wanted.has(item.id) || item.state !== 'waiting') return item; changed++; return { ...item, state: to, changedAt: now }; });
  return { state: changed ? { items, blockedFrom: state.blockedFrom } : state, changed };
}

/** Developer test: the earliest waiting plan is due right now (its due time one minute ago). */
export function makeUpcomingDue(state: UpcomingStored, now: number, knobs: UpcomingKnobs = UPCOMING_KNOBS): { state: UpcomingStored; changed: boolean } {
  const waiting = state.items.filter(item => item.state === 'waiting').sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))[0];
  if (!waiting) return { state, changed: false };
  const dueAt = now - 60_000;
  return { state: { items: state.items.map(item => item.id === waiting.id ? { ...item, dueAt, expiresAt: dueAt + knobs.keep.expireDays * DAY } : item), blockedFrom: state.blockedFrom }, changed: true };
}

/** What the panel shows: soonest first; expired ones last. */
export function shownUpcoming(state: UpcomingStored | undefined | null, now: number, knobs: UpcomingKnobs = UPCOMING_KNOBS): UpcomingShown[] {
  if (!state) return [];
  return settleUpcoming(state, now, knobs).state.items.map(({ id, what, said, dueAt, state: s }) => ({ id, what, said, dueAt, state: s }))
    .sort((a, b) => Number(a.state === 'expired') - Number(b.state === 'expired') || a.dueAt - b.dueAt || a.id.localeCompare(b.id));
}

const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const plainId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !CONTROL.test(value);
const phrase = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() === value && !!value && length(value) <= max && !CONTROL.test(value);
const KEYS = ['id', 'from', 'what', 'said', 'dueAt', 'expiresAt', 'state', 'createdAt', 'changedAt'];

/** Strict, for what comes back from disk: throws on anything it does not expect (the profile file is then left as it is). */
export function validateUpcoming(value: unknown, knobs: UpcomingKnobs = UPCOMING_KNOBS): UpcomingStored {
  const fail = (): never => { throw Error('她记得的事格式不正确。'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  const names = Object.keys(v);
  if (names.length !== 2 || !names.includes('items') || !names.includes('blockedFrom')) return fail();
  if (!Array.isArray(v.items) || v.items.length > knobs.keep.maxPerCharacter || !Array.isArray(v.blockedFrom) || v.blockedFrom.length > knobs.keep.maxBlockedSegments
    || !v.blockedFrom.every(plainId)) return fail();
  const ids = new Set<string>();
  for (const item of v.items as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail();
    const i = item as Record<string, unknown>;
    if (Object.keys(i).length !== KEYS.length || !KEYS.every(key => key in i)) return fail();
    if (!plainId(i.id) || ids.has(i.id) || !plainId(i.from) || !phrase(i.what, knobs.text.whatChars + 10) || !phrase(i.said, knobs.text.saidChars + 10)
      || !whole(i.dueAt) || !whole(i.expiresAt) || !whole(i.createdAt) || !whole(i.changedAt) || !(UPCOMING_STATES as readonly unknown[]).includes(i.state as UpcomingState)) return fail();
    ids.add(i.id);
  }
  return structuredClone(value) as UpcomingStored;
}
