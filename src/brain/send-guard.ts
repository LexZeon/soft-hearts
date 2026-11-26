/**
 * The window's send guard and what happens to a typed line that does not go out (2026-11-22, docs/claude/2026-11-22-typed-line-drops.md;
 * user, typing in full-screen Unbound: answers seemed to wait too long, and it was typing, not voice).
 *
 * Before: sendChat (src/wiring/chat-wiring.ts) returned silently when a reply was running or a local control was still pending, and after
 * it had already emptied the box when another turn began meanwhile; a local control that never heard back held the guard for good, so every
 * later line (the full-screen box's too) vanished without a word. Now:
 * - the guard a local control (stop reading, framing, breath) or a developer test command holds is released by any result for that request
 *   (its stream's done or error, its companion-command view, an ordinary chat-started for it, the request failing) and, whatever happens,
 *   once it is older than SEND_DROP_KNOBS.readoutControlTimeoutMs;
 * - every drop says why in one closed word (shared/brain/send-drop/drop.ts), puts the text back in the box it came from (never over a new
 *   draft), shows "没发出去，再试一次" (or the host's own failure), and hands the host one journal fact (numbers and closed words only).
 *   A line from her full-screen box shows nothing here: the control window is usually hidden, and the box itself opens again with the line
 *   and the hint (electron/unbound/say-ack.ts).
 */
import { SEND_DROP_HINT, SEND_DROP_KNOBS, type SendDropFact, type SendDropFrom, type SendDropWhy, type SendOutcome, type SendWaits } from '../../shared/brain';
import { uiText } from '../foundation/ui-language';
import { takeHandedLine, windowTimer, type SendTimer } from './pause-talk-send';

export interface SendGuardPorts {
  /** A monotonic clock in ms (performance.now). */
  now(): number;
  /** The wall clock (Date.now; sentAt is on it) and the window's timers; tests give fake ones. */
  wall?(): number;
  timer?: SendTimer;
  /** Which window's box this is. */
  from(): Exclude<SendDropFrom, 'unbound'>;
  notify(text: string, error: boolean): void;
  /** One journal fact for the host (noteJournalFact 'send-dropped'; it writes only while the journal is on). */
  journal(fact: SendDropFact): void;
}

/** What a drop shows: the hint (default), the host's own failure text (an error notice), or nothing (null: it was already shown). */
export type DropNotice = typeof SEND_DROP_HINT | { error: unknown } | null;

/** One send, from its start (src/wiring/chat-wiring.ts sendChat). */
export interface SendAttempt {
  /** Why it cannot start now (a reply is running, a local control is pending), or null. */
  readonly busy: SendDropWhy | null;
  /**
   * The line did not go out. The text goes back into the box when the box is empty (a draft typed since stays), the notice is shown (not
   * for a full-screen line: its own box says it), the host gets one journal fact. Returns the reason, which is the send's outcome.
   */
  drop(why: SendDropWhy, notice?: DropNotice): SendDropWhy;
  /**
   * A local control (stop reading, framing, breath; `once` false) or a developer test command (`once` true) goes to the host under the
   * guard `id`. `ask` sends it and says whether it was one (false: not a command, the send goes on as chat: null). Handled: the box is
   * emptied when it still holds the line, 'sent'. A local control keeps the guard until its result comes or it times out; a test command
   * lets it go as soon as the host answered. The host failing is a drop ('host-refused', with the host's own text).
   */
  local(id: string, ask: (id: string) => Promise<boolean>, once?: boolean): Promise<SendOutcome | null>;
  /**
   * One of the send's waits (telling the host you typed, the settings save, this turn's pictures): its ms go with the request. With `after`,
   * the wait is capped (SEND_DROP_KNOBS.saveWaitMs) and then gives `after`: the work goes on behind, the line does not wait for it. Used for
   * the save: the host queues it behind every other write (coordinator 2026-11-22: a typed line reached the host 39 s late, only once the
   * voice capture left running after a call had stopped; electron/brain/companion.ts context() waits for its pending operations).
   */
  timed<T>(stage: 'note' | 'save' | 'look', work: Promise<T>, after?: T): Promise<T>;
  /**
   * 2026-11-23: work the line does not wait for (telling the host you typed: the chat request comes after it on the same channel, so the
   * host still hears it first). A failure is swallowed; nothing is counted.
   */
  aside(work: Promise<unknown>): void;
  /**
   * What the chat request carries about this send: sentAt, the waits so far (shared/brain/send-drop/drop.ts SendWaits; `before`: from sentAt
   * to this send's start), and for a full-screen line the host's number of it (electron/brain/handed-line-gate.ts).
   */
  stamp(): { sentAt: number; waits: SendWaits; line?: number };
}

