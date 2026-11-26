// I-021 (docs/claude/2026-11-04-memory-notes.md): her notebook. When a chat segment has ended and the user is not with her,
// one small-model call writes one note for it; old segments get theirs the same way, slowly, newest and current character
// first, until every one worth noting has one. Interruptible: what is written is saved after each note, so the next run
// carries on with the segments still missing one.
//
// Ordering and lifetime (one reply is filed once; cancellation, lateness or a changed context cannot revive it): one call at a
// time; a result lands only while it is still the running call, its segment still exists with the same text, and the user
// has not deleted its note. Deleting a memory (MemoryStore's removal hook) or its note aborts a call for it. The chat archive
// (`memories.jsonl`) is only read, never written.
//
// Privacy: the conversation goes only to the user's own Claude Code (the writer the host gives, the same way as chat); nothing
// here logs a note or a message, only counts and durations (MemoryNotesEvent).

import type {
  MemoryNote, MemoryNoteBody, MemoryNoteHint, MemoryNoteTraits, MemoryNoteUpdate, MemoryNoteState, MemoryNotesEvent, MemoryNotesProgress, MemoryNoteWriter,
  MemoryRecallHints, NoteArchive, NoteSegmentInfo, NoteSegmentMessage, RecordsRemoval,
} from '../../../shared/memory/memory-notes/interface';
import { MEMORY_NOTES_KNOBS, type MemoryNotesKnobs } from '../../../shared/memory/memory-notes/knobs';
import { MEMORY_SEMANTIC_KNOBS } from '../../../shared/memory/memory-semantic/knobs';
import { MEMORY_NOTE_SYSTEM_PROMPT, faithfulNote, memoryNotePrompt, parseMemoryNote } from '../../../shared/memory/memory-notes/note';
import { withUpcomingQuestion } from '../../../shared/behaviors/upcoming/prompt';
import { hasTimeWord } from '../../../shared/behaviors/upcoming/due';
import { updatesFor } from '../../../shared/memory/memory-notes/supersede';
import { noteHint, prepareNote, prepareNoteQuery, sharedNoteTags, type PreparedNote } from '../../../shared/memory/memory-notes/recall';
import type { MemoryNotesFile } from './store';
import { extractKeywordsField, type Keyword } from '../../../shared/memory/memory-keywords/keyword';
import { putListed, takeListed, type ListedPart } from '../../foundation/keyed-part';

export interface MemoryNotesDeps {
  readonly archive: NoteArchive;
  /** One small-model call (haiku): prompt, system prompt → its raw answer. Throwing is a failed call, not a bad note. */
  readonly write: MemoryNoteWriter;
  save(file: MemoryNotesFile): Promise<void>;
  /** The user is with her now (a chat turn, typing, her reply or voice playing, voice input): no new note starts. */
  userBusy(): boolean;
  /** Another model call is running, or Claude is unavailable: no new note starts. */
  modelBusy(): boolean;
  /** When the user last interacted with her (ms), or null. */
  lastActivityAt(): number | null;
  /** The current character and connection (MemoryStore.noteScope), or null: its segments go first; the panel counts only it. */
  currentScope(): string | null;
  /** The control window's view changed. */
  changed?(): void;
  /** Counts and durations only. */
  report?(event: MemoryNotesEvent): void;
  now?(): number;
  /** I-049: a note was written; its writer also gave keywords (kept in the separate keyword index, never in the note). Best effort. */
  noted?(info: { recordId: string; scope: string; at: number; body: MemoryNoteBody; keywords: readonly Keyword[] }): void;
  /** I-049: these memories' notes went (deleted, forgotten, note deleted): their keywords go too. Best effort. */
  dropped?(recordIds: readonly string[]): void;
  /** I-049: the chat records the keywords point at for this user line (and the lines before it), with a score each. Local, never waits. */
  keywordScores?(text: string): ReadonlyMap<string, { score: number; terms: readonly string[] }>;
  /** I-111: the chat records whose MEANING is close to this user line, with a score each (electron/memory/memory-semantic/). Local, never waits; empty when off. */
  semanticScores?(text: string): ReadonlyMap<string, { score: number; terms: readonly string[] }>;
  /** I-088: the notes changed (`removed`: a note or memory went). The people-and-things entries are recomputed from the notes. Best effort. */
  notesChanged?(removed: boolean): void;
  /** I-088: for this user message (matching form), the notes whose entry (a person or thing under several names) the message names, with the names. Local, never waits. */
  aliasNotes?(squashedMessage: string): ReadonlyMap<string, readonly string[]> | null;
  /** Local calendar day of a time (the daily cap). */
  localDay?(ms: number): string;
  /** P-001: this segment is marked "may record" (the switch was on for all of it). Only then the note call carries the extra question. Local, never waits. */
  marked?(recordId: string): boolean;
  /** P-001: a note was written for a marked segment; the writer's whole answer is handed over to read the plans in it. Best effort. */
  upcomingNoted?(info: { recordId: string; scope: string; at: number; raw: string; messages: readonly NoteSegmentMessage[] }): void;
  /** P-001: the segments that exist now (reconcile): what came from any other goes. Best effort. */
  survivors?(ids: ReadonlySet<string>): void;
  knobs?: MemoryNotesKnobs;
}

