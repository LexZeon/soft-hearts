// 体验记录 (the experience journal): the entry types of the cards part (角色卡): character.
// shared/memory/journal.ts joins every part's slice and keeps THE BOUNDARY written at its top: a line holds times, the character
// id, a type, fixed enum values, numbers and a plain-language reason from a fixed table; never a word of chat, a file path or a key.
// Moved here from shared/memory/journal.ts on 2026-11-16 (docs/claude/2026-11-16-journal-split.md) without changing a line it writes.
// THE RULE FOR A NEW ENTRY TYPE: it goes into its part's slice, shared/<part>/journal-entries.ts: its input shape in the part's
// <Part>JournalInput, its closed word lists beside it, its case in the slice's three functions (reason, build, describe) and its
// name in <PART>_JOURNAL_TYPES. Then its name goes into JOURNAL_TYPES in shared/memory/journal.ts, valid inputs for it into
// BASES in tests/helpers/journal-behaviour.ts, and both goldens are regenerated (scripts/dev/journal-surface.mjs --write,
// scripts/dev/journal-behaviour.ts --write), saying why in the commit. A part without a slice gets one: a new file like this, one
// entry in each of the four slice tables of shared/memory/journal.ts, and its names on the part's index.ts.
import { has, type JournalTranslate } from '../foundation/journal-fields';

export const CHARACTER_JOURNAL_EVENTS = ['activate', 'update', 'model-link', 'add', 'remove', 'greeting-first', 'greeting-new-chat'] as const;
/** 2026-11-25: why her greeting was shown: she never opened with the user (first), or the user began a new chat (new-chat). Closed; no text. */
export type GreetingWhy = 'first' | 'new-chat';
export type CharacterJournalEvent = (typeof CHARACTER_JOURNAL_EVENTS)[number];
const CHARACTER_REASON: Readonly<Record<CharacterJournalEvent, string>> = {
  activate: '换成了这个角色', update: '角色卡更新了', 'model-link': '角色关联的模型变了', add: '新增了角色卡', remove: '删除了角色卡',
  'greeting-first': '她第一次见到你，说了自己的开场问候', 'greeting-new-chat': '新对话开始，她说了自己的开场问候',
};

/** The journal entry types of this part, in JOURNAL_TYPES order (shared/memory/journal.ts dispatches by it). */
export const CARDS_JOURNAL_TYPES = ['character'] as const;

/** What a caller hands to the writer for this part's types (shared/memory/journal.ts JournalInput joins every part's). */
export type CardsJournalInput =
  | { type: 'character'; characterId: string; event: CharacterJournalEvent; linked?: boolean };

// ---------------------------------------------------------------- the fixed plain-language reasons

/** The fixed reason of this part's entries (shared/memory/journal.ts journalReason). Only enum fields choose it; nothing a caller wrote can reach it. */
export function cardsJournalReason(entry: CardsJournalInput): string {
  switch (entry.type) {
    case 'character': return CHARACTER_REASON[entry.event];
  }
}

// ---------------------------------------------------------------- building a line (the whitelist)

/**
 * This part's lines, field by field from closed sets (shared/memory/journal.ts buildJournalEntry checked the input, the type and the
 * character id, and adds the version, the time and the reason). Null when anything does not fit.
 */
export function buildCardsJournalEntry(type: string, v: Record<string, unknown>, characterId: string | null): CardsJournalInput | null {
  let body: CardsJournalInput | null = null;
  switch (type) {
    case 'character':
      if (!characterId || !has(CHARACTER_JOURNAL_EVENTS, v.event)) return null;
      body = { type, characterId, event: v.event, ...(typeof v.linked === 'boolean' ? { linked: v.linked } : {}) };
      break;
  }
  return body;
}

// ---------------------------------------------------------------- "刚才发生了什么": one plain line per entry

/** This part's entries in the control window, after the time (shared/memory/journal.ts describeJournalEntry); `reason` is the entry's reason, translated. */
export function describeCardsJournalEntry(entry: CardsJournalInput, reason: string, tr: JournalTranslate): string {
  let body: string;
  switch (entry.type) {
    default: body = reason;
  }
  return body;
}
