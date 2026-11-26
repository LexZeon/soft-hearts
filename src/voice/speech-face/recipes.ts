import type { SpeechIntent } from './intent-table';

/**
 * I-073 part 3, layer 2 data ("配方"): which universal slider an intent moves, how much, and how it rises and falls.
 * Adding an expression = adding a row (or a variant), never a code branch.
 *
 * - family: 'face' = one eye/brow slider per event (smile eyes, raised brows or a slight squint; never two at once);
 *   'head' = a nod (head pitch) or a tilt (head roll) through the universal skeleton's head; 'blush' = the cheeks.
 *   The mouth and jaw are not here on purpose: they belong to lip-sync (hard rule 1).
 * - amp: [low, high] of the slider (0..1) or of the angle (degrees); she picks inside it (choose.ts), the hard caps still win.
 * - keys: the envelope as key poses [seconds, value 0..1 of amp] (negative = a small anticipation or follow-through the
 *   other way). Between two keys the value moves along a smootherstep, so it starts and stops every segment at zero speed:
 *   keyframe animation, never a jump. The largest key is the accent: it lands on the voice's stress.
 * - style: what kind of variant it is, for her temper to prefer ('quick', 'slow', 'double', 'soft'); 'sides' for a tilt.
 * - at: 'peak' = on a loud point inside the clause (the default); 'boundary' = in the real pause after the clause (a nod
 *   that closes a sentence). Without audio both become the clause's start, gentler.
 * Our own numbers (starting values; not measured on a real model yet). Codex T-236's caps and envelopes were the start.
 */
/** 'eyeWide' and 'lidSoft' are used only by the music reactions (I-077, music-react/recipes.ts), never by speech. */
export type FaceSlider = 'smileEyes' | 'browUp' | 'jitome' | 'eyeWide' | 'lidSoft';
export type HeadMove = 'nod' | 'tilt';
export interface Variant {
  readonly id: string;
  readonly family: 'face' | 'head' | 'blush';
  readonly slider: FaceSlider | HeadMove | 'blush';
  readonly amp: readonly [number, number];
  readonly keys: readonly (readonly [number, number])[];
  readonly style: 'quick' | 'slow' | 'double' | 'soft';
  readonly at?: 'peak' | 'boundary';
  /** Relative pick weight among the intent's variants of the same family (default 1). */
  readonly weight?: number;
  /** Which hormone lean makes this variant more likely: 'playful' (less under stress C), 'warm' (more with closeness O), 'tense' (more under C). */
  readonly lean?: 'playful' | 'warm' | 'tense';
}
const v = (id: string, family: Variant['family'], slider: Variant['slider'], amp: readonly [number, number], keys: readonly (readonly [number, number])[],
  style: Variant['style'], extra: Partial<Pick<Variant, 'at' | 'weight' | 'lean'>> = {}): Variant => Object.freeze({ id, family, slider, amp, keys, style, ...extra });

// Shared envelopes (seconds, share of amp).
const FLASH = [[0, 0], [0.28, 1], [0.4, 1], [0.82, 0]] as const;               // T-236 started at in 0.22 s; 0.28 s keeps the change of speed within the face-twitch round 3 limit
const LINGER = [[0, 0], [0.32, 1], [0.72, 0.9], [1.36, 0]] as const;
const NOD = [[0, 0], [0.1, -0.08], [0.3, 1], [0.62, -0.06], [0.9, 0]] as const; // a hint up first, a little rebound after
const NOD_DOUBLE = [[0, 0], [0.22, 1], [0.42, 0.18], [0.62, 0.7], [0.92, -0.05], [1.15, 0]] as const;
const NOD_SLOW = [[0, 0], [0.14, -0.06], [0.42, 1], [0.9, -0.04], [1.25, 0]] as const;
const TILT = [[0, 0], [0.4, 1], [0.85, 0.92], [1.4, 0]] as const;
const TILT_SLOW = [[0, 0], [0.55, 1], [1.2, 0.85], [1.8, 0]] as const;
const BLUSH = [[0, 0], [0.8, 1], [2.0, 1], [3.2, 0]] as const;                  // T-236: 0.8 s in, at most 2 s held, 1.2 s out

