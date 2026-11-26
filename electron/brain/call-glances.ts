/**
 * I-161 A (= 按推荐就行): in a call, the small 「发图片」 camera frames
 * she was shown stay in the warm Claude process until the call ends, instead of retiring the process after every picture turn (which
 * cost about 0.9 s on the next sentence's first character, docs/claude/2026-11-19-call-glance-warm.md).
 *
 * The privacy rule this replaces: "one frame is seen for one sentence only" (2026-11-02, electron/brain/claude-session.ts). Claude Code
 * cannot drop one picture from a live conversation, so frames are forgotten the only way it can: by closing the process (its memory is
 * the only place they are; `--no-session-persistence` keeps them off the disk). The user approved the looser rule, with these limits:
 *  - only turns whose every picture is a small 「发图片」 frame, marked by the voice host for a call segment (`CallGlanceMark`); a frame
 *    the user asked for ("你看看我", the screen) still retires the process after its turn, and typed chat never sets the mark;
 *  - only while a call holds the process warm (PersistentClaudeChat.holdWarm); hang-up drops them (a new call never sees them);
 *  - "别看", a camera, 「发图片」 or screen switch going off, or a cleared vision context drops them at once (forgetFrames: the process is
 *    replaced now when she is idle, when the running turn ends otherwise); and before every write a check asks each held frame whether
 *    it may still be seen (`still`), so a missed signal still replaces the process before anything more is written to it;
 *  - at most CALL_LOOK.glancesPerProcess frames per process.
 * Nothing here keeps a picture: a held frame is a count and a check that closes over its ticket (source, opening, context, digest).
 *
 * I-166: every turn now carries a small frame from each sense that is on
 * (typed chat, voice input and calls; the screen's small frame too), so outside a call the same rule holds (SEE_AND_SAY.keepOutsideCall):
 * frames shown outside a call carry the tag OUTSIDE_CALL and go only by the same checks ("别看", a switch off, a cleared context, the cap).
 * They may continue into a call, where the first call frame joins them to that call (hang-up then drops them all); a call's frames never
 * continue after it ends.
 */
import { CALL_LOOK, SEE_AND_SAY, type CallGlanceMark } from '../../shared/senses';

export type { CallGlanceMark };

/** The knobs PersistentClaudeChat reads (tests and the measuring script pass their own). */
/** `outside` (I-166): small frames shown outside a call stay too. */
export interface CallGlanceKnobs { stays: boolean; cap: number; outside?: boolean }
export function callGlanceKnobs(): CallGlanceKnobs {
  return { stays: CALL_LOOK.glanceStaysInCall === true, cap: CALL_LOOK.glancesPerProcess,
    outside: SEE_AND_SAY.keepOutsideCall === true && SEE_AND_SAY.smallFramesEveryTurn === true };
}
/** I-166: the tag of small frames shown outside any call (call numbers start at 1). */
export const OUTSIDE_CALL = -1;
/** The tag a turn's small frames get: the call's number in a call, OUTSIDE_CALL otherwise. */
export const glanceTag = (inCall: boolean, call: number): number => (inCall ? call : OUTSIDE_CALL);

/** The small frames one Claude process holds: a count and their checks, never the frames. Lives and dies with its session. */
export class HeldGlances {
  count = 0;
  private checks: Array<() => boolean> = [];
  private forgotten = false;
  /** The call (PersistentClaudeChat's call number) these frames were shown in; OUTSIDE_CALL (I-166) for frames of no call. */
  constructor(public call: number) {}

  /** `tag`: the turn's (glanceTag). Frames of no call joined by a call's frames belong to that call from now on (hang-up drops them). */
  add(frames: number, still: () => boolean, tag: number = this.call): void {
    if (this.call === OUTSIDE_CALL) this.call = tag;
    this.count += frames;
    this.checks.push(still);
  }

  /** "别看", a switch off, a cleared context, hang-up: these frames must go (for good: a later "看看我" does not bring them back). */
  forget(): void { this.forgotten = true; }

  /** True once any held frame may no longer be seen, or they were forgotten. Latches. */
  stale(): boolean {
    if (this.forgotten) return true;
    for (const still of this.checks) {
      let ok = false;
      try { ok = still() === true; } catch { ok = false; }
      if (!ok) { this.forgotten = true; return true; }
    }
    return false;
  }
}

/** Whether a picture turn may leave its frames in the process (else it retires, as before I-161 A). */
export function keepsGlances(turn: { frames: number; glanceOnly: boolean; inCall: boolean; held: HeldGlances | undefined; call: number; knobs: CallGlanceKnobs }): boolean {
  if (!turn.knobs.stays || !turn.glanceOnly || turn.frames <= 0) return false;
  if (!turn.inCall && turn.knobs.outside !== true) return false; // I-166: outside a call only with SEE_AND_SAY.keepOutsideCall
  const tag = glanceTag(turn.inCall, turn.call);
  if (turn.held && ((turn.held.call !== tag && turn.held.call !== OUTSIDE_CALL) || turn.held.stale())) return false;
  return (turn.held?.count ?? 0) + turn.frames <= turn.knobs.cap;
}

/** Whether a process holding small frames must be replaced now: the call ended (or another began), or a frame may no longer be seen. */
export function glancesMustGo(held: HeldGlances | undefined, inCall: boolean, call: number): boolean {
  if (!held || held.count <= 0) return false;
  if (held.stale()) return true;
  if (held.call === OUTSIDE_CALL) return false; // I-166: frames of no call go only by their checks
  return !inCall || held.call !== call;
}

/** Reads a turn's mark once, where its message is written. A failing mark counts as "not only small frames" (the process retires). */
export function readGlanceMark(mark: CallGlanceMark | undefined): { only: boolean; still: () => boolean } {
  if (!mark) return { only: false, still: () => false };
  try {
    const only = mark.glanceOnly() === true;
    return only ? { only, still: mark.still() } : { only: false, still: () => false };
  } catch { return { only: false, still: () => false }; }
}

/** The line for a process that holds earlier small frames ('' when it holds none or the mark fails). */
export function pastGlancesLine(held: HeldGlances | undefined, mark: CallGlanceMark | undefined, now: boolean): string {
  if (!held || held.count <= 0 || !mark) return '';
  try { return mark.past(now) || ''; } catch { return ''; }
}
