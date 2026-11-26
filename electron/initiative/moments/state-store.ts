// I-188: the small state the moments keep across restarts, in `<profile>/moments-state.json`: the last minute someone was at the
// computer on each of the last few nights (#4, numbers only), and the day/night each once-only moment was last recognised (late night,
// first meeting of the day, her goodnight). No words, no window, no app name. Unreadable: kept as it is, nothing learned and every once-only moment
// counts as used this session (fail closed: at worst she is quieter).
import { readFile } from 'node:fs/promises';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';
import { noteNightActivity, type BedNights } from '../../../shared/behaviors/moments/bedtime';
import { MOMENT_KNOBS, type MomentKnobs } from '../../../shared/behaviors/moments/knobs';

const KEY = /^\d{4}-\d{2}-\d{2}$/u;
export const MOMENT_ONCE = ['first-today', 'goodnight', 'late-night'] as const;
export type MomentOnce = (typeof MOMENT_ONCE)[number];

export class MomentStateStore {
  private nights: BedNights = {};
  private once: Partial<Record<MomentOnce, string>> = {};
  private state: 'unloaded' | 'loading' | 'ready' | 'blocked' = 'unloaded';
  private queue: Promise<void> = Promise.resolve();
  private dirty = false;
  constructor(private readonly file: () => string | null, private readonly write: AtomicFileWriter = atomicWriteFile, private readonly knobs: MomentKnobs = MOMENT_KNOBS) {}

  async load(): Promise<void> {
    if (this.state !== 'unloaded') return;
    const file = this.file();
    if (!file) return;
    this.state = 'loading';
    try {
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      if (!record || record.version !== 1) throw new Error('Invalid moments state');
      const nights: Record<string, number> = {};
      for (const [key, minute] of Object.entries((record.nights && typeof record.nights === 'object' ? record.nights : {}) as Record<string, unknown>))
        if (KEY.test(key) && typeof minute === 'number' && Number.isInteger(minute) && minute >= 0 && minute < 1440) nights[key] = minute;
      const once: Partial<Record<MomentOnce, string>> = {};
      for (const name of MOMENT_ONCE) { const day = (record.once as Record<string, unknown> | undefined)?.[name]; if (typeof day === 'string' && KEY.test(day)) once[name] = day; }
      // Anything noted while the file was loading is newer.
      this.nights = { ...nights, ...this.nights };
      this.once = { ...once, ...this.once };
      this.state = 'ready';
    } catch (error) {
      this.state = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'ready' : 'blocked';
    }
  }

  get ready(): boolean { if (this.state === 'unloaded') void this.load(); return this.state === 'ready'; }
  bedNights(): BedNights { return this.ready ? { ...this.nights } : {}; }

  /** Tonight's last active minute (only while ready); written at most once a minute by the caller's pace. */
  noteActive(tonight: string, localMinute: number): void {
    if (!this.ready || !KEY.test(tonight)) return;
    const next = noteNightActivity(this.nights, tonight, localMinute, this.knobs);
    if (next === this.nights) return;
    this.nights = next;
    this.dirty = true;
  }

  /** Already done this day/night, or not known yet (fail closed). */
  used(name: MomentOnce, day: string): boolean { return !this.ready || this.once[name] === day; }
  remember(name: MomentOnce, day: string): void {
    if (!KEY.test(day) || !this.ready) return;
    this.once[name] = day;
    this.dirty = true;
    this.save();
  }

  /** Writes when something changed (the host calls it about once a minute; remember() writes at once). */
  save(): void {
    const file = this.file();
    if (!this.dirty || !file || this.state !== 'ready') return;
    this.dirty = false;
    const data = JSON.stringify({ version: 1, nights: this.nights, once: this.once });
    this.queue = this.queue.then(() => this.write(file, data)).catch(() => { this.dirty = true; });
  }

  /** The 「知道你是不是在忙」 switch went off: what was learned about the nights goes (the once-only days stay). */
  forgetNights(): void { if (!Object.keys(this.nights).length) return; this.nights = {}; this.dirty = true; this.save(); }

  flush(): Promise<void> { return this.queue; }
}
