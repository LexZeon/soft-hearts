/**
 * Unbound v1 step 2, typing to her (docs/claude/2026-11-15-unbound-v1-step2-typing.md): the host side, as ports so tests drive it.
 *
 * A single click on her opens the small input box beside her head (I-194: that is wanting to talk, not a touch). A touch is ONE report
 * (kind 'click', her part and side, where: 'unbound'; electron/mood/touch/sink.ts reportTouch hands it to the brain side) and happens
 * only for a click while the box is already open, or a press held still on her (the page's `hold`). Nothing here is a reaction: what
 * she does about a touch is hers to decide on the brain side. The shortcut opens the same box, and exists only while she is out.
 * Enter sends the line through the chat path the chat boxes use (`say`), the line shows briefly near her, the box closes; Esc,
 * clicking away or her going back to the small window closes it.
 */
import type { UnboundState } from '../../shared/unbound/scene';
import type { HeadSpot, UnboundTouchReport } from '../../shared/unbound/typing';
import { INPUT_BOX_SIZE, INPUT_PANEL_SIZE, placeInputBox } from '../../shared/unbound/typing';
import type { Rect } from '../../shared/unbound/world';
import { SEND_DROP_HINT, SEND_DROP_KNOBS } from '../../shared/brain';
import type { SayHeard, UnboundSayAcks } from './say-ack';
import { ASSISTANT_NAME } from '../../shared/foundation/assistant-name';

/** Ctrl+Alt+T: not Ctrl+Alt+P (show/hide the companion) or Ctrl+Alt+U (out/back), and not the push-to-talk key. */
export const TYPING_SHORTCUT = 'CommandOrControl+Alt+T';

/** 'sent': handed to the control window (whether it really went out comes back as an ack, electron/unbound/say-ack.ts). */
export type SayResult = 'sent' | 'unavailable';
export const SUBMIT_HINTS = Object.freeze({
  empty: '', unavailable: `现在发不出去（${ASSISTANT_NAME} 暂时用不了），过一会儿再试。`, away: '她已经回小窗了。', dropped: SEND_DROP_HINT,
});
/** The line's number and its submit time, handed on with it (electron/unbound/say-line.ts). */
export interface SayTag { line: number; sentAt: number }
/** A line that did not go out, put back in the box (2026-11-22). */
export interface BoxRefill { text: string; hint: string }

export interface InputBoxPort {
  /**
   * Shows the box at the screen rectangle and gives it the keyboard (a new line each time). Moves it when it is already open. `panel`: with the
   * senses panel open (I-190). `refill` (2026-11-22): a line that did not go out, put back with its hint instead of an empty line.
   */
  open(rect: Rect, panel?: boolean, refill?: BoxRefill): void;
  close(): void;
  destroy(): void;
  /** Step 4: the box is on screen now (it also hides itself when it loses focus). */
  isOpen?(): boolean;
}
export interface TypingPorts {
  /** electron/mood/touch/sink.ts reportTouch. */
  touch(value: unknown): boolean;
  /** The chat path (electron/main.ts): the same host `chat` request the chat boxes make, through the window that owns the reading. */
  say(text: string, tag?: SayTag): SayResult;
  /** 2026-11-22: the control window's word on each line (sent / dropped); without it a handed-on line counts as sent, as before. */
  acks?: UnboundSayAcks;
  /** How long the box waits for that word before it closes anyway (SEND_DROP_KNOBS.unboundAckWaitMs). */
  ackWaitMs?: number;
  shortcut: { register(accelerator: string, run: () => void): boolean; unregister(accelerator: string): void };
  input: InputBoxPort;
  state(): UnboundState;
  /** The Unbound window's rectangle and the work area it covers (screen coordinates); null when she has no window. */
  window(): Rect | null;
  /** Asks the page where her head is now (null: no answer in time, or her head is not on the window). */
  askHead(): Promise<HeadSpot | null>;
  /** The line the user sent, shown briefly near her. */
  said(text: string): void;
  clock(): number;
}

/** 2026-11-23: a key in her box this recently (ms) counts as you typing now (her kiss / hug gate); the box merely open does not. */
export const TYPING_RECENT_MS = 2_000;

export class UnboundTyping {
  private registered = false;
  private opening = 0;
  private typedAt = -Infinity;
  constructor(private readonly ports: TypingPorts) {}

  /** A click on her. The page has checked that it was a click (shared/unbound/click.ts); the host checks she is out. */
  click(report: UnboundTouchReport): void {
    if (this.ports.state() !== 'unbound') return;
    if (report.menu) { this.openAt(report.head, true); return; } // I-190: a right click opens the senses panel; it is not a touch
    // I-194: a click that opens the box is wanting to talk, not a touch. It is a touch only while the box is already open, or a press held still (`hold`).
    if (report.hold === true || this.boxOpen) this.ports.touch({ kind: 'click', part: report.part, side: report.side, where: 'unbound', at: this.ports.clock() });
    if (report.hold !== true) this.openAt(report.head);
  }

  /** The shortcut: the box, without a click. Only while she is out. */
  async openFromShortcut(): Promise<void> {
    if (this.ports.state() !== 'unbound') return;
    const ticket = ++this.opening;
    let head: HeadSpot | null = null;
    try { head = await this.ports.askHead(); } catch { head = null; }
    if (ticket !== this.opening || this.ports.state() !== 'unbound') return;
    this.openAt(head);
  }

