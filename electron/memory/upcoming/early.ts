// P-001 step 1, "两分钟先记下": a plan is captured about two minutes after the user says it, not only when the
// chat segment ends (the segment's note waits 15 quiet minutes plus 90 seconds, and any new message restarts that wait).
//
// For a segment marked "may record", when the user's NEW messages (not examined before) contain a time word and the user has not interacted
// for `UPCOMING_KNOBS.early.quietSeconds`, with nothing else busy, ONE small call looks at just those messages (plus a little context before
// them) and asks only for the upcoming field. The answer goes through the same local guards as the note's (extractUpcoming, the profile's
// sensitive words) and the same book (blockedFrom, dedupe, the switch re-checked when the file is written).
//  - Every message is examined once: the examined count moves when the call starts, whatever happens to it (no retry; the segment's own note
//    still asks the same question later and the book dedupes by segment + moment, so a plan is never listed twice).
//  - Turning the recording switch off by hand (recordingOff) abandons a call in flight; a call that lands after the switch is off, the mark
//    gone, the segment deleted or the host disposed writes nothing.
//  - A per-day cap is the safety net against a loop, not a pacing rule.
// Nothing here is logged but counts; the journal gets the existing `upcoming` event with via: 'early'.

import { hasTimeWord } from '../../../shared/behaviors/upcoming/due';
import type { UpcomingBook } from '../../../shared/behaviors/upcoming/interface';
import { UPCOMING_KNOBS, type UpcomingKnobs } from '../../../shared/behaviors/upcoming/knobs';
import { EARLY_UPCOMING_SYSTEM_PROMPT, extractUpcoming } from '../../../shared/behaviors/upcoming/prompt';
import type { UpcomingJournalEvent, UpcomingJournalVia } from '../../../shared/memory/journal-entries';
import { memoryNotePrompt } from '../../../shared/memory/memory-notes/note';
import type { MemoryNoteWriter, NoteArchive, NoteSegmentMessage } from '../../../shared/memory/memory-notes/interface';

export interface EarlyUpcomingDeps {
  archive: NoteArchive;
  /** The same small no-tools call the notebook uses (haiku). */
  write: MemoryNoteWriter;
  /** The user's recording switch, with a ready profile. */
  recording(): boolean;
  marked(recordId: string): boolean;
  /** The profile scope id of the character a notebook key belongs to, or null. */
  scopeOf(noteScope: string): string | null;
  book: UpcomingBook;
  /** Same gates as the notebook: the user with her / speaking, another model call in flight or Claude unavailable. */
  userBusy(): boolean;
  modelBusy(): boolean;
  lastActivityAt(): number | null;
  reject?(text: string): boolean;
  changed?(): void;
  journal?(event: UpcomingJournalEvent, count: number, via?: UpcomingJournalVia): void;
  now?(): number;
  localDay?(ms: number): string;
  tickMs?: number;
  knobs?: UpcomingKnobs;
}

interface Run { recordId: string; controller: AbortController; epoch: number }

const localDay = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const MAX_REMEMBERED = 500;

export class EarlyUpcoming {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Run | null = null;
  private epoch = 0;
  private disposed = false;
  /** Per segment: the source fingerprint last looked at and how many of the user's messages were examined. */
  private readonly seen = new Map<string, { source: string; users: number }>();
  private calls = { day: '', count: 0 };
  /** Calls started (tests and the developer view). */
  started = 0;

  constructor(private readonly deps: EarlyUpcomingDeps) {}

