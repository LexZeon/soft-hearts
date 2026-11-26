/**
 * The conversation's switch lock (docs/claude/2026-11-23-switch-lock.md). Every change of the accepted context (another character,
 * connection or persona, a new conversation, a deleted record, forgotten memories) bumps the generation synchronously, before any
 * await, so a reply in flight from the old scope can never land in the new one (`current(generation)` turns false at once). The
 * companion reports "角色或对话正在切换" while the latest bump has not settled.
 *
 * The rule this class holds (user evidence 2026-11-23 21:04: the lock stayed held and no character switch worked until a restart):
 * every bump is settled exactly once, by `settle()`, whether its step finished, threw or returned early. A bump that a later
 * bump overtook settles too; the later one settles after it (the companion runs these steps one at a time, in order), so the
 * lock is free once the newest step has ended. Nothing else may move the committed generation.
 */
export class ContextLock {
  private bumped = 0;
  private committed = 0;

  /** The newest generation (a turn or a speech scope captures it when it starts). */
  get generation(): number { return this.bumped; }
  /** True between a bump and the end of its step. */
  get switching(): boolean { return this.committed !== this.bumped; }

  /** Invalidates every earlier generation now; the caller must hand the result to settle() (its queued step). */
  bump(): number { return ++this.bumped; }

  /** A result captured at `generation` may still land: nothing changed since and that change has settled. */
  current(generation: number): boolean { return generation === this.bumped && generation === this.committed; }

  /** The step of one bump: whatever `body` does (finish, throw, return early), the bump is settled when it ends. */
  async settle<T>(generation: number, body: () => Promise<T>): Promise<T> {
    try { return await body(); }
    finally { this.commit(generation); }
  }

  private commit(generation: number): void {
    // Steps settle in order; an older step never moves the lock back over a newer one that already settled.
    if (generation > this.committed && generation <= this.bumped) this.committed = generation;
  }
}
