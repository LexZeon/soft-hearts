/**
 * X1 "等回复时也有表现" (docs/claude/2026-11-02-waiting-expression.md): the
 * renderer side. ReplyPresentationState tells it which accepted reply is
 * waiting for its first word (the same state that shows the B09 waiting dots);
 * it hands that to the stage's thinking channel (src/stage/reply-thinking.ts)
 * and, read-aloud on, starts one soft "嗯…" if its clip is ready.
 *
 * Timing contract (the first word must not get slower): everything here is a
 * side branch of the reply lifecycle. `waiting()` is synchronous, returns
 * nothing to await, never throws, and does no I/O itself; the cue is decided
 * one microtask later (the lifecycle sets the reply's owner right after it
 * begins) and is fire-and-forget with a short start deadline, so it is skipped
 * rather than played late. The stream, the bubble and the reply speech never
 * wait on it.
 */
import type { CueKind } from '../../shared/feed-cue';

export interface ThinkingStagePort { setReplyThinking(key: string | null): void }
export interface ThinkingCuePort { play(kind: CueKind, deadlineMs: number): Promise<unknown> }
export interface ReplyThinkingOptions {
  stage(): ThinkingStagePort | null | undefined;
  cue?: ThinkingCuePort;
  /** The read-aloud switch. */
  voiceOn(): boolean;
  /** This window reads this reply aloud (its owner, a typed message, a visible pet). */
  speaks(id: string): boolean;
  /** Her voice is in use right now (a feeding cue or pause, a reply still playing, the system engine busy): skip. */
  busy?(): boolean;
  /** Defers the cue decision (default queueMicrotask). */
  schedule?(task: () => void): void;
}

/** A "嗯…" that cannot start this soon after the message is accepted is skipped, never played late. */
export const THINK_CUE_DEADLINE_MS = 350;
const MAX_CUED = 64;

export class ReplyThinkingPresenter {
  private current: string | null = null;
  private readonly cued = new Set<string>();
  constructor(private readonly options: ReplyThinkingOptions) {}

  /** ReplyPresentationState's waiting observer: the waiting reply's id, or null. */
  waiting(id: string | null): void {
    if (id === this.current) return;
    this.current = id;
    try { this.options.stage()?.setReplyThinking(id); } catch { /* The stage presentation is optional. */ }
    if (id === null || this.cued.has(id)) return;
    this.cued.add(id);
    if (this.cued.size > MAX_CUED) this.cued.delete(this.cued.values().next().value!);
    try { (this.options.schedule ?? queueMicrotask)(() => this.cue(id)); } catch { /* A cue is optional. */ }
  }

  private cue(id: string): void {
    const cue = this.options.cue;
    // The first word, a stop or a clear may already have ended the wait.
    if (!cue || this.current !== id) return;
    try {
      if (!this.options.voiceOn() || !this.options.speaks(id) || this.options.busy?.()) return;
      void Promise.resolve(cue.play('think', THINK_CUE_DEADLINE_MS)).catch(() => {});
    } catch { /* A cue is optional. */ }
  }
}

/** The system speech engine is speaking or has something queued (a cue never queues behind or cuts into it). */
export function systemSpeechBusy(): boolean {
  try {
    const engine = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
    return !!engine && (engine.speaking === true || engine.pending === true);
  } catch { return false; }
}
