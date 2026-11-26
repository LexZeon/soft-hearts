// I-188 #13: the reminders the user asked her for ("明天八点提醒我交报告"), per character, local only, in `<profile>/reminders.json`.
// What is kept: the time, the user's own short words of what to remind (they go nowhere but her own prompt when it is time), whether the
// time was a guess, and the state. A reminder fires at most once: it is marked 'fired' in memory the moment her line is delivered, before
// the write, and a fired, cancelled or missed one is never due again (kept two days so a restart cannot bring it back). Unreadable file:
// left as it is; nothing is added or fired this session (fail closed).
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';
import { MOMENT_KNOBS, type MomentKnobs } from '../../../shared/behaviors/moments/knobs';

export const REMINDER_STATES = ['due', 'fired', 'cancelled', 'missed'] as const;
export type ReminderState = (typeof REMINDER_STATES)[number];
export interface StoredReminder {
  readonly id: string;
  readonly characterId: string;
  readonly dueAt: number;
  readonly what: string;
  readonly guessed: boolean;
  readonly createdAt: number;
  state: ReminderState;
  tries: number;
  nextTryAt: number;
  endedAt?: number;
  /** I-195: her own alarm (electron/initiative/moments/alarm-store.ts), not the user's reminder; the user's reminder methods never see these. */
  by?: 'her';
  /** I-195: what her alarm waits for (an AlarmEvent word or a word the user may say), whether it was seen (armed), and when it is given up (event and word ones). */
  on?: string;
  talk?: string;
  armed?: boolean;
  expiresAt?: number;
}

const HOUR = 3_600_000;
const KEEP_ENDED_MS = 48 * HOUR;
const MAX_ITEMS = 200;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;

