// I-014 回收站 (Claude's suggestion, recorded as revocable in docs/claude/2026-11-03-three-way-interconnect.md): when the
// user's own Claude deletes what a character remembers through the agent channel, nothing is deleted for good at once.
// Each deletion becomes one entry under `<profile>/recycle-bin/<character>/`: a small `<id>.json` with names and counts
// (what the panel and list_recycle_bin show) and `<id>.data.json` with the removed data itself. An entry can be put
// back within the retention period (default 7 days, 1–30, `settings.json`); after that `purge()` removes it.
// I-144: the bin also holds deleted characters (her card and, when ticked,
// everything she remembered) and things deleted one at a time in their own panels (a memory note, the moving memory, a listening note).
// Those entries are written as version 2 (an older app leaves them alone); chat and profile entries stay version 1. An entry is deleted
// for good only when it expires or the user presses 「永久删除」 in a window: the agent channel has no way to.
// Host only: no IPC path reaches the files, the data file is never sent to a renderer or over the channel.
// No Electron import.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RecycleEntryKind, RecycleSummary } from '../../shared/foundation/recycle-bin';

export const RECYCLE_DIRECTORY = 'recycle-bin';
export const RECYCLE_DEFAULT_DAYS = 7;
export const RECYCLE_MIN_DAYS = 1;
export const RECYCLE_MAX_DAYS = 30;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Version 1: what the agent channel deletes (I-014). Version 2: the kinds I-144 added. */
const V1_PARTS: readonly RecycleEntryKind[] = ['chat', 'profile'];
/** I-144b: the single deletions added later are version 2 too (an older app does not know their part and leaves them alone). */
const V2_PARTS: readonly RecycleEntryKind[] = ['character', 'memory-note', 'moving-memory', 'listen-note', 'chat-record', 'ambient-transcript', 'listen-raw',
  'song-memory', 'profile-entry', 'diary-day', 'diary-all', 'review', 'plan', 'plans-all', 'nickname', 'her-nickname', 'card-milestone', 'object-note', 'text-memorial', 'our-thing', 'assistant-chat'];

interface EntryMeta {
  version: 1 | 2; id: string; characterId: string; characterName: string; part: RecycleEntryKind;
  count: number; label: string; deletedAt: number; memories?: boolean; itemAt?: number;
}

export interface RecycleEntryInput { characterId: string; characterName: string; part: RecycleEntryKind; count: number; label: string; memories?: boolean; itemAt?: number }
export type RecycleSummaryView = RecycleSummary;
/** I-144: an entry's two files exactly as they are on disk (base64), for carrying it inside another entry and back. */
export interface RecycleRawEntry { meta: string; data: string }

/**
 * I-144: called before an entry is deleted for good (it expired, or 「永久删除」), with its data. An entry whose removed thing still lives
 * elsewhere (the moving memory stays in its own list after "删掉这一件") finishes the deletion there. Throwing keeps the entry for the next try.
 */
export type RecycleFinalize = (summary: RecycleSummaryView, data: unknown) => Promise<void>;

/** Character ids are card UUIDs; anything else gets a fixed-length folder name that cannot leave the bin. */
export function recycleCharacterFolder(characterId: string): string {
  return /^[A-Za-z0-9-]{1,64}$/.test(characterId) ? characterId.toLowerCase()
    : `c-${Buffer.from(characterId, 'utf8').toString('hex').slice(0, 56)}`;
}
const characterFolder = recycleCharacterFolder;

function validMeta(value: unknown): EntryMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const meta = value as Record<string, unknown>;
  const version = meta.version === 1 || meta.version === 2 ? meta.version : null;
  const parts = version === 1 ? V1_PARTS : version === 2 ? [...V1_PARTS, ...V2_PARTS] : [];
  if (!version || typeof meta.id !== 'string' || !UUID.test(meta.id) || typeof meta.characterId !== 'string' || !meta.characterId
    || meta.characterId.length > 256 || typeof meta.characterName !== 'string' || !parts.includes(meta.part as RecycleEntryKind)
    || !Number.isSafeInteger(meta.count) || (meta.count as number) < 0 || typeof meta.label !== 'string'
    || !Number.isSafeInteger(meta.deletedAt) || (meta.deletedAt as number) < 0
    || (meta.memories !== undefined && typeof meta.memories !== 'boolean')
    || (meta.itemAt !== undefined && (version !== 2 || !Number.isSafeInteger(meta.itemAt) || (meta.itemAt as number) < 0))) return null;
  return { version, id: meta.id.toLowerCase(), characterId: meta.characterId, characterName: meta.characterName.slice(0, 80),
    part: meta.part as RecycleEntryKind, count: meta.count as number, label: meta.label.slice(0, 80), deletedAt: meta.deletedAt as number,
    ...(meta.memories !== undefined ? { memories: meta.memories as boolean } : {}), ...(meta.itemAt !== undefined ? { itemAt: meta.itemAt as number } : {}) };
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, data, typeof data === 'string' ? { encoding: 'utf8', mode: 0o600 } : { mode: 0o600 });
  try { await rename(temporary, file); }
  catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

