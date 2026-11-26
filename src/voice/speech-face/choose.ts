import { SPEECH_FACE_KNOBS } from './knobs';
import { RECIPES, type Variant } from './recipes';
import type { SpeechIntent } from './intent-table';

/**
 * I-073 part 3, layer 3 ("她来挑"): whether she does it, how big, and which variant, inside the recipe's ranges.
 *
 * Read from her mood as the six hormone-inspired channels (handbook/how-we-work.md "心情相关的事，按六种激素来想"), each
 * relative to the card's own baseline (±50 points = ±1), never as absolute numbers or mood names:
 *  - N 去甲肾上腺素 (activation and alertness), read together with the others (SPEECH_FACE_KNOBS.hormones.N, a data table):
 *    with D up → livelier, more and bigger accents; with C up and E not → tense, startled: fewer playful picks, no smile-eye
 *    or blush flourishes, tenser brows; alone → alert, attentive (a little more often). Never "N = excitement" by itself;
 *  - A 腺苷 via fatigue (F in drowsy phases, as procedural life reads it) → fewer and smaller; asleep → none;
 *  - O 催产素 (closeness): warmer picks (smile eyes, the shy blush) more likely;
 *  - C 皮质醇 (stress): fewer playful picks (the happy tilt, the question's playful tilt), tenser brows more likely;
 *  - D 多巴胺 (reward): happy clauses more likely acted on, a smile on an affirmation more likely;
 *  - E 内啡肽 (comfort): softer: a little smaller, a little slower, the slow/soft variants preferred.
 * The card's tendencies (I-037 dispositions, 0..100) shift the same: lively more, restrained less (quiet characters skip
 * more), volatile bigger, shy blushes more, clingy warmer. Never the same variant twice in a row in a family (I-013).
 * Pure: the random source is passed in (seeded in the stage, injectable in tests).
 */
export interface HormoneTemper {
  /** Each (value − baseline) / 50, clamped to [-1, 1]. */
  readonly D: number; readonly O: number; readonly E: number; readonly N: number; readonly C: number;
  /** 0..1 sleep pressure as shown (A through fatigue F and its phase); 1 = asleep. */
  readonly sleepy: number;
}
export interface DispositionTemper { readonly lively: number; readonly restrained: number; readonly volatile: number; readonly shy: number; readonly clingy: number }
export const NEUTRAL_TEMPER: HormoneTemper = Object.freeze({ D: 0, O: 0, E: 0, N: 0, C: 0, sleepy: 0 });
export const NEUTRAL_DISPOSITIONS: DispositionTemper = Object.freeze({ lively: 50, restrained: 50, volatile: 50, shy: 50, clingy: 50 });

type Values = Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>>;
const clamp = (x: number, lo: number, hi: number) => Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : 0;
/** Mood numbers relative to the card's baseline (missing baseline: 50) and the fatigue as procedural life reads it. */
export function hormoneTemper(values: Values | null | undefined, baseline: Values | null | undefined, fatigue: { phase?: string; F?: number; sleeping?: boolean } | null | undefined): HormoneTemper {
  const rel = (key: 'D' | 'O' | 'E' | 'N' | 'C') => {
    const value = values?.[key], base = baseline?.[key];
    return typeof value === 'number' ? clamp((value - (typeof base === 'number' && Number.isFinite(base) ? base : 50)) / 50, -1, 1) : 0;
  };
  const phase = fatigue?.phase, F = clamp(fatigue?.F ?? 0, 0, 1);
  const sleepy = fatigue?.sleeping || phase === 'falling-asleep' || phase === 'asleep' || phase === 'micro-awake' ? 1 : phase === 'drowsy' ? F : phase === 'light-drowsy' ? F * 0.5 : 0;
  return { D: rel('D'), O: rel('O'), E: rel('E'), N: rel('N'), C: rel('C'), sleepy };
}

export interface Choice {
  readonly variant: Variant;
  /** In slider units (face, blush) or radians (head). */
  readonly amp: number;
  /** Envelope time scale (1 = as written; > 1 slower). */
  readonly timeScale: number;
  /** For a tilt: which way (+1 / −1). */
  readonly side: number;
}
export type Skip = 'calm' | 'unclear' | 'no-variant' | 'unavailable' | 'chance' | 'asleep';

const pos = (x: number) => Math.max(0, x);
const disp = (value: number) => clamp((value - 50) / 50, -1, 1);

/** N's effect right now: its rise above her baseline, shared out by what rises with it (D; C over E; alone). */
export function arousalEffect(t: HormoneTemper): { often: number; size: number; playful: number; warm: number; tense: number } {
  const table = SPEECH_FACE_KNOBS.hormones.N, n = pos(t.N);
  const d = pos(t.D), c = pos(t.C - pos(t.E)), alone = table.aloneShare, total = d + c + alone;
  const mix = (key: 'often' | 'size' | 'playful' | 'warm' | 'tense') => n * (d * table.withD[key] + c * table.withC[key] + alone * table.alone[key]) / total;
  return { often: mix('often'), size: mix('size'), playful: mix('playful'), warm: mix('warm'), tense: mix('tense') };
}

