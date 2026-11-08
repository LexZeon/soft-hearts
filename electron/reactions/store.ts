import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../atomic-file';
import { DISPOSITION_IDS, validateDispositions, type DispositionId, type Dispositions } from '../../shared/behaviors/reactions/dispositions';

/**
 * I-037 新的反应方式, two small files in the profile directory:
 *
 * - `reactions.json`: the switch, how many times haiku was asked today and how many messages the user sent today (the local date
 *   both belong to; today's limit grows with the messages, the same formula as the 心情调整员 but counted on its own). The switch's
 *   default depends on the channel: ON for the development channel and source runs, OFF for the stable channel,
 *   until the user has accepted it. A file that holds the user's own choice keeps it either way.
 * - `reaction-dispositions.json`: the six 反应倾向 per character id (by character id in a small file, never in the
 *   card: older versions read cards strictly). A character without a row uses the values derived from its card.
 *
 * Never a word, an event or an answer: a boolean, counts, dates and 0–100 integers.
 */
interface StoredSwitch { version: 1; enabled: boolean | null; day: string; count: number; chats: number }
interface StoredDispositions { version: 1; characters: Record<string, Dispositions> }
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const amount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 100_000) : 0;
const emptySwitch = (): StoredSwitch => ({ version: 1, enabled: null, day: '', count: 0, chats: 0 });

export interface ReactionStoreOptions {
  /** The profile directory, or null (tests, no profile yet: memory only). */
  directory(): string | null;
  /** The switch when the user never chose: true for development and source runs, false for the stable channel. */
  defaultEnabled: boolean;
  write?: AtomicFileWriter;
}

export class ReactionStore {
  private data: StoredSwitch = emptySwitch();
  private characters = new Map<string, Dispositions>();
  private loaded: { switch: 'no' | 'ready' | 'blocked'; dispositions: 'no' | 'ready' | 'blocked' } = { switch: 'no', dispositions: 'no' };
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly options: ReactionStoreOptions) {}

  private file(name: string): string | null { const dir = this.options.directory(); return dir ? path.join(dir, name) : null; }

  async load(): Promise<void> {
    const switchFile = this.file('reactions.json'), dispositionFile = this.file('reaction-dispositions.json');
    if (!switchFile) this.loaded.switch = 'ready';
    else try {
      const raw = JSON.parse(await readFile(switchFile, 'utf8')) as Partial<StoredSwitch>;
      if (!raw || typeof raw !== 'object' || raw.version !== 1) throw new Error('Invalid reactions file');
      this.data = { version: 1, enabled: typeof raw.enabled === 'boolean' ? raw.enabled : null, day: typeof raw.day === 'string' && DAY.test(raw.day) ? raw.day : '',
        count: amount(raw.count), chats: amount(raw.chats) };
      this.loaded.switch = 'ready';
    } catch (error) {
      // Missing: a first launch (the channel's default). Unreadable: leave the file alone, keep this session in memory, and stay OFF.
      this.data = emptySwitch();
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') this.loaded.switch = 'ready';
      else { this.loaded.switch = 'blocked'; this.data.enabled = false; }
    }
    if (!dispositionFile) this.loaded.dispositions = 'ready';
    else try {
      const raw = JSON.parse(await readFile(dispositionFile, 'utf8')) as Partial<StoredDispositions>;
      if (!raw || typeof raw !== 'object' || raw.version !== 1 || !raw.characters || typeof raw.characters !== 'object' || Array.isArray(raw.characters)) throw new Error('Invalid dispositions file');
      this.characters.clear();
      for (const [id, value] of Object.entries(raw.characters)) {
        if (!ID.test(id)) continue;
        try { this.characters.set(id, Object.freeze(validateDispositions(value) as Dispositions)); } catch { /* A broken row: that character uses its card's values. */ }
      }
      this.loaded.dispositions = 'ready';
    } catch (error) {
      this.characters.clear();
      this.loaded.dispositions = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'ready' : 'blocked';
    }
  }

  // ---------------------------------------------------------------- the switch and the day's counts

  get enabled(): boolean { return this.data.enabled ?? this.options.defaultEnabled; }
  /** True once the user (or the agent channel on the user's words) chose; the channel's default otherwise. */
  get chosen(): boolean { return this.data.enabled !== null; }
  setEnabled(value: boolean): void {
    if (typeof value !== 'boolean') throw new Error('新的反应方式开关不正确。');
    if (this.data.enabled === value) return;
    this.data.enabled = value; this.saveSwitch();
  }
  today(day: string): number { return this.data.day === day ? this.data.count : 0; }
  noteCall(day: string): number { this.turnDay(day); this.data.count++; this.saveSwitch(); return this.data.count; }
  chatsToday(day: string): number { return this.data.day === day ? this.data.chats : 0; }
  noteChat(day: string): number { this.turnDay(day); this.data.chats = Math.min(this.data.chats + 1, 100_000); this.saveSwitch(); return this.data.chats; }
  private turnDay(day: string): void { if (this.data.day !== day) { this.data.day = day; this.data.count = 0; this.data.chats = 0; } }

  // ---------------------------------------------------------------- dispositions

  /** The stored six for this character, or null (then its card's derived values are used). */
  dispositions(characterId: string): Dispositions | null { return this.characters.get(characterId) ?? null; }
  /**
   * Sets some or all of the six for this character (`base` fills the ones not given: the values it uses now). Returns what was
   * stored before (null: none, the card's values were used), so the change can be undone with `restore`.
   */
  setDispositions(characterId: string, values: unknown, base: Dispositions): { before: Dispositions | null; after: Dispositions } {
    if (typeof characterId !== 'string' || !ID.test(characterId)) throw new Error('角色不正确。');
    if (this.loaded.dispositions === 'blocked') throw new Error('反应倾向文件读不出来，这次先不改（文件原样保留）。');
    const partial = validateDispositions(values, { partial: true });
    const after = {} as Record<DispositionId, number>;
    for (const id of DISPOSITION_IDS) after[id] = partial[id] ?? base[id];
    const before = this.characters.get(characterId) ?? null;
    this.characters.set(characterId, Object.freeze(after));
    this.saveDispositions();
    return { before, after: Object.freeze({ ...after }) };
  }
  /** Puts back what `setDispositions` returned as `before` (null: the row goes, the card's values are used again). */
  restore(characterId: string, before: Dispositions | null): void {
    if (typeof characterId !== 'string' || !ID.test(characterId) || this.loaded.dispositions === 'blocked') return;
    if (before) this.characters.set(characterId, Object.freeze(validateDispositions(before) as Dispositions)); else this.characters.delete(characterId);
    this.saveDispositions();
  }

  // ---------------------------------------------------------------- saving

  private saveSwitch(): void {
    const file = this.file('reactions.json');
    if (!file || this.loaded.switch !== 'ready') return;
    this.enqueue(file, JSON.stringify(this.data));
  }
  private saveDispositions(): void {
    const file = this.file('reaction-dispositions.json');
    if (!file || this.loaded.dispositions !== 'ready') return;
    this.enqueue(file, JSON.stringify({ version: 1, characters: Object.fromEntries(this.characters) } satisfies StoredDispositions));
  }
  private enqueue(file: string, text: string): void {
    this.queue = this.queue.then(async () => { await mkdir(path.dirname(file), { recursive: true }); await (this.options.write ?? atomicWriteFile)(file, text); }).catch(() => {});
  }
  flush(): Promise<void> { return this.queue; }
}