interface Run {
  readonly recordId: string;
  readonly source: string;
  readonly segmentAt: number;
  readonly messages: readonly NoteSegmentMessage[];
  readonly controller: AbortController;
  readonly startedAt: number;
  /** P-001: asked the extra question. */
  readonly marked: boolean;
}

/**
 * I-021 删除一致性: how long a deleted note's mark waits for its memory to come back from the recycle bin (the bin keeps an
 * entry at most RECYCLE_MAX_DAYS = 30 days, electron/memory/memory-recycle-bin.ts; a test holds this above it).
 */
export const PARKED_DAYS = 31;
/** I-144: what the recycle bin keeps of the notebook for some records (MemoryNotesCore.recycleCopy). */
export interface MemoryNotesPart {
  notes: ListedPart<MemoryNote> | null;
  deleted: ListedPart<string> | null;
  parked: ListedPart<[string, number]> | null;
  failed: ListedPart<[string, { source: string; attempts: number }]> | null;
}
const localDay = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const NO_PROGRESS: MemoryNotesProgress = Object.freeze({ noted: 0, waiting: 0 });
export const NOT_A_SEGMENT: MemoryNoteState = Object.freeze({ status: 'none', note: null, writtenAt: null, progress: NO_PROGRESS });

export class MemoryNotesCore implements MemoryRecallHints {
  private notes = new Map<string, MemoryNote>();
  private readonly prepared = new Map<string, PreparedNote>();
  private deleted = new Set<string>();
  /** Deleted marks whose memory is in the recycle bin: record id → when it went (PARKED_DAYS). */
  private parked = new Map<string, number>();
  /** MemoryRecallHints.revision: goes up whenever a note is taken back. */
  private withdrawn = 0;
  private failed = new Map<string, { source: string; attempts: number }>();
  private calls = { day: '', count: 0 };
  private running: Run | null = null;
  private readonly now: () => number;
  private readonly knobs: MemoryNotesKnobs;
  private readonly bootAt: number;
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private pausedUntil = 0;
  private saving: Promise<void> = Promise.resolve();
  private disposed = false;
  /** This run's numbers (developer view and tests). */
  readonly counts: Record<MemoryNotesEvent['kind'] | 'started', number> = { started: 0, written: 0, invalid: 0, failed: 0, dropped: 0, aborted: 0 };

  constructor(private readonly deps: MemoryNotesDeps) {
    this.now = deps.now ?? Date.now;
    this.knobs = deps.knobs ?? MEMORY_NOTES_KNOBS;
    this.bootAt = this.now();
  }

  /** The loaded file (already validated). */
  load(file: MemoryNotesFile): void {
    this.notes = new Map(file.notes.map(note => [note.recordId, structuredClone(note)]));
    this.prepared.clear();
    this.deleted = new Set(file.deleted);
    this.parked = new Map((file.parked ?? []).map(item => [item.recordId, item.at]));
    this.failed = new Map(file.failed.map(item => [item.recordId, { source: item.source, attempts: item.attempts }]));
    this.calls = { ...file.calls };
  }
  snapshot(): MemoryNotesFile {
    return { version: 1, notes: [...this.notes.values()].map(note => structuredClone(note)), deleted: [...this.deleted],
      parked: [...this.parked].map(([recordId, at]) => ({ recordId, at })),
      failed: [...this.failed].map(([recordId, item]) => ({ recordId, ...item })), calls: { ...this.calls } };
  }

