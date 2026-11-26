/**
 * The one interruption arbiter of full-screen Unbound.
 *
 * Every action kind declares which causes end it (ACTION_ENDS); every input is classified once (pressSize for a press on her, the host's
 * interaction names for the rest) and then only `endsAction` is asked, on the page and on the host alike. What never ends anything:
 *   pointer  the mouse moving (over her or anywhere)
 *   wheel    the wheel while she is doing something (it is a pull in steps only when she is free)
 *   tug      a press or pull on her smaller than ACTION_END_KNOBS.largePullPx from the press point: her body, hair and clothes give a little
 *            (the existing pull's body layer, bounded), the action goes on from there
 *   typing   you typing, to her or anywhere
 *   keys     key or mouse input as the computer's idle time reads it (that "you went on working" back-off is gone)
 * What may end an action (per kind below): a large pull (it then hands over to the pull exactly as it works today), a click on her (her
 * attention: she pauses and turns to you — but never for kiss, hug and the look, the close family), a game starting (a new action of hers),
 * and for her own small things the conversation taking her (a call, you waiting for her, her reply, her reading aloud) as before.
 * The ends that are not your input stay where they are: the action's own end (the hold she decided), a new action of hers, sleep, the app
 * hiding her, a full-screen program, the host's timeout.
 * Pure.
 */
import { ACTION_END_KNOBS, type ActionEndKnobs } from './knobs';

/** What she can be doing. kiss / hug / look: the close family (I-184, I-185, I-192: the peek is its look). */
export const ACTION_KINDS = ['kiss', 'hug', 'look', 'walk', 'life', 'beat', 'opening', 'act'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
/** Everything that might end one (the host's interaction names, shared/unbound/life/arbiter.ts LifeInteraction, are a subset). */
export const END_CAUSES = ['pointer', 'wheel', 'tug', 'pull', 'click', 'typing', 'keys', 'call', 'play', 'waiting', 'reply', 'reading'] as const;
export type EndCause = (typeof END_CAUSES)[number];
/** The causes that are you acting on her directly: when one of them ends an action, she is told next turn and it is journaled. */
export const USER_END_CAUSES = ['pull', 'click'] as const;
export type UserEndCause = (typeof USER_END_CAUSES)[number];

const CLOSE: readonly EndCause[] = Object.freeze(['pull', 'play']);
/** Per kind, the causes that end it. Anything not listed never does. */
export const ACTION_ENDS: Readonly<Record<ActionKind, readonly EndCause[]>> = Object.freeze({
  kiss: CLOSE, hug: CLOSE, look: CLOSE,
  /** I-193 a walk she chose: as before (her reply, her reading, a call and you typing never stop it). */
  walk: Object.freeze(['pull', 'click', 'play'] as EndCause[]),
  /** Her own small things: as before, minus typing (you typing to her no longer stops her; sending it does: 'waiting'). */
  life: Object.freeze(['pull', 'click', 'play', 'call', 'waiting', 'reply', 'reading'] as EndCause[]),
  /** Her reply's beats, the opening beat before she speaks, the preview's acts: only a large pull. */
  beat: Object.freeze(['pull'] as EndCause[]), opening: Object.freeze(['pull'] as EndCause[]), act: Object.freeze(['pull'] as EndCause[]),
});

/** Does this cause end that action? (null or unknown: no.) */
export function endsAction(kind: ActionKind, cause: string | null | undefined): boolean {
  return !!cause && (ACTION_ENDS[kind] ?? []).includes(cause as EndCause);
}
export const isUserEndCause = (cause: unknown): cause is UserEndCause => (USER_END_CAUSES as readonly unknown[]).includes(cause);

/**
 * A press on her, `dx`, `dy` window pixels from where it went down: 'tug' (small: the action goes on, her body gives a little) or 'pull'
 * (large: it ends the action and becomes the pull). Not finite: 'tug'.
 */
export function pressSize(dx: number, dy: number, knobs: ActionEndKnobs = ACTION_END_KNOBS): 'tug' | 'pull' {
  const d = Math.hypot(dx, dy);
  return Number.isFinite(d) && d >= knobs.largePullPx ? 'pull' : 'tug';
}

/**
 * Where a tug may take the pointer the body follows: the point clamped to just inside the large radius around the press point, so the body
 * layer's give stays bounded (it never shows more than a tug of that size). Window pixels. (The point the body layer is handed: tugTarget.)
 */
export function tugPoint(anchor: { x: number; y: number }, at: { x: number; y: number }, knobs: ActionEndKnobs = ACTION_END_KNOBS): { x: number; y: number } {
  const dx = at.x - anchor.x, dy = at.y - anchor.y, d = Math.hypot(dx, dy), max = knobs.largePullPx * 0.999;
  if (!Number.isFinite(d) || d <= max) return Number.isFinite(d) ? { x: at.x, y: at.y } : { ...anchor };
  return { x: anchor.x + dx / d * max, y: anchor.y + dy / d * max };
}

/**
 * The point the pull's body layer is handed for a tug (window pixels): the clamped tug, measured in her height rather than in pixels, so a full
 * small tug moves the grabbed spot by `tugShare` of her height however near she is (`heightPx`: her height on the window at the press). Never
 * less than the pointer itself (far away it is the pull's own 1 : 1).
 */
export function tugTarget(anchor: { x: number; y: number }, at: { x: number; y: number }, heightPx: number, knobs: ActionEndKnobs = ACTION_END_KNOBS): { x: number; y: number } {
  const held = tugPoint(anchor, at, knobs);
  const gain = Number.isFinite(heightPx) && heightPx > 0 ? Math.max(1, knobs.tugShare * heightPx / knobs.largePullPx) : 1;
  return { x: anchor.x + (held.x - anchor.x) * gain, y: anchor.y + (held.y - anchor.y) * gain };
}
