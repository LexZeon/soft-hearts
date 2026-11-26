/**
 * I-175 step 4 (docs/claude/2026-11-22-i175-part-mixer.md; plan "眼皮"、"头"): the eyelids' one ceiling and the head's one order, for the
 * Unbound engine (the companion window and full-screen share the figure). Pure: numbers in, numbers out.
 *
 * Eyelids. The smile eyes (笑い), the half lid (じと目) and the blink (まばたき) are separate morphs, and on many models (Gene among them) they
 * move the same lid vertices: written side by side, a smile plus a blink closes past shut (the lid sinks under the eye). The old stage has
 * a rule for this (src/stage/channel-compositors.ts EyelidCompositor `sharedClosure`: the blink is capped by the closure the shapes already
 * show on the same vertices); this is that rule, not that code: on a model whose lid shapes overlap the blink, the blink gets only what the
 * shapes leave under the ceiling (knobs.lidCeiling, 1 = exactly shut), so the shapes and the blink together shut the eye and never pass it.
 * Unlike the old stage the shapes do not dip for a natural blink: they stay eased (the window's rule that every expression morph eases; a
 * crisp 70 ms blink would make them jump). On a model whose shapes do not overlap the blink (`overlap` false) nothing is capped (no gap
 * between the lids: the old stage's 2026-11-19 pat fix).
 *
 * Head. Who holds her head, top first (HEAD_ORDER): where she looks (the eye-head coordinator turns the head toward it), a nod or a beat's
 * tilt (deliberate: added on top), talk-calm (I-170: while you talk the idle's own head sway is calmed), the idle's own sway (lowest). The
 * last two scale the idle's head only: `idleHeadScale` = talk-calm's factor, times less while a deliberate head action holds the head
 * (`headHeld`, from the face's head offset), so a nod or a tilt never fights her idle drift and the drift eases back when it ends. Both
 * modes lay the face's goals with ../../../src/unbound/her/face-goals.ts and the idle with src/unbound/motion/unbound-idle.ts, so one order.
 */
import { PART_MIX_KNOBS, type PartMixKnobs } from './knobs';

const clamp01 = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const smoothstep = (value: number) => { const t = clamp01(value); return t * t * (3 - 2 * t); };

/** What the lids show: the blink morph and the two lid shapes, under one ceiling. */
export interface LidValues { readonly blink: number; readonly smileEyes: number; readonly jitome: number }

/**
 * The lids under the ceiling. `closure`: everything asked of the blink morph this frame (a natural blink, a held or soft closure, an
 * expression's closed eyes); `smileEyes`, `jitome`: the lid shapes asked (passed through, at most the ceiling). `overlap` (default true): the
 * shapes move the blink's vertices; then the blink gets at most what they leave under the ceiling, so blink + max(shapes) ≤ ceiling.
 */
export function lidsUnderCeiling(closure: number, smileEyes: number, jitome: number, knobs: PartMixKnobs = PART_MIX_KNOBS, out?: { blink: number; smileEyes: number; jitome: number },
  overlap = true): LidValues {
  const ceiling = clamp01(knobs.lidCeiling), c = clamp01(closure);
  const smile = Math.min(ceiling, clamp01(smileEyes)), half = Math.min(ceiling, clamp01(jitome));
  const blink = overlap ? Math.min(c, ceiling - Math.max(smile, half)) : Math.min(c, ceiling);
  const result = out ?? { blink: 0, smileEyes: 0, jitome: 0 };
  result.blink = Math.max(0, blink); result.smileEyes = smile; result.jitome = half;
  return result;
}

/** Who holds her head, top first: the first ones own it, the last ones yield (see the file comment). */
export const HEAD_ORDER = ['gaze', 'nod', 'beatTilt', 'talkCalm', 'idleSway'] as const;
export type HeadHolder = typeof HEAD_ORDER[number];

/** How much a deliberate head action (a nod, a beat's tilt: the face's head offset, rad) holds her head now (0..1, continuous). */
export function headHeld(head: { pitch: number; yaw: number; roll: number } | null | undefined, knobs: PartMixKnobs = PART_MIX_KNOBS): number {
  if (!head) return 0;
  const size = Math.hypot(Number.isFinite(head.pitch) ? head.pitch : 0, Number.isFinite(head.yaw) ? head.yaw : 0, Number.isFinite(head.roll) ? head.roll : 0);
  return smoothstep(size / (knobs.headHeldRad > 0 ? knobs.headHeldRad : 0.08));
}

/** The idle's own head sway this frame: talk-calm's factor (I-170), and less while a deliberate head action holds the head (never 0). */
export function idleHeadScale(calm: number, held: number, knobs: PartMixKnobs = PART_MIX_KNOBS): number {
  const keep = clamp01(knobs.idleUnderHeld);
  return clamp01(calm) * (1 - clamp01(held) * (1 - keep));
}
