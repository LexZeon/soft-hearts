// Wiring for I-021 (docs/claude/2026-11-04-memory-notes.md), so electron/main.ts only adds a few lines: the notebook reads the
// chat archive through three read-only methods and two hooks (recall asks it, a removal tells it), writes `memory-notes.json`
// on its own, runs on its own unref'd timer, and answers the control window's two operations.

import type { MemoryScope } from '../../shared/memory';
import type { MemoryNoteState, MemoryNoteWriter, MemoryRecallHints, NoteArchive, RecordsRemoval } from '../../shared/memory-notes/interface';
import { MemoryNotesCore, NOT_A_SEGMENT } from './core';
import { MemoryNotesStore } from './store';
import type { KeywordRecall } from '../memory-keywords/recall';

/** What the chat archive gives the notebook (electron/memory.ts MemoryStore). */
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
  /** electron/inner-loop/model.ts quickLineWithClaude's text: the user's own Claude Code, haiku, no tools. */
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
  /** I-049: the keyword index (electron/memory-keywords/recall.ts). Absent: the notebook works as before. */
  keywords?: KeywordRecall;
  /** I-049: the lines before the user's current one (newest first), for the keyword match; absent: only the line itself. */
  previousLines?(): readonly string[];
}

export class MemoryNotes {
  readonly core: MemoryNotesCore;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: MemoryNotesHostDeps, private readonly store = new MemoryNotesStore(deps.directory, { now: deps.now })) {
    this.core = new MemoryNotesCore({
      archive: deps.archive, write: deps.write, save: file => store.save(file),
      userBusy: deps.userBusy, modelBusy: deps.modelBusy, lastActivityAt: deps.lastActivityAt,
      currentScope: () => this.scopeKey(), changed: () => deps.changed?.(), now: deps.now,
      // Developer mode only, and only the kind and how long it took: never a note or a message.
      report: event => { if (deps.developerMode?.()) console.info('[soft hearts] memory note', event.kind, `${event.ms} ms`); },
      ...(deps.keywords ? {
        noted: info => { const character = this.characterOf(info.scope); if (character) void deps.keywords!.noteChat(character, info.recordId, info.at, info.body, info.keywords); },
        dropped: ids => { void deps.keywords!.removeEverywhere(ids); },
        keywordScores: text => { const character = this.currentCharacter(); this.warm(character); return deps.keywords!.chatScores(character, [text, ...(deps.previousLines?.() ?? [])]); },
      } : {}),
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
  private currentCharacter(): string | null { try { return this.deps.scope()?.characterId ?? null; } catch { return null; } }
  private characterOf(scope: string): string | null { try { return this.deps.archive.characterOfScope?.(scope) ?? null; } catch { return null; } }

  /** After the chat archive has loaded. */
  async start(): Promise<void> {
    this.core.load(await this.store.load());
    this.core.reconcile();
    this.warm(this.currentCharacter());
    this.deps.archive.setRecallHints(this.core);
    this.deps.archive.onRecordsRemoved((ids, how) => this.core.removed(ids, how));
    if (!this.timer) { this.timer = setInterval(() => this.core.tick(), this.deps.tickMs ?? 10_000); this.timer.unref?.(); }
  }

  state(recordId: unknown): MemoryNoteState { return this.core.state(recordId, this.scopeKey()); }
  deleteNote(recordId: unknown): Promise<MemoryNoteState> {
    if (typeof recordId !== 'string' || !recordId || recordId.length > 256) return Promise.reject(new Error('这条笔记不存在或已经删除。'));
    return this.core.deleteNote(recordId, this.scopeKey());
  }

  /** Quitting: the timer stops, a running call is abandoned, pending saves are written. */
  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.core.dispose();
    await this.core.flush();
  }

  private scopeKey(): string | null {
    try { const scope = this.deps.scope(); return scope ? this.deps.archive.noteScope(scope) : null; } catch { return null; }
  }
}

/** The control window's two operations (control-window only, like the other memory controls). */
export function registerMemoryNotesIpc(host: (method: string, operation: (...args: any[]) => unknown) => void, get: () => MemoryNotes | null): void {
  host('readMemoryNote', (id: unknown) => get()?.state(id) ?? NOT_A_SEGMENT);
  host('deleteMemoryNote', (id: unknown) => {
    const notes = get();
    if (!notes) throw new Error('这条笔记不存在或已经删除。');
    return notes.deleteNote(id);
  });
}
