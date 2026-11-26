/**
 * I-086 我们的小东西 on disk: `<profile>/our-things/<characterId>.json` (the list and how often she handed you something) and
 * `<profile>/our-things/<characterId>/<id>.jpg|png` (the small pictures: a 256 px JPEG of a snack you fed her, a PNG of her own
 * picture). Per character, never mixed into her memories, diary or profile files. Every write is atomic (a temporary file beside
 * it, then a rename); the list is bounded (shared/initiative/our-things.ts addOurThing: records and total picture bytes); deleting a record
 * deletes its picture. Nothing here is ever uploaded.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';
import { MutationQueue } from '../../foundation/mutation-queue';
import { EMPTY_GIVE_LEDGER, readGiveLedger, type GiveLedger } from '../../../shared/behaviors/give/choose';
import {
  OUR_THINGS_MAX, OUR_THING_PICTURE_MAX_BYTES, OUR_THING_THUMB_MAX_BYTES, addOurThing, isOurThingFile, markOurThing, readOurThing,
  removeOurThing, type OurThing,
} from '../../../shared/initiative/our-things'; // direct, not via shared/memory: the page would pull this host-only module into the renderer bundle (docs/claude/2026-11-16-overhaul-parts-2.md)
import { sniffImageFormat } from '../../../shared/senses';

const CHARACTER = /^[A-Za-z0-9_-]{1,100}$/u;
interface Row { items: OurThing[]; ledger: GiveLedger }
/** I-144b: one record as the bin keeps it (OurThingsStore.thingCopy): the record with its place, its picture's bytes in base64 (or null). */
export interface OurThingPart { characterId: string; item: { at: number; value: OurThing }; picture: string | null }

export interface OurThingsStoreOptions {
  /** The profile folder (null before the app is ready: nothing is read or written). */
  directory(): string | null;
  write?: AtomicFileWriter;
  /** Tests: the bounds. */
  limits?: { max: number; bytes: number };
}

export class OurThingsStore {
  private readonly rows = new Map<string, Row>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly blocked = new Set<string>();
  private readonly queue = new MutationQueue();
  constructor(private readonly options: OurThingsStoreOptions) {}

  private root(): string | null { const dir = this.options.directory(); return dir ? path.join(dir, 'our-things') : null; }
  private listFile(characterId: string): string | null { const root = this.root(); return root ? path.join(root, `${characterId}.json`) : null; }
  private filesDir(characterId: string): string | null { const root = this.root(); return root ? path.join(root, characterId) : null; }

  /** Reads one character's list once (missing: empty; unreadable: kept in memory only and never overwritten this session). */
  load(characterId: string): Promise<void> {
    if (!CHARACTER.test(characterId)) return Promise.resolve();
    if (this.rows.has(characterId)) return Promise.resolve();
    const running = this.loading.get(characterId);
    if (running) return running;
    const job = (async () => {
      const file = this.listFile(characterId);
      const row: Row = { items: [], ledger: EMPTY_GIVE_LEDGER };
      if (file) {
        try {
          const raw = JSON.parse(await readFile(file, 'utf8')) as { v?: unknown; items?: unknown; ledger?: unknown };
          if (!raw || raw.v !== 1 || !Array.isArray(raw.items)) throw new Error('bad our-things file');
          const items = raw.items.map(readOurThing).filter((item): item is OurThing => item !== null);
          row.items = items.sort((a, b) => a.at - b.at).slice(-OUR_THINGS_MAX);
          row.ledger = readGiveLedger(raw.ledger);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.blocked.add(characterId);
        }
      }
      this.rows.set(characterId, row);
    })().finally(() => this.loading.delete(characterId));
    this.loading.set(characterId, job);
    return job;
  }

  /** Loaded yet (the synchronous readers below say "nothing" until then: she offers nothing she cannot count). */
  loaded(characterId: string): boolean { return this.rows.has(characterId); }

