// P-001: where the plans she remembers live. One file per character and connection beside the profile files: `upcoming-<scopeId>.json`
// ({ version: 1, scopeId, upcoming }), with the same scope id as `profile-<scopeId>.json`. It is NOT part of the profile file on purpose: a
// previous build reads profile files strictly by name and has never heard of this file, so an update or a fall back to the previous version
// can never make a profile or a diary unreadable because of it.
//
// Rules: written with the atomic writer; read strictly (a file that does not read is left exactly as it is and nothing is written over it);
// not written when empty and deleted when it becomes empty; only changed while recording is on (asked at the moment the change runs, in
// one queue with the hard delete, so a change that was waiting when the switch went off finds it off). The pure rules are
// shared/behaviors/upcoming/state.ts. Never exported with a character card, never sent anywhere.

import path from 'node:path';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createAtomicFileWriter, type AtomicFileDependencies } from '../../foundation/atomic-file';
import type { UpcomingShown, UpcomingStored } from '../../../shared/behaviors/upcoming/interface';
import { clearUpcoming, compactUpcoming, dueUpcoming, emptyUpcoming, removeUpcoming, shownUpcoming, validateUpcoming } from '../../../shared/behaviors/upcoming/state';

export const UPCOMING_FILE = /^upcoming-([a-f0-9]{64})\.json$/u;
const MAX_BYTES = 1_000_000;
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** What the user profile store needs from this store (electron/memory/user-profile.ts options). */
export interface UpcomingPort {
  /** The scope is shown: its list is read, so that the panel can show it without waiting. */
  load(scopeId: string): Promise<void>;
  shown(scopeId: string, now: number): UpcomingShown[];
  /** The user's own deletions in the panel. */
  remove(scopeId: string, id: string): Promise<boolean>;
  clear(scopeId: string): Promise<number>;
  /** "允许记录" turned off by hand: every character's file is deleted. */
  purgeAll(): Promise<void>;
  /** The character's profile was deleted: so is her list. */
  forget(scopeId: string): Promise<void>;
  /** I-144b: a single deletion's copy, and putting it back (UpcomingStore). */
  itemsCopy?(scopeId: string, select: { id: string } | { all: true } | { from: string }): Promise<UpcomingPart | null>;
  restoreItems?(part: UpcomingPart): Promise<number>;
}

export interface UpcomingStoreOptions {
  now?: () => number;
  atomic?: AtomicFileDependencies;
  /** Whether recording is on right now (the user's switch). Changes are refused while it is not. */
  recording: () => boolean;
}

/** I-144b: plans as the bin keeps them (UpcomingStore.itemsCopy): items with places, marks the deletion added and marks it took away. */
export interface UpcomingPart { scopeId: string; items: { at: number; value: UpcomingStored['items'][number] }[]; added: string[]; removed: string[] }

export type UpcomingChange =(state: UpcomingStored, at: number) => UpcomingStored | null;

export class UpcomingStore implements UpcomingPort {
  private readonly cache = new Map<string, UpcomingStored>();
  /** Scopes whose file did not read: never written over. */
  private readonly unreadable = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  constructor(readonly directory: string, private readonly options: UpcomingStoreOptions) {
    if (!path.isAbsolute(directory) || directory.includes('\0')) throw Error('清单目录须由宿主提供。');
    this.now = options.now ?? Date.now;
  }

  file(scopeId: string): string {
    if (!hex(scopeId)) throw Error('清单范围不正确。');
    return path.join(this.directory, `upcoming-${scopeId}.json`);
  }

  private async read(scopeId: string): Promise<UpcomingStored | null> {
    let bytes: string;
    try { bytes = await readFile(this.file(scopeId), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.unreadable.delete(scopeId); return null; } this.unreadable.add(scopeId); return null; }
    try {
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw Error('too large');
      const data = JSON.parse(bytes) as { version?: unknown; scopeId?: unknown; upcoming?: unknown };
      if (!data || data.version !== 1 || data.scopeId !== scopeId) throw Error('wrong file');
      this.unreadable.delete(scopeId);
      return validateUpcoming(data.upcoming);
    } catch { this.unreadable.add(scopeId); return null; }
  }

