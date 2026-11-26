// Wiring for I-021 (docs/claude/2026-11-04-memory-notes.md), so electron/main.ts only adds a few lines: the notebook reads the
// chat archive through three read-only methods and two hooks (recall asks it, a removal tells it), writes `memory-notes.json`
// on its own, runs on its own unref'd timer, and answers the control window's two operations.

import type { MemoryScope } from '../../../shared/memory/memory';
import type { MemoryNoteState, MemoryNoteWriter, MemoryRecallHints, NoteArchive, RecordsRemoval } from '../../../shared/memory/memory-notes/interface';
import { MemoryNotesCore, NOT_A_SEGMENT, type MemoryNotesPart } from './core';
import { MemoryNotesStore } from './store';
import type { KeywordRecall } from '../memory-keywords/recall';
import type { SemanticRecall } from '../memory-semantic/recall';
import { PeopleThings } from '../people-things/host';
import { PeopleThingsStore } from '../people-things/store';
import type { PeopleNoteInput } from '../../../shared/memory/people-things/gather';
import { EMPTY_PEOPLE_THINGS_VIEW } from '../../../shared/memory/people-things/view';

/** P-001: what the plan memory (electron/memory/upcoming/host.ts) hooks into the notebook with. All best effort and local. */
export interface NotebookUpcomingHooks {
  marked(recordId: string): boolean;
  noted(info: { recordId: string; scope: string; at: number; raw: string; messages: readonly { role: 'user' | 'assistant'; content: string }[] }): void;
  dropped(recordIds: readonly string[]): void;
  survivors(ids: ReadonlySet<string>): void;
}

/** What the chat archive gives the notebook (electron/memory/memory.ts MemoryStore). */
export interface NotebookArchive extends NoteArchive {
  noteScope(scope: MemoryScope): string;
  /** I-049: the character a scope hash belongs to (MemoryStore.characterOfScope). */
  characterOfScope?(key: string): string | null;
  setRecallHints(hints: MemoryRecallHints | null): void;
  onRecordsRemoved(listener: ((recordIds: readonly string[], how: RecordsRemoval) => void) | null): void;
}

export interface MemoryNotesHostDeps {
  /** The profile directory (beside memories.jsonl). */
  directory: string;
  archive: NotebookArchive;
  /** electron/initiative/inner-loop/model.ts quickLineWithClaude's text: the user's own Claude Code, haiku, no tools. */
  write: MemoryNoteWriter;
  userBusy(): boolean;
  modelBusy(): boolean;
  lastActivityAt(): number | null;
  /** The current character and connection, or null while switching. */
  scope(): MemoryScope | null;
  changed?(): void;
  developerMode?(): boolean;
  now?(): number;
  /** How often the timer looks (default 10 s; the knobs decide whether anything starts). */
  tickMs?: number;
  /** I-049: the keyword index (electron/memory/memory-keywords/recall.ts). Absent: the notebook works as before. */
  keywords?: KeywordRecall;
  /** I-049: the lines before the user's current one (newest first), for the keyword match; absent: only the line itself. */
  previousLines?(): readonly string[];
  /** P-001: the plan memory's hooks. Absent: the notebook works as before. */
  upcoming?: NotebookUpcomingHooks;
  /** I-111: recall by meaning (electron/memory/memory-semantic/recall.ts). Absent, or its switch off: recall is exactly what it was. */
  semantic?: SemanticRecall;
}