  private get knobs(): UpcomingKnobs { return this.deps.knobs ?? UPCOMING_KNOBS; }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? 10_000);
    this.timer.unref?.();
  }

  get busy(): boolean { return !!this.running; }

  /** Looks once; starts at most one call and returns whether it did. */
  tick(): boolean {
    if (this.disposed || this.running) return false;
    if (!this.safe(() => this.deps.recording(), false)) return false;
    if (this.safe(() => this.deps.userBusy(), true) || this.safe(() => this.deps.modelBusy(), true)) return false;
    const now = this.now(), early = this.knobs.early;
    const last = this.safe(() => this.deps.lastActivityAt(), null);
    if (last !== null && now - last < early.quietSeconds * 1000) return false;
    const day = (this.deps.localDay ?? localDay)(now);
    if (this.calls.day === day && this.calls.count >= early.dailyCalls) return false;
    let segments;
    try { segments = this.deps.archive.noteSegments(now); } catch { return false; }
    for (const segment of [...segments].sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id))) {
      if (!this.safe(() => this.deps.marked(segment.id), false)) continue;
      const before = this.seen.get(segment.id);
      if (before && before.source === segment.source) continue;
      let text;
      try { text = this.deps.archive.noteSegment(segment.id, now); } catch { continue; }
      if (!text) continue;
      const users = text.messages.filter(message => message.role === 'user').length;
      const examined = Math.min(before?.users ?? 0, users);
      this.seen.set(segment.id, { source: segment.source, users });
      this.trim();
      // The user's messages not examined yet; only a time word among them is worth a call.
      const fresh = text.messages.map((message, index) => ({ message, index })).filter(item => item.message.role === 'user').slice(examined);
      if (!fresh.some(item => typeof item.message.content === 'string' && hasTimeWord(item.message.content, segment.createdAt))) continue;
      const start = Math.max(0, fresh[0].index - early.contextMessages);
      const slice: NoteSegmentMessage[] = text.messages.slice(start).slice(-early.maxMessages).map(message => ({ ...message }));
      const run: Run = { recordId: segment.id, controller: new AbortController(), epoch: this.epoch };
      this.running = run;
      this.started++;
      this.calls = { day, count: (this.calls.day === day ? this.calls.count : 0) + 1 };
      let pending: Promise<string>;
      try { pending = this.deps.write(memoryNotePrompt(slice), EARLY_UPCOMING_SYSTEM_PROMPT, run.controller.signal); }
      catch (error) { pending = Promise.reject(error); }
      pending.then(raw => this.land(run, segment.scope, segment.createdAt, slice, raw), () => { if (this.running === run) this.running = null; });
      return true;
    }
    return false;
  }

  private land(run: Run, noteScope: string, at: number, messages: readonly NoteSegmentMessage[], raw: unknown): void {
    if (this.running !== run) return;
    this.running = null;
    if (this.disposed || run.controller.signal.aborted || run.epoch !== this.epoch || typeof raw !== 'string') return;
    if (!this.safe(() => this.deps.recording(), false) || !this.safe(() => this.deps.marked(run.recordId), false)) return;
    let still;
    try { still = this.deps.archive.noteSegment(run.recordId, this.now()); } catch { still = null; }
    if (!still) return;
    const scope = this.safe(() => this.deps.scopeOf(noteScope), null);
    if (!scope) return;
    const items = extractUpcoming(raw, messages, { at, reject: this.deps.reject });
    if (!items.length) return;
    void this.deps.book.add({ from: run.recordId, items, scope }).then(added => {
      if (added > 0 && !this.disposed) { this.deps.journal?.('recorded', added, 'early'); this.deps.changed?.(); }
    }).catch(() => undefined);
  }

  /** The segment's full note was written: everything in it counts as examined (its own question covers the same ground). */
  noteWritten(recordId: string): void {
    const now = this.now();
    try {
      const text = this.deps.archive.noteSegment(recordId, now);
      const info = this.deps.archive.noteSegments(now).find(segment => segment.id === recordId);
      if (text && info) this.seen.set(recordId, { source: info.source, users: text.messages.filter(message => message.role === 'user').length });
    } catch { /* The book dedupes anyway. */ }
  }

  forget(ids: readonly string[]): void { for (const id of ids) this.seen.delete(id); }
  keepOnly(ids: ReadonlySet<string>): void { for (const id of [...this.seen.keys()]) if (!ids.has(id)) this.seen.delete(id); }

  /** The user turned the recording switch off by hand: a call in flight is abandoned and writes nothing. */
  recordingOff(): void {
    this.epoch++;
    this.running?.controller.abort();
    this.running = null;
    this.seen.clear();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running?.controller.abort();
    this.running = null;
  }

  private trim(): void { while (this.seen.size > MAX_REMEMBERED) { const oldest = this.seen.keys().next().value; if (oldest === undefined) break; this.seen.delete(oldest); } }
}
