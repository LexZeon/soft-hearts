// I-134 new chat, step 1: her card's greeting, once the chat window showed it, goes into her archive as one of her own lines
// (an initiative record: never a user turn, a reward or a relationship round), so a session opened later sees what she said.
// The window only says "it was shown"; the text is the active card's own greeting, read here in the host, so nothing the
// renderer sends becomes archive text. Off (new chat off): nothing is written.
import type { MemoryInitiative, MemoryScope } from '../../../shared/memory';
import type { LongChatSourceMessage } from './window';
import type { GreetingWhy } from '../../../shared/cards';

export const GREETING_LABEL = '开场问候';
/** The archive's bound for one of her lines (MemoryStore.appendInitiative). */
const GREETING_MAX = 2000;

export interface GreetingArchiveDeps {
  enabled: boolean;
  memory(): { chatWindowSource(scope: MemoryScope): LongChatSourceMessage[]; appendInitiative(scope: MemoryScope, input: MemoryInitiative, current?: () => boolean): Promise<unknown>;
    /** 2026-11-25: whether she ever opened with the user (an ordinary chat, or her greeting shown before); null when the archive is off. */
    hasOpened?(characterId: string): boolean | null } | null;
  scope(): MemoryScope;
  /** The active card's greeting ('' for none). */
  greeting(): string;
  /** Still the same character and conversation when the write happens. */
  identity(): string;
  id(): string;
  now?(): number;
  /** 2026-11-25: one journal row when her greeting is shown (which card, why; no text). Never blocks the archive. */
  journal?(characterId: string, why: GreetingWhy): void;
}

export class GreetingArchive {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: GreetingArchiveDeps) {}

  /**
   * True when the greeting was archived now. Not again while it is already the newest thing she said in this scope (both windows
   * show it; "new conversation" twice in a row), never while new chat is off, never a card without a greeting.
   */
  remember(): Promise<boolean> {
    this.noteShown();
    const run = this.chain.then(() => this.write(), () => this.write());
    this.chain = run.catch(() => {});
    return run;
  }

  private lastRow: { id: string; at: number } | null = null;
  /**
   * One journal row per shown greeting: both windows show it and ask, so the same card within a few seconds is one row. Why: she never
   * opened with the user (first), or this is a new chat of hers (new-chat); read before the archive line is written.
   */
  private noteShown(): void {
    try {
      if (!this.deps.journal) return;
      const id = this.deps.scope().characterId, at = this.deps.now?.() ?? Date.now();
      if (this.lastRow && this.lastRow.id === id && at - this.lastRow.at < 5000) return;
      this.lastRow = { id, at };
      this.deps.journal(id, this.deps.memory()?.hasOpened?.(id) === false ? 'first' : 'new-chat');
    } catch { /* the journal never blocks her greeting */ }
  }

  private async write(): Promise<boolean> {
    if (!this.deps.enabled) return false;
    try {
      const memory = this.deps.memory();
      const text = Array.from(this.deps.greeting().trim()).slice(0, GREETING_MAX).join('');
      if (!memory || !text) return false;
      const scope = this.deps.scope(), identity = this.deps.identity();
      const newest = memory.chatWindowSource(scope).at(-1);
      if (newest?.origin?.sources.includes('greeting') && newest.content === text) return false;
      const id = this.deps.id(), at = this.deps.now?.() ?? Date.now();
      await memory.appendInitiative(scope, { id, text, at, origin: { kind: 'proactive', id, at, sources: ['greeting'], labels: [GREETING_LABEL] } },
        () => this.deps.identity() === identity);
      return true;
    } catch { return false; }
  }
}