  list(characterId: string): OurThing[] { return (this.rows.get(characterId)?.items ?? []).map(item => ({ ...item })); }
  ledger(characterId: string): GiveLedger | null { const row = this.rows.get(characterId); return row ? { ...row.ledger } : null; }

  /** Writes the new ledger (how often she offered). */
  setLedger(characterId: string, ledger: GiveLedger): Promise<boolean> {
    return this.queue.run(async () => {
      await this.load(characterId);
      const row = this.rows.get(characterId);
      if (!row) return false;
      row.ledger = { ...ledger };
      return this.save(characterId);
    });
  }

  /**
   * Adds one record, with its picture when given (JPEG for a snack you fed her, PNG for her picture; checked by its first bytes and
   * size). The picture is written first under a new name; the list after; records pushed out by the bounds lose their pictures.
   */
  add(characterId: string, thing: OurThing, picture?: Uint8Array | null): Promise<OurThing | null> {
    return this.queue.run(async () => {
      await this.load(characterId);
      const row = this.rows.get(characterId), dir = this.filesDir(characterId);
      if (!row || !CHARACTER.test(characterId) || row.items.some(item => item.id === thing.id)) return null;
      let stored = thing;
      if (picture) {
        const format = sniffImageFormat(picture), isPicture = thing.kind === 'picture';
        const max = isPicture ? OUR_THING_PICTURE_MAX_BYTES : OUR_THING_THUMB_MAX_BYTES;
        if (!dir || picture.byteLength < 1 || picture.byteLength > max || format !== (isPicture ? 'png' : 'jpeg')) return null;
        const file = `${thing.id}.${isPicture ? 'png' : 'jpg'}`;
        await mkdir(dir, { recursive: true });
        const target = path.join(dir, file), temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
        try { await writeFile(temporary, picture, { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
        catch { await rm(temporary, { force: true }).catch(() => {}); return null; }
        stored = { ...thing, file, bytes: picture.byteLength };
      }
      const { list, dropped } = addOurThing(row.items, stored, this.options.limits);
      row.items = list;
      if (!await this.save(characterId)) {
        // The list could not be written: take the record back out of memory and remove its picture (nothing half-kept).
        row.items = row.items.filter(item => item.id !== stored.id);
        if (stored.file) await this.unlinkFile(characterId, stored.file);
        return null;
      }
      for (const item of dropped) if (item.file) await this.unlinkFile(characterId, item.file);
      return { ...stored };
    });
  }

  /** The user removed one record on the page: the record and its picture go. */
  remove(characterId: string, id: unknown): Promise<boolean> {
    return this.queue.run(async () => {
      await this.load(characterId);
      const row = this.rows.get(characterId);
      if (!row) return false;
      const { list, removed } = removeOurThing(row.items, id);
      if (!removed) return false;
      row.items = list;
      if (!await this.save(characterId)) { row.items = [...row.items, removed].sort((a, b) => a.at - b.at); return false; }
      if (removed.file) await this.unlinkFile(characterId, removed.file);
      return true;
    });
  }

  /**
   * I-144 (删角色并勾选「同时删除她的记忆」, through the recycle bin): this character's list and every picture go, file and memory. Also
   * what the bin calls before writing her files back, so no copy held here writes over them.
   */
  forget(characterId: string): Promise<void> {
    return this.queue.run(async () => {
      if (!CHARACTER.test(characterId)) return;
      this.rows.delete(characterId); this.blocked.delete(characterId);
      const file = this.listFile(characterId), dir = this.filesDir(characterId);
      if (file) await rm(file, { force: true });
      if (dir) await rm(dir, { recursive: true, force: true });
    });
  }

  // ---- I-144b 单条删除也先进回收站 (electron/memory/recycle/items-wiring.ts) ----

  /** One record as the user is about to remove it, with its place and its picture's bytes (base64); null when absent. Nothing changes. */
  thingCopy(characterId: string, id: unknown): Promise<OurThingPart | null> {
    return this.queue.run(async () => {
      await this.load(characterId);
      const items = this.rows.get(characterId)?.items ?? [], at = items.findIndex(item => item.id === id);
      if (at < 0) return null;
      const item = items[at]!, dir = this.filesDir(characterId);
      let picture: string | null = null;
      if (item.file && dir && isOurThingFile(item.file)) {
        try { picture = (await readFile(path.join(dir, item.file))).toString('base64'); }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      }
      return { characterId, item: { at, value: { ...item } }, picture };
    });
  }
  /** Puts what thingCopy copied back: its picture first, then the record at its place. False when a record with its id is here again. */
  restoreThing(characterId: string, part: OurThingPart): Promise<boolean> {
    return this.queue.run(async () => {
      const thing = part?.item?.value ? readOurThing(part.item.value) : null;
      if (!part || part.characterId !== characterId || !thing || thing.id !== part.item.value.id || !Number.isInteger(part.item.at)
        || (part.picture !== null && typeof part.picture !== 'string')) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
      await this.load(characterId);
      const row = this.rows.get(characterId), dir = this.filesDir(characterId);
      if (!row || this.blocked.has(characterId)) throw new Error('我们的小东西现在读不出来，回收站里还留着。');
      if (row.items.some(item => item.id === thing.id)) return false;
      if (part.picture !== null && thing.file) {
        if (!dir || !isOurThingFile(thing.file)) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
        await mkdir(dir, { recursive: true });
        const target = path.join(dir, thing.file), temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
        try { await writeFile(temporary, Buffer.from(part.picture, 'base64'), { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
        catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
      }
      const before = row.items;
      row.items = [...before]; row.items.splice(Math.max(0, Math.min(row.items.length, part.item.at)), 0, { ...part.item.value });
      if (!await this.save(characterId)) {
        row.items = before;
        if (part.picture !== null && thing.file) await this.unlinkFile(characterId, thing.file);
        throw new Error('我们的小东西没能写回去，回收站里还留着。');
      }
      return true;
    });
  }

  /** Her offer was taken or not (only her own 'gave' records change). */
  mark(characterId: string, id: string, taken: boolean): Promise<boolean> {
    return this.queue.run(async () => {
      await this.load(characterId);
      const row = this.rows.get(characterId);
      if (!row || !row.items.some(item => item.id === id && item.dir === 'gave')) return false;
      row.items = markOurThing(row.items, id, taken);
      return this.save(characterId);
    });
  }

  /** One record's picture bytes (by record id; never by a name from outside), or null. */
  async picture(characterId: string, id: unknown): Promise<{ bytes: Uint8Array; type: 'image/jpeg' | 'image/png' } | null> {
    await this.load(characterId);
    const item = this.rows.get(characterId)?.items.find(entry => entry.id === id);
    const dir = this.filesDir(characterId);
    if (!item?.file || !dir || !isOurThingFile(item.file)) return null;
    try {
      const file = path.join(dir, item.file);
      const info = await stat(file);
      if (!info.isFile() || info.size > OUR_THING_PICTURE_MAX_BYTES) return null;
      const bytes = new Uint8Array(await readFile(file));
      const format = sniffImageFormat(bytes);
      return format === 'png' ? { bytes, type: 'image/png' } : format === 'jpeg' ? { bytes, type: 'image/jpeg' } : null;
    } catch { return null; }
  }

  private async unlinkFile(characterId: string, file: string): Promise<void> {
    const dir = this.filesDir(characterId);
    if (!dir || !isOurThingFile(file)) return;
    await unlink(path.join(dir, file)).catch(() => {});
  }

  private async save(characterId: string): Promise<boolean> {
    const file = this.listFile(characterId), row = this.rows.get(characterId);
    if (!file || !row || this.blocked.has(characterId)) return false;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await (this.options.write ?? atomicWriteFile)(file, JSON.stringify({ v: 1, items: row.items, ledger: row.ledger }));
      return true;
    } catch { return false; }
  }

  /** Waits for queued writes (tests, quitting). */
  idle(): Promise<void> { return this.queue.run(async () => {}); }
}