export class MemoryNotes {
  readonly core: MemoryNotesCore;
  /** I-088: her people and things, gathered from the notes under all the names they go by (electron/memory/people-things/). */
  readonly people: PeopleThings;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: MemoryNotesHostDeps, private readonly store = new MemoryNotesStore(deps.directory, { now: deps.now })) {
    this.people = new PeopleThings({ store: new PeopleThingsStore({ directory: () => deps.directory }), directory: () => deps.directory,
      notesOf: character => this.notesOfCharacter(character), currentCharacter: () => this.currentCharacter() });
    this.core = new MemoryNotesCore({
      notesChanged: removed => this.people.notesChanged(removed), aliasNotes: squashed => this.people.matching(squashed),
      archive: deps.archive, write: deps.write, save: file => store.save(file),
      userBusy: deps.userBusy, modelBusy: deps.modelBusy, lastActivityAt: deps.lastActivityAt,
      currentScope: () => this.scopeKey(), changed: () => deps.changed?.(), now: deps.now,
      // Developer mode only, and only the kind and how long it took: never a note or a message.
      report: event => { if (deps.developerMode?.()) console.info('[soft hearts] memory note', event.kind, `${event.ms} ms`); },
      ...(deps.keywords ? {
        noted: info => { const character = this.characterOf(info.scope); if (character) void deps.keywords!.noteChat(character, info.recordId, info.at, info.body, info.keywords); },
        keywordScores: text => { const character = this.currentCharacter(); this.warm(character); return deps.keywords!.chatScores(character, [text, ...(deps.previousLines?.() ?? [])]); },
      } : {}),
      ...(deps.semantic ? { semanticScores: (text: string) => deps.semantic!.scores(text) } : {}),
      dropped: ids => {
        if (deps.keywords) void deps.keywords.removeEverywhere(ids);
        if (deps.semantic) void deps.semantic.removeEverywhere(ids); // I-111: the meaning vectors of deleted memories go with them
        try { deps.upcoming?.dropped(ids); } catch { /* The plan memory catches up when it reconciles. */ }
      },
      ...(deps.upcoming ? { marked: (id: string) => deps.upcoming!.marked(id), upcomingNoted: (info: Parameters<NotebookUpcomingHooks['noted']>[0]) => deps.upcoming!.noted(info),
        survivors: (ids: ReadonlySet<string>) => deps.upcoming!.survivors(ids) } : {}),
    });
  }

  private warmed: string | null = null;
  /**
   * I-049: the character's keyword index is loaded (off the reply path) and her old notes get keywords from their people, things and
   * tags, once, locally. Called at start and the first time a turn needs the character's keywords.
   */
  warm(character: string | null): void {
    const keywords = this.deps.keywords;
    if (!keywords || !character || this.warmed === character) return;
    this.warmed = character;
    void keywords.ensure(character).then(() => {
      const mine = new Map<string, string>();
      try { for (const segment of this.deps.archive.noteSegments(this.deps.now?.() ?? Date.now())) mine.set(segment.id, segment.scope); } catch { return; }
      const notes = this.core.written().filter(note => { const scope = mine.get(note.recordId); return !!scope && this.characterOf(scope) === character; });
      return keywords.convertOldNotes(character, notes.map(note => ({ recordId: note.recordId, at: note.at, body: note.body })));
    }).catch(() => undefined);
  }
  /** I-088: the written notes (people and things only) of one character, by the chat segment each note belongs to. Throws when the archive cannot be read. */
  private notesOfCharacter(character: string): PeopleNoteInput[] {
    const scopes = new Map<string, string>();
    for (const segment of this.deps.archive.noteSegments(this.deps.now?.() ?? Date.now())) scopes.set(segment.id, segment.scope);
    const out: PeopleNoteInput[] = [];
    for (const note of this.core.written()) {
      const scope = scopes.get(note.recordId);
      if (scope && this.characterOf(scope) === character) out.push({ recordId: note.recordId, at: note.at, people: note.body.people, things: note.body.things });
    }
    return out;
  }
  /**
   * I-088 第 1 条: the titles and summaries of the written notes of ONE character and connection whose chat began in [start, end), oldest first
   * (what her weekly look-back reads; never the chat itself). Deleted notes are not here. Empty when the archive cannot be read.
   */
  notesBetween(scope: MemoryScope, start: number, end: number): { at: number; title: string; summary: string }[] {
    try {
      const key = this.deps.archive.noteScope(scope), mine = new Set<string>();
      for (const segment of this.deps.archive.noteSegments(this.deps.now?.() ?? Date.now())) if (segment.scope === key) mine.add(segment.id);
      return this.core.written().filter(note => mine.has(note.recordId) && note.at >= start && note.at < end)
        .sort((a, b) => a.at - b.at || a.recordId.localeCompare(b.recordId)).map(note => ({ at: note.at, title: note.body.title, summary: note.body.summary }));
    } catch { return []; }
  }
  private currentCharacter(): string | null { try { return this.deps.scope()?.characterId ?? null; } catch { return null; } }
  private characterOf(scope: string): string | null { try { return this.deps.archive.characterOfScope?.(scope) ?? null; } catch { return null; } }

  /** After the chat archive has loaded. */
  async start(): Promise<void> {
    this.core.load(await this.store.load());
    this.core.reconcile();
    this.warm(this.currentCharacter());
    void this.people.warm();
    this.deps.archive.setRecallHints(this.core);
    this.deps.archive.onRecordsRemoved((ids, how) => this.core.removed(ids, how));
    if (!this.timer) { this.timer = setInterval(() => this.core.tick(), this.deps.tickMs ?? 10_000); this.timer.unref?.(); }
  }

  state(recordId: unknown): MemoryNoteState { return this.core.state(recordId, this.scopeKey()); }
  deleteNote(recordId: unknown): Promise<MemoryNoteState> {
    if (typeof recordId !== 'string' || !recordId || recordId.length > 256) return Promise.reject(new Error('这条笔记不存在或已经删除。'));
    return this.core.deleteNote(recordId, this.scopeKey());
  }

  // ---- I-144 回收站 (electron/memory/recycle-wiring.ts) ----
  /** What the notebook keeps for these records (see MemoryNotesCore.recycleCopy). */
  recycleCopy(recordIds: readonly string[]): MemoryNotesPart | null { return this.core.recycleCopy(recordIds); }
  recycleRestore(part: MemoryNotesPart): Promise<void> { return this.core.recycleRestore(part); }
  /** One note of the shown character and connection, before the user deletes it; null when there is none. */
  noteCopy(recordId: unknown): MemoryNotesPart | null {
    return typeof recordId === 'string' && recordId && recordId.length <= 256 ? this.core.noteCopy(recordId, this.scopeKey()) : null;
  }
  /** Puts one deleted note back (its memory must be in `scope`). */
  restoreNote(part: MemoryNotesPart, scope: MemoryScope): Promise<boolean> {
    let key: string | null = null;
    try { key = this.deps.archive.noteScope(scope); } catch { key = null; }
    return this.core.restoreNote(part, key);
  }

  /** Quitting: the timer stops, a running call is abandoned, pending saves are written. */
  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.core.dispose();
    await this.core.flush();
    await this.people.dispose();
  }

  private scopeKey(): string | null {
    try { const scope = this.deps.scope(); return scope ? this.deps.archive.noteScope(scope) : null; } catch { return null; }
  }
}

/** The control window's two operations (control-window only, like the other memory controls). */
export function registerMemoryNotesIpc(host: (method: string, operation: (...args: any[]) => unknown) => void, get: () => MemoryNotes | null,
  /** I-144: deleting a note goes through the recycle bin (electron/memory/recycle-wiring.ts); absent: deleted as before. */
  recycled?: (id: unknown) => Promise<MemoryNoteState>): void {
  host('readMemoryNote', (id: unknown) => get()?.state(id) ?? NOT_A_SEGMENT);
  host('deleteMemoryNote', (id: unknown) => {
    const notes = get();
    if (!notes) throw new Error('这条笔记不存在或已经删除。');
    return recycled ? recycled(id) : notes.deleteNote(id);
  });
  // I-088: the page "你生活里的人和事" (control window only): the entries with their names, and the user's decisions.
  host('getPeopleThings', () => get()?.people.view() ?? Promise.resolve(EMPTY_PEOPLE_THINGS_VIEW));
  host('changePeopleThings', (op: unknown) => {
    const notes = get();
    if (!notes) throw new Error('现在还不能整理。');
    return notes.people.apply(op);
  });
}
