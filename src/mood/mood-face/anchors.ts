/**
 * I-073 part 1 (docs/claude/how-to-tune-mood-face.md): the face from the mood's numbers, not from its name.
 *
 * A handful of typical states ("anchors"): calm at the centre, and content, close, happy, excited, concerned, disappointed,
 * longing, sad, tense-expectation each a little past the point where shared/foundation/mood.ts starts calling her that (so a state that
 * just earned the name already looks like it, as it did when the name picked the row). Each anchor's slider values are the
 * row the label used to pick (continuous-expression.ts TABLE), so the face is unchanged there; stronger states keep the
 * nearest anchor's look (nothing is extrapolated); below a threshold the face fades toward calm with the numbers. The face
 * reading (reading.ts) is blended over the anchors with a smooth kernel of its distance to each (kernel() below, radius
 * MOOD_FACE_KNOBS.anchorWidth, normalised): exactly at an anchor only that anchor counts, so the face there is what it was;
 * in between it moves smoothly with the numbers, never switching by the nearest name. Upset and relieved need an event context or a reunion, not numbers, so they are not
 * anchors; they (and every label) come in through the label style below. Afraid (I-076, 心情第二批) is the same kind: its numbers
 * (N, C up, E down) are concerned's unless a frightening cause is there (shared/foundation/mood.ts), and an anchor for it would sit within
 * anchorWidth of concerned (0.12 apart at its threshold); so its look (continuous-expression.ts TABLE: wide eyes, inner brows up,
 * the head a little back, no smile) comes in through the label share s, only while the label is 害怕.
 *
 * Label style: the current label (LabelBlend weights, drifting on a change) takes a share MOOD_FACE_KNOBS.labelStyle × s of
 * the weights, where s (0..1) is how far the reading is from calm; a label without an anchor (upset, relieved: the numbers
 * cannot tell them) takes s. Near calm the label adds nothing; at a clear mood it adds its own look. Everything here is
 * continuous in the reading and the label weights, so a label change never steps anything.
 */
import type { LabelWeight } from './label-blend';
import { MOOD_FACE_KNOBS } from './knobs';
import { FACE_AXES, emptyPoint, type FacePoint } from './reading';

export const ANCHOR_LABELS = ['calm', 'content', 'close', 'happy', 'excited', 'concerned', 'disappointed', 'longing', 'sad', 'tense-expectation'] as const;
export interface Anchor { label: string; point: FacePoint }
/**
 * Where each typical state sits: channel levels (50 = resting; unlisted = 50) and longing (0..100). Ours, chosen a few points
 * past the label rule's thresholds in getMoodSnapshot (shared/foundation/mood.ts): happy D ≥ 60 and E ≥ 55, close O ≥ 60 and E ≥ 50,
 * content E ≥ 60, excited D ≥ 75 and N ≥ 60, concerned / tense C ≥ 60 and N ≥ 60, disappointed D ≤ 40, longing 30+, sad 60+.
 */
export const ANCHOR_LEVELS: Readonly<Record<typeof ANCHOR_LABELS[number], { levels: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>>; longing?: number }>> = Object.freeze({
  calm: { levels: {} },
  content: { levels: { E: 63, N: 47, C: 45 } },
  close: { levels: { O: 63, E: 53, C: 45 } },
  happy: { levels: { D: 63, E: 58, O: 53 } },
  excited: { levels: { D: 78, N: 63, E: 58 } },
  concerned: { levels: { C: 63, N: 63, D: 45, E: 45 } },
  disappointed: { levels: { D: 37, E: 45 } },
  longing: { levels: { O: 55 }, longing: 38 },
  sad: { levels: { D: 42, E: 45 }, longing: 65 },
  'tense-expectation': { levels: { D: 78, C: 63, N: 70 } },
});
/** The anchors' places in the face's mood space ((level − 50) / 50; longing / 100). */
export const ANCHORS: readonly Anchor[] = Object.freeze(ANCHOR_LABELS.map(label => {
  const anchor = ANCHOR_LEVELS[label], point = emptyPoint();
  for (const axis of ['D', 'O', 'E', 'N', 'C'] as const) point[axis] = ((anchor.levels[axis] ?? 50) - 50) / 50;
  point.M = (anchor.longing ?? 0) / 100;
  return Object.freeze({ label, point: Object.freeze(point) as FacePoint });
}));
const ANCHORED: ReadonlySet<string> = new Set(ANCHOR_LABELS);
/** How far from calm counts as a clear mood (s = 1): about where the labels start (15 points on one channel). */
const CLEAR = 0.3;

