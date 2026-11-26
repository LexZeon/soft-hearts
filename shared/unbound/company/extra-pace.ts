/**
 * 三人同框别卡: how hard each full-screen page draws when
 * several characters are on stage. Every character is her own full-screen transparent window, so three of them draw three full-screen frames
 * sixty times a second even when two are only standing there. The one the user is with draws as she always did; an extra who is idle draws at
 * IDLE_FPS and one quality tier lower (the pixel ratio), and is back at full the very next frame the moment anything starts for her.
 *
 * Pure: no DOM. The page (src/unbound/company/stage-page.ts) feeds it once per animation frame; src/unbound/perf.ts applies the answer
 * (the frame-rate governor's cap, the renderer's pixel ratio). Alone on stage it always answers "full": the page is what it was.
 */

export const EXTRA_PACE_KNOBS = Object.freeze({
  /** An idle extra is drawn at most this many frames a second (the quiet rate the page already uses when nothing moves). */
  idleFps: 30,
  /**
   * An idle extra's pixel ratio goes one tier lower only after she has been idle this long (ms): resizing the canvas is the one costly step,
   * and a pause between two of her walking steps must not cost a resize each time. The frame rate drops at once; coming back is never delayed.
   */
  settleMs: 1_200,
});

/** What makes her "someone the user is with" besides being the last one clicked (closed names; each can only keep her at full rate). */
export const INVOLVEMENT_KINDS = ['focused', 'speaking', 'touched', 'walking', 'closing', 'dancing'] as const;
export type InvolvementKind = (typeof INVOLVEMENT_KINDS)[number];
export type Involvement = Readonly<Record<InvolvementKind, boolean>>;

/** The page's own reading of what she is doing now (everything but `focused`, which the stage tells). */
export type OwnInvolvement = Omit<Involvement, 'focused'>;

/** What a page asks for this frame: a frame-rate cap (null: none) and whether her pixel ratio is one tier lower. */
export interface PaceDecision { capFps: number | null; lowered: boolean; idle: boolean }
export const FULL_PACE: PaceDecision = Object.freeze({ capFps: null, lowered: false, idle: false });

/** She is with the user (or something of hers is going on): any one of them is enough. */
export const involvedIn = (involvement: Involvement): boolean => INVOLVEMENT_KINDS.some(kind => involvement[kind] === true);

export class ExtraPace {
  private idleSince: number | null = null;

  /** One animation frame. `present`: how many are on stage (fewer than two: always full). */
  step(now: number, present: number, involvement: Involvement, knobs = EXTRA_PACE_KNOBS): PaceDecision {
    if (present < 2 || involvedIn(involvement)) { this.idleSince = null; return FULL_PACE; }
    this.idleSince ??= now;
    return { capFps: knobs.idleFps, lowered: now - this.idleSince >= knobs.settleMs, idle: true };
  }
}
