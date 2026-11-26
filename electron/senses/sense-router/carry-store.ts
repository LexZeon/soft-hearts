import type { SenseNote } from '../../../shared/senses/sense-router';

/**
 * I-161 a call's carried notes (memory only). A finished look waits here until a call segment is written; several looks that outlive
 * their segments (docs/claude/2026-11-20-call-look-carry-over.md) wait together, oldest first, and go into ONE note for ONE segment.
 * Pure bookkeeping: the host decides what is still valid (switches, "别看", deadline), this keeps order, claims and the cap.
 */
export interface CarryMeta { scope: string; identity: string; conversation: string; characterId: string }
/** A note with how long ago it was seen (for "N 秒前" in her private line; never a clock time). */
export type AgedNote = SenseNote & { agoMs: number };
interface Entry { note: SenseNote; at: number; seenAt: number; claim: string | null }

/** At most this many notes in one carried line (the oldest go first). A bound on the prompt, not a pace. */
export const MAX_CARRIED_NOTES = 4;

export class CarryStore {
  private meta: CarryMeta | null = null;
  private entries: Entry[] = [];

  get held(): boolean { return this.meta !== null && this.entries.length > 0; }
  get scope(): string | null { return this.meta?.scope ?? null; }
  clear(): void { this.meta = null; this.entries = []; }

  /** A finished turn's notes. `at`: when its message came (the deadline counts from there); `seenAt`: when the facts came. */
  add(meta: CarryMeta, notes: readonly SenseNote[], at: number, seenAt: number): void {
    const same = this.meta && this.meta.scope === meta.scope && this.meta.identity === meta.identity
      && this.meta.conversation === meta.conversation && this.meta.characterId === meta.characterId;
    if (!same) this.entries = [];
    this.meta = { ...meta };
    for (const note of notes) {
      // "it is off" once per sense in one carried line.
      if (note.kind === 'off' && this.entries.some(entry => entry.note.kind === 'off' && entry.note.sense === note.sense)) continue;
      this.entries.push({ note: { ...note }, at, seenAt, claim: null });
    }
    this.entries.sort((a, b) => a.seenAt - b.seenAt);
    while (this.entries.length > MAX_CARRIED_NOTES) this.entries.shift();
  }

  /**
   * What segment `claim` reads (the same notes on every read; notes another segment claimed are not its). `valid`: the scope, character,
   * model and conversation still match; `keep`: a note that may still be said (sense on, no "别看"). Others are dropped for good.
   */
  read(scope: string, claim: string, now: number, deadlineMs: number, valid: (meta: CarryMeta) => boolean, keep: (note: SenseNote) => boolean): { notes: AgedNote[]; fresh: boolean } {
    const none = { notes: [] as AgedNote[], fresh: false };
    if (!this.meta || !scope || this.meta.scope !== scope) return none;
    if (!valid(this.meta)) { this.clear(); return none; }
    this.entries = this.entries.filter(entry => now - entry.at <= deadlineMs && keep(entry.note));
    if (!this.entries.length) { this.clear(); return none; }
    const mine = this.entries.filter(entry => entry.claim === null || entry.claim === claim);
    const fresh = mine.some(entry => entry.claim === null);
    for (const entry of mine) entry.claim = claim;
    return { notes: mine.map(entry => ({ ...entry.note, agoMs: Math.max(0, now - entry.seenAt) }) as AgedNote), fresh };
  }

  /** The segment that took notes ended: those are forgotten; notes that came after it began stay for the next segment. */
  release(claim: string): void {
    this.entries = this.entries.filter(entry => entry.claim !== claim);
    if (!this.entries.length) this.clear();
  }
}