export class ReminderStore {
  protected items: StoredReminder[] = [];
  private state: 'unloaded' | 'loading' | 'ready' | 'blocked' = 'unloaded';
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly file: () => string | null, private readonly write: AtomicFileWriter = atomicWriteFile,
    protected readonly knobs: MomentKnobs = MOMENT_KNOBS, protected readonly createId: () => string = randomUUID) {}

  async load(): Promise<void> {
    if (this.state !== 'unloaded') return;
    const file = this.file();
    if (!file) return;
    this.state = 'loading';
    try {
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      if (!record || record.version !== 1 || !Array.isArray(record.items)) throw new Error('Invalid reminders');
      const loaded = record.items.map(readItem).filter((item): item is StoredReminder => item !== null);
      const known = new Set(this.items.map(item => item.id));
      this.items = [...loaded.filter(item => !known.has(item.id)), ...this.items].slice(-MAX_ITEMS);
      this.state = 'ready';
    } catch (error) {
      this.state = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'ready' : 'blocked';
    }
  }

  /** Whether the file was read (or none was there yet); a blocked file stays as it is and nothing is added or fired this session. */
  get ready(): boolean { if (this.state === 'unloaded') void this.load(); return this.state === 'ready'; }

  /** A new reminder for this character; null when not ready, the words are empty or the character has too many waiting. */
  add(characterId: string, request: { dueAt: number; what: string; guessed: boolean }, now: number): StoredReminder | null {
    if (!this.ready || !characterId || !Number.isFinite(request.dueAt) || request.dueAt <= now) return null;
    const what = Array.from(String(request.what ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()).slice(0, this.knobs.reminder.whatChars).join('');
    if (this.waiting(characterId).length >= this.knobs.reminder.perCharacter) return null;
    const item: StoredReminder = { id: this.createId().replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 64) || `r${now}`, characterId, dueAt: request.dueAt, what: what || '到点了',
      guessed: request.guessed === true, createdAt: now, state: 'due', tries: 0, nextTryAt: request.dueAt };
    this.items.push(item);
    this.persist(now);
    return { ...item };
  }

  /** "不用提醒了": the newest waiting reminder of this character is cancelled. Returns it, or null when none was waiting. */
  cancelLatest(characterId: string, now: number): StoredReminder | null {
    if (!this.ready) return null;
    const item = this.waiting(characterId).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!item) return null;
    item.state = 'cancelled'; item.endedAt = now;
    this.persist(now);
    return { ...item };
  }

  /** One reminder's state (null: not known: gone, or the store is not ready). */
  stateOf(id: string): ReminderState | null { return this.ready ? this.items.find(item => item.id === id)?.state ?? null : null; }

  /** The user's waiting reminders of this character (her own alarms, I-195, are kept apart: AlarmStore). */
  waiting(characterId: string): StoredReminder[] { return this.ready ? this.items.filter(item => item.characterId === characterId && item.state === 'due' && item.by !== 'her') : []; }

  /**
   * The earliest reminder of this character whose time has come and whose next try is due; one too late (past lateHours) becomes 'missed'
   * on the way (returned in `missed` so the caller can journal it).
   */
  due(characterId: string, now: number): { item: StoredReminder | null; missed: StoredReminder[] } {
    const missed: StoredReminder[] = [];
    if (!this.ready) return { item: null, missed };
    for (const item of this.waiting(characterId)) {
      if (item.dueAt <= now && now - item.dueAt > this.knobs.reminder.lateHours * HOUR) { item.state = 'missed'; item.endedAt = now; missed.push({ ...item }); }
    }
    if (missed.length) this.persist(now);
    const item = this.waiting(characterId).filter(entry => entry.dueAt <= now && entry.nextTryAt <= now).sort((a, b) => a.dueAt - b.dueAt)[0] ?? null;
    return { item: item ? { ...item } : null, missed };
  }

  /** Her line about it was delivered: fired, never due again. Returns false when it was not waiting (already fired, cancelled, gone). */
  fired(id: string, now: number): boolean {
    const item = this.items.find(entry => entry.id === id);
    if (!item || item.state !== 'due') return false;
    item.state = 'fired'; item.endedAt = now;
    this.persist(now);
    return true;
  }

  /** A try that did not end in her saying it: the next one after retryMinutes; after `tries` tries it is 'missed'. Returns the new state. */
  tried(id: string, now: number): ReminderState | null {
    const item = this.items.find(entry => entry.id === id);
    if (!item || item.state !== 'due') return null;
    item.tries += 1;
    if (item.tries >= this.knobs.reminder.tries) { item.state = 'missed'; item.endedAt = now; }
    else item.nextTryAt = now + this.knobs.reminder.retryMinutes * 60_000;
    this.persist(now);
    return item.state;
  }

  /** Every reminder of this character goes (deleting the character with her memories, or the data map's clear). */
  forgetCharacter(characterId: string, now = Date.now()): number {
    const before = this.items.length;
    this.items = this.items.filter(item => item.characterId !== characterId);
    if (this.items.length !== before) this.persist(now);
    return before - this.items.length;
  }

  protected persist(now: number): void {
    this.items = this.items.filter(item => item.state === 'due' || now - (item.endedAt ?? now) <= KEEP_ENDED_MS).slice(-MAX_ITEMS);
    const file = this.file();
    if (!file || this.state !== 'ready') return;
    const data = JSON.stringify({ version: 1, items: this.items });
    this.queue = this.queue.then(() => this.write(file, data)).catch(() => { /* The next change writes the whole list again. */ });
  }

  flush(): Promise<void> { return this.queue; }
}

function readItem(raw: unknown): StoredReminder | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  if (typeof v.id !== 'string' || !ID.test(v.id) || typeof v.characterId !== 'string' || !v.characterId || v.characterId.length > 200 || typeof v.what !== 'string'
    || v.what.length > 200 || !(REMINDER_STATES as readonly unknown[]).includes(v.state) || Number.isNaN(num(v.dueAt)) || Number.isNaN(num(v.createdAt))) return null;
  return { id: v.id, characterId: v.characterId, dueAt: num(v.dueAt), what: v.what, guessed: v.guessed === true, createdAt: num(v.createdAt), state: v.state as ReminderState,
    tries: Number.isInteger(v.tries) && (v.tries as number) >= 0 ? v.tries as number : 0, nextTryAt: Number.isNaN(num(v.nextTryAt)) ? num(v.dueAt) : num(v.nextTryAt),
    ...(Number.isFinite(num(v.endedAt)) ? { endedAt: num(v.endedAt) } : {}),
    ...(v.by === 'her' ? { by: 'her' as const, ...(typeof v.on === 'string' && v.on.length <= 40 ? { on: v.on } : {}), ...(typeof v.talk === 'string' && v.talk.length <= 80 ? { talk: v.talk } : {}),
      ...(v.armed === true ? { armed: true } : {}), ...(Number.isFinite(num(v.expiresAt)) ? { expiresAt: num(v.expiresAt) } : {}) } : {}) };
}