  /**
   * Notes, deleted marks and failures whose segment is no longer in the archive go (a crash between a memory's deletion and its
   * note's). A parked mark whose memory is back from the recycle bin is a deleted mark again; one the bin cannot hold any more
   * goes. Nothing changes when the archive cannot be read. Returns whether anything went.
   */
  reconcile(segments?: readonly NoteSegmentInfo[]): boolean {
    let list = segments;
    if (!list) { try { list = this.deps.archive.noteSegments(this.now()); } catch { return false; } }
    const ids = new Set(list.map(segment => segment.id));
    let changed = false;
    const now = this.now();
    for (const [id, at] of [...this.parked]) {
      if (ids.has(id)) { this.parked.delete(id); this.deleted.add(id); changed = true; }
      else if (now - at > PARKED_DAYS * 86_400_000) { this.parked.delete(id); changed = true; }
    }
    let gone = false;
    for (const id of [...this.notes.keys()]) if (!ids.has(id)) { this.notes.delete(id); this.prepared.delete(id); changed = gone = true; }
    if (gone) this.safe(() => this.deps.notesChanged?.(true), undefined);
    for (const id of [...this.deleted]) if (!ids.has(id)) { this.deleted.delete(id); changed = true; }
    for (const id of [...this.failed.keys()]) if (!ids.has(id)) { this.failed.delete(id); changed = true; }
    this.safe(() => this.deps.survivors?.(ids), undefined);
    if (changed) this.persist();
    return changed;
  }

  // ---- writing ----

  /** The host's timer. Starts at most one call; returns whether it did. */
  tick(): boolean {
    if (this.disposed || this.running) return false;
    const now = this.now(), pace = this.knobs.pace;
    if (now - this.bootAt < pace.startDelaySeconds * 1000 || now - this.lastCallAt < pace.spacingSeconds * 1000 || now < this.pausedUntil) return false;
    if (this.safe(() => this.deps.userBusy(), true) || this.safe(() => this.deps.modelBusy(), true)) return false;
    const last = this.safe(() => this.deps.lastActivityAt(), null);
    if (last !== null && now - last < pace.quietSeconds * 1000) return false;
    const day = (this.deps.localDay ?? localDay)(now);
    if (this.calls.day === day && this.calls.count >= pace.dailyCalls) return false;
    let segments: readonly NoteSegmentInfo[];
    try { segments = this.deps.archive.noteSegments(now); } catch { return false; }
    this.reconcile(segments);
    const current = this.safe(() => this.deps.currentScope(), null);
    const next = segments.filter(segment => segment.ended && this.wanted(segment))
      .sort((a, b) => Number(b.scope === current) - Number(a.scope === current) || b.lastAt - a.lastAt || a.id.localeCompare(b.id))[0];
    if (!next) return false;
    let text;
    try { text = this.deps.archive.noteSegment(next.id, now); } catch { return false; }
    if (!text || text.info.source !== next.source || !text.messages.length) return false;
    const run: Run = { recordId: next.id, source: next.source, segmentAt: next.createdAt, messages: text.messages.map(message => ({ ...message })),
      controller: new AbortController(), startedAt: now, marked: this.isMarked(next.id) };
    this.running = run;
    this.lastCallAt = now;
    this.calls = { day, count: (this.calls.day === day ? this.calls.count : 0) + 1 };
    this.counts.started++;
    this.persist();
    let pending: Promise<string>;
    try { pending = this.deps.write(memoryNotePrompt(run.messages, this.knobs), withUpcomingQuestion(MEMORY_NOTE_SYSTEM_PROMPT, run.marked), run.controller.signal); }
    catch (error) { pending = Promise.reject(error); }
    pending.then(raw => this.land(run, raw), () => this.failedCall(run));
    return true;
  }

  /** True while a note call is running (tests and the developer view). */
  get busy(): boolean { return !!this.running; }