export const RECIPES: Readonly<Record<Exclude<SpeechIntent, 'calm'>, readonly Variant[]>> = Object.freeze({
  happy: Object.freeze([
    v('smile-quick', 'face', 'smileEyes', [0.1, 0.18], FLASH, 'quick', { lean: 'warm' }),
    v('smile-linger', 'face', 'smileEyes', [0.08, 0.15], LINGER, 'slow', { lean: 'warm' }),
    v('happy-tilt', 'head', 'tilt', [1.4, 2.2], TILT, 'quick', { lean: 'playful', weight: 0.6 }),
  ]),
  emphasis: Object.freeze([
    v('brow-flash', 'face', 'browUp', [0.1, 0.16], FLASH, 'quick', { lean: 'tense' }),
    v('brow-hold', 'face', 'browUp', [0.08, 0.13], LINGER, 'slow', { lean: 'tense' }),
    v('nod-beat', 'head', 'nod', [1.6, 2.5], NOD, 'quick'),
  ]),
  question: Object.freeze([
    v('tilt', 'head', 'tilt', [2, 3], TILT, 'quick', { lean: 'playful' }),
    v('tilt-slow', 'head', 'tilt', [1.8, 2.6], TILT_SLOW, 'slow'),
    v('brow-ask', 'face', 'browUp', [0.07, 0.12], FLASH, 'quick', { weight: 0.7 }),
  ]),
  thinking: Object.freeze([
    v('squint', 'face', 'jitome', [0.05, 0.1], LINGER, 'slow', { lean: 'tense' }),
    v('think-tilt', 'head', 'tilt', [1.2, 2], TILT_SLOW, 'slow'),
  ]),
  shy: Object.freeze([
    v('blush', 'blush', 'blush', [0.07, 0.13], BLUSH, 'soft', { lean: 'warm' }),
    v('shy-smile', 'face', 'smileEyes', [0.06, 0.12], LINGER, 'soft', { lean: 'warm' }),
    v('shy-dip', 'head', 'nod', [1, 1.8], NOD_SLOW, 'slow'),
  ]),
  affirm: Object.freeze([
    v('nod', 'head', 'nod', [1.8, 2.5], NOD, 'quick', { at: 'boundary' }),
    v('nod-double', 'head', 'nod', [1.2, 1.8], NOD_DOUBLE, 'double', { at: 'boundary', weight: 0.7 }),
    v('nod-slow', 'head', 'nod', [1.6, 2.2], NOD_SLOW, 'slow', { at: 'boundary' }),
    v('affirm-smile', 'face', 'smileEyes', [0.06, 0.12], FLASH, 'soft', { lean: 'warm', weight: 0.6 }),
  ]),
});

/** Seconds from an envelope's start to its accent (its largest key). */
export function peakTime(keys: Variant['keys']): number {
  let best = 0, at = 0;
  for (const [t, value] of keys) if (value > best) { best = value; at = t; }
  return at;
}
export const duration = (keys: Variant['keys']): number => keys[keys.length - 1][0];

const smoother = (x: number) => { const t = x <= 0 ? 0 : x >= 1 ? 1 : x; return t * t * t * (t * (t * 6 - 15) + 10); };
/** The envelope at `t` seconds (time-scaled by `scale`): smootherstep between key poses, 0 outside. */
export function envelope(keys: Variant['keys'], t: number, scale = 1): number {
  const s = scale > 0 ? t / scale : t;
  if (!(s > 0) || s >= keys[keys.length - 1][0]) return 0;
  for (let k = 1; k < keys.length; k++) {
    const [t1, v1] = keys[k];
    if (s <= t1) { const [t0, v0] = keys[k - 1]; return v0 + (v1 - v0) * smoother((s - t0) / Math.max(1e-6, t1 - t0)); }
  }
  return 0;
}
