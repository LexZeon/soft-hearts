// I-089 item 2 「记忆会更新，而且记得对」 (docs/claude/2026-11-12-i089-item-2.md). When the user says something changed ("我搬家了", "不是周三是周四",
// "你记错了"), the note written for that talk carries the change as `{was, now}` (the model that writes the note already reads the talk; no extra
// call). Here, locally: which OLDER notes does a newer change speak about, so recall can put "后来更新了" beside the old excerpt instead of letting
// it pass for current. Nothing is deleted or rewritten: the old note and the original chat stay as they were (history), and the older
// excerpt is only marked. Pure: no clock, no I/O.
//
// Idea borrowed (not code): Graphiti keeps a fact's validity in time and marks stale ones instead of deleting; mem0 decides, when a new memory
// comes in, whether it adds to, updates or voids an old one; Kin Mind hangs a correction beside the original record.

import type { MemoryNoteBody, MemoryNoteChange, MemoryNoteUpdate } from './interface';
import { MEMORY_NOTES_KNOBS, type MemoryNotesKnobs } from './knobs';
import { squashText } from './recall';

const bigrams = (key: string): string[] => {
  const chars = Array.from(key);
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  return [...out];
};
/** What an old note says, in matching form (title, summary, things, plans, tags and people). */
const noteText = (body: MemoryNoteBody): string => squashText([body.title, body.summary, ...body.things, ...body.plans, ...body.tags, ...body.people].join(' '));

/** Does this change speak about this (older) note? The whole "was" phrase is in it, or enough of the phrase's character pairs are. */
export function changeSpeaksAbout(change: MemoryNoteChange, old: MemoryNoteBody, knobs: MemoryNotesKnobs = MEMORY_NOTES_KNOBS): boolean {
  const was = squashText(change.was), text = noteText(old);
  if (Array.from(was).length < 2 || !text) return false;
  if (text.includes(was)) return true;
  const pairs = bigrams(was);
  if (pairs.length < knobs.update.minPairs) return false;
  const hit = pairs.filter(pair => text.includes(pair)).length;
  return hit >= knobs.update.minPairs && hit / pairs.length >= knobs.update.minShare;
}

export interface UpdateSource {
  readonly recordId: string;
  readonly at: number;
  readonly body: MemoryNoteBody;
}

/**
 * The updates that apply to `target`: changes written in notes of LATER talks (never itself, never an earlier one) that speak about it.
 * Newest first, at most knobs.update.maxShown, one per distinct "now" (a change said twice is one). `sources` should already exclude
 * notes the user deleted.
 */
export function updatesFor(target: UpdateSource, sources: Iterable<UpdateSource>, knobs: MemoryNotesKnobs = MEMORY_NOTES_KNOBS): MemoryNoteUpdate[] {
  const found: (MemoryNoteUpdate & { at: number })[] = [];
  for (const source of sources) {
    if (source.recordId === target.recordId || source.at <= target.at || !source.body.changes?.length) continue;
    for (const change of source.body.changes) {
      if (changeSpeaksAbout(change, target.body, knobs)) found.push({ was: change.was, now: change.now, at: source.at });
    }
  }
  found.sort((a, b) => b.at - a.at);
  const seen = new Set<string>(), out: MemoryNoteUpdate[] = [];
  for (const item of found) {
    const key = squashText(item.now);
    if (seen.has(key)) continue;
    seen.add(key); out.push({ was: item.was, now: item.now });
    if (out.length >= Math.max(1, knobs.update.maxShown)) break;
  }
  return out;
}

/** The line put before an old excerpt. It says what the user said later; it does not decide for her (the later word wins, the old one is history). */
export function updateMarker(updates: readonly MemoryNoteUpdate[]): string {
  const clean = (value: string) => value.replace(/[<>\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const parts = updates.map(item => `原来是“${clean(item.was)}”，后来用户说的是“${clean(item.now)}”`).join('；');
  return `【后来有更新：${parts}。下面这段是更早的话，涉及这件事的以后来的为准，别再当成现在的情况说，也别用旧说法去纠正用户。】`;
}
