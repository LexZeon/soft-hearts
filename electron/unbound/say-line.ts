/**
 * I-177 (asked "要不要改成和窗口一样能发？" -> "按推荐"):
 * a line sent from her small box while she is still answering goes out like a line sent in the companion window. It is never refused
 * for that: her reply stops where it is (the bubble keeps what was shown; the reading stops with the new turn), how far it got goes with
 * the message (the same `pauseCut` the window sends, so the host hands her next turn the same note), and the line is a normal turn.
 *
 * Only the user's sent line does this. Nothing here is called by a screenshot, Win+D, a focus change or her own line (I-171/I-174).
 * The control window does the sending (src/wiring/control-window-wiring.ts): if a reply is still streaming there it stops it first.
 */
import type { PauseTalkCut } from '../../shared/brain';
import type { SayResult, SayTag } from './typing';

/**
 * What the host hands the control window: the line, and how far the reply it interrupts had been shown (only when part was not).
 * 2026-11-22: its number (the control window answers with it, electron/unbound/say-ack.ts) and the host time of the box's submit (the
 * request's sentAt, so the journal's sendMs counts the whole wait from Enter).
 */
export interface UnboundSayLine { text: string; cut?: PauseTalkCut; line?: number; sentAt?: number }

export interface SayPorts {
  chatAvailable(): boolean;
  /** The control window that owns the chat is there. */
  controlsAlive(): boolean;
  /** Her bubble's reply stops where it is; how far it got when part was never shown (electron/unbound/bubble-hold.ts interrupt). */
  interruptReply(): PauseTalkCut | null;
  send(line: UnboundSayLine): void;
}

export function sayLine(ports: SayPorts, text: string, tag?: SayTag): SayResult {
  if (!ports.chatAvailable() || !ports.controlsAlive()) return 'unavailable';
  let cut: PauseTalkCut | null = null;
  try { cut = ports.interruptReply(); } catch { cut = null; }
  ports.send({ text, ...(cut ? { cut } : {}), ...(tag ? { line: tag.line, sentAt: tag.sentAt } : {}) });
  return 'sent';
}