export function retentionDays(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < RECYCLE_MIN_DAYS || (value as number) > RECYCLE_MAX_DAYS)
    throw new Error(`回收站保留天数只能是 ${RECYCLE_MIN_DAYS}～${RECYCLE_MAX_DAYS} 的整数。`);
  return value as number;
}

export class MemoryRecycleBin {
  private readonly entries = new Map<string, EntryMeta>();
  private days = RECYCLE_DEFAULT_DAYS;
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  readonly directory: string;
  /** I-144: set once by the host (electron/memory/recycle-wiring.ts); see RecycleFinalize. */
  finalize: RecycleFinalize | null = null;

  constructor(profileDirectory: string, private readonly now: () => number = Date.now, private readonly changed?: () => void) {
    this.directory = path.join(profileDirectory, RECYCLE_DIRECTORY);
  }

  get retentionDays(): number { return this.days; }
  /** False until load() finished: nothing can be put in (a deletion then keeps everything where it is). */
  get ready(): boolean { return this.loaded; }

  /** Reads the retention setting and every entry's small file (never the data), then removes what has expired. */
  load(): Promise<void> {
    return this.serial(async () => {
      try {
        const raw = JSON.parse(await readFile(path.join(this.directory, 'settings.json'), 'utf8'));
        this.days = retentionDays(raw?.days);
      } catch { this.days = RECYCLE_DEFAULT_DAYS; }
      this.entries.clear();
      let folders: string[] = [];
      try { folders = await readdir(this.directory); } catch { folders = []; }
      for (const folder of folders) {
        if (folder === 'settings.json' || folder.endsWith('.tmp')) continue;
        let names: string[];
        try { names = await readdir(path.join(this.directory, folder)); } catch { continue; }
        await this.sweep(folder, names);
        for (const name of names) {
          if (!/^[0-9a-f-]{36}\.json$/i.test(name) || !names.includes(name.replace(/\.json$/i, '.data.json'))) continue;
          try {
            const meta = validMeta(JSON.parse(await readFile(path.join(this.directory, folder, name), 'utf8')));
            if (meta && characterFolder(meta.characterId) === folder && `${meta.id}.json` === name.toLowerCase()) this.entries.set(meta.id, meta);
          } catch { /* An unreadable entry stays on disk untouched; it is just not offered. */ }
        }
      }
      this.loaded = true;
      await this.purgeNow();
    });
  }

  /** Names and counts only, newest first; `characterId` narrows to one character. */
  summaries(characterId?: string): RecycleSummaryView[] {
    return [...this.entries.values()]
      .filter(meta => !characterId || meta.characterId === characterId)
      .sort((a, b) => b.deletedAt - a.deletedAt)
      .map(meta => this.summary(meta));
  }

  /** Writes the data first, then the small file: an entry is only offered once its data is safely on disk. */
  put(input: RecycleEntryInput, data: unknown): Promise<RecycleSummaryView> {
    return this.serial(async () => {
      this.ready_();
      if (![...V1_PARTS, ...V2_PARTS].includes(input.part)) throw new Error('回收站不收这一种。');
      const version: 1 | 2 = V1_PARTS.includes(input.part) ? 1 : 2;
      const meta: EntryMeta = { version, id: randomUUID(), characterId: input.characterId, characterName: String(input.characterName ?? '').slice(0, 80),
        part: input.part, count: Math.max(0, Math.floor(input.count)), label: String(input.label ?? '').slice(0, 80), deletedAt: Math.floor(this.now()),
        ...(version === 2 && input.memories !== undefined ? { memories: input.memories === true } : {}),
        ...(version === 2 && Number.isSafeInteger(input.itemAt) && (input.itemAt as number) >= 0 ? { itemAt: input.itemAt as number } : {}) };
      if (!validMeta(meta)) throw new Error('回收站条目不正确。');
      const folder = path.join(this.directory, characterFolder(meta.characterId));
      await writeAtomic(path.join(folder, `${meta.id}.data.json`), JSON.stringify({ version: 1, id: meta.id, data }));
      try { await writeAtomic(path.join(folder, `${meta.id}.json`), JSON.stringify(meta)); }
      catch (error) { await rm(path.join(folder, `${meta.id}.data.json`), { force: true }).catch(() => {}); throw error; }
      this.entries.set(meta.id, meta);
      this.notify();
      return this.summary(meta);
    });
  }