  private land(run: Run, raw: unknown): void {
    if (this.running !== run || this.disposed) return;
    this.running = null;
    const now = this.now();
    this.lastCallAt = now;
    const ms = now - run.startedAt;
    if (run.controller.signal.aborted) { this.event('aborted', ms); return; }
    let current;
    try { current = this.deps.archive.noteSegment(run.recordId, now); } catch { current = null; }
    if (!current || current.info.source !== run.source || this.isDeleted(run.recordId)) { this.event('dropped', ms); return; }
    const parsed = typeof raw === 'string' ? parseMemoryNote(raw) : null;
    if (!parsed) {
      const previous = this.failed.get(run.recordId);
      this.failed.set(run.recordId, { source: run.source, attempts: (previous?.source === run.source ? previous.attempts : 0) + 1 });
      this.persist();
      this.event('invalid', ms);
      return;
    }
    const body = faithfulNote(parsed, run.messages);
    this.notes.set(run.recordId, { recordId: run.recordId, source: run.source, segmentAt: run.segmentAt, writtenAt: now, body });
    this.prepared.set(run.recordId, prepareNote(body));
    this.failed.delete(run.recordId);
    this.safe(() => this.deps.notesChanged?.(false), undefined);
    if (this.deps.noted) {
      const keywords = this.safe(() => extractKeywordsField(raw as string, run.messages.map(message => message.content).join('\n')), [] as Keyword[]);
      this.safe(() => this.deps.noted?.({ recordId: run.recordId, scope: current.info.scope, at: run.segmentAt, body, keywords }), undefined);
    }
    if (run.marked && this.isMarked(run.recordId))
      this.safe(() => this.deps.upcomingNoted?.({ recordId: run.recordId, scope: current.info.scope, at: run.segmentAt, raw: raw as string, messages: run.messages }), undefined);
    this.persist();
    this.event('written', ms);
    this.changed();
  }

  private failedCall(run: Run): void {
    if (this.running !== run || this.disposed) return;
    this.running = null;
    const now = this.now();
    this.lastCallAt = now;
    if (run.controller.signal.aborted) { this.event('aborted', now - run.startedAt); return; }
    // A failed call (offline, signed out, a timeout) is not this segment's fault: no attempt is counted; all writing pauses a while.
    this.pausedUntil = now + this.knobs.pace.errorPauseMinutes * 60_000;
    this.event('failed', now - run.startedAt);
  }

  private wanted(segment: NoteSegmentInfo): boolean {
    if (this.isDeleted(segment.id) || !this.worth(segment)) return false;
    if (this.notes.get(segment.id)?.source === segment.source) return false;
    const failed = this.failed.get(segment.id);
    return !(failed && failed.source === segment.source && failed.attempts >= this.knobs.note.maxAttempts);
  }
  private worth(segment: NoteSegmentInfo): boolean {
    if (segment.replies <= 0) return false;
    return segment.userChars >= this.knobs.note.minUserChars || this.shortButDated(segment);
  }
  /** P-001: a very short segment is noted only when it is marked "may record" and the user's own words name a day or a clock time. */
  private shortButDated(segment: NoteSegmentInfo): boolean {
    if (!this.isMarked(segment.id)) return false;
    try {
      const text = this.deps.archive.noteSegment(segment.id, this.now());
      return !!text && text.messages.some(message => message.role === 'user' && hasTimeWord(message.content, segment.createdAt));
    } catch { return false; }
  }
  private isMarked(recordId: string): boolean { return this.safe(() => this.deps.marked?.(recordId) === true, false); }

  // ---- the user's deletions ----

  /**
   * Memories went (deleted, or a character's memories forgotten): their notes go with them, and a call for one stops. Into the
   * recycle bin (`how.recoverable`): a note the user had deleted stays deleted if the memory comes back (parked); deleted for
   * good: nothing of it is kept.
   */
  removed(recordIds: readonly string[], how?: RecordsRemoval): void {
    let changed = false, withdrawn = false;
    for (const id of recordIds) {
      if (typeof id !== 'string') continue;
      if (this.running?.recordId === id) this.abort();
      if (this.notes.delete(id)) changed = withdrawn = true;
      this.prepared.delete(id);
      const marked = this.deleted.delete(id) || this.parked.has(id);
      if (marked && how?.recoverable === true) this.parked.set(id, this.now());
      else this.parked.delete(id);
      changed = marked || changed;
      changed = this.failed.delete(id) || changed;
    }
    if (withdrawn) { this.withdrawn++; this.safe(() => this.deps.notesChanged?.(true), undefined); }
    this.safe(() => this.deps.dropped?.(recordIds.filter(id => typeof id === 'string')), undefined);
    if (changed) { this.persist().catch(() => { /* The next start reconciles with the archive. */ }); this.changed(); }
  }