export class SendGuard {
  private held: { id: string; at: number } | null = null;
  constructor(private readonly ports: SendGuardPorts, private readonly timeoutMs = SEND_DROP_KNOBS.readoutControlTimeoutMs,
    private readonly saveWaitMs = SEND_DROP_KNOBS.saveWaitMs) {}

  /** A local control or a test command is on its way to the host under this id: an ordinary send waits for its result. */
  hold(id: string): void { this.held = { id, at: this.ports.now() }; }
  /** Its result came (or the chat was cleared): with an id, only when it is still the one held. */
  release(id?: string): void { if (id === undefined || this.held?.id === id) this.held = null; }
  /** The id held now (null when nothing is, or what was held is older than the timeout: it is let go here). */
  get pending(): string | null {
    if (this.held && this.ports.now() - this.held.at >= this.timeoutMs) this.held = null;
    return this.held?.id ?? null;
  }

  /** Why a send cannot start now, or null. A guard older than the timeout never blocks. */
  blocked(activeChat: string | null): SendDropWhy | null {
    if (activeChat) return 'busy';
    return this.pending ? 'readout-pending' : null;
  }

  /** A send starts: its line, its box, when it was sent (a full-screen line: its box's submit), whether it came from the full-screen box. */
  begin(activeChat: string | null, content: string, box: { value: string }, sentAt: number, unbound: boolean): SendAttempt {
    const wall = () => this.ports.wall?.() ?? Date.now(), timer = this.ports.timer ?? windowTimer;
    const line = takeHandedLine(); // 2026-11-23: the full-screen line's number, taken at once, before any wait (src/brain/pause-talk-send.ts)
    const drop = (why: SendDropWhy, notice: DropNotice = SEND_DROP_HINT): SendDropWhy => {
      if (content && !box.value.trim()) box.value = content;
      if (!unbound && notice === SEND_DROP_HINT) this.ports.notify(uiText(SEND_DROP_HINT), false);
      else if (!unbound && notice && typeof notice === 'object') this.ports.notify(String(notice.error), true);
      const waitMs = wall() - sentAt;
      // A full-screen line's drop is journaled by the host, once per line, from the ack (electron/unbound/say-ack.ts): a line the host had
      // already taken back and then refused is not a second drop.
      if (!unbound) { try { this.ports.journal({ why, from: this.ports.from(), ...(waitMs >= 0 ? { waitMs } : {}) }); } catch { /* the journal never blocks a send */ } }
      return why;
    };
    const local = async (id: string, ask: (id: string) => Promise<boolean>, once = false): Promise<SendOutcome | null> => {
      this.hold(id);
      let failed = true;
      try {
        const handled = await ask(id);
        failed = false;
        if (!handled) return null;
        if (box.value.trim() === content) box.value = '';
        return 'sent';
      } catch (error) { return drop('host-refused', { error }); }
      finally { if (once || failed) this.release(id); }
    };
    const waits: SendWaits = { before: Math.max(0, wall() - sentAt), note: 0, save: 0, look: 0 };
    const timed = async <T>(stage: 'note' | 'save' | 'look', work: Promise<T>, after?: T): Promise<T> => {
      const start = wall();
      let handle: unknown;
      const cap = after === undefined ? null : new Promise<T>(resolve => { handle = timer.set(() => resolve(after), this.saveWaitMs); });
      try { return await (cap ? Promise.race([work, cap]) : work); } finally { if (cap) timer.clear(handle); waits[stage] += Math.max(0, wall() - start); }
    };
    const aside = (work: Promise<unknown>) => { void Promise.resolve(work).catch(() => {}); };
    return { busy: this.blocked(activeChat), drop, local, timed, aside, stamp: () => ({ sentAt, waits: { ...waits }, ...(line === undefined ? {} : { line }) }) };
  }
}

/**
 * Whether two settings values are the same, whatever the key order (plain JSON-like data: objects, arrays, strings, numbers, booleans, null;
 * undefined members count as absent). 2026-11-23: src/wiring/settings-wiring.ts saveBeforeSend skips a save that would change nothing.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) { const other = b as unknown[]; return a.length === other.length && a.every((item, i) => sameValue(item, other[i])); }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = (value: Record<string, unknown>) => Object.keys(value).filter(key => value[key] !== undefined);
  const own = keys(left);
  return own.length === keys(right).length && own.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/** The guard of a window (src/wiring/chat-wiring.ts): `kind` is the window's kind ('controls' or the companion window's); nothing is read until used. */
export function windowSendGuard(kind: () => string, notify: (text: string, error: boolean) => void): SendGuard {
  return new SendGuard({ now: () => performance.now(), from: () => kind() === 'controls' ? 'controls' : 'companion', notify,
    journal: fact => { void window.desktop.noteJournalFact('send-dropped', fact).catch(() => {}); } });
}
