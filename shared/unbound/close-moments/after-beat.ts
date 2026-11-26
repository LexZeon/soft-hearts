/**
 * I-184: what she does right after a kiss or a hug (about "之后可能害羞一下": "按性格定"). Decided by her character (the
 * card's mood template: weights and intensity) with her mood: a shy, cautious character blushes and looks away; a bold,
 * playful one grins or winks; a warm, comfortable one looks pleased; a reserved one with little expression acts as if nothing happened.
 * Never one fixed beat for everyone. Pure; the caller hands in the random number.
 */
import type { MoodReading } from '../director';
import type { MoodLabel } from '../../foundation/mood';
import { closeReading, pickFrom, NEUTRAL_TEMPERAMENT, type CloseTemperament } from './chooser';

export const AFTER_BEATS = ['shy', 'grin', 'wink', 'pleased', 'cool'] as const;
export type AfterBeat = (typeof AFTER_BEATS)[number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const over = (w: number) => Math.max(0, Math.min(1.5, (Number.isFinite(w) ? w : 1) - 1));
const under = (w: number) => Math.max(0, Math.min(1, 1 - (Number.isFinite(w) ? w : 1)));

/** The chances of each beat (sum 1). */
export function afterBeatChances(input: { mood: MoodReading; label: MoodLabel | null; temperament?: CloseTemperament }): Record<AfterBeat, number> {
  const t = input.temperament ?? NEUTRAL_TEMPERAMENT, r = closeReading(input.mood, input.label, t);
  const w = t.weights, expression = clamp01(t.intensity.expression / 100), playful = clamp01(t.intensity.playful / 100);
  const flat = clamp01((45 - t.intensity.expression) / 35); // little expression: she keeps a straight face
  const raw: Record<AfterBeat, number> = {
    shy: 0.3 + 0.5 * over(w.cautious) + 0.3 * (1 - r.boldness) + 0.25 * r.tension + (input.label === 'close' ? 0.1 : 0),
    grin: 0.05 + 0.7 * r.boldness * playful + 0.4 * over(w.playful),
    wink: 0.02 + 0.6 * over(w.playful) * expression + 0.3 * clamp01((playful - 0.6) / 0.4) * expression,
    pleased: 0.29 + 0.45 * r.warmth * (0.5 + 0.5 * clamp01((w.close + w.comfortable) / 3)),
    cool: 0.03 + 0.9 * flat + 0.3 * under(w.playful) * flat,
  };
  // Expression scales how much any visible beat shows over a straight face.
  for (const beat of ['shy', 'grin', 'wink', 'pleased'] as const) raw[beat] *= 0.4 + 0.6 * clamp01(expression + 0.2);
  const total = AFTER_BEATS.reduce((sum, beat) => sum + raw[beat], 0);
  return Object.fromEntries(AFTER_BEATS.map(beat => [beat, raw[beat] / total])) as Record<AfterBeat, number>;
}

export function chooseAfterBeat(input: Parameters<typeof afterBeatChances>[0], random: number): AfterBeat {
  return pickFrom(afterBeatChances(input), AFTER_BEATS, random);
}

/** The beat in a few words, for her next turn's line (facts only, no instruction). */
export const AFTER_BEAT_WORDS: Readonly<Record<AfterBeat, string>> = Object.freeze({
  shy: '红着脸别开了眼睛', grin: '笑了笑', wink: '冲用户眨了眨眼', pleased: '一脸满足', cool: '装作什么都没发生',
});
