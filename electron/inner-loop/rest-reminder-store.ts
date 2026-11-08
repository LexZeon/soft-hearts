import { readFile } from 'node:fs/promises';
import { atomicWriteFile, type AtomicFileWriter } from '../atomic-file';

const NIGHT = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Remembers the night of the last rest reminder, across restarts, in
 * `<profile>/inner-loop-state.json`. One value for the whole app: a character switch does not buy another
 * reminder the same night. Until the file is read (or when it cannot be read) every night counts as used.
 */
export class RestReminderStore {
  private last: string | null = null;
  private state: 'unloaded' | 'loading' | 'ready' | 'blocked' = 'unloaded';
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly file: () => string | null, private readonly write: AtomicFileWriter = atomicWriteFile) {}

  async load(): Promise<void> {
    if (this.state !== 'unloaded') return;
    const file = this.file();
    if (!file) return;
    this.state = 'loading';
    try {
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      if (!record || record.version !== 1 || (record.restReminderNight !== null && (typeof record.restReminderNight !== 'string' || !NIGHT.test(record.restReminderNight))))
        throw new Error('Invalid inner-loop state');
      // A reminder given while the file was loading is newer than the stored one.
      this.last ??= record.restReminderNight as string | null;
      this.state = 'ready';
    } catch (error) {
      // Missing file: nothing reminded yet. Unreadable: keep the file, skip reminders this session.
      this.state = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'ready' : 'blocked';
    }
  }

  used(night: string): boolean {
    if (this.state === 'unloaded') void this.load();
    return this.state !== 'ready' || this.last === night;
  }

  remember(night: string): void {
    if (!NIGHT.test(night)) return;
    this.last = night;
    const file = this.file();
    if (!file || this.state === 'blocked') return;
    const data = JSON.stringify({ version: 1, restReminderNight: night });
    this.queue = this.queue.then(() => this.write(file, data)).catch(() => { /* Next launch may remind once more. */ });
  }

  /** Test seam and quit path: wait for the last write. */
  flush(): Promise<void> { return this.queue; }
}