  /**
   * The user deleted one note (the memory stays). It is never written again for this segment, and a call for it stops. Resolves
   * after the file is saved; rejects when the segment is not in `scope` or has no note. When the file cannot be saved, the note
   * is put back as it was (the panel, recall and a retry all see it again) and the error is passed on.
   */
  async deleteNote(recordId: string, scope: string | null): Promise<MemoryNoteState> {
    const segment = this.segmentIn(recordId, scope);
    const note = this.notes.get(recordId);
    if (!segment || !note) throw new Error('这条笔记不存在或已经删除。');
    if (this.running?.recordId === recordId) this.abort();
    const failed = this.failed.get(recordId);
    this.notes.delete(recordId); this.prepared.delete(recordId); this.failed.delete(recordId);
    this.deleted.add(recordId);
    this.withdrawn++;
    this.safe(() => this.deps.dropped?.([recordId]), undefined);
    this.safe(() => this.deps.notesChanged?.(true), undefined);
    this.changed();
    try { await this.persist(); }
    catch (error) {
      // Only while nothing has changed it since (the memory itself was not deleted meanwhile, no other note took its place).
      if (this.deleted.has(recordId) && !this.notes.has(recordId) && this.segmentIn(recordId, scope)) {
        this.deleted.delete(recordId);
        this.notes.set(recordId, note);
        if (failed) this.failed.set(recordId, failed);
        this.withdrawn++;
        this.safe(() => this.deps.notesChanged?.(false), undefined);
        this.changed();
        // A later save may already have written the deletion: the file follows what is in memory again.
        this.persist().catch(() => { /* Saved with the next change. */ });
      }
      throw error;
    }
    return this.state(recordId, scope);
  }

  // ---- I-144 回收站：完整复原 (electron/memory/recycle-wiring.ts) ----

  /**
   * Everything kept for these records (notes, the user's deleted and parked marks, failures), each with its place in the file; null when
   * nothing. Nothing changes. Taken before her memories go; the memories' removal then drops them here as usual.
   */
  recycleCopy(recordIds: readonly string[]): MemoryNotesPart | null {
    const ids = new Set(recordIds);
    const part: MemoryNotesPart = {
      notes: takeListed([...this.notes.values()], note => ids.has(note.recordId)),
      deleted: takeListed([...this.deleted], id => ids.has(id)),
      parked: takeListed([...this.parked], ([id]) => ids.has(id)),
      failed: takeListed([...this.failed], ([id]) => ids.has(id)),
    };
    return part.notes || part.deleted || part.parked || part.failed ? part : null;
  }

  /** Puts what recycleCopy copied back at its places (after her memories came back), and saves. */
  async recycleRestore(part: MemoryNotesPart): Promise<void> {
    if (!part || typeof part !== 'object') throw new Error('回收站里这一项的数据不完整，原文件已保留。');
    if (part.notes) {
      for (const item of part.notes.items) if (!item?.value || typeof item.value.recordId !== 'string' || !item.value.body) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
      this.notes = new Map(putListed([...this.notes.values()], part.notes, (a, b) => a.recordId === b.recordId).map(note => [note.recordId, note]));
    }
    if (part.deleted) this.deleted = new Set(putListed([...this.deleted], part.deleted, (a, b) => a === b));
    if (part.parked) this.parked = new Map(putListed([...this.parked], part.parked, (a, b) => a[0] === b[0]));
    if (part.failed) this.failed = new Map(putListed([...this.failed], part.failed, (a, b) => a[0] === b[0]));
    for (const item of part.notes?.items ?? []) this.prepared.delete(item.value.recordId);
    this.withdrawn++;
    this.safe(() => this.deps.notesChanged?.(false), undefined);
    this.changed();
    await this.persist();
  }

  /**
   * One note the user is about to delete (MemoryPanel 「删除这条笔记」), with its place and its failure count; null when it is not a note of
   * a segment in `scope`. Nothing changes.
   */
  noteCopy(recordId: string, scope: string | null): MemoryNotesPart | null {
    if (!this.segmentIn(recordId, scope) || !this.notes.has(recordId)) return null;
    return this.recycleCopy([recordId]);
  }

  /** The note comes back from the recycle bin: it is a note again (no longer deleted), at its old place. False when its memory is gone. */
  async restoreNote(part: MemoryNotesPart, scope: string | null): Promise<boolean> {
    const recordId = part?.notes?.items[0]?.value.recordId;
    if (typeof recordId !== 'string' || part.notes!.items.length !== 1 || !this.segmentIn(recordId, scope)) return false;
    this.deleted.delete(recordId);
    await this.recycleRestore({ notes: part.notes, deleted: null, parked: null, failed: part.failed });
    return true;
  }

