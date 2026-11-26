import type { LabelWeight } from '../mood';
import { MOOD_FACE_KNOBS } from '../mood';

/**
 * R36 continuous expression (docs/mood/procedural-expression-research.md):
 * the current mood becomes a subtle, continuous face instead of a carousel of
 * authored clips. Semantic slots only (model-profile.ts), so it works on any
 * model whose profile validated the slot; a missing slot is simply skipped by
 * the caller.
 *
 * - smile eyes / half lid (jitome when drowsy): lid shapes. They are requests to
 *   the eyelid compositor, which yields them to the natural blink.
 * - mouth smile: a mouth expression; the mouth compositor rule gives the mouth
 *   to lip-sync and feeding first.
 * - troubled / angry brows: through the brow rule (one shape per brow).
 * - blush: an amount for the procedural blush (or the model's own blush morph).
 * - head X: a tiny pitch, |x| <= 0.025 rad (positive = chin down).
 * - brow up (I-073): raised brows of eagerness (profile slot browUp), only where the mood is excited.
 * - eye wide (I-076 害怕, 心情第二批): wide eyes (profile slot surprise), only in the afraid look; it gives way to a blink like the
 *   E1 shows do (procedural-life.ts applies it times the open lids).
 *
 * I-073 (docs/claude/how-to-tune-mood-face.md): these are the universal face sliders. Each label's row below is the
 * look of one typical state; the stage blends the rows by how close the mood's numbers are to each state
 * (mood-face/anchors.ts), so the face follows the numbers. A slow drift on the same noise as the wobble keeps the
 * face from sitting frozen. Each face region follows at its own speed (MOOD_FACE_KNOBS.regions).
 *
 * Amounts are the research candidates' scale (subtle), times the card's
 * `intensity.expression` / 50, modulated by the mood channels and a slow
 * noise so the face never sits frozen. Every channel eases toward its target
 * with its region's time constants (rising / falling; the eyes 0.35 s / 0.5 s),
 * one step capped at 0.25 s, as the research's bounded smoothing specified.
 */

export interface ExpressionChannels {
  smileEyes: number;
  mouthSmile: number;
  sad: number;
  angry: number;
  jitome: number;
  blush: number;
  headX: number;
  browUp: number;
  eyeWide: number;
}
export const EXPRESSION_CHANNELS = Object.freeze(['smileEyes', 'mouthSmile', 'sad', 'angry', 'jitome', 'blush', 'headX', 'browUp', 'eyeWide'] as const);
export const emptyExpression = (): ExpressionChannels => ({ smileEyes: 0, mouthSmile: 0, sad: 0, angry: 0, jitome: 0, blush: 0, headX: 0, browUp: 0, eyeWide: 0 });
/** I-073: which face region each slider belongs to (its follow speed, MOOD_FACE_KNOBS.regions). */
export const EXPRESSION_REGION: Readonly<Record<keyof ExpressionChannels, keyof typeof MOOD_FACE_KNOBS.regions>> = Object.freeze({
  smileEyes: 'eyes', jitome: 'eyes', mouthSmile: 'mouth', sad: 'brows', angry: 'brows', browUp: 'brows', blush: 'blush', headX: 'head', eyeWide: 'eyes' });

/** Caps per channel (morph weights before profile calibration; head in rad). */
export const EXPRESSION_LIMITS: Readonly<ExpressionChannels> = Object.freeze({ smileEyes: 0.3, mouthSmile: 0.45, sad: 0.3, angry: 0.25, jitome: 0.35, blush: 0.25, headX: 0.025, browUp: 0.2, eyeWide: 0.2 });
/** The eyes' time constants (s); the other regions have their own (MOOD_FACE_KNOBS.regions). */
export const EXPRESSION_RISE = MOOD_FACE_KNOBS.regions.eyes[0];
export const EXPRESSION_FALL = MOOD_FACE_KNOBS.regions.eyes[1];
const MAX_STEP = 0.25;

type Row = readonly [smileEyes: number, mouthSmile: number, sad: number, angry: number, blush: number, headX: number, browUp?: number, eyeWide?: number];
/**
 * Full-intensity (expression 50) candidates per mood label; one table for every model. I-073: the look of each typical state
 * (mood-face/anchors.ts places them in the mood's numbers); browUp is new (only the eager states raise the brows).
 */
