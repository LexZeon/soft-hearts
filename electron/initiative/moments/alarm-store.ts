// I-195: her own alarms ("留心"), in the same per-character file as the user's reminders (reminders.json; I-188 #13), kept apart by `by: 'her'`.
// An alarm is a time (it fires then), or an event / a word the user may say (it fires when that happens, once the optional time has passed), or both.
// Each fires at most once: the in-memory state moves to 'fired' the moment her line is delivered (or the word was told her in chat), before the write,
// and a fired, cancelled or missed one is never due again. Limits: perCharacter waiting; a time alarm is given up lateHours after its time, an event
// or word one eventExpiryDays after it could start. The note is her own words and goes nowhere but her own prompt (and the user's profile page).
import { ALARM_KNOBS, type AlarmKnobs } from '../../../shared/behaviors/alarms/knobs';
import { cleanAlarmWords } from '../../../shared/behaviors/alarms/parse';
import { isAlarmEvent, type AlarmEvent, type AlarmSpec, type AlarmView, type AlarmWhy } from '../../../shared/behaviors/alarms/interface';
import { USER_SLEEP } from '../../../shared/behaviors/alarms/prompt';
import { ReminderStore, type StoredReminder } from './reminder-store';

const HOUR = 3_600_000, DAY = 24 * HOUR;

export class AlarmStore extends ReminderStore {
  constructor(file: () => string | null, write?: ConstructorParameters<typeof ReminderStore>[1], momentKnobs?: ConstructorParameters<typeof ReminderStore>[2],
    createId?: ConstructorParameters<typeof ReminderStore>[3], private readonly alarmKnobs: AlarmKnobs = ALARM_KNOBS) { super(file, write, momentKnobs, createId); }

  /** A new alarm; null when the store is not ready, the note is empty or she already has the most waiting. */
  addHer(characterId: string, spec: AlarmSpec, now: number): StoredReminder | null {
    if (!this.ready || !characterId || !Number.isFinite(now)) return null;
    this.sweep(characterId, now);
    const note = cleanAlarmWords(spec.note, this.alarmKnobs.noteChars);
    if (!note || (spec.at === null && !spec.on && !spec.talk)) return null;
    if (this.mine(characterId).length >= this.alarmKnobs.perCharacter) return null;
    const waits = !!spec.on || !!spec.talk;
    const dueAt = spec.at ?? now;
    const item: StoredReminder = { id: this.createId().replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 64) || `a${now}`, characterId, dueAt, what: note, guessed: false, createdAt: now,
      state: 'due', tries: 0, nextTryAt: dueAt, by: 'her', ...(spec.on ? { on: spec.on } : {}), ...(spec.talk ? { talk: spec.talk } : {}),
      ...(waits ? { expiresAt: Math.max(dueAt, now) + this.alarmKnobs.eventExpiryDays * DAY } : {}) };
    this.items.push(item);
    this.persist(now);
    return { ...item };
  }

  /** Her waiting alarms of this character, oldest first (the order her prompt list numbers them in); the given-up ones are swept first. */
  views(characterId: string, now: number): AlarmView[] {
    return this.mine(characterId, now).map(item => ({ id: item.id, at: (item.on || item.talk) && item.dueAt <= item.createdAt ? null : item.dueAt,
      on: isAlarmEvent(item.on) ? item.on : null, talk: item.talk ?? null, note: item.what, createdAt: item.createdAt }));
  }

  /** Take one (1.. in the list's order), all, or the only one ('any' with exactly one waiting) away. `ambiguous`: 'any' with more than one: nothing taken. */
  dropHer(characterId: string, which: number | 'all' | 'any', now: number): { dropped: StoredReminder[]; ambiguous: boolean; count: number } {
    const list = this.mine(characterId, now);
    const chosen = which === 'all' ? list : which === 'any' ? (list.length === 1 ? list : []) : list[which - 1] ? [list[which - 1]!] : [];
    for (const item of chosen) { item.state = 'cancelled'; item.endedAt = now; }
    if (chosen.length) this.persist(now);
    return { dropped: chosen.map(item => ({ ...item })), ambiguous: which === 'any' && list.length > 1, count: list.length };
  }

  /** One recognised event: the alarms waiting for it (whose time window has opened) are armed. Returns how many. */
  event(characterId: string, word: AlarmEvent, now: number): number {
    let armed = 0;
    for (const item of this.mine(characterId, now)) if (item.on === word && !item.armed && item.dueAt <= now) { item.armed = true; item.nextTryAt = now; armed++; }
    if (armed) this.persist(now);
    return armed;
  }

  /**
   * The user's own message: an alarm waiting for a word they used, or for them going to sleep, wakes now. It is handed to her inside this chat turn (no
   * speech opportunity needed), so it is marked fired here, once. Returns the woken ones with the cause.
   */
  textHits(characterId: string, text: unknown, now: number): { item: StoredReminder; why: AlarmWhy }[] {
    const message = typeof text === 'string' ? text.slice(0, 2000).toLowerCase().replace(/\s+/gu, '') : '';
    if (!message) return [];
    const hits: { item: StoredReminder; why: AlarmWhy }[] = [];
    for (const item of this.mine(characterId, now)) {
      if (item.dueAt > now) continue;
      const talked = !!item.talk && message.includes(item.talk.toLowerCase().replace(/\s+/gu, ''));
      const slept = item.on === 'user-sleep' && USER_SLEEP.test(String(text));
      if (!talked && !slept) continue;
      item.state = 'fired'; item.endedAt = now;
      hits.push({ item: { ...item }, why: talked ? 'talk' : 'user-sleep' });
    }
    if (hits.length) this.persist(now);
    return hits;
  }

  /** The earliest alarm of this character that should speak now (a time one whose time came, or an armed event one); `gaveUp` counts the ones swept as too late. */
  dueHer(characterId: string, now: number): { item: StoredReminder | null; gaveUp: number } {
    const gaveUp = this.sweep(characterId, now);
    const list = this.mine(characterId);
    const item = list.filter(entry => entry.nextTryAt <= now && entry.dueAt <= now && ((!entry.on && !entry.talk) || (!!entry.on && entry.armed === true)))
      .sort((a, b) => a.dueAt - b.dueAt)[0] ?? null;
    return { item: item ? { ...item } : null, gaveUp };
  }

  /** Why this alarm woke (for her line and the journal). */
  whyOf(item: Pick<StoredReminder, 'on' | 'talk'>): AlarmWhy { return isAlarmEvent(item.on) ? item.on : item.talk ? 'talk' : 'time'; }

  /** Waiting alarms of this character, oldest first; given-up ones swept (state 'missed') on the way when `now` is given. */
  private mine(characterId: string, now?: number): StoredReminder[] {
    if (now !== undefined) this.sweep(characterId, now);
    return this.items.filter(item => item.by === 'her' && item.characterId === characterId && item.state === 'due').sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  private sweep(characterId: string, now: number): number {
    let changed = 0;
    for (const item of this.items) {
      if (item.by !== 'her' || item.characterId !== characterId || item.state !== 'due') continue;
      const waits = !!item.on || !!item.talk;
      if (waits ? now > (item.expiresAt ?? item.createdAt + this.alarmKnobs.eventExpiryDays * DAY) : now - item.dueAt > this.alarmKnobs.lateHours * HOUR) { item.state = 'missed'; item.endedAt = now; changed++; }
    }
    if (changed) this.persist(now);
    return changed;
  }
}