  private async write(scopeId: string, state: UpcomingStored): Promise<void> {
    const kept = compactUpcoming(state);
    if (!kept) { await rm(this.file(scopeId), { force: true }); this.cache.delete(scopeId); return; }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await createAtomicFileWriter({ ...this.options.atomic })(this.file(scopeId), JSON.stringify({ version: 1, scopeId, upcoming: kept }) + '\n');
    this.cache.set(scopeId, structuredClone(kept));
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async load(scopeId: string): Promise<void> {
    await this.serial(async () => {
      const state = await this.read(scopeId);
      if (state) this.cache.set(scopeId, state); else this.cache.delete(scopeId);
    });
  }
  shown(scopeId: string, now: number): UpcomingShown[] { return shownUpcoming(this.cache.get(scopeId), now); }
  /** Step 2 and 3: plans whose time has come and that nobody asked about yet (in memory). */
  due(scopeId: string, now: number): UpcomingShown[] {
    const state = this.cache.get(scopeId);
    return state ? dueUpcoming(state, now).map(({ id, what, said, dueAt, state: s }) => ({ id, what, said, dueAt, state: s })) : [];
  }
  /** I-087: ids of the plans still waiting that were noted at or after `since` (in memory; a pinky promise marks them). */
  recent(scopeId: string, since: number): string[] {
    return (this.cache.get(scopeId)?.items ?? []).filter(item => item.state === 'waiting' && item.createdAt >= since).map(item => item.id);
  }

  /** Changes one character's list while recording is on. Resolves to whether it changed (and was saved); never throws. */
  change(scopeId: string, change: UpcomingChange): Promise<boolean> {
    return this.serial(async () => {
      try {
        if (!this.options.recording() || !hex(scopeId)) return false;
        const known = this.cache.get(scopeId) ?? await this.read(scopeId);
        if (this.unreadable.has(scopeId)) return false;
        const next = change(known ?? emptyUpcoming(), this.now());
        if (!next) return false;
        await this.write(scopeId, next);
        return true;
      } catch { return false; }
    });
  }

  /** Every character's list (those cascades do not depend on which character is shown). Resolves to the sum of what `change` reports. */
  changeAll(change: (state: UpcomingStored, at: number) => { state: UpcomingStored | null; count: number }): Promise<number> {
    return this.serial(async () => {
      let total = 0;
      try {
        if (!this.options.recording()) return 0;
        for (const name of await readdir(this.directory)) {
          const match = UPCOMING_FILE.exec(name);
          if (!match) continue;
          try {
            const scopeId = match[1];
            const known = this.cache.get(scopeId) ?? await this.read(scopeId);
            if (!known || this.unreadable.has(scopeId)) continue;
            const result = change(known, this.now());
            if (result.state) { await this.write(scopeId, result.state); total += result.count; }
          } catch { /* one file that fails does not stop the others */ }
        }
      } catch { /* no directory yet */ }
      return total;
    });
  }

  async remove(scopeId: string, id: string): Promise<boolean> {
    return (await this.change(scopeId, state => { const result = removeUpcoming(state, id); return result.removed ? result.state : null; }));
  }
  async clear(scopeId: string): Promise<number> {
    let count = 0;
    await this.change(scopeId, state => { const result = clearUpcoming(state); count = result.removed; return result.removed ? result.state : null; });
    return count;
  }

  // ---- I-144b 单条删除也先进回收站 (electron/memory/recycle/items-wiring.ts) ----

  /**
   * What a deletion is about to take from one list, each item with its place: one plan (`id`), every plan (`all`), or what came from one chat
   * record (`from`, the record is being deleted); with the blocked marks the deletion adds and the ones it takes away. null when nothing.
   */
  itemsCopy(scopeId: string, select: { id: string } | { all: true } | { from: string }): Promise<UpcomingPart | null> {
    return this.serial(async () => {
      if (!hex(scopeId)) return null;
      const state = this.cache.get(scopeId) ?? await this.read(scopeId);
      if (!state || this.unreadable.has(scopeId)) return null;
      const mine = (item: UpcomingStored['items'][number]) => 'id' in select ? item.id === select.id : 'all' in select ? true : item.from === select.from;
      const items = state.items.flatMap((value, at) => mine(value) ? [{ at, value: structuredClone(value) }] : []);
      const blocked = new Set(state.blockedFrom);
      if ('from' in select) return items.length || blocked.has(select.from) ? { scopeId, items, added: [], removed: blocked.has(select.from) ? [select.from] : [] } : null;
      return items.length ? { scopeId, items, added: [...new Set(items.map(item => item.value.from))].filter(from => !blocked.has(from)), removed: [] } : null;
    });
  }
  /** Puts what itemsCopy copied back (an item here again is left as it is), and undoes its marks. Only while recording is on; resolves to how many came back. */
  async restoreItems(part: UpcomingPart): Promise<number> {
    if (!part || !hex(part.scopeId) || !Array.isArray(part.items) || !Array.isArray(part.added) || !Array.isArray(part.removed)
      || part.items.some(item => !item?.value || typeof item.value.id !== 'string' || !Number.isInteger(item.at))) throw Error('回收站里这一项的数据不完整，原文件已保留。');
    let count = 0;
    const ok = await this.change(part.scopeId, state => {
      const items = part.items.filter(item => !state.items.some(kept => kept.id === item.value.id));
      count = items.length;
      const added = new Set(part.added.map(String));
      const list = [...state.items];
      for (const { at, value } of [...items].sort((a, b) => a.at - b.at)) list.splice(Math.max(0, Math.min(list.length, at)), 0, value);
      return { items: list, blockedFrom: [...state.blockedFrom.filter(from => !added.has(from)), ...part.removed.map(String).filter(from => !state.blockedFrom.includes(from))] };
    });
    if (!ok) throw Error('现在放不回去：「允许记录」关着，或计划文件读不出来。回收站里还留着。');
    return count;
  }

  /** Hard delete (no recycle bin): every `upcoming-*.json`, whatever it holds, even one that does not read. */
  purgeAll(): Promise<void> {
    this.cache.clear();
    return this.serial(async () => {
      this.cache.clear(); this.unreadable.clear();
      let names: string[];
      try { names = await readdir(this.directory); } catch { return; }
      for (const name of names) if (UPCOMING_FILE.test(name)) { try { await rm(path.join(this.directory, name), { force: true }); } catch { /* left; deleted at the next switch-off */ } }
    });
  }

  forget(scopeId: string): Promise<void> {
    return this.serial(async () => { this.cache.delete(scopeId); this.unreadable.delete(scopeId); await rm(this.file(scopeId), { force: true }); });
  }

  /** Waits for every queued change and delete (tests, quitting). */
  settled(): Promise<void> { return this.queue.then(() => undefined); }
}