  /**
   * Enter in the box. `ok: false` keeps the box open and says why. 2026-11-22: the box waits a moment for the control window's word that
   * the line really went out; dropped: the box keeps the line with "没发出去，再试一次" (opened again with it if it closed meanwhile); no word
   * yet: it closes, and a drop that comes later (or no word at all) opens it again with the line (electron/unbound/say-ack.ts).
   * 2026-11-23: the host decides the line's end itself (the request carrying its number was accepted, or it was taken back and is refused
   * from then on), so the box never says "没发出去" about a line that still goes out; still on its way, the line shows near her only once sent.
   */
  async submit(text: unknown): Promise<{ ok: boolean; hint?: string }> {
    if (this.ports.state() !== 'unbound') { this.close(); return { ok: false, hint: SUBMIT_HINTS.away }; }
    const line = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim().slice(0, 2_000) : '';
    if (!line) return { ok: false, hint: SUBMIT_HINTS.empty };
    this.typedAt = -Infinity; // 2026-11-23: the keys of the line being sent are not "typing now": her reply to it is never gated by them
    const acks = this.ports.acks, tag = acks?.start(heard => this.ended(line, heard));
    let result: SayResult;
    try { result = this.ports.say(line, tag); } catch (error) { if (tag) acks!.forget(tag.line); throw error; } // the box says it could not send
    if (result === 'unavailable') { if (tag) acks!.forget(tag.line); return { ok: false, hint: SUBMIT_HINTS.unavailable }; }
    const heard = tag ? await acks!.wait(tag.line, this.ports.ackWaitMs ?? SEND_DROP_KNOBS.unboundAckWaitMs) : 'sent';
    if (heard && heard !== 'sent') {
      if (this.boxOpen && this.ports.state() === 'unbound') return { ok: false, hint: SUBMIT_HINTS.dropped };
      this.refill(line);
      return { ok: false };
    }
    // 2026-11-23: still on its way (null) is not a failure: the box closes, and the line shows near her only once it really went out.
    if (heard === 'sent') this.shown(line);
    this.close();
    return { ok: true };
  }

  /** How a line ended after the box stopped waiting (electron/unbound/say-ack.ts, exactly once): shown as said, or back in the box. */
  private ended(line: string, heard: SayHeard): void { if (heard === 'sent') this.shown(line); else this.refill(line); }

  private shown(line: string): void { try { this.ports.said(line.slice(0, 200)); } catch { /* the line is a courtesy */ } }

  /** A line that did not go out comes back in the box with the hint, beside her head, while she is still out. */
  private refill(line: string): void {
    if (this.ports.state() !== 'unbound') return;
    const ticket = ++this.opening;
    void Promise.resolve().then(() => this.ports.askHead()).catch(() => null).then(head => {
      if (ticket !== this.opening || this.ports.state() !== 'unbound') return;
      this.openAt(head, false, { text: line, hint: SUBMIT_HINTS.dropped });
    });
  }

  cancel(): void { this.close(); }

  /** Every change of state: the shortcut lives exactly while she is out; the box never outlives her. */
  modeChanged(state: UnboundState): void {
    if (state === 'unbound') {
      if (!this.registered) this.registered = this.ports.shortcut.register(TYPING_SHORTCUT, () => { void this.openFromShortcut(); });
      return;
    }
    if (this.registered || state === 'normal') { try { this.ports.shortcut.unregister(TYPING_SHORTCUT); } catch { /* already gone */ } this.registered = false; }
    this.close();
    if (state === 'normal') this.ports.input.destroy();
  }

  get shortcutActive(): boolean { return this.registered; }
  /** Step 4: her input box is open (you are typing to her): her own life yields to you. */
  get boxOpen(): boolean { try { return this.ports.input.isOpen?.() === true; } catch { return false; } }
  /** 2026-11-23 (the box had come back open with a line that had not gone out, and nobody typed): a key went in just now. */
  typed(): void { this.typedAt = this.ports.clock(); }
  /** You are typing to her now: the box is open and a key went in within TYPING_RECENT_MS. */
  get typingNow(): boolean { const now = this.ports.clock(); return this.boxOpen && now >= this.typedAt && now - this.typedAt < TYPING_RECENT_MS; }

  quit(): void {
    try { this.ports.shortcut.unregister(TYPING_SHORTCUT); } catch { /* quitting */ }
    this.registered = false;
    this.ports.input.destroy();
  }

  private close(): void { this.opening++; try { this.ports.input.close(); } catch { /* a closing window */ } }

  private openAt(head: HeadSpot | null, panel = false, refill?: BoxRefill): void {
    const window = this.ports.window();
    if (!window) return;
    const spot = head ? { x: window.x + head.x, y: window.y + head.y, r: head.r } : null;
    const rect = placeInputBox(spot, window, panel ? INPUT_PANEL_SIZE : INPUT_BOX_SIZE);
    this.opening++;
    const at = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    if (refill) this.ports.input.open(at, panel, refill);
    else if (panel) this.ports.input.open(at, true);
    else this.ports.input.open(at);
  }
}
