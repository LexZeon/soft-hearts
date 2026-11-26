/**
 * A typed line that did not go out (2026-11-22, docs/claude/2026-11-22-typed-line-drops.md; reported while typing in full-screen Unbound:
 * answers seemed to wait too long, and it was typing, not voice): a line typed in her box never
 * started a turn and nothing said so. Now every place a typed line can be dropped says why in one closed word, the text goes back to where
 * it was typed with a short hint, and one journal line records it (numbers and closed words only, never the line).
 *
 * Shared by both sides: the windows decide and report (src/brain/send-guard.ts), the host checks and writes (shared/brain/journal-entries.ts),
 * and the full-screen box hears back from the control window whether its line really went out (electron/unbound/say-ack.ts).
 */

/**
 * Why a typed line did not go out. busy: a reply was still being written in the window that sends; readout-pending: a local control
 * (stop reading, framing, breath) or a developer test command had not heard back yet; superseded: another turn began, or the stop button
 * was pressed, while this one was being prepared; save-failed: the window's settings did not save; host-refused: the host did not take the
 * request (it threw); no-ack: (host only) the full-screen line had not gone out within SEND_DROP_KNOBS.unboundAckGiveUpMs, so the host took
 * it back (it is refused if it comes later: 2026-11-23); late: (host only) such a taken-back line did reach the host afterwards and was
 * refused (waitMs says how late; this is how a slow hand-over shows itself, the line itself was already reported as no-ack).
 */
export const SEND_DROP_WHYS = ['busy', 'readout-pending', 'superseded', 'save-failed', 'host-refused', 'no-ack', 'late'] as const;
export type SendDropWhy = (typeof SEND_DROP_WHYS)[number];
/** Where the line was typed: the control window's box, the companion window's box, or her full-screen box. */
export const SEND_DROP_FROMS = ['controls', 'companion', 'unbound'] as const;
export type SendDropFrom = (typeof SEND_DROP_FROMS)[number];

/** The hint beside the box the line went back to (English twin in shared/foundation/ui-copy.unbound.en.ts). */
export const SEND_DROP_HINT = '没发出去，再试一次。';

/** The host's refusal of a full-screen line it had already taken back (electron/brain/handed-line-gate.ts; English twin in ui-copy.unbound.en.ts). */
export const HANDED_LINE_REFUSED = '这句已经收回了，没有再发。';

/** What a send did: it went out (the host took it), it was dropped (why), or there was nothing to send / it became a task offer (undefined). */
export type SendOutcome = 'sent' | SendDropWhy | undefined;

/** What the control window tells the host about one full-screen line (`line` is the host's number for it). */
export type UnboundSayAck = { line: number; result: 'sent' } | { line: number; result: 'dropped'; why: SendDropWhy };

/** The fact the windows hand the host for the journal (noteJournalFact 'send-dropped'). */
export interface SendDropFact { why: SendDropWhy; from: SendDropFrom; waitMs?: number }

/**
 * 2026-11-22 (coordinator, from tonight's journal: typed full-screen turns with sendMs 43 s, 33 s, 12 s, 7.8 s while Claude itself took
 * 1–3 s; "unbound打电话还蛮快的。但是打字有概率异常慢。"): where a typed line spent its time between the send and the host taking it, so the
 * next slow turn names the cause. Window side, ms each: before (from the send to the window starting it: for a full-screen line the hand-over
 * box → host → control window and the stop of her reply, at most SEND_DROP_KNOBS.unboundStopTimeoutMs), note (telling the host you typed),
 * save (the window's settings save, queued behind any earlier one), look (the host taking this turn's pictures: screen, camera, small frames).
 * What is left of sendMs is the request itself on its way (ipc).
 */
export interface SendWaits { before: number; note: number; save: number; look: number }
export const SEND_HELD_WORDS = ['before', 'note', 'save', 'look', 'ipc'] as const;
export type SendHeld = (typeof SEND_HELD_WORDS)[number];
const WAIT_KEYS = ['before', 'note', 'save', 'look'] as const;

/** The host reads the window's waits: four whole ms numbers within ten minutes, or nothing. */
export function validSendWaits(value: unknown): SendWaits | undefined {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!v) return undefined;
  const out: Partial<SendWaits> = {};
  for (const key of WAIT_KEYS) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 600_000) return undefined;
    out[key] = Math.round(n);
  }
  return out as SendWaits;
}

/** Which wait held the line longest (the rest of sendMs counts as ipc), and how long. Null without both numbers. */
export function sendHeldBy(sendMs: number | null | undefined, waits: SendWaits | undefined): { held: SendHeld; heldMs: number } | null {
  if (typeof sendMs !== 'number' || !Number.isFinite(sendMs) || sendMs < 0 || !waits) return null;
  const parts: [SendHeld, number][] = [...WAIT_KEYS.map(key => [key, waits[key]] as [SendHeld, number]), ['ipc', Math.max(0, sendMs - waits.before - waits.note - waits.save - waits.look)]];
  const [held, heldMs] = parts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { held, heldMs: Math.round(heldMs) };
}

const isWhy =(value: unknown): value is SendDropWhy => typeof value === 'string' && (SEND_DROP_WHYS as readonly string[]).includes(value);

/** The ack for one line from what the send did; anything but 'sent' is a drop (nothing sent and no reason known counts as superseded). */
export function unboundSayAckOf(line: number, outcome: SendOutcome): UnboundSayAck {
  return outcome === 'sent' ? { line, result: 'sent' } : { line, result: 'dropped', why: outcome ?? 'superseded' };
}

/** The host reads an ack from the control window: only these shapes, a safe line number and a closed reason. */
export function parseUnboundSayAck(value: unknown): UnboundSayAck | null {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!v || typeof v.line !== 'number' || !Number.isSafeInteger(v.line) || v.line < 1) return null;
  if (v.result === 'sent') return { line: v.line, result: 'sent' };
  return v.result === 'dropped' && isWhy(v.why) ? { line: v.line, result: 'dropped', why: v.why } : null;
}
