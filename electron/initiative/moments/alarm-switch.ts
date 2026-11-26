// I-195: the one switch for her own alarms ("让她自己留心（闹钟）", on the user profile page), default OFF everywhere.
// A small sidecar in the profile (`her-alarms.json`, one boolean), read once the first time somebody asks; a missing or damaged file is "off". Only the
// user's own click on the page writes it (the agent channel has no entry for it: it changes how much of the user's Claude usage a chat turn takes).
// `override` is for a throw-away test profile (the real-chat acceptance sets it): it only ever turns the switch on and writes nothing.
import { readFileSync } from 'node:fs';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';

export class AlarmSwitch {
  private value: boolean | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: () => string | null, private readonly write: AtomicFileWriter = atomicWriteFile, private readonly override: () => boolean = () => false,
    private readonly read: (file: string) => string = file => readFileSync(file, 'utf8')) {}

  get on(): boolean {
    try { if (this.override()) return true; } catch { /* the override is only a test hook */ }
    if (this.value === null) {
      this.value = false;
      try { const file = this.file(); if (file) { const raw: unknown = JSON.parse(this.read(file)); this.value = !!raw && typeof raw === 'object' && (raw as { version?: unknown }).version === 1 && (raw as { on?: unknown }).on === true; } } catch { this.value = false; }
    }
    return this.value;
  }

  /** The user's click. Resolves to the new value; a failed write keeps the old one. */
  set(on: boolean): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const file = this.file();
      if (!file) throw new Error('No profile folder.');
      await this.write(file, JSON.stringify({ version: 1, on }));
      this.value = on;
      return on;
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
