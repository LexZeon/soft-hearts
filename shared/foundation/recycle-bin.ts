// I-144 回收站: what the
// windows and the agent channel see of the recycle bin. Names, kinds, counts and times only: the removed data itself never leaves the host
// (electron/memory/memory-recycle-bin.ts keeps it in a file no IPC path reads).

/**
 * What an entry holds.
 *  - 'chat' / 'profile': what the user's Claude deleted through the agent channel (I-014): a character's chat memory, or her profile and
 *    diary (with her plans, look-backs, her note and the moving memory, I-144).
 *  - 'character': a deleted character: her card and model binding, and, when "同时删除她的记忆" was ticked, everything she remembered.
 *  - 'memory-note' / 'moving-memory' / 'listen-note': one thing deleted in its own panel.
 *  - I-144b (every single deletion goes into the bin first), one thing or one clear in its own panel:
 *    'chat-record' one chat record (记忆页「删除这段记录」), 'ambient-transcript' one heard-sound transcript, 'listen-raw' 「清空原文」,
 *    'song-memory' 「清除她记得的歌」, 'profile-entry' one thing she noted about you, 'diary-day' / 'diary-all' one diary day / the whole
 *    diary, 'review' one look-back, 'plan' / 'plans-all' one plan / every plan, 'nickname' what she calls you, 'her-nickname' one name you call her (Unbound v1 step 3), 'text-memorial' one text
 *    memorial, 'our-thing' one of 我们的小东西 (with its picture), 'assistant-chat' the Claude assistant's conversation (「清空」).
 */
export type RecycleEntryKind = 'chat' | 'profile' | 'character' | 'memory-note' | 'moving-memory' | 'listen-note'
  | 'chat-record' | 'ambient-transcript' | 'listen-raw' | 'song-memory' | 'profile-entry' | 'diary-day' | 'diary-all' | 'review'
  | 'plan' | 'plans-all' | 'nickname' | 'her-nickname' | 'card-milestone' | 'object-note' | 'text-memorial' | 'our-thing' | 'assistant-chat';
export const RECYCLE_ENTRY_KINDS: readonly RecycleEntryKind[] = ['chat', 'profile', 'character', 'memory-note', 'moving-memory', 'listen-note',
  'chat-record', 'ambient-transcript', 'listen-raw', 'song-memory', 'profile-entry', 'diary-day', 'diary-all', 'review',
  'plan', 'plans-all', 'nickname', 'her-nickname', 'card-milestone', 'object-note', 'text-memorial', 'our-thing', 'assistant-chat'];
/** I-144b: the kinds a panel deletes one at a time (or clears at once), each found back in that panel's 「最近删除的」. */
export const RECYCLE_ITEM_KINDS = ['memory-note', 'moving-memory', 'listen-note', 'chat-record', 'ambient-transcript', 'listen-raw', 'song-memory',
  'profile-entry', 'diary-day', 'diary-all', 'review', 'plan', 'plans-all', 'nickname', 'her-nickname', 'card-milestone', 'object-note', 'text-memorial', 'our-thing', 'assistant-chat'] as const satisfies readonly RecycleEntryKind[];
export type RecycleItemKind = (typeof RECYCLE_ITEM_KINDS)[number];
/** I-144b: the Claude assistant's conversation belongs to no character; its entries are filed under this owner (its panel lists them). */
export const RECYCLE_ASSISTANT_OWNER = 'claude-assistant';

export interface RecycleSummary {
  id: string;
  characterId: string;
  characterName: string;
  part: RecycleEntryKind;
  count: number;
  /** Host-written, e.g. "聊天记忆 12 段", "角色卡和她的全部记忆". */
  label: string;
  deletedAt: number;
  expiresAt: number;
  /** 'character' only: her memories are in it too (the box was ticked). */
  memories?: boolean;
  /** I-144b: when the deleted thing is from (a chat's or a diary day's date, a look-back's first day), so a window can say "11月10日的日记". */
  itemAt?: number;
}

export interface RecycleBinView {
  /** Days an entry stays (1–30, default 7). */
  days: number;
  /** Newest first. */
  entries: RecycleSummary[];
  /** False while the bin has not loaded (or could not): deleting then keeps everything where it is. */
  ready: boolean;
}

export const RECYCLE_DAYS_MIN = 1;
export const RECYCLE_DAYS_MAX = 30;
export const RECYCLE_DAYS_DEFAULT = 7;
