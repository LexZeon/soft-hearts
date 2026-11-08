// 体验记录 (E2): the one writer of `<profile>/journal/<local date>.jsonl`. It only ever appends. It never rotates, renames,
// truncates or deletes a journal file (tests/journal-writer.test.ts reads this source to check): a day that reaches the wide
// daily ceiling (8 MiB, the marker included) gets one `truncated` line and nothing more that day, and everything written before
// stays as it was.
// A failed write is remembered for the panel and never reaches the caller: the companion goes on exactly as before.
import { appendFile, mkdir, open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { JOURNAL_DAY_LIMIT_BYTES, JOURNAL_RECENT, buildJournalEntry, readJournalLine, type JournalEntry, type JournalInput } from '../../shared/journal';
import { localDateKey } from '../diary/diary-dates';

/** The few file operations the writer uses (tests replace them to make a write fail). */
export interface JournalFs {
  mkdir(directory: string): Promise<unknown>;
  append(file: string, text: string): Promise<void>;
  /** Size in bytes, or null when the file does not exist yet. */
  size(file: string): Promise<number | null>;
  /** The last `bytes` of a file as UTF-8 ('' when it does not exist). */
  tail(file: string, bytes: number): Promise<string>;
  list(directory: string): Promise<string[]>;
}

export const nodeJournalFs: JournalFs = {
  mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
  append: (file, text) => appendFile(file, text, { encoding: 'utf8', mode: 0o600 }),
  size: async file => { try { return (await stat(file)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } },
  tail: async (file, bytes) => {
    let handle;
    try { handle = await open(file, 'r'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
    try {
      const { size } = await handle.stat(), length = Math.min(size, bytes), buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally { await handle.close(); }
  },
  list: async directory => { try { return await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } },
};

export interface JournalWriterOptions {
  /** `<profile>/journal`; null keeps nothing (no profile yet). */
  directory(): string | null;
  /** The user's switch "保留体验记录（只存本机）". Off: nothing is written or kept. */
  enabled(): boolean;
  clock?(): number;
  /** The local date of a time (YYYY-MM-DD): the file a line goes into. */
  localDay?(ms: number): string;
  dayLimitBytes?: number;
  fs?: JournalFs;
  /** A line was kept (for the control window's "刚才发生了什么"). */
  changed?(entry: JournalEntry): void;
}

export interface JournalWriterStatus {
  enabled: boolean;
  /** The last write failed (the code only, never a path). Cleared by the next successful write. */
  failure: string | null;
  /** Today's file reached the daily ceiling. */
  truncatedToday: boolean;
  /** Lines not written: the day was full, or too many were waiting. */
  dropped: number;
}

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const MAX_WAITING = 1_000;
const TAIL_BYTES = 64 * 1024;

export class JournalWriter {
  private readonly entries: JournalEntry[] = [];
  private readonly days = new Map<string, { size: number; truncated: boolean }>();
  private queue: Promise<void> = Promise.resolve();
  private waiting = 0;
  private failure: string | null = null;
  private dropped = 0;
  private readonly fs: JournalFs;
  constructor(private readonly options: JournalWriterOptions) { this.fs = options.fs ?? nodeJournalFs; }

  private now(): number { try { const value = (this.options.clock ?? Date.now)(); return Number.isFinite(value) ? value : Date.now(); } catch { return Date.now(); } }
  private on(): boolean { try { return this.options.enabled() === true; } catch { return false; } }
  private day(ms: number): string { return (this.options.localDay ?? localDateKey)(ms); }
  private limit(): number { return Math.max(1024, this.options.dayLimitBytes ?? JOURNAL_DAY_LIMIT_BYTES); }

  /** Keeps one moment, if the switch is on and it fits the whitelist. Never throws, never waits. */
  record(input: JournalInput): JournalEntry | null {
    try {
      if (!this.on()) return null;
      const entry = buildJournalEntry(input, this.now());
      if (!entry) return null;
      this.remember(entry);
      if (this.waiting >= MAX_WAITING) { this.dropped++; return entry; }
      this.waiting++;
      this.queue = this.queue.then(() => this.write(entry)).catch(error => { this.failure = errorCode(error); }).finally(() => { this.waiting--; });
      try { this.options.changed?.(entry); } catch { /* A closed window just misses this line. */ }
      return entry;
    } catch { return null; }
  }

  private remember(entry: JournalEntry): void {
    this.entries.push(entry);
    while (this.entries.length > JOURNAL_RECENT) this.entries.shift();
  }

  private async write(entry: JournalEntry): Promise<void> {
    const directory = this.options.directory();
    if (!directory) return;
    const day = this.day(entry.at), file = path.join(directory, `${day}.jsonl`);
    let state = this.days.get(day);
    if (!state) {
      await this.fs.mkdir(directory);
      const size = await this.fs.size(file) ?? 0;
      // A file near the ceiling may already end with this day's marker (an earlier run wrote it).
      const truncated = size + 4096 > this.limit() && (await this.fs.tail(file, 2048)).includes('"type":"truncated"');
      state = { size, truncated };
      this.days.set(day, state);
    }
    if (state.truncated) { this.dropped++; return; }
    const line = JSON.stringify(entry) + '\n', bytes = Buffer.byteLength(line);
    // 8 MiB 含标记: a line goes in only when the day's marker still fits after it, so the file, marker included, stays within it.
    const marker = JSON.stringify(buildJournalEntry({ type: 'truncated', characterId: null, day }, entry.at)) + '\n';
    const markerBytes = Buffer.byteLength(marker);
    if (state.size + bytes + markerBytes > this.limit()) {
      // A file an older version filled closer than one marker to the limit just stops here, without a marker, never going over.
      if (state.size + markerBytes <= this.limit()) {
        try { await this.fs.append(file, marker); } catch (error) { this.days.delete(day); throw error; }
        state.size += markerBytes;
        this.failure = null;
      }
      state.truncated = true; this.dropped++;
      return;
    }
    try { await this.fs.append(file, line); } catch (error) { this.days.delete(day); throw error; }
    state.size += bytes;
    this.failure = null;
  }

  /** Whether a line handed over now would be kept (the switch is on). Sources that merge moments ask before they start merging. */
  accepting(): boolean { return this.on(); }

  /** Waits for every line handed over so far (the quit path and tests). */
  async flush(): Promise<void> { await this.queue.catch(() => {}); }

  /** "刚才发生了什么": newest last; one character's lines only when `characterId` is given. Empty while the switch is off. */
  recent(characterId?: string | null): JournalEntry[] {
    if (!this.on()) return [];
    return this.entries.filter(entry => !characterId || entry.characterId === characterId).map(entry => structuredClone(entry));
  }

  status(): JournalWriterStatus {
    const today = this.days.get(this.day(this.now()));
    return { enabled: this.on(), failure: this.failure, truncatedToday: !!today?.truncated, dropped: this.dropped };
  }

  /**
   * After a restart or when the switch is turned on: the newest lines of the last two day files, read back through the same
   * whitelist, so the panel is not empty. Reads only; a damaged line is skipped.
   */
  async loadRecent(): Promise<void> {
    try {
      const directory = this.options.directory();
      if (!directory || !this.on()) return;
      const names = (await this.fs.list(directory)).filter(name => DAY_FILE.test(name)).sort().slice(-2);
      const loaded: JournalEntry[] = [];
      for (const name of names) {
        const text = await this.fs.tail(path.join(directory, name), TAIL_BYTES);
        const lines = text.split('\n');
        if (text.length >= TAIL_BYTES) lines.shift(); // The first line may be cut in the middle.
        for (const line of lines) { const entry = readJournalLine(line); if (entry && entry.type !== 'truncated') loaded.push(entry); }
      }
      const seen = new Set(this.entries.map(entry => JSON.stringify(entry)));
      const merged = [...loaded.filter(entry => !seen.has(JSON.stringify(entry))), ...this.entries].sort((a, b) => a.at - b.at).slice(-JOURNAL_RECENT);
      this.entries.splice(0, this.entries.length, ...merged);
    } catch { /* The panel starts empty; writing is unaffected. */ }
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'write-failed';
}
