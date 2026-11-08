import type { MoodView } from '../../shared/mood-runtime';
import type { MoodCue } from '../../shared/mood';

/**
 * Who may take one accepted mood cue. In the app the opening choice decides (electron/inner-loop/opening-host.ts, I-020 #10):
 * her memorial invitation and R20 (off) are asked first, a speech cue then goes to what she picked — the screen chat, a sound
 * line, her small feeling or an invite (both through the inner loop), or nothing ('quiet'); while she is asleep nobody ('asleep').
 * The screen and sound entries only reserve the cue; their own engines act on it later in the same tick, and only on a cue the
 * choice gave them (proactiveVision.start, AmbientComments.observe).
 */
export const MOOD_CUE_CLAIMANTS = ['memorial', 'r20', 'vision', 'ambient', 'inner'] as const;
export type MoodCueClaimant = (typeof MOOD_CUE_CLAIMANTS)[number];
/** Who got the cue: one claimant, 'asleep' (she is asleep: nobody), or 'quiet' (she chose not to say anything this time). */
export type MoodCueOwner = MoodCueClaimant | 'asleep' | 'quiet';

/**
 * "睡着不说" for every claimant (docs/claude/2026-11-04-quiet-when-asleep.md): the inner loop's own reading of her sleep
 * and its silent end of a speech cue (InnerLoop.asleep / InnerLoop.silence).
 */
export interface MoodCueSleep {
  /** Fatigue phase asleep or micro-awake. */
  asleep(): boolean;
  /** The speech cue she slept through: its quota returns, it is recorded as 睡着. Never a model call or a capture. */
  silence(cue: MoodCue): unknown;
}

/**
 * The old fixed order (memorial → R20 → screen → sound → inner loop), first that wants it takes it. The app no longer uses it
 * (#10: she picks, opening-host.ts); it stays for harnesses with a single claimant and for the "old" arm of the frequency
 * comparison (tests/opening-choice-frequency.test.ts). Asleep, a speech cue goes to nobody, as in the app.
 */
export function claimMoodCue(cue: MoodCue | null | undefined,
  claimants: Partial<Record<MoodCueClaimant, (cue: MoodCue) => boolean>>,
  /** A claimant that already owns this cue keeps it on later publishes (the cue lives a few seconds). */
  held?: (cue: MoodCue) => MoodCueClaimant | null,
  /** While she is asleep no claimant is asked about a speech cue: no memorial invitation, no screen capture, no listen line, no model call. */
  sleep?: MoodCueSleep | null): MoodCueOwner | null {
  if (!cue) return null;
  try { const owner = held?.(cue); if (owner && MOOD_CUE_CLAIMANTS.includes(owner)) return owner; } catch { /* Fall back to the ordered pass. */ }
  let asleep = false;
  try { asleep = cue.kind === 'speech' && sleep?.asleep() === true; } catch { asleep = false; }
  if (asleep) {
    try { sleep!.silence(cue); } catch { /* Nobody speaks either way; at worst the quota stays charged. */ }
    return 'asleep';
  }
  for (const name of MOOD_CUE_CLAIMANTS) {
    const claim = claimants[name];
    let taken = false;
    try { taken = !!claim && claim(cue) === true; } catch { taken = false; }
    if (taken) return name;
  }
  return null;
}

/**
 * What the renderer and the audio comment engines (electron/main.ts ambientComments.observe) see after the claim. A memorial
 * or R20 cue is hidden as it is; the inner loop's, one she slept through and one she chose to let pass also drop what the cue
 * started (withoutClaimedCue), so no face reaction or listen line follows it.
 */
export function claimedView(view: MoodView, owner: MoodCueOwner | null, host?: { cueHidden(cueId: string): void } | null): MoodView {
  if (owner === 'memorial' || owner === 'r20') return { ...view, snapshot: { ...view.snapshot, cue: null } };
  return owner === 'inner' || owner === 'asleep' || owner === 'quiet' ? withoutClaimedCue(view, host) : view;
}

/**
 * The renderer must not show a cue the inner loop owns: no rule motion, no face reaction, no idle gesture.
 * `owner` (the MoodHost) is told, so what it picked for the cue is never remembered as shown (#11, shared/behaviors/idle-gesture/).
 */
export function withoutClaimedCue(view: MoodView, owner?: { cueHidden(cueId: string): void } | null): MoodView {
  const cue = view.snapshot.cue;
  if (!cue) return view;
  try { owner?.cueHidden(cue.id); } catch { /* Bookkeeping only; the cue is hidden either way. */ }
  const reaction = view.behavior?.reaction ?? null;
  const fromCue = !!reaction && reaction.stateKey.startsWith(`reaction:${cue.id}:`);
  const { idleGesture, ...rest } = view;
  return { ...rest, snapshot: { ...view.snapshot, cue: null },
    ...(idleGesture && idleGesture.cueId !== cue.id ? { idleGesture } : {}),
    ...(view.behavior ? { behavior: { ...view.behavior, reaction: fromCue ? null : reaction } } : {}) };
}