const smoothstep = (value: number) => { const t = Math.min(1, Math.max(0, value)); return t * t * (3 - 2 * t); };
/**
 * The kernel: a smooth bump (1 − d²/R²)³ that is exactly 0 from R on (so at an anchor only that anchor counts: R is below
 * the distance from any anchor to the next), and where the bumps do not cover the reading, a floor (FLOOR in all, shared by
 * a softmax over the anchors' distances, σ = SPREAD) so a reading far from every anchor still blends the nearest ones
 * smoothly. The softmax is shifted by the nearest distance for range only (it cancels in the ratio), so everything is smooth.
 */
const FLOOR = 0.1, SPREAD = 0.1, MIN_SHARE = 1e-4;
const bump = (d2: number, radius: number) => { const r2 = Math.max(1e-6, radius * radius); return d2 < r2 ? (1 - d2 / r2) ** 3 : 0; };
const bumps = new Float64Array(ANCHOR_LABELS.length), floors = new Float64Array(ANCHOR_LABELS.length), kernels = new Float64Array(ANCHOR_LABELS.length);
const distance2 = (a: FacePoint, b: FacePoint) => { let sum = 0; for (const axis of FACE_AXES) { const d = a[axis] - b[axis]; sum += d * d; } return sum; };

/** How clear the mood is (0 at calm, 1 at 15 points away or more), smooth. */
export function moodStrength(point: FacePoint): number { return smoothstep(Math.sqrt(distance2(point, ANCHORS[0].point)) / CLEAR); }

/**
 * Weights over labels for this reading (sum 1): the anchors by the kernel, plus the label style. `labels` are the current
 * LabelBlend weights (null: no style). Writes into `out` (entry objects reused) and returns it.
 */
export function anchorWeights(point: FacePoint, labels: readonly LabelWeight[] | null, out: LabelWeight[] = [],
  style = MOOD_FACE_KNOBS.labelStyle, width = MOOD_FACE_KNOBS.anchorWidth): LabelWeight[] {
  let entries = spare.get(out);
  if (!entries) spare.set(out, entries = []);
  out.length = 0;
  const put = (label: string, weight: number) => {
    if (!(weight > 0)) return;
    for (let i = 0; i < out.length; i++) if (out[i].label === label) { out[i].weight += weight; return; }
    const entry = entries[out.length] ??= { label, weight };
    entry.label = label; entry.weight = weight; out.push(entry);
  };
  // Bumps first; the faint floor only where no bump covers the reading (it fades in as the bumps fade out, smoothly).
  let covered = 0;
  for (let i = 0; i < ANCHORS.length; i++) covered += bumps[i] = bump(distance2(point, ANCHORS[i].point), width);
  const open = (1 - Math.min(1, covered)) ** 3;
  // The floor is a softmax of −d² / 2σ² scaled to FLOOR in all: the nearest anchors share it, and it never vanishes far away.
  let near = Infinity;
  for (const anchor of ANCHORS) near = Math.min(near, distance2(point, anchor.point));
  let sum = 0;
  for (let i = 0; i < ANCHORS.length; i++) sum += floors[i] = Math.exp(-(distance2(point, ANCHORS[i].point) - near) / (2 * SPREAD * SPREAD));
  let total = 0;
  for (let i = 0; i < ANCHORS.length; i++) total += kernels[i] = bumps[i] + open * FLOOR * floors[i] / sum;
  // A share below MIN_SHARE is dropped (and the rest renormalised): a sad or calm face keeps its exact zeros (the drowsy and
  // eyelid rules wait for an exact 0); the step this can make is at most MIN_SHARE of a slider's range (invisible).
  let kept = 0;
  for (let i = 0; i < ANCHORS.length; i++) { if (kernels[i] < MIN_SHARE * total) kernels[i] = 0; kept += kernels[i]; }
  total = kept;
  // The label's share: labelStyle × s for a label that has an anchor; s for one the numbers cannot tell (upset, relieved).
  const strength = labels && labels.length ? moodStrength(point) : 0, own = Math.min(1, Math.max(0, style));
  let share = 0;
  if (strength > 0) for (const entry of labels!) share += entry.weight * strength * (ANCHORED.has(entry.label) ? own : 1);
  for (let i = 0; i < ANCHORS.length; i++) put(ANCHORS[i].label, (1 - share) * kernels[i] / total);
  if (strength > 0) for (const entry of labels!) put(entry.label, entry.weight * strength * (ANCHORED.has(entry.label) ? own : 1));
  return out;
}
/** Entry objects reused per output list (no allocation per frame once warm). */
const spare = new WeakMap<LabelWeight[], LabelWeight[]>();
