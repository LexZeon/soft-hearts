/**
 * Whether a line from her full-screen box really went out (2026-11-22, docs/claude/2026-11-22-typed-line-drops.md; reported later that day:
 * a line typed in the box never started a turn, and the box had closed as if it had).
 *
 * The box hands the line to the host (electron/unbound/typing.ts), the host hands it to the control window (electron/unbound/say-line.ts),
 * the control window sends it like its own chat box (src/brain/pause-talk-send.ts). This ledger keeps each line between: a number and the
 * host time of its submit (the journal's sendMs then counts from the box).
 *
 * 2026-11-23: one truth per line, decided by the host.
 * - sent: the chat request carrying the line's number was accepted (electron/brain/handed-line-gate.ts calls `open` then `sent`), or the
 *   control window said so (a local control from the box sends no number);
 * - dropped: the control window said it did not go out, and why;
 * - taken back ('no-ack'): it had not gone out within SEND_DROP_KNOBS.unboundAckGiveUpMs. From then on the host refuses it (`open` is false,
 *   one journal line 'late' if it does come), so "没发出去" is the truth: the line never goes out after it, and never twice.
 * Each line ends exactly once; whoever waits hears it (`wait`), otherwise `later` does (the box opens again with the line, or shows it as said).
 * While any line is open the control window is kept awake (`awake`; electron/unbound/control-awake.ts owns the throttling): hidden, it is throttled and a line could wait there 20 s and more.
 * One journal line per real drop (from 'unbound'; the control window writes none for these lines). Ports only: tests drive it with a fake clock.
 */
import { SEND_DROP_KNOBS, parseUnboundSayAck, type SendDropWhy } from '../../shared/brain';
import type { HandedLineGate } from '../brain';

/** What became of a line: it went out, or it was dropped (why; 'no-ack': taken back). */
export type SayHeard = 'sent' | { dropped: SendDropWhy };

export interface SayAckPorts {
  /** Wall clock in ms (Date.now: the control window stamps the request with the same clock). */
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** One journal fact per real drop of a full-screen line (and 'late' for a taken-back line that came afterwards); ms since the submit. */
  journal(fact: { why: SendDropWhy; waitMs: number }): void;
  /** The control window must not be throttled (true) while a line is open, and may be again (false) once none is. */
  awake?(on: boolean): void;
  /** I-209 step 3: whom a line without a number goes to now (the one you clicked last on stage); null: the first one. */
  addressee?(): string | null;
}

interface Pending { sentAt: number; giveUp: unknown; waiter: ((heard: SayHeard | null) => void) | null; later: (heard: SayHeard) => void }

/** How many taken-back lines are remembered (a later request for one is refused; an unknown number is refused too). */
const TAKEN_BACK_KEEP = 64;

export class UnboundSayAcks implements HandedLineGate {
  private last = 0;
  private readonly lines = new Map<number, Pending>();
  private readonly takenBack = new Map<number, number>();
  constructor(private readonly ports: SayAckPorts, private readonly knobs: { unboundAckGiveUpMs: number } = SEND_DROP_KNOBS) {}

  /** A line goes out: its number and the time of its submit. `later`: how it ended, when nobody waits any more (a drop, or a late 'sent'). */
  start(later: (heard: SayHeard) => void): { line: number; sentAt: number } {
    const line = ++this.last, sentAt = this.ports.now();
    const giveUp = this.ports.setTimer(() => this.settle(line, { dropped: 'no-ack' }), this.knobs.unboundAckGiveUpMs);
    this.lines.set(line, { sentAt, giveUp, waiter: null, later });
    if (this.lines.size === 1) this.wake(true);
    return { line, sentAt };
  }

  /** The line never went to the control window (the host refused it first): nothing to wait for, nothing to journal. */
  forget(line: number): void {
    const p = this.lines.get(line); if (!p) return;
    this.ports.clearTimer(p.giveUp); this.lines.delete(line);
    if (!this.lines.size) this.wake(false);
  }

  /** Waits up to `ms` for this line's end: 'sent', a drop, or null (still on its way; its end then goes to `later`). */
  wait(line: number, ms: number): Promise<SayHeard | null> {
    const p = this.lines.get(line);
    if (!p) return Promise.resolve(null);
    return new Promise(resolve => {
      const timer = this.ports.setTimer(() => { if (p.waiter === answer) p.waiter = null; resolve(null); }, ms);
      const answer = (heard: SayHeard | null) => { this.ports.clearTimer(timer); resolve(heard); };
      p.waiter = answer;
    });
  }

  /** The control window's word (checked here); true when it ended a line still open. */
  ack(value: unknown): boolean {
    const ack = parseUnboundSayAck(value);
    if (!ack || !this.lines.has(ack.line)) return false;
    this.settle(ack.line, ack.result === 'sent' ? 'sent' : { dropped: ack.why });
    return true;
  }

  /** The chat handler's question (HandedLineGate): may this line go out now? A taken-back one that comes anyway: one 'late' line, refused. */
  open(line: number): boolean {
    if (this.lines.has(line)) return true;
    const sentAt = this.takenBack.get(line);
    if (sentAt !== undefined) { this.takenBack.delete(line); this.note('late', sentAt); }
    return false;
  }

  /** Its request was accepted (HandedLineGate): the line is sent. */
  sent(line: number): void { this.settle(line, 'sent'); }

  /** I-209 step 3 ("点谁和谁说"): this line was typed into the box of `owner` (null: the first one's). Kept for the last TAKEN_BACK_KEEP lines. */
  own(line: number, owner: string | null): void {
    if (!owner) { this.owners.delete(line); return; }
    this.owners.set(line, owner);
    while (this.owners.size > TAKEN_BACK_KEEP) this.owners.delete(this.owners.keys().next().value!);
  }
  /** HandedLineGate: whose box this line came from (null: the first one's). */
  ownerOf(line: number): string | null { return this.owners.get(line) ?? null; }
  /** HandedLineGate: a line without a number (voice input) goes to the one you clicked last while several are on stage. */
  addressee(): string | null { try { return this.ports.addressee?.() ?? null; } catch { return null; } }
  private readonly owners = new Map<number, string>();

  /** Lines still on their way (tests, diagnostics). */
  get pending(): number { return this.lines.size; }

  private settle(line: number, heard: SayHeard): void {
    const p = this.lines.get(line);
    if (!p) return;
    this.lines.delete(line);
    this.ports.clearTimer(p.giveUp);
    if (!this.lines.size) this.wake(false);
    if (heard !== 'sent') {
      if (heard.dropped === 'no-ack') { this.takenBack.set(line, p.sentAt); while (this.takenBack.size > TAKEN_BACK_KEEP) this.takenBack.delete(this.takenBack.keys().next().value!); }
      this.note(heard.dropped, p.sentAt);
    }
    if (p.waiter) { const waiter = p.waiter; p.waiter = null; waiter(heard); return; }
    try { p.later(heard); } catch { /* a closing window */ }
  }

  private note(why: SendDropWhy, sentAt: number): void {
    try { this.ports.journal({ why, waitMs: Math.max(0, this.ports.now() - sentAt) }); } catch { /* the journal never blocks */ }
  }

  private wake(on: boolean): void { try { this.ports.awake?.(on); } catch { /* a closing window */ } }
}
