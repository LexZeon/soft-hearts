// I-014 回收站 (Claude's suggestion, revocable): "删除记忆 / 日记 / 画像" through the agent channel never deletes for good at
// once. A character's chat memory (`chat`) or her profile with her diary (`profile`, one file per connection) goes into
// her recycle bin first and can be put back until it expires. Every connection scope the character may have memories
// under is covered, like C2's "同时删除她的记忆" (electron/character-forget.ts). Familiarity, nickname, text memorials,
// transcripts and the card itself are never touched here. No Electron import: tests drive it with real stores.
import type { AgentRecyclePart } from '../shared/agent-channel';
import type { MemoryScope } from '../shared/memory';
import type { MemoryRecycleBin, RecycleSummaryView } from './memory-recycle-bin';
import { characterProviderScopes } from './character-forget';

export interface RecoverableForgetPorts {
  /** The connection scopes this character's memories may sit under (forgettableProviderScopes). */
  providerScopes(): string[];
  chat: {
    forgetScope(scope: MemoryScope, keep: (records: unknown[]) => Promise<void>): Promise<number>;
    /** `owner`: the character and connection the records were forgotten from. */
    restoreRecords(records: readonly unknown[], owner?: MemoryScope): Promise<number>;
    /** I-021 删除一致性: the other connections she was talked to under (MemoryStore.providerScopesOf); joined to providerScopes(). */
    providerScopesOf?(characterId: string): string[];
  };
  profiles: {
    forgetScope(scope: MemoryScope, keep: (stored: unknown) => Promise<void>): Promise<boolean>;
    restoreScope(scope: MemoryScope, stored: unknown, keepReplaced: (current: unknown) => Promise<void>): Promise<void>;
  } | null;
  bin: MemoryRecycleBin;
  /**
   * I-048: her watch notes (descriptions, summaries and their keywords) follow her chat memory through the same bin: they ride in the
   * chat entry's data, stop being recalled when it is made, come back with it, and go when it is purged. Absent: nothing changes.
   */
  watch?: {
    /** The character's watch notes as they are now (the notes carry their keywords); [] when there are none. */
    snapshot(characterId: string): Promise<unknown[]>;
    /** Delete them now (notes, their keywords, cached screenshots): after the entry holding them is safely in the bin. */
    remove(characterId: string): Promise<void>;
    /** Put the notes back (and their keywords). */
    restore(characterId: string, notes: readonly unknown[]): Promise<void>;
  };
}

export interface ForgetOutcome { entries: RecycleSummaryView[]; empty: AgentRecyclePart[]; failed: AgentRecyclePart[] }
export interface RestoreOutcome { restored: RecycleSummaryView; count: number; replaced: RecycleSummaryView | null }

interface ChatData { kind: 'chat'; providerScope: string; records: unknown[]; watch?: unknown[] }
interface ProfileData { kind: 'profile'; providerScope: string; stored: unknown }

const PARTS: readonly AgentRecyclePart[] = ['chat', 'profile'];
export const RECYCLE_PART_LABELS: Readonly<Record<AgentRecyclePart, string>> = Object.freeze({ chat: '聊天记忆', profile: '画像和日记' });

function profileCounts(stored: unknown): { entries: number; diary: number } {
  const value = stored as { entries?: unknown; diary?: unknown } | null;
  return { entries: Array.isArray(value?.entries) ? value.entries.length : 0, diary: Array.isArray(value?.diary) ? value.diary.length : 0 };
}
const profileLabel = (stored: unknown) => { const { entries, diary } = profileCounts(stored); return `画像 ${entries} 条、日记 ${diary} 天`; };

export function recyclePartsInput(value: unknown): AgentRecyclePart[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PARTS.length) throw new Error('要删的部分只能是 chat、profile 里的一两项。');
  const parts: AgentRecyclePart[] = [];
  for (const item of value) {
    if (!PARTS.includes(item as AgentRecyclePart) || parts.includes(item)) throw new Error('要删的部分只能是 chat、profile 里的一两项，不能重复。');
    parts.push(item as AgentRecyclePart);
  }
  return parts;
}

/**
 * Moves each part, scope by scope, into the bin. The bin entry is written before the store removes anything; a scope
 * whose entry could not be written keeps its memories (reported in `failed`). A part with nothing in it is `empty`.
 * I-021 删除一致性: a scope whose store could not remove them after its entry was written also keeps them, and that entry
 * is taken out of the bin again: a copy left there could later bring back what the user then deletes for good.
 */
