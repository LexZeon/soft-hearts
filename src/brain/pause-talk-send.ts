import type { PauseTalkCut } from '../../shared/behaviors/pause-talk/interface';
import { SEND_DROP_KNOBS, unboundSayAckOf, type SendOutcome, type UnboundSayAck } from '../../shared/brain';

/**
 * The moment the user sends an ordinary message (src/wiring/chat-wiring.ts). The earlier reply's reveal stops where it is, and how
 * far it got goes with the request (only a number) when part of it was never shown, so the host can tell her next turn: with 停停说说
 * on, as her unsaid words (F7); off, as a plain line that the user did not see the rest (the same shape as an interrupted call).
 * A reply that was fully shown, stopped, cancelled or failed has nothing unsaid: undefined.
 *
 * I-177: full-screen Unbound shows her reply in its own bubble, not in this window's reveal, so the bubble's host says how far it got
 * (`handOutsideCut`, only around the one send that line makes); this window's own reveal, when it has one, wins.
 */
let outsideCut: PauseTalkCut | undefined;

export function handOutsideCut(cut: PauseTalkCut | undefined): void { outsideCut = cut; }

export function pauseCutForSend(presentation: { interrupt(): PauseTalkCut | null }): PauseTalkCut | undefined {
  const own = presentation.interrupt() ?? undefined, outside = outsideCut;
  outsideCut = undefined;
  return own ?? outside;
}

/** A line from her full-screen box as the host hands it: the text, how far her bubble got, its number and its submit time (electron/unbound/say-line.ts). */
export interface UnboundSaid { text: string; cut?: PauseTalkCut; line?: number; sentAt?: number }

/** What the host hands the control window for a line from her small box: a bare string (older shape) or the line with its details. */
export function unboundSayOf(value: unknown): UnboundSaid | null {
  if (typeof value === 'string') return { text: value };
  const line = value as { text?: unknown; cut?: PauseTalkCut; line?: unknown; sentAt?: unknown } | null;
  if (!line || typeof line.text !== 'string') return null;
  const number = typeof line.line === 'number' && Number.isSafeInteger(line.line) && line.line > 0 ? line.line : undefined;
  const sentAt = typeof line.sentAt === 'number' && Number.isFinite(line.sentAt) && line.sentAt > 0 ? line.sentAt : undefined;
  return { text: line.text, ...(line.cut ? { cut: line.cut } : {}), ...(number === undefined ? {} : { line: number }), ...(sentAt === undefined ? {} : { sentAt }) };
}

/**
 * I-177: a line sent from her full-screen box while she is still answering goes out like one typed in this window:
 * a reply still streaming here is stopped first (what it had said stays in the history, as for the stop button), then the line is an
 * ordinary turn carrying how far the bubble got. `send` is this window's own send (sendChat with the line in its box).
 *
 * 2026-11-22 (docs/claude/2026-11-22-typed-line-drops.md): the stop waits at most `stopTimeoutMs` (SEND_DROP_KNOBS.unboundStopTimeoutMs),
 * then the line goes anyway (the host refuses a second reply if the first is still running, and that refusal is a drop the box hears of).
 * The line is sent exactly once. Returns what the send did ('sent', or why it was dropped; a send that threw counts as host-refused).
 */
export async function sendUnboundLine(ports: { answering(): boolean; stop(): Promise<void>; send(): Promise<SendOutcome>; timer?: SendTimer }, cut?: PauseTalkCut,
  stopTimeoutMs = SEND_DROP_KNOBS.unboundStopTimeoutMs, line?: number): Promise<SendOutcome> {
  if (ports.answering()) {
    const timer = ports.timer ?? windowTimer;
    let handle: unknown;
    const waited = new Promise<void>(resolve => { handle = timer.set(resolve, stopTimeoutMs); });
    try { await Promise.race([Promise.resolve().then(() => ports.stop()), waited]); } catch { /* the send below still goes */ }
    finally { timer.clear(handle); }
  }
  handOutsideCut(cut);
  handedLine = line; // read once, synchronously, by the send's start (src/brain/send-guard.ts begin)
  try { return await ports.send(); } catch { return 'host-refused'; } finally { handOutsideCut(undefined); handedLine = undefined; }
}

/**
 * 2026-11-23: the host's number of the full-screen line being sent now (electron/unbound/say-ack.ts). The send's start takes it (once) and
 * puts it into the chat request, so the host can tell, at the one place every request passes, whether this line may still go out.
 */
let handedLine: number | undefined;
export function takeHandedLine(): number | undefined { const line = handedLine; handedLine = undefined; return line; }

/** The window's timers, as a port (tests run the send on a fake clock; the window's own are throttled while it is hidden). */
export interface SendTimer { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
export const windowTimer: SendTimer = { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/**
 * The control window hears a line from her full-screen box (src/wiring/control-window-wiring.ts): the line goes into this window's box
 * (a draft typed here is put back afterwards), out through sendUnboundLine, and the host hears exactly one answer for its number: sent,
 * or dropped and why (electron/unbound/say-ack.ts; a drop opens her box again with the line). Null when the value is not a line.
 */
const boxLinesOf = new WeakMap<object, { count: number; draft: string }>();
export function receiveUnboundSay(said: unknown, ports: { box(): { value: string }; answering(): boolean; stop(): Promise<void>;
  send(sentAt?: number): Promise<SendOutcome>; ack(ack: UnboundSayAck): void; stopTimeoutMs?: number; timer?: SendTimer }): Promise<void> | null {
  const got = unboundSayOf(said);
  if (!got) return null;
  // 2026-11-23: two lines can be here at once (the user pressed Enter again on the same words): the draft is kept by the first and put back
  // by the last; an earlier line ending never empties the box the later one is about to send from (before, the second Enter vanished).
  const box = ports.box(), boxLines = boxLinesOf.get(box) ?? { count: 0, draft: '' }; boxLinesOf.set(box, boxLines);
  if (boxLines.count++ === 0) boxLines.draft = box.value;
  box.value = got.text;
  return sendUnboundLine({ answering: ports.answering, stop: ports.stop, send: () => ports.send(got.sentAt), ...(ports.timer ? { timer: ports.timer } : {}) }, got.cut, ports.stopTimeoutMs, got.line).then(outcome => {
    if (--boxLines.count === 0 && (!box.value || box.value === got.text)) box.value = boxLines.draft;
    if (got.line !== undefined) { try { ports.ack(unboundSayAckOf(got.line, outcome)); } catch { /* the host gives up on its own and opens the box again */ } }
  });
}
