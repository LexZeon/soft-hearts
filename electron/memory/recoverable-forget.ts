// I-014 回收站 (Claude's suggestion, revocable): "删除记忆 / 日记 / 画像" through the agent channel never deletes for good at
// once. A character's chat memory (`chat`) or her profile with her diary (`profile`, one file per connection) goes into
// her recycle bin first and can be put back until it expires. Every connection scope the character may have memories
// under is covered, like C2's "同时删除她的记忆" (electron/cards/character-forget.ts). Familiarity, nickname, text memorials,
// transcripts and the card itself are never touched here. No Electron import: tests drive it with real stores.
import type { AgentRecyclePart } from '../../shared/safety';
import type { MemoryScope } from '../../shared/memory/memory';
import type { MemoryRecycleBin, RecycleSummaryView } from './memory-recycle-bin';
import { characterProviderScopes } from '../cards';
import type { ScopePort } from './recycle/ports';

/** I-144: what rides in the profile part's entry with her profile and diary, in this order. */
export const PROFILE_EXTRA_ROWS = ['upcoming-plans', 'period-reviews', 'her-note', 'moving-memory'] as const;
export type ProfileExtraRow = typeof PROFILE_EXTRA_ROWS[number];

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
  /**
   * 边说边演: what describes her replies (their beats and grey lines, no words) rides in the chat entry of its connection: captured before the
   * chat is forgotten (the chat store drops the entries of the removed turns itself), put back after the records. Absent: nothing changes.
   */
  beats?: {
    capture(scope: MemoryScope): Promise<unknown | null> | unknown | null;
    restore(scope: MemoryScope, part: unknown): Promise<void>;
  };
  /**
   * I-144: her plans, look-backs, her note and the moving memory of a connection ride in the profile part's entry (captured before the profile
   * goes, put back after it). Absent: they are left as before (the profile store deletes plans and look-backs with the profile).
   */
  profileExtras?: Partial<Record<ProfileExtraRow, ScopePort | null>>;
}

export interface ForgetOutcome { entries: RecycleSummaryView[]; empty: AgentRecyclePart[]; failed: AgentRecyclePart[] }
export interface RestoreOutcome { restored: RecycleSummaryView; count: number; replaced: RecycleSummaryView | null }

interface ChatData { kind: 'chat'; providerScope: string; records: unknown[]; watch?: unknown[]; beats?: unknown }
interface ProfileData { kind: 'profile'; providerScope: string; stored: unknown; extras?: Partial<Record<ProfileExtraRow, unknown>> }

const PARTS: readonly AgentRecyclePart[] = ['chat', 'profile'];
export const RECYCLE_PART_LABELS: Readonly<Record<AgentRecyclePart, string>> = Object.freeze({ chat: '聊天记忆', profile: '画像和日记' });

function profileCounts(stored: unknown): { entries: number; diary: number } {
  const value = stored as { entries?: unknown; diary?: unknown } | null;
  return { entries: Array.isArray(value?.entries) ? value.entries.length : 0, diary: Array.isArray(value?.diary) ? value.diary.length : 0 };
}
const profileLabel = (stored: unknown, extras?: unknown) => {
  const { entries, diary } = profileCounts(stored);
  return stored === null || stored === undefined ? '她的计划、回顾和笔记' : `画像 ${entries} 条、日记 ${diary} 天${extras ? '，连同计划、回顾和她的笔记' : ''}`;
};

/** I-144: the extras of one connection that have something (each row's capture), or null. */
async function captureExtras(ports: RecoverableForgetPorts, scope: MemoryScope, only?: readonly ProfileExtraRow[]): Promise<Partial<Record<ProfileExtraRow, unknown>> | null> {
  const out: Partial<Record<ProfileExtraRow, unknown>> = {};
  for (const row of only ?? PROFILE_EXTRA_ROWS) {
    const port = ports.profileExtras?.[row];
    if (!port) continue;
    const value = await port.capture(scope);
    if (value !== null && value !== undefined) out[row] = value;
  }
  return Object.keys(out).length ? out : null;
}

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
          const beats = await Promise.resolve(ports.beats?.capture(scope)).catch(() => null); // before anything goes; it is only a copy
          const count = await ports.chat.forgetScope(scope, records => {
            const carried = watch.length && !watchPlaced ? watch : undefined;
            const label = `聊天记忆 ${records.length} 段${carried ? `、看剧笔记 ${carried.length} 条` : ''}`;
            return keep({ characterId, characterName, part, count: records.length, label }, { kind: 'chat', providerScope, records, ...(carried ? { watch: carried } : {}), ...(beats ? { beats } : {}) })
              .then(() => { if (carried) watchPlaced = true; });
          });
          if (count) found = true;
        } else {
          if (!ports.profiles) continue;
          // I-144: her plans, look-backs, note and moving memory are captured first (the profile store deletes plans and look-backs with it).
          const extras = await captureExtras(ports, scope);
          const removed = await ports.profiles.forgetScope(scope, stored => {
            const { entries, diary } = profileCounts(stored);
            return keep({ characterId, characterName, part, count: entries + diary, label: profileLabel(stored, extras) }, { kind: 'profile', providerScope, stored, ...(extras ? { extras } : {}) });
          });
          if (removed) found = true;
          else if (extras) { await keep({ characterId, characterName, part, count: 0, label: profileLabel(null) }, { kind: 'profile', providerScope, stored: null, extras }); found = true; }
          // Only now, with their copy safe in the bin. One that cannot be removed stays where it is (its copy is in the entry too).
          for (const row of PROFILE_EXTRA_ROWS) {
            const port = ports.profileExtras?.[row];
            if (port && extras?.[row] !== undefined) await port.remove(scope, extras[row]).catch(() => undefined);
          }
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
    const beats = (value as { beats?: unknown }).beats;
    if (ports.beats && beats) await ports.beats.restore(scope, beats).catch(() => undefined); // the grey lines of her long window only: a failure never blocks the chat coming back
    const watch = (value as { watch?: unknown }).watch;
    if (ports.watch && Array.isArray(watch) && watch.length) await ports.watch.restore(summary.characterId, watch);
  } else {
    if (!ports.profiles) throw new Error('用户画像尚未就绪，稍后再试。');
    const extras = (value as { extras?: Partial<Record<ProfileExtraRow, unknown>> }).extras;
    const rows = extras && typeof extras === 'object' ? PROFILE_EXTRA_ROWS.filter(row => extras[row] !== undefined) : [];
    if (rows.some(row => !ports.profileExtras?.[row])) throw new Error('她的计划、回顾或笔记现在还不能放回，稍后再试。');
    // I-144: what she has of those now (written since) is swapped into the bin with a newer profile, so nothing is lost.
    const now = rows.length ? await captureExtras(ports, scope, rows) : null;
    let swapped = false;
    const swap = async (current: unknown) => {
      const { entries, diary } = profileCounts(current);
      replaced = await ports.bin.put({ characterId: summary.characterId, characterName: summary.characterName, part: 'profile',
        count: entries + diary, label: `${profileLabel(current, now)}（找回旧的时换下来的）`.slice(0, 80) },
        { kind: 'profile', providerScope: scope.providerScope, stored: current, ...(now ? { extras: now } : {}) } satisfies ProfileData);
      swapped = true;
    };
    if (value.stored !== null && value.stored !== undefined) await ports.profiles.restoreScope(scope, value.stored, swap);
    if (now && !swapped) await swap(null);
    for (const row of rows) await ports.profileExtras![row]!.restore(scope, extras![row]);
    count = summary.count;
  }
  await ports.bin.remove(summary.id);
  return { restored: summary, count, replaced };
}
