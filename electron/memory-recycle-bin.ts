// I-014 回收站 (Claude's suggestion, recorded as revocable in docs/claude/2026-11-03-three-way-interconnect.md): when the
// user's own Claude deletes what a character remembers through the agent channel, nothing is deleted for good at once.
// Each deletion becomes one entry under `<profile>/recycle-bin/<character>/`: a small `<id>.json` with names and counts
// (what the panel and list_recycle_bin show) and `<id>.data.json` with the removed data itself. An entry can be put
// back within the retention period (default 7 days, 1–30, `settings.json`); after that `purge()` removes it.
// Host only: no IPC path reaches the files, the data file is never sent to a renderer or over the channel.
// No Electron import.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRecyclePart, AgentRecycleSummary } from '../shared/agent-channel';

export const RECYCLE_DIRECTORY = 'recycle-bin';
export const RECYCLE_DEFAULT_DAYS = 7;
export const RECYCLE_MIN_DAYS = 1;
export const RECYCLE_MAX_DAYS = 30;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTS: readonly AgentRecyclePart[] = ['chat', 'profile'];

interface EntryMeta {
  version: 1; id: string; characterId: string; characterName: string; part: AgentRecyclePart;
  count: number; label: string; deletedAt: number;
}

export interface RecycleEntryInput { characterId: string; characterName: string; part: AgentRecyclePart; count: number; label: string }
export type RecycleSummaryView = AgentRecycleSummary;

/** Character ids are card UUIDs; anything else gets a fixed-length folder name that cannot leave the bin. */
function characterFolder(characterId: string): string {
  return /^[A-Za-z0-9-]{1,64}$/.test(characterId) ? characterId.toLowerCase()
    : `c-${Buffer.from(characterId, 'utf8').toString('hex').slice(0, 56)}`;
}

function validMeta(value: unknown): EntryMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const meta = value as Record<string, unknown>;
  if (meta.version !== 1 || typeof meta.id !== 'string' || !UUID.test(meta.id) || typeof meta.characterId !== 'string' || !meta.characterId
    || meta.characterId.length > 256 || typeof meta.characterName !== 'string' || !PARTS.includes(meta.part as AgentRecyclePart)
    || !Number.isSafeInteger(meta.count) || (meta.count as number) < 0 || typeof meta.label !== 'string'
    || !Number.isSafeInteger(meta.deletedAt) || (meta.deletedAt as number) < 0) return null;
  return { version: 1, id: meta.id.toLowerCase(), characterId: meta.characterId, characterName: meta.characterName.slice(0, 80),
    part: meta.part as AgentRecyclePart, count: meta.count as number, label: meta.label.slice(0, 80), deletedAt: meta.deletedAt as number };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
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

  constructor(profileDirectory: string, private readonly now: () => number = Date.now, private readonly changed?: () => void) {
    this.directory = path.join(profileDirectory, RECYCLE_DIRECTORY);
  }

  get retentionDays(): number { return this.days; }

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
      .map(meta => ({ id: meta.id, characterId: meta.characterId, characterName: meta.characterName, part: meta.part, count: meta.count,
        label: meta.label, deletedAt: meta.deletedAt, expiresAt: meta.deletedAt + this.days * DAY_MS }));
  }

  /** Writes the data first, then the small file: an entry is only offered once its data is safely on disk. */
  put(input: RecycleEntryInput, data: unknown): Promise<RecycleSummaryView> {
    return this.serial(async () => {
      this.ready();
      if (!PARTS.includes(input.part)) throw new Error('回收站只收聊天记忆、画像和日记。');
      const meta: EntryMeta = { version: 1, id: randomUUID(), characterId: input.characterId, characterName: String(input.characterName ?? '').slice(0, 80),
        part: input.part, count: Math.max(0, Math.floor(input.count)), label: String(input.label ?? '').slice(0, 80), deletedAt: Math.floor(this.now()) };
      if (!validMeta(meta)) throw new Error('回收站条目不正确。');
      const folder = path.join(this.directory, characterFolder(meta.characterId));
      await writeAtomic(path.join(folder, `${meta.id}.data.json`), JSON.stringify({ version: 1, id: meta.id, data }));
      try { await writeAtomic(path.join(folder, `${meta.id}.json`), JSON.stringify(meta)); }
      catch (error) { await rm(path.join(folder, `${meta.id}.data.json`), { force: true }).catch(() => {}); throw error; }
      this.entries.set(meta.id, meta);
      this.notify();
      return this.summaries().find(item => item.id === meta.id)!;
    });
  }

  /** The removed data of one entry that has not expired. Nothing is removed yet (see `remove`). */
  read(id: unknown): Promise<{ summary: RecycleSummaryView; data: unknown }> {
    return this.serial(async () => {
      this.ready();
      const meta = typeof id === 'string' && UUID.test(id) ? this.entries.get(id.toLowerCase()) : undefined;
      if (!meta || this.expired(meta)) throw new Error('回收站里没有这一项（可能已经找回或到期清理了）。');
      const file = path.join(this.directory, characterFolder(meta.characterId), `${meta.id}.data.json`);
      let raw: { version?: unknown; id?: unknown; data?: unknown };
      try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('回收站里这一项的数据读不出来，原文件已保留。'); }
      if (raw?.version !== 1 || raw.id !== meta.id) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
      return { summary: this.summaries().find(item => item.id === meta.id)!, data: raw.data };
    });
  }

  /**
   * I-021 删除一致性: a move that did not finish (the memories stayed where they were, electron/recoverable-forget.ts). The entry
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

  /** After a successful restore: the entry leaves the bin. */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const meta = this.entries.get(id.toLowerCase());
      if (!meta) return;
      await this.delete(meta);
      this.notify();
    });
  }

  setRetentionDays(value: unknown): Promise<number> {
    let days: number;
    try { days = retentionDays(value); } catch (error) { return Promise.reject(error); }
    return this.serial(async () => {
      this.ready();
      await writeAtomic(path.join(this.directory, 'settings.json'), JSON.stringify({ version: 1, days }));
      this.days = days;
      await this.purgeNow();
      this.notify();
      return days;
    });
  }

  /** Removes every entry past its retention; returns how many went. */
  purge(): Promise<number> { return this.serial(async () => { this.ready(); return this.purgeNow(); }); }

  private async purgeNow(): Promise<number> {
    let removed = 0;
    for (const meta of [...this.entries.values()]) {
      if (!this.expired(meta)) continue;
      try { await this.delete(meta); removed++; } catch { /* Tried again at the next purge. */ }
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
  private ready(): void { if (!this.loaded) throw new Error('回收站尚未就绪。'); }
  private notify(): void { try { this.changed?.(); } catch { /* Status only. */ } }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}
