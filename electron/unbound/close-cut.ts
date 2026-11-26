/**
 * I-203: a kiss or a hug from her reply was interrupted (a large pull, or her face could not reach). Verbatim (answering "亲抱被打断时，
 * 她要不要马上开口说一句？这会多占你的用量"): "可以，但不预设怎么说，只给信息，比如用户动鼠标拉了打断了这样。"
 *
 * So she gets ONE immediate turn, through the moments' one path (electron/initiative/moments/host.ts, kind 'close-cut': the inner loop's turn
 * with this line, the same proactive-speech gate, archived and journaled like her other lines; 'promise' mode: no cooldown, it is not her own
 * autonomous behaviour). Its line carries only facts (shared/unbound/close-moments/frames.ts closeCutLine). At most one per interrupted moment:
 *   - cut(...)     the reply completed (archived once, whole, with its cut record); the facts wait here
 *   - take()       the moments host takes them for the immediate turn, only while its gate is open (nobody typing, no chat turn under way, ...),
 *                  and only within `immediateMs`; once taken, never again
 *   - settled()    how that turn went: spoke or stayed quiet (her choice) → done; never happened → her next chat turn hears it instead
 *   - turnLine()   her next chat turn: the facts when no immediate turn happened (the user was already talking, or it did not go through)
 * Memory only; nothing here is written anywhere (the cut record is filed by the speech-beats host, the journal by the moments host).
 */
import { closeCutLine, closeCutParts, type CloseCutFacts } from '../../shared/unbound/close-moments';
import type { CutRecord } from '../../shared/foundation/reply-cut';

export const CLOSE_CUT_TIMING = Object.freeze({
  /** The immediate turn only within this long after the reply completed (it is "immediate"); later, the next chat turn hears it. */
  immediateMs: 60_000,
  /** The next chat turn hears it only within this long. */
  freshMs: 30 * 60_000,
});

export interface CloseCutNoticePorts {
  clock?(): number;
  /** Her chat's language (the facts read in it). */
  language?(): string | null;
  /** The facts were told (the immediate turn happened, or the next chat turn got them): the shorter "you were pulled away" line is not told again. */
  told?(): void;
}

interface Pending { id: number; facts: CloseCutFacts; at: number; state: 'waiting' | 'offered' | 'next'; owner?: string }

export class CloseCutNotice {
  private pending: Pending | null = null;
  private seq = 0;
  constructor(private readonly ports: CloseCutNoticePorts = {}) {}

  /**
   * One interrupted moment of her reply, after the reply completed. `text`: the reply as archived; `cut`: its record (offsets into it); `owner`
   * (I-209 step 2): whose reply it was, so only she takes the immediate turn.
   */
  cut(event: Pick<CloseCutFacts, 'kind' | 'frame' | 'cause'>, cut: CutRecord, text: string, owner?: string): void {
    const parts = closeCutParts(typeof text === 'string' ? text : '', cut.saidEnd, cut.sentenceEnd);
    this.pending = { id: ++this.seq, facts: { kind: event.kind, frame: event.frame, cause: event.cause, ...parts }, at: this.now(), state: 'waiting', ...(owner ? { owner } : {}) };
  }

  /** An immediate turn may take it now (the moments host asks only while its gate is open). */
  get waiting(): boolean { const p = this.fresh(); return !!p && p.state === 'waiting' && this.now() - p.at <= CLOSE_CUT_TIMING.immediateMs; }

  /** The immediate turn takes the facts (once: never a second turn for the same moment). Null: nothing to take, or the facts are another character's (I-209 step 2). */
  take(characterId?: string): { id: number; line: string } | null {
    if (!this.waiting) return null;
    const p = this.pending!, line = closeCutLine(p.facts, this.language());
    if (p.owner && characterId !== undefined && characterId !== p.owner) return null;
    if (!line) { p.state = 'next'; return null; }
    p.state = 'offered';
    return { id: p.id, line };
  }

  /** The immediate turn for `id` may still go ahead (its facts were not told to a chat turn meanwhile). */
  live(id: number): boolean { const p = this.pending; return !!p && p.id === id && p.state === 'offered'; }

  /** How the immediate turn went: `happened` (her line was said) ends it; otherwise her next chat turn hears the facts. */
  settled(id: number, happened: boolean): void {
    const p = this.pending;
    if (!p || p.id !== id || p.state !== 'offered') return;
    if (happened) { this.pending = null; this.told(); } else p.state = 'next';
  }

  /**
   * Her next chat turn ('' for none): the facts when no immediate turn happened (or one taken but not said yet: the user's message came
   * first, so this turn hears them and that one never goes ahead: `live` is false from now). Told once.
   */
  turnLine(): string {
    const p = this.fresh();
    if (!p) return '';
    this.pending = null;
    const line = closeCutLine(p.facts, this.language());
    if (line) this.told();
    return line ? `\n${line}` : '';
  }

  private fresh(): Pending | null {
    const p = this.pending;
    if (p && this.now() - p.at > CLOSE_CUT_TIMING.freshMs) { this.pending = null; return null; }
    return p;
  }
  private told(): void { try { this.ports.told?.(); } catch { /* information only */ } }
  private language(): string | null { try { return this.ports.language?.() ?? null; } catch { return null; } }
  private now(): number { try { const v = (this.ports.clock ?? Date.now)(); return Number.isFinite(v) ? v : Date.now(); } catch { return Date.now(); } }
}
