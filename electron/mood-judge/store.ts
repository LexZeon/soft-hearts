import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../atomic-file';

/**
 * I-027, `<profile>/mood-judge.json`: the switch "心情调整员" (default OFF: it spends the user's Claude quota, so only the user's
 * own words or click turn it on), how many times haiku was asked today and how many messages the user sent her today (the local
 * date both belong to; today's limit grows with the messages). The counts survive a restart and start again at local midnight.
 * Never an event, a word or an answer.
 */
interface Stored { version: 1; enabled: boolean; day: string; count: number; chats: number }
// On by default in every version (心情调整员默认开启); a saved choice (on or off) still wins.
const empty = (): Stored => ({ version: 1, enabled: true, day: '', count: 0, chats: 0 });
const amount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 100_000) : 0;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export class MoodJudgeStore {
  private data: Stored = empty();
  private loaded: 'no' | 'ready' | 'blocked' = 'no';
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly options: { file: () => string | null; write?: AtomicFileWriter }) {}

  async load(): Promise<void> {
    const file = this.options.file();
    if (!file) { this.loaded = 'ready'; return; }
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<Stored>;
      if (!raw || typeof raw !== 'object' || raw.version !== 1) throw new Error('Invalid mood-judge file');
      this.data = { version: 1, enabled: raw.enabled === true,
        day: typeof raw.day === 'string' && DAY.test(raw.day) ? raw.day : '',
        // A file from before 2026-11-06 has no `chats`: today's limit starts from the base.
        count: amount(raw.count), chats: amount(raw.chats) };
      this.loaded = 'ready';
    } catch (error) {
      // Missing: a first launch (on by default since 2026-11-07). Unreadable: leave the file alone, keep this session in memory, and
      // stay off (the user's choice is unknown: it may have been off).
      const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
      this.data = missing ? empty() : { ...empty(), enabled: false };
      this.loaded = missing ? 'ready' : 'blocked';
    }
  }

  get enabled(): boolean { return this.data.enabled; }
  setEnabled(value: boolean): void {
    if (typeof value !== 'boolean') throw new Error('心情调整员开关不正确。');
    if (this.data.enabled === value) return;
    this.data.enabled = value; this.save();
  }

  /** How many calls were made on local date `day` (0 for any other day). */
  today(day: string): number { return this.data.day === day ? this.data.count : 0; }
  /** One more call on `day`: a new day starts again at 1. Returns today's count. */
  noteCall(day: string): number {
    this.turnDay(day);
    this.data.count++;
    this.save();
    return this.data.count;
  }
  /** How many messages the user sent her on local date `day` (0 for any other day): today's limit grows with it. */
  chatsToday(day: string): number { return this.data.day === day ? this.data.chats : 0; }
  /** One more message on `day`. Only a number is kept, never the message. */
  noteChat(day: string): number {
    this.turnDay(day);
    this.data.chats = Math.min(this.data.chats + 1, 100_000);
    this.save();
    return this.data.chats;
  }
  private turnDay(day: string): void {
    if (this.data.day !== day) { this.data.day = day; this.data.count = 0; this.data.chats = 0; }
  }

  private save(): void {
    const file = this.options.file();
    if (!file || this.loaded !== 'ready') return;
    const text = JSON.stringify(this.data);
    this.queue = this.queue.then(async () => { await mkdir(path.dirname(file), { recursive: true }); await (this.options.write ?? atomicWriteFile)(file, text); }).catch(() => {});
  }
  flush(): Promise<void> { return this.queue; }
}