  /** The removed data of one entry that has not expired. Nothing is removed yet (see `remove`). */
  read(id: unknown): Promise<{ summary: RecycleSummaryView; data: unknown }> {
    return this.serial(async () => {
      this.ready_();
      const meta = typeof id === 'string' && UUID.test(id) ? this.entries.get(id.toLowerCase()) : undefined;
      if (!meta || this.expired(meta)) throw new Error('回收站里没有这一项（可能已经找回或到期清理了）。');
      return { summary: this.summary(meta), data: await this.readData(meta) };
    });
  }

  /**
   * I-144: one character's entries exactly as they are on disk, so a deleted character's entry can carry them (and put them back
   * unchanged when she is found back). Entries that have expired are left to the purge.
   */
  rawEntries(characterId: string): Promise<{ id: string; raw: RecycleRawEntry }[]> {
    return this.serial(async () => {
      this.ready_();
      const out: { id: string; raw: RecycleRawEntry }[] = [];
      for (const meta of this.entries.values()) {
        if (meta.characterId !== characterId || this.expired(meta)) continue;
        const folder = path.join(this.directory, characterFolder(meta.characterId));
        out.push({ id: meta.id, raw: { meta: (await readFile(path.join(folder, `${meta.id}.json`))).toString('base64'),
          data: (await readFile(path.join(folder, `${meta.id}.data.json`))).toString('base64') } });
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    });
  }

  /**
   * I-144: puts entries carried by rawEntries back, byte for byte, under their own ids and times (one already offered is skipped).
   * Each must be a valid entry of `characterId`.
   */
  adoptRaw(characterId: string, raws: readonly RecycleRawEntry[]): Promise<number> {
    return this.serial(async () => {
      this.ready_();
      let adopted = 0;
      for (const raw of raws) {
        const metaBytes = Buffer.from(String(raw?.meta ?? ''), 'base64'), dataBytes = Buffer.from(String(raw?.data ?? ''), 'base64');
        let meta: EntryMeta | null = null, data: { version?: unknown; id?: unknown } | null = null;
        try { meta = validMeta(JSON.parse(metaBytes.toString('utf8'))); data = JSON.parse(dataBytes.toString('utf8')); } catch { meta = null; }
        if (!meta || meta.characterId !== characterId || data?.version !== 1 || data.id !== meta.id) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
        if (this.entries.has(meta.id)) continue;
        const folder = path.join(this.directory, characterFolder(meta.characterId));
        await writeAtomic(path.join(folder, `${meta.id}.data.json`), dataBytes);
        try { await writeAtomic(path.join(folder, `${meta.id}.json`), metaBytes); }
        catch (error) { await rm(path.join(folder, `${meta.id}.data.json`), { force: true }).catch(() => {}); throw error; }
        this.entries.set(meta.id, meta);
        adopted++;
      }
      if (adopted) this.notify();
      return adopted;
    });
  }

  /**
   * I-021 删除一致性: a move that did not finish (the memories stayed where they were, electron/memory/recoverable-forget.ts). The entry
   * stops being offered at once, then both of its files go; whatever cannot be removed now is cleared at the next load.
   */
  discard(id: string): Promise<void> {
    return this.serial(async () => {
      const meta = this.entries.get(String(id).toLowerCase());
      if (!meta) return;
      this.entries.delete(meta.id);
      this.notify();
      const folder = path.join(this.directory, characterFolder(meta.characterId));
      const results = await Promise.allSettled([rm(path.join(folder, `${meta.id}.json`), { force: true }), rm(path.join(folder, `${meta.id}.data.json`), { force: true })]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw (failure as PromiseRejectedResult).reason;
    });
  }

  /** After a successful restore (or when the entry was carried into another one): the entry leaves the bin. */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const meta = this.entries.get(id.toLowerCase());
      if (!meta) return;
      await this.delete(meta);
      this.notify();
    });
  }

  /**
   * I-144 「永久删除」: only from a window, after the user confirmed twice (the agent channel has no path here). The entry's finalize
   * runs first (see RecycleFinalize); then both files go.
   */
  deleteForGood(id: unknown): Promise<void> {
    return this.serial(async () => {
      this.ready_();
      const meta = typeof id === 'string' && UUID.test(id) ? this.entries.get(id.toLowerCase()) : undefined;
      if (!meta) throw new Error('回收站里没有这一项（可能已经找回或到期清理了）。');
      await this.finalizeEntry(meta);
      await this.delete(meta);
      this.notify();
    });
  }

  setRetentionDays(value: unknown): Promise<number> {
    let days: number;
    try { days = retentionDays(value); } catch (error) { return Promise.reject(error); }
    return this.serial(async () => {
      this.ready_();
      await writeAtomic(path.join(this.directory, 'settings.json'), JSON.stringify({ version: 1, days }));
      this.days = days;
      await this.purgeNow();
      this.notify();
      return days;
    });
  }

  /** Removes every entry past its retention; returns how many went. */
  purge(): Promise<number> { return this.serial(async () => { this.ready_(); return this.purgeNow(); }); }

  private summary(meta: EntryMeta): RecycleSummaryView {
    return { id: meta.id, characterId: meta.characterId, characterName: meta.characterName, part: meta.part, count: meta.count,
      label: meta.label, deletedAt: meta.deletedAt, expiresAt: meta.deletedAt + this.days * DAY_MS, ...(meta.memories !== undefined ? { memories: meta.memories } : {}),
      ...(meta.itemAt !== undefined ? { itemAt: meta.itemAt } : {}) };
  }

  private async readData(meta: EntryMeta): Promise<unknown> {
    const file = path.join(this.directory, characterFolder(meta.characterId), `${meta.id}.data.json`);
    let raw: { version?: unknown; id?: unknown; data?: unknown };
    try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('回收站里这一项的数据读不出来，原文件已保留。'); }
    if (raw?.version !== 1 || raw.id !== meta.id) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
    return raw.data;
  }

  private async finalizeEntry(meta: EntryMeta): Promise<void> {
    if (!this.finalize) return;
    let data: unknown;
    try { data = await this.readData(meta); } catch { return; /* Nothing readable to finish; the files still go. */ }
    await this.finalize(this.summary(meta), data);
  }

  private async purgeNow(): Promise<number> {
    let removed = 0;
    for (const meta of [...this.entries.values()]) {
      if (!this.expired(meta)) continue;
      try { await this.finalizeEntry(meta); await this.delete(meta); removed++; } catch { /* Tried again at the next purge. */ }
    }
    if (removed) this.notify();
    return removed;
  }

  /**
   * I-021 删除一致性: files of one character's folder that no entry can be offered from go, so no copy of what was removed is
   * left behind: a data file without its small file (a crash between the two writes, or a removal half done), a small file
   * without its data (it could never be put back), and a half-written temporary file. An unreadable small file whose data is
   * there is still left untouched.
   */
  private async sweep(folder: string, names: readonly string[]): Promise<void> {
    const present = new Set(names.map(name => name.toLowerCase()));
    for (const name of names) {
      const lower = name.toLowerCase();
      const data = /^([0-9a-f-]{36})\.data\.json$/.exec(lower), small = /^([0-9a-f-]{36})\.json$/.exec(lower);
      const orphan = (data && !present.has(`${data[1]}.json`)) || (small && !present.has(`${small[1]}.data.json`))
        || /\.json\.\d+\.[0-9a-f]{8}\.tmp$/.test(lower);
      if (orphan) await rm(path.join(this.directory, folder, name), { force: true }).catch(() => { /* Tried again at the next load. */ });
    }
  }

  private async delete(meta: EntryMeta): Promise<void> {
    const folder = path.join(this.directory, characterFolder(meta.characterId));
    // The small file goes first: an entry is never offered without its data.
    await rm(path.join(folder, `${meta.id}.json`), { force: true });
    this.entries.delete(meta.id);
    await rm(path.join(folder, `${meta.id}.data.json`), { force: true });
  }

  private expired(meta: EntryMeta): boolean { return this.now() > meta.deletedAt + this.days * DAY_MS; }
  private ready_(): void { if (!this.loaded) throw new Error('回收站尚未就绪。'); }
  private notify(): void { try { this.changed?.(); } catch { /* Status only. */ } }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}