const TABLE: Readonly<Record<string, Row>> = Object.freeze({
  calm: [0, 0.06, 0, 0, 0, 0],
  close: [0.08, 0.15, 0, 0, 0.12, 0.006],
  content: [0.1, 0.18, 0, 0, 0.04, -0.004],
  happy: [0.12, 0.25, 0, 0, 0.05, -0.01],
  excited: [0.1, 0.32, 0, 0, 0.1, -0.015, 0.06],
  relieved: [0.08, 0.14, 0.04, 0, 0.04, 0],
  concerned: [0, 0, 0.16, 0, 0, 0.008],
  'tense-expectation': [0, 0.05, 0.08, 0, 0.04, -0.005, 0.04],
  disappointed: [0, 0, 0.18, 0, 0, 0.015],
  upset: [0, 0, 0.06, 0.1, 0, 0.005],
  longing: [0, 0.04, 0.1, 0, 0.03, 0.012],
  sad: [0, 0, 0.2, 0, 0, 0.018],
  // I-076 害怕 (心情第二批): wide eyes, the inner brows up (the troubled-brow slot), the head a little back (chin up), no smile, no blush.
  afraid: [0, 0, 0.12, 0, 0, -0.012, 0.04, 0.12],
});

/** Slow noise samples in [-1, 1]: the wobble (smile, brow, lid, blush) and, I-073, the drift per slider (same noise, slower). */
export interface ExpressionWobble {
  smile: number; brow: number; lid: number; blush: number;
  drift?: { face: number; headX: number };
}

export interface ExpressionMood {
  primary?: string;
  companion?: string | null;
  values?: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>>;
}
const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : 0;
const channel = (values: ExpressionMood['values'], key: 'D' | 'O' | 'E' | 'N' | 'C') => {
  const value = values?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? clamp((value - 50) / 50, -1, 1) : 0;
};

/**
 * Targets for one mood. `face` is intensity.expression / 50 (0..2), `drowsy`
 * 0..1, `blushScale` the card's blush intensity / 35 (0 when blush is off),
 * `wobble` four slow noise samples in [-1, 1] (smile, brow, lid, blush).
 * Writes into `out` (no allocation). `labels`: LabelBlend weights of the primary and the companion ('' = no companion);
 * the targets then drift between labels instead of switching rows on one frame (twitch round 3). One label at weight 1
 * gives exactly the unblended targets.
 */
