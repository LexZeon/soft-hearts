import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../atomic-file';
import { FED_LIST_MAX, noteFed, readFedItem, type FedItem, type FeedVerdict } from '../../shared/feed-recognition';

/**
 * I-019, `<profile>/feed-recognition.json`: the switch "喂食时让她认出是什么" (default on: the user decided on 2026-11-03 that
 * the first feed does not ask) and, per character, what the user fed her: name, kind, how many times, the last time. Never a
 * picture, a file name or her words. Kinds are added only while the user profile's "允许记录" is on (how-we-work 做事方式 3:
 * remembering the user follows the profile switch), and go with the diary's clear like the 猜拳 counts (electron/rps/store.ts).
 */
interface Stored {
  version: 1;
  recognize: boolean;
  characters: Record<string, { fed: FedItem[] }>;
}
const empty = (): Stored => ({ version: 1, recognize: true, characters: {} });
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);

export class FeedRecognitionStore {
  private data: Stored = empty();
  private loaded: 'no' | 'ready' | 'blocked' = 'no';
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly options: { file: () => string | null; write?: AtomicFileWriter }) {}

  async load(): Promise<void> {
    const file = this.options.file();
    if (!file) { this.loaded = 'ready'; return; }
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<Stored>;
      if (!raw || typeof raw !== 'object' || raw.version !== 1) throw new Error('Invalid feed-recognition file');
      const data = empty();
      data.recognize = raw.recognize !== false;
      for (const [id, row] of Object.entries(raw.characters ?? {}).slice(0, 64)) {
        if (!validId(id) || !row || !Array.isArray(row.fed)) continue;
        data.characters[id] = { fed: row.fed.map(readFedItem).filter((item): item is FedItem => item !== null).slice(-FED_LIST_MAX) };
      }
      this.data = data; this.loaded = 'ready';
    } catch (error) {
      // Missing: a first launch. Unreadable: leave the file alone, keep this session in memory (the switch stays on).
      this.loaded = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'ready' : 'blocked';
    }
  }

  get recognize(): boolean { return this.data.recognize; }
  setRecognize(value: boolean): void {
    if (typeof value !== 'boolean') throw new Error('认图开关不正确。');
    if (this.data.recognize === value) return;
    this.data.recognize = value; this.save();
  }

  /** What the user fed this character, oldest first (empty while nothing was recorded). */
  fed(characterId: string): FedItem[] { return (this.data.characters[characterId]?.fed ?? []).map(item => ({ ...item })); }
  /** The newest kind fed, for the "此刻" line. */
  last(characterId: string): FedItem | null {
    const list = this.data.characters[characterId]?.fed ?? [];
    return list.length ? { ...list.reduce((a, b) => (b.lastAt >= a.lastAt ? b : a)) } : null;
  }
  /** One recognized food: counted only when `record` (the profile's "允许记录"). Returns how many times before this one. */
  note(characterId: string, verdict: FeedVerdict, at: number, record: boolean): number {
    if (!verdict.edible || !validId(characterId)) return 0;
    const list = this.data.characters[characterId]?.fed ?? [];
    const before = list.find(item => item.name === verdict.name)?.count ?? 0;
    if (!record) return before;
    this.data.characters[characterId] = { fed: noteFed(list, verdict, at) };
    this.save();
    return before;
  }

  /** Privacy: the diary was cleared or "允许记录" turned off, so this character's list goes too (the switch stays). */
  forget(characterId: string): boolean {
    if (!Object.hasOwn(this.data.characters, characterId)) return false;
    delete this.data.characters[characterId];
    this.save();
    return true;
  }

  private save(): void {
    const file = this.options.file();
    if (!file || this.loaded !== 'ready') return;
    const text = JSON.stringify(this.data);
    this.queue = this.queue.then(async () => { await mkdir(path.dirname(file), { recursive: true }); await (this.options.write ?? atomicWriteFile)(file, text); }).catch(() => {});
  }
  flush(): Promise<void> { return this.queue; }
}