/** How much more (or less) often and how much bigger she accents right now (both > 0). */
export function temperGains(t: HormoneTemper, d: DispositionTemper): { often: number; size: number } {
  const h = SPEECH_FACE_KNOBS.hormones, k = SPEECH_FACE_KNOBS.dispositions;
  const n = arousalEffect(t);
  const often = (1 + n.often) * (1 + h.sleepy.often * t.sleepy) * (1 + k.lively.often * disp(d.lively)) * (1 + k.restrained.often * disp(d.restrained))
    * (1 + k.volatile.often * disp(d.volatile));
  const size = (1 + n.size) * (1 + h.sleepy.size * t.sleepy) * (1 + h.E.size * pos(t.E)) * (1 + k.lively.size * disp(d.lively))
    * (1 + k.restrained.size * disp(d.restrained)) * (1 + k.volatile.size * disp(d.volatile));
  return { often: clamp(often, 0, 3), size: clamp(size, 0.3, 1.6) };
}

/**
 * One family's pick for one clause: null with a reason when she lets it pass. `available(slider)` says whether this model
 * has the slider (missing ones are skipped before she picks, so a model without raised brows still nods). `last`: the
 * variant id this family showed last (never the same twice in a row when another is possible).
 */
export function choose(intent: SpeechIntent, weight: number, family: Variant['family'], temper: HormoneTemper, dispositions: DispositionTemper,
  random: () => number, available: (slider: Variant['slider']) => boolean, last: string | null, options: { always?: boolean } = {}): Choice | Skip {
  if (intent === 'calm') return 'calm';
  if (temper.sleepy >= 1) return 'asleep';
  const knobs = SPEECH_FACE_KNOBS, h = knobs.hormones;
  if (!options.always && weight < knobs.choice.minWeight) return 'unclear';
  let pool = RECIPES[intent].filter(item => item.family === family);
  if (!pool.length) return 'no-variant';
  pool = pool.filter(item => available(item.slider));
  if (!pool.length) return 'unavailable';
  if (pool.length > 1 && last) { const rest = pool.filter(item => item.id !== last); if (rest.length) pool = rest; }
  const gains = temperGains(temper, dispositions), n = arousalEffect(temper);
  const warm = Math.max(0.05, (1 + h.O.warm * pos(temper.O)) * (1 + knobs.dispositions.clingy.warm * pos(disp(dispositions.clingy))) * (1 + n.warm));
  const playful = Math.max(0.05, (1 + h.C.playful * pos(temper.C)) * (1 + n.playful));
  // The chance: the family's base, how clear the clause is, her temper, and the hormones that speak for this intent.
  let chance = (family === 'face' ? knobs.choice.face : family === 'head' ? knobs.choice.head : knobs.choice.blush) * Math.min(1, weight / 0.8) * gains.often;
  if (intent === 'happy') chance *= (1 + h.D.happy * pos(temper.D)) * playful;
  if (family === 'blush') chance *= warm * (1 + knobs.dispositions.shy.blush * disp(dispositions.shy));
  if (intent === 'affirm' && family === 'face') chance *= 1 + h.D.smile * pos(temper.D);
  // N with C (tense, startled): the smile-eye and blush flourishes give way.
  if (family === 'blush' || family === 'face' && (intent === 'happy' || intent === 'shy' || intent === 'affirm')) chance *= Math.min(1, Math.max(0, 1 + n.warm));
  if (!options.always && !(random() < clamp(chance, 0, 0.95))) return 'chance';
  // Which variant: weights leaned by the hormones (O warm, C playful/tense, E soft/slow).
  const weights = pool.map(item => {
    let w = item.weight ?? 1;
    if (item.lean === 'warm') w *= warm;
    if (item.lean === 'playful') w *= playful;
    if (item.lean === 'tense') w *= (1 + h.C.tense * pos(temper.C)) * (1 + n.tense);
    if (item.style === 'slow' || item.style === 'soft') w *= 1 + h.E.soft * pos(temper.E);
    if (item.style === 'double') w *= Math.max(0.1, 1 + disp(dispositions.lively));
    return w;
  });
  let roll = random() * weights.reduce((a, b) => a + b, 0), index = 0;
  while (index < pool.length - 1 && roll >= weights[index]) { roll -= weights[index]; index++; }
  const variant = pool[index];
  const [lo, hi] = variant.amp, where = clamp(0.5 + 0.35 * (random() - 0.5) + n.size, 0, 1);
  const amount = (lo + (hi - lo) * where) * gains.size * clamp(0.75 + 0.25 * weight, 0.5, 1);
  const head = variant.family === 'head';
  return Object.freeze({ variant, amp: head ? amount * Math.PI / 180 : amount, timeScale: 1 + h.E.slow * pos(temper.E), side: random() < 0.5 ? -1 : 1 });
}