export function expressionTargets(mood: ExpressionMood | null | undefined, face: number, drowsy: number, blushScale: number,
  wobble: ExpressionWobble, out: ExpressionChannels = emptyExpression(),
  labels?: { primary: readonly LabelWeight[]; companion: readonly LabelWeight[] }): ExpressionChannels {
  if (!labels) return labelTargets(mood?.primary ?? '', mood?.companion ?? null, mood, face, drowsy, blushScale, wobble, out);
  // Twitch round 3 (mood-face/label-blend.ts): while a label drifts, the targets are the weighted sum of each label's own.
  for (const key of EXPRESSION_CHANNELS) out[key] = 0;
  for (const p of labels.primary) for (const c of labels.companion) {
    const weight = p.weight * c.weight;
    if (!(weight > 0)) continue;
    labelTargets(p.label, c.label || null, mood, face, drowsy, blushScale, wobble, scratch);
    for (const key of EXPRESSION_CHANNELS) out[key] += weight * scratch[key];
  }
  // I-073 part 2: the slow drift. On the morphs it scales what is showing (a shape that is not showing stays exactly 0, which
  // the eyelid, brow and drowsy rules rely on); the head's tiny pitch drifts both ways.
  const drift = wobble.drift;
  if (drift) {
    const knobs = MOOD_FACE_KNOBS.drift, gain = 1 + knobs.face * clamp(drift.face, -1, 1);
    for (const key of ['smileEyes', 'mouthSmile', 'sad', 'angry', 'blush', 'browUp', 'eyeWide'] as const) out[key] = clamp(out[key] * gain, 0, EXPRESSION_LIMITS[key]);
    out.headX = clamp(out.headX + knobs.headX * clamp(face, 0, 2) * clamp(drift.headX, -1, 1), -EXPRESSION_LIMITS.headX, EXPRESSION_LIMITS.headX);
  }
  return out;
}
const scratch = emptyExpression();
function labelTargets(primary: string, companion: string | null, mood: ExpressionMood | null | undefined, face: number, drowsy: number, blushScale: number,
  wobble: ExpressionWobble, out: ExpressionChannels): ExpressionChannels {
  const row = TABLE[primary] ?? TABLE.calm;
  const comfort = channel(mood?.values, 'E'), reward = channel(mood?.values, 'D'), tension = Math.max(0, channel(mood?.values, 'C'));
  const scale = clamp(face, 0, 2), sleepy = clamp(drowsy, 0, 1), awake = 1 - 0.6 * sleepy;
  const warm = 1 + 0.25 * Math.max(0, comfort) + 0.15 * Math.max(0, reward) + (companion === 'playful' ? 0.1 : 0);
  const smile = scale * warm * awake * (1 + 0.12 * wobble.smile);
  out.smileEyes = clamp(row[0] * smile * (companion === 'comfortable' ? 1.15 : 1), 0, EXPRESSION_LIMITS.smileEyes);
  out.mouthSmile = clamp(row[1] * smile, 0, EXPRESSION_LIMITS.mouthSmile);
  const brow = scale * (1 + 0.4 * tension) * (1 + 0.12 * wobble.brow);
  out.sad = clamp((row[2] + (companion === 'wistful' ? 0.05 : 0)) * brow + 0.04 * sleepy * scale, 0, EXPRESSION_LIMITS.sad);
  out.angry = clamp(row[3] * brow, 0, EXPRESSION_LIMITS.angry);
  out.jitome = clamp(0.25 * sleepy * scale * (1 + 0.1 * wobble.lid), 0, EXPRESSION_LIMITS.jitome);
  out.blush = clamp(row[4] * scale * clamp(blushScale, 0, 2) * (1 + 0.15 * wobble.blush), 0, EXPRESSION_LIMITS.blush);
  out.headX = clamp((row[5] * scale + 0.018 * sleepy), -EXPRESSION_LIMITS.headX, EXPRESSION_LIMITS.headX);
  out.browUp = clamp((row[6] ?? 0) * scale * awake * (1 + 0.12 * wobble.brow), 0, EXPRESSION_LIMITS.browUp);
  out.eyeWide = clamp((row[7] ?? 0) * scale * awake * (1 + 0.1 * wobble.lid), 0, EXPRESSION_LIMITS.eyeWide);
  return out;
}

/** Bounded asymmetric smoothing of every channel toward its target, each face region at its own speed (MOOD_FACE_KNOBS.regions). */
export class ContinuousExpression {
  readonly value = emptyExpression();
  reset(): void { for (const key of EXPRESSION_CHANNELS) this.value[key] = 0; }
  frame(delta: number, target: ExpressionChannels): ExpressionChannels {
    const dt = Number.isFinite(delta) ? clamp(delta, 0, MAX_STEP) : 0;
    const v = this.value;
    for (const key of EXPRESSION_CHANNELS) v[key] = step(v[key], target[key], dt, MOOD_FACE_KNOBS.regions[EXPRESSION_REGION[key]], key === 'headX' ? HEAD_SETTLE : SETTLE);
    return v;
  }
}
/**
 * Twitch round 3: the head pitch settles to zero only below 1e-5 rad (0.0006°). The morphs' 1e-3 (a weight step nobody
 * sees) was a 0.057° one-frame step of the head when the mood's pitch went to 0 (happy → calm).
 */
const SETTLE = 1e-3, HEAD_SETTLE = 1e-5;
function step(current: number, target: number, dt: number, tau2: readonly [number, number], settle: number): number {
  const goal = Number.isFinite(target) ? target : 0;
  const tau = Math.abs(goal) > Math.abs(current) ? tau2[0] : tau2[1];
  const next = current + (goal - current) * (1 - Math.exp(-dt / tau));
  // Settle to an exact zero (below anything visible) so a yielded channel stops writing.
  return goal === 0 && Math.abs(next) < settle ? 0 : next;
}
