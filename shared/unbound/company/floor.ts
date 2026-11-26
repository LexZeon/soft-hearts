/**
 * I-209 step 3: one voice at a time on the full-screen stage (plan: "一次只有一个声音，后面的排队"). Pure.
 *
 * Every line read aloud belongs to someone on stage (the one whose turn it was). Her voice is one reading pipeline (the control window reads
 * one reply at a time); this is who has the floor while it reads: her mouth moves, nobody else's does. A line of someone else that comes while
 * she still reads waits its turn in the queue (first come, first served) and gets the floor when hers ends. Nothing here picks who talks:
 * the user picks by clicking ("点谁和谁说"), the reading order is the order the lines came.
 */
export interface FloorTurn { replyId: string; owner: string }

/** At most this many lines wait (older ones are forgotten: a line that never ends cannot hold the queue for ever). */
export const FLOOR_QUEUE_MAX = 8;

export class StageFloor {
  private now: FloorTurn | null = null;
  private readonly waiting: FloorTurn[] = [];

  /** Who has the floor (her mouth moves with the voice), or null. */
  get holder(): FloorTurn | null { return this.now ? { ...this.now } : null; }
  /** The lines waiting, in order. */
  get queue(): FloorTurn[] { return this.waiting.map(turn => ({ ...turn })); }

  /** A line starts to be read: 'now' when she has the floor, 'queued' when someone else still speaks. The same line twice changes nothing. */
  ask(replyId: string, owner: string): 'now' | 'queued' {
    if (this.now?.replyId === replyId) return 'now';
    if (this.waiting.some(turn => turn.replyId === replyId)) return 'queued';
    if (!this.now) { this.now = { replyId, owner }; return 'now'; }
    this.waiting.push({ replyId, owner });
    while (this.waiting.length > FLOOR_QUEUE_MAX) this.waiting.shift();
    return 'queued';
  }

  /**
   * 2026-11-25: the one voice is sounding line `replyId` now
   * (its sentence became audible). That line has the floor, whoever had it: there is only one voice, so a line still holding the floor
   * whose end never arrived (it was never voiced, or its "done" came after the voice had already stopped) is over. Lines waiting keep their
   * place. Returns who has the floor now.
   */
  sounding(replyId: string, owner: string): FloorTurn | null {
    if (this.now?.replyId === replyId) return this.holder;
    const at = this.waiting.findIndex(turn => turn.replyId === replyId);
    if (at >= 0) this.waiting.splice(at, 1);
    this.now = { replyId, owner };
    return this.holder;
  }

  /** A line ended (read through, cut, taken back): the next one waiting gets the floor (returned), or nobody. */
  end(replyId: string): FloorTurn | null {
    const at = this.waiting.findIndex(turn => turn.replyId === replyId);
    if (at >= 0) { this.waiting.splice(at, 1); return this.holder; }
    if (this.now?.replyId !== replyId) return this.holder;
    this.now = this.waiting.shift() ?? null;
    return this.holder;
  }

  /** Someone left the stage: her lines go (she cannot speak from off stage). */
  leave(owner: string): FloorTurn | null {
    for (let i = this.waiting.length - 1; i >= 0; i--) if (this.waiting[i]!.owner === owner) this.waiting.splice(i, 1);
    if (this.now?.owner === owner) this.now = this.waiting.shift() ?? null;
    return this.holder;
  }

  /** Everything ends (she left full screen). */
  clear(): void { this.now = null; this.waiting.length = 0; }
}