  // ---- reading ----

  /** The control window's view of one memory's note. Another scope's segment reads as no note at all. */
  state(recordId: unknown, scope: string | null): MemoryNoteState {
    const segment = typeof recordId === 'string' ? this.segmentIn(recordId, scope) : null;
    if (!segment || typeof recordId !== 'string') return { ...NOT_A_SEGMENT, progress: this.progress(scope) };
    const note = this.notes.get(recordId);
    const status = note ? 'written' : this.isDeleted(recordId) ? 'deleted'
      : this.worth(segment) && this.wanted(segment) ? 'waiting' : 'none';
    return { status, note: note ? structuredClone(note.body) as MemoryNoteBody : null, writtenAt: note?.writtenAt ?? null, progress: this.progress(scope) };
  }

  progress(scope: string | null): MemoryNotesProgress {
    if (!scope) return NO_PROGRESS;
    let segments: readonly NoteSegmentInfo[];
    try { segments = this.deps.archive.noteSegments(this.now()); } catch { return NO_PROGRESS; }
    let noted = 0, waiting = 0;
    for (const segment of segments) {
      if (segment.scope !== scope) continue;
      if (this.notes.has(segment.id)) noted++;
      else if (this.wanted(segment)) waiting++;
    }
    return { noted, waiting };
  }

  /** MemoryRecallHints for MemoryStore.retrieve: local matching only, never throws, never waits. */
  prepare(text: string): (recordId: string) => MemoryNoteHint | null {
    let query;
    try { query = prepareNoteQuery(text); } catch { query = null; }
    // I-049: the keywords point at records too (0 ms, local); their score adds to the note's own and never makes a deleted note count.
    let keyed: ReadonlyMap<string, { score: number; terms: readonly string[] }> | null = null;
    try { keyed = this.deps.keywordScores?.(text) ?? null; } catch { keyed = null; }
    // I-111: what is close in MEANING to this line (local dot products on vectors computed earlier; empty with the switch off or no model).
    let meant: ReadonlyMap<string, { score: number; terms: readonly string[] }> | null = null;
    try { meant = this.deps.semanticScores?.(text) ?? null; } catch { meant = null; }
    if (!query || (!this.notes.size && !keyed?.size && !meant?.size)) return () => null;
    const ready = query;
    // I-088: a person or thing under another of its names counts like a person name (0 ms, local; only notes that exist and were not deleted).
    let aliased: ReadonlyMap<string, readonly string[]> | null = null;
    try { aliased = this.deps.aliasNotes?.(ready.squashed) ?? null; } catch { aliased = null; }
    // I-083: which tags many of her notes share, counted once for this message (a few dozen notes, local).
    let shared: Set<string> | null = null;
    try { shared = sharedNoteTags([...this.notes.values()].map(note => note.body), this.knobs); } catch { shared = null; }
    return recordId => {
      try {
        const note = this.notes.get(recordId);
        let hint = null as ReturnType<typeof noteHint>;
        if (note) {
          let prepared = this.prepared.get(recordId);
          if (!prepared) { prepared = prepareNote(note.body); this.prepared.set(recordId, prepared); }
          hint = noteHint(ready, prepared, this.knobs, shared);
          const named = this.isDeleted(recordId) ? undefined : aliased?.get(recordId);
          if (named?.length) hint = { score: (hint?.score ?? 0) + this.knobs.recall.person, explicit: hint?.explicit ?? false,
            terms: [...new Set([...(hint?.terms ?? []), ...named])], title: hint?.title ?? prepared.title };
        }
        const key = this.isDeleted(recordId) ? undefined : keyed?.get(recordId);
        if (key) hint = { score: (hint?.score ?? 0) + key.score, explicit: hint?.explicit ?? false,
          terms: [...new Set([...(hint?.terms ?? []), ...key.terms])], title: hint?.title ?? (note ? prepareNote(note.body).title : '') };
        // I-111: meaning is a candidate signal only. Alone it is worth at most knobs.match.maxScore (under a name or a three-character term);
        // on a memory the words already found it adds at most withLiteralMax, so a literal match never gets worse and never loses its place to meaning.
        const meaning = meant?.get(recordId);
        if (!meaning) return hint;
        const bonus = hint ? Math.min(meaning.score, MEMORY_SEMANTIC_KNOBS.match.withLiteralMax) : meaning.score;
        return { score: (hint?.score ?? 0) + bonus, explicit: hint?.explicit ?? false, terms: hint?.terms ?? [],
          title: hint?.title ?? (note ? prepareNote(note.body).title : '') };
      } catch { return null; }
    };
  }