export async function forgetRecoverably(characterId: string, characterName: string, parts: readonly AgentRecyclePart[], ports: RecoverableForgetPorts): Promise<ForgetOutcome> {
  const outcome: ForgetOutcome = { entries: [], empty: [], failed: [] };
  // Every connection she has memories under, the ones the archive learned included (a model typed earlier); fixed for the call.
  const scopes = characterProviderScopes(characterId, ports.providerScopes(), id => ports.chat.providerScopesOf?.(id) ?? []);
  for (const part of parts) {
    let found = false, failed = false;
    // The watch notes ride in the first chat entry made for the character (or in one of their own when she has no chat memory).
    let watch: unknown[] = [], watchPlaced = false;
    if (part === 'chat' && ports.watch) { try { watch = await ports.watch.snapshot(characterId); } catch { watch = []; } }
    for (const providerScope of scopes) {
      const scope = { characterId, providerScope };
      const placed: RecycleSummaryView[] = [];
      const keep = async (input: Parameters<MemoryRecycleBin['put']>[0], data: ChatData | ProfileData) => {
        const entry = await ports.bin.put(input, data);
        placed.push(entry); outcome.entries.push(entry);
      };
      try {
        if (part === 'chat') {
          const count = await ports.chat.forgetScope(scope, records => {
            const carried = watch.length && !watchPlaced ? watch : undefined;
            const label = `聊天记忆 ${records.length} 段${carried ? `、看剧笔记 ${carried.length} 条` : ''}`;
            return keep({ characterId, characterName, part, count: records.length, label }, { kind: 'chat', providerScope, records, ...(carried ? { watch: carried } : {}) })
              .then(() => { if (carried) watchPlaced = true; });
          });
          if (count) found = true;
        } else {
          if (!ports.profiles) continue;
          const removed = await ports.profiles.forgetScope(scope, stored => {
            const { entries, diary } = profileCounts(stored);
            return keep({ characterId, characterName, part, count: entries + diary, label: profileLabel(stored) }, { kind: 'profile', providerScope, stored });
          });
          if (removed) found = true;
        }
      } catch {
        failed = true;
        for (const entry of placed) {
          outcome.entries.splice(outcome.entries.indexOf(entry), 1);
          await ports.bin.discard(entry.id).catch(() => { /* No longer offered in this run; the bin's next load clears what is left. */ });
        }
      }
    }
    if (!failed && part === 'chat' && ports.watch && watch.length) {
      try {
        if (!watchPlaced) {
          // No chat memory to carry them: their own entry, so they are restorable all the same.
          const entry = await ports.bin.put({ characterId, characterName, part, count: 0, label: `看剧笔记 ${watch.length} 条` },
            { kind: 'chat', providerScope: scopes[0] ?? '', records: [], watch } satisfies ChatData);
          outcome.entries.push(entry); found = true;
        }
        await ports.watch.remove(characterId); // only now, with the notes safe in the bin
      } catch { failed = true; }
    }
    if (failed) outcome.failed.push(part);
    else if (!found) outcome.empty.push(part);
  }
  return outcome;
}

/** Puts one entry back. A profile the character has again is swapped into the bin first (nothing is lost). */
export async function restoreRecoverably(entryId: unknown, ports: RecoverableForgetPorts): Promise<RestoreOutcome> {
  const { summary, data } = await ports.bin.read(entryId);
  const value = data as { kind?: unknown; providerScope?: unknown; records?: unknown; stored?: unknown } | null;
  if (!value || value.kind !== summary.part || typeof value.providerScope !== 'string' || !value.providerScope)
    throw new Error('回收站里这一项的数据不完整，原文件已保留。');
  const scope = { characterId: summary.characterId, providerScope: value.providerScope };
  let count = 0, replaced: RecycleSummaryView | null = null;
  if (summary.part === 'chat') {
    if (!Array.isArray(value.records)) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
    count = await ports.chat.restoreRecords(value.records, scope);
    const watch = (value as { watch?: unknown }).watch;
    if (ports.watch && Array.isArray(watch) && watch.length) await ports.watch.restore(summary.characterId, watch);
  } else {
    if (!ports.profiles) throw new Error('用户画像尚未就绪，稍后再试。');
    await ports.profiles.restoreScope(scope, value.stored, async current => {
      const { entries, diary } = profileCounts(current);
      replaced = await ports.bin.put({ characterId: summary.characterId, characterName: summary.characterName, part: 'profile',
        count: entries + diary, label: `${profileLabel(current)}（找回旧的时换下来的）` }, { kind: 'profile', providerScope: scope.providerScope, stored: current } satisfies ProfileData);
    });
    count = summary.count;
  }
  await ports.bin.remove(summary.id);
  return { restored: summary, count, replaced };
}
