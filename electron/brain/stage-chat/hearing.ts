/**
 * I-209 step 4: everyone on stage hears every line, and each records it in her own memory with its speaker.
 *
 * The chat memory tells (electron/memory/stage-lines.ts StageLineEvent) when a line was SAID in someone's archive: her finished reply with the
 * user's line it answered, a line of her own (a host initiative), her chime-in. While two or more are on stage and the speaker is one of
 * them, every other one on stage gets that line once in her own archive (a stage line: the user's line with whom it was said to, the
 * speaker's line with her name). The id each copy gets is made from the line's own id, so the same line twice keeps one record per character
 * (one archive per line per character). What a character merely heard is never told on, so it never echoes further.
 * The chime-in round (chime-in.ts) hears the same lines. Alone on stage nothing here does anything.
 */
import { createHash } from 'node:crypto';
import type { MemoryScope, MemorySpeaker, MemoryStageLine } from '../../../shared/memory';
import type { StageLine } from './facts';

/** What the memory tells (electron/memory/stage-lines.ts StageLineEvent, repeated here so the brain does not import the store). */
export type HeardEvent =
  | { kind: 'begin'; scope: MemoryScope; turnId: string; at: number }
  | { kind: 'said'; scope: MemoryScope; turnId: string; at: number; text: string; user?: { text: string; at: number } };

export interface HearingPorts {
  /** Everyone on stage now (card ids, the desktop companion included); fewer than two: alone. */
  present(): readonly string[];
  /** Her own memory scope (CompanionService.ownerScope), or null when she has none now. */
  scopeOf(id: string): MemoryScope | null;
  /** Her card id and name as the archive keeps them. */
  speaker(id: string): MemorySpeaker | undefined;
  append(scope: MemoryScope, line: MemoryStageLine): Promise<unknown>;
  /** The chime-in round hears the same lines (absent: nobody chimes in). */
  heard?(line: StageLine): void;
  userSpoke?(at: number): void;
}

/** The id of a line's copy in the listeners' archives: the same line always gives the same id (no second record on a repeat). */
/** Every heard copy's id starts with this. */
export const HEARD_PREFIX = 'heard-';
export function heardId(lineId: string, part: 'u' | 'a'): string {
  return `${HEARD_PREFIX}${createHash('sha256').update(String(lineId)).digest('hex').slice(0, 24)}-${part}`;
}

export class StageHearing {
  /** Copies written (tests, diagnostics). */
  readonly counts = { lines: 0, copies: 0, failed: 0 };
  constructor(private readonly ports: HearingPorts) {}

  private present(): string[] { try { return [...this.ports.present()]; } catch { return []; } }

  event(event: HeardEvent): void {
    if (!event || typeof event !== 'object') return;
    const present = this.present(), speaker = event.scope?.characterId;
    if (present.length < 2 || !speaker || !present.includes(speaker)) return;
    if (event.kind === 'begin') { try { this.ports.userSpoke?.(event.at); } catch { /* the round is dropped anyway on the next line */ } return; }
    if (event.kind !== 'said' || typeof event.text !== 'string' || !event.text.trim()) return;
    // A copy someone only heard is never passed on again, even if the store took it for her own line (a missing speaker): no echo, ever.
    if (event.turnId.startsWith(HEARD_PREFIX)) return;
    this.counts.lines++;
    const listeners = present.filter(id => id !== speaker);
    let by: MemorySpeaker | undefined;
    try { by = this.ports.speaker(speaker); } catch { by = undefined; }
    const user = event.user && typeof event.user.text === 'string' && event.user.text.trim() ? event.user : null;
    const userLine = user ? { id: heardId(event.turnId, 'u'), text: user.text, at: user.at } : null, replyLine = { id: heardId(event.turnId, 'a'), text: event.text, at: event.at };
    for (const listener of listeners) {
      let scope: MemoryScope | null;
      try { scope = this.ports.scopeOf(listener); } catch { scope = null; }
      if (!scope) continue;
      if (userLine) this.write(scope, { ...userLine, role: 'user', ...(by ? { to: by } : {}) });
      this.write(scope, { ...replyLine, role: 'assistant', ...(by ? { by } : { by: { characterId: speaker, name: '' } }) });
    }
    try {
      if (userLine) this.ports.heard?.({ id: userLine.id, speaker: null, text: userLine.text, at: userLine.at, to: speaker });
      this.ports.heard?.({ id: replyLine.id, speaker, text: replyLine.text, at: replyLine.at });
    } catch { /* the round is the chime-in's; the records are written */ }
  }

  private write(scope: MemoryScope, line: MemoryStageLine): void {
    this.counts.copies++;
    try { void Promise.resolve(this.ports.append(scope, line)).catch(() => { this.counts.failed++; }); } catch { this.counts.failed++; }
  }
}
