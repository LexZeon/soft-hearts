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
 *
 * Amounts are the research candidates' scale (subtle), times the card's
 * `intensity.expression` / 50, modulated by the mood channels and a slow
 * noise so the face never sits frozen. Every channel eases toward its target
 * with time constants 0.35 s (rising) and 0.5 s (falling), one step capped
 * at 0.25 s, as the research's bounded smoothing specified.
 */

export interface ExpressionChannels {
  smileEyes: number;
  mouthSmile: number;
  sad: number;
  angry: number;
  jitome: number;
  blush: number;
  headX: number;
}
export const EXPRESSION_CHANNELS = Object.freeze(['smileEyes', 'mouthSmile', 'sad', 'angry', 'jitome', 'blush', 'headX'] as const);
export const emptyExpression = (): ExpressionChannels => ({ smileEyes: 0, mouthSmile: 0, sad: 0, angry: 0, jitome: 0, blush: 0, headX: 0 });

/** Caps per channel (morph weights before profile calibration; head in rad). */
export const EXPRESSION_LIMITS: Readonly<ExpressionChannels> = Object.freeze({ smileEyes: 0.3, mouthSmile: 0.45, sad: 0.3, angry: 0.25, jitome: 0.35, blush: 0.25, headX: 0.025 });
export const EXPRESSION_RISE = 0.35;
export const EXPRESSION_FALL = 0.5;
const MAX_STEP = 0.25;

type Row = readonly [smileEyes: number, mouthSmile: number, sad: number, angry: number, blush: number, headX: number];
/** Full-intensity (expression 50) candidates per mood label; one table for every model. */
const TABLE: Readonly<Record<string, Row>> = Object.freeze({
  calm: [0, 0.06, 0, 0, 0, 0],
  close: [0.08, 0.15, 0, 0, 0.12, 0.006],
  content: [0.1, 0.18, 0, 0, 0.04, -0.004],
  happy: [0.12, 0.25, 0, 0, 0.05, -0.01],
  excited: [0.1, 0.32, 0, 0, 0.1, -0.015],
  relieved: [0.08, 0.14, 0.04, 0, 0.04, 0],
  concerned: [0, 0, 0.16, 0, 0, 0.008],
  'tense-expectation': [0, 0.05, 0.08, 0, 0.04, -0.005],
  disappointed: [0, 0, 0.18, 0, 0, 0.015],
  upset: [0, 0, 0.06, 0.1, 0, 0.005],
  longing: [0, 0.04, 0.1, 0, 0.03, 0.012],
  sad: [0, 0, 0.2, 0, 0, 0.018],
});

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
 * Writes into `out` (no allocation).
 */
export function expressionTargets(mood: ExpressionMood | null | undefined, face: number, drowsy: number, blushScale: number,
  wobble: { smile: number; brow: number; lid: number; blush: number }, out: ExpressionChannels = emptyExpression()): ExpressionChannels {
  const row = TABLE[mood?.primary ?? ''] ?? TABLE.calm;
  const comfort = channel(mood?.values, 'E'), reward = channel(mood?.values, 'D'), tension = Math.max(0, channel(mood?.values, 'C'));
  const scale = clamp(face, 0, 2), sleepy = clamp(drowsy, 0, 1), awake = 1 - 0.6 * sleepy;
  const companion = mood?.companion ?? null;
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
  return out;
}

/** Bounded asymmetric smoothing of every channel toward its target (0.35 s up, 0.5 s down). */
export class ContinuousExpression {
  readonly value = emptyExpression();
  reset(): void { for (const key of EXPRESSION_CHANNELS) this.value[key] = 0; }
  frame(delta: number, target: ExpressionChannels): ExpressionChannels {
    const dt = Number.isFinite(delta) ? clamp(delta, 0, MAX_STEP) : 0;
    const v = this.value;
    v.smileEyes = step(v.smileEyes, target.smileEyes, dt); v.mouthSmile = step(v.mouthSmile, target.mouthSmile, dt);
    v.sad = step(v.sad, target.sad, dt); v.angry = step(v.angry, target.angry, dt); v.jitome = step(v.jitome, target.jitome, dt);
    v.blush = step(v.blush, target.blush, dt); v.headX = step(v.headX, target.headX, dt);
    return v;
  }
}
function step(current: number, target: number, dt: number): number {
  const goal = Number.isFinite(target) ? target : 0;
  const tau = Math.abs(goal) > Math.abs(current) ? EXPRESSION_RISE : EXPRESSION_FALL;
  const next = current + (goal - current) * (1 - Math.exp(-dt / tau));
  // Settle to an exact zero (below anything visible) so a yielded channel stops writing.
  return goal === 0 && Math.abs(next) < 1e-3 ? 0 : next;
}