  /** I-089 回忆有轻重 (MemoryRecallHints.traits): what the note says about how much it mattered. Null for no note or a deleted one. Local, never throws. */
  traits(recordId: string): MemoryNoteTraits | null {
    try {
      const note = this.notes.get(recordId);
      if (!note || this.isDeleted(recordId)) return null;
      return { felt: note.body.felt ?? null, openPlans: note.body.plans.length > 0, at: note.segmentAt };
    } catch { return null; }
  }

  /**
   * I-089 item 2 (MemoryRecallHints.updates): later changes the user stated (their notes' `changes`) that speak about this older memory.
   * Notes the user deleted do not count. Local, never throws.
   */
  updates(recordId: string): readonly MemoryNoteUpdate[] | null {
    try {
      const note = this.notes.get(recordId);
      if (!note || this.isDeleted(recordId)) return null;
      // Codex X-454: only a change said to the same character (the same scope) speaks about this memory. A memory whose scope
      // cannot be told gets none.
      const scope = this.scopeOf(recordId);
      if (!scope) return null;
      const sources = [...this.notes.values()].filter(other => other.body.changes?.length && !this.isDeleted(other.recordId) && this.scopeOf(other.recordId) === scope)
        .map(other => ({ recordId: other.recordId, at: other.segmentAt, body: other.body }));
      if (!sources.length) return null;
      const found = updatesFor({ recordId, at: note.segmentAt, body: note.body }, sources, this.knobs);
      return found.length ? found : null;
    } catch { return null; }
  }

  /** Every written note with the time of its segment (the host turns old ones into keywords, once, locally). Copies; deleted notes are not here. */
  written(): { recordId: string; at: number; body: MemoryNoteBody }[] {
    return [...this.notes.values()].map(note => ({ recordId: note.recordId, at: note.segmentAt, body: structuredClone(note.body) as MemoryNoteBody }));
  }

  /** MemoryRecallHints.revision (MemoryStore.recallRevision). */
  get revision(): number { return this.withdrawn; }

  /** Every pending save, written. */
  async flush(): Promise<void> { await this.saving; }
  /** Quitting: the running call stops; nothing more starts or lands. */
  dispose(): void { this.abort(); this.disposed = true; }

  /** The user deleted this note; a parked one counts too (its memory is back from the bin before the next reconcile). */
  private isDeleted(recordId: string): boolean { return this.deleted.has(recordId) || this.parked.has(recordId); }
  /** The scope (character and connection) of a written note's segment, from the archive; a segment's scope never changes, so it is kept. */
  private readonly scopes = new Map<string, string | null>();
  private scopeOf(recordId: string): string | null {
    if (this.scopes.has(recordId)) return this.scopes.get(recordId) ?? null;
    let scope: string | null = null;
    try { scope = this.deps.archive.noteSegment(recordId, this.now())?.info.scope ?? null; } catch { scope = null; }
    if (this.scopes.size >= 10_000) this.scopes.clear();
    if (scope) this.scopes.set(recordId, scope); // an unknown one is asked again next time
    return scope;
  }
  private segmentIn(recordId: string, scope: string | null): NoteSegmentInfo | null {
    if (!scope || typeof recordId !== 'string' || !recordId || recordId.length > 256) return null;
    try {
      const text = this.deps.archive.noteSegment(recordId, this.now());
      return text && text.info.scope === scope ? text.info : null;
    } catch { return null; }
  }
  private abort(): void {
    const run = this.running;
    if (!run) return;
    this.running = null;
    run.controller.abort();
    this.lastCallAt = this.now();
    this.event('aborted', this.now() - run.startedAt);
  }
  private persist(): Promise<void> {
    const file = this.snapshot();
    const next = this.saving.then(() => this.deps.save(file));
    this.saving = next.catch(() => {});
    return next;
  }
  private event(kind: MemoryNotesEvent['kind'], ms: number): void {
    this.counts[kind]++;
    try { this.deps.report?.({ kind, ms: Math.max(0, Math.round(ms)) }); } catch { /* Reporting never blocks her notes. */ }
  }
  private changed(): void { try { this.deps.changed?.(); } catch { /* A closed window is fine. */ } }
  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
}
