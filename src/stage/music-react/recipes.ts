/**
 * I-077 step 1, the recipes ("配方"): what each music intent can look like. Adding a way to react = adding a row, never a branch.
 *
 * Each variant has up to three parts, all optional, all eased (keys between which the value moves along a smootherstep, so every
 * segment starts and stops at zero speed: keyframe animation, never a jump):
 *  - face: one universal face slider through the speaking-accent layer (speech-face/layer.ts `performPick`): its hard caps, spacing and
 *    yield rules apply. Keys in seconds at a 0.5 s beat; stretched with the song's beat (and slower when she is at ease).
 *  - head: a small head offset (rad) added to the music's own head motion (music-dance.ts shape), so it goes through the universal
 *    skeleton's head and yields with the dance or the nod. Keys in beats.
 *  - dance: how the dance or nod itself changes for a while: `energy` (share added to its size, + bigger / − smaller; the director keeps
 *    the sum within SHAPE_LIMITS.energy, so a reaction never makes the dance's own motion jerkier than R29 allows) and `slow` (the
 *    share of the slow four-beat sway). Keys in beats.
 * Intents: lift (the song rises: "来了"), settle (it falls back: she slows and sways), enjoy (she is into it), moved (a slow, dark song
 * touches her), recognize (step 2: the intro of a song she knows: a happy flash and a little bounce). `lean` says which temper prefers it: 'lively' (N and D up), 'soft' (E up, a slower variant), 'quiet' (does very little).
 * Our own numbers (starting values; not seen on a real model yet).
 */
import type { Variant } from '../../voice';

export const MUSIC_INTENTS = ['lift', 'settle', 'enjoy', 'moved', 'recognize'] as const;
export type MusicIntent = typeof MUSIC_INTENTS[number];

export type Keys = readonly (readonly [number, number])[];
export interface MusicVariant {
  readonly id: string;
  readonly face?: { readonly slider: Variant['slider'] & ('smileEyes' | 'browUp' | 'jitome' | 'eyeWide' | 'lidSoft'); readonly amp: readonly [number, number]; readonly keys: Keys; readonly style: Variant['style'] };
  /** Head pitch (x, + chin down) and roll (z, signed by a side she picks), rad at full size. */
  readonly head?: { readonly x: number; readonly z: number; readonly keys: Keys };
  readonly dance?: { readonly energy: number; readonly slow: number; readonly keys: Keys };
  readonly lean?: 'lively' | 'soft' | 'quiet';
  readonly weight?: number;
}

// Face envelopes (seconds at a 0.5 s beat).
const BRIGHTEN = [[0, 0], [0.45, 1], [1.0, 0.85], [1.8, 0]] as const;   // a 0.45 s rise keeps the change of speed within the face-twitch round 3 limit at 30 fps
const WARM = [[0, 0], [0.45, 1], [1.4, 0.9], [2.4, 0]] as const;
const CLOSE = [[0, 0], [0.8, 1], [2.6, 1], [3.8, 0]] as const;      // eyes slowly closing to listen, held, opening
const SOFTEN = [[0, 0], [1.0, 1], [3.2, 0.9], [4.6, 0]] as const;
// Head and dance envelopes (beats).
const UP = [[0, 0], [1, 1], [2, 0.8], [3.5, 0]] as const;
const DIP = [[0, 0], [1, 1], [3, 0.85], [5, 0]] as const;
const LEAN = [[0, 0], [1.5, 1], [4, 0.9], [6, 0]] as const;
const SURGE = [[0, 0], [1, 1], [4, 1], [8, 0]] as const;
const EASE = [[0, 0], [2, 1], [6, 1], [10, 0]] as const;

const variant = (v: MusicVariant): MusicVariant => Object.freeze(v);

export const MUSIC_RECIPES: Readonly<Record<MusicIntent, readonly MusicVariant[]>> = Object.freeze({
  lift: Object.freeze([
    variant({ id: 'lift-eyes', face: { slider: 'eyeWide', amp: [0.1, 0.16], keys: BRIGHTEN, style: 'quick' }, head: { x: -0.02, z: 0, keys: UP },
      dance: { energy: 0.18, slow: 0, keys: SURGE }, lean: 'lively' }),
    variant({ id: 'lift-brows', face: { slider: 'browUp', amp: [0.1, 0.15], keys: BRIGHTEN, style: 'quick' }, head: { x: 0.022, z: 0, keys: [[0, 0], [1, 1], [2, 0.4], [3.5, 0]] },
      dance: { energy: 0.2, slow: 0, keys: SURGE } }),
    variant({ id: 'lift-grin', face: { slider: 'smileEyes', amp: [0.1, 0.16], keys: WARM, style: 'slow' }, head: { x: 0, z: 0.02, keys: LEAN },
      dance: { energy: 0.15, slow: 0, keys: SURGE }, weight: 0.8 }),
  ]),
  settle: Object.freeze([
    variant({ id: 'settle-close', face: { slider: 'lidSoft', amp: [0.22, 0.32], keys: CLOSE, style: 'soft' },
      dance: { energy: -0.2, slow: 0.6, keys: EASE }, lean: 'soft' }),
    variant({ id: 'settle-sway', face: { slider: 'smileEyes', amp: [0.05, 0.09], keys: SOFTEN, style: 'soft' }, head: { x: 0, z: 0.018, keys: LEAN },
      dance: { energy: -0.15, slow: 0.8, keys: EASE } }),
    variant({ id: 'settle-still', head: { x: 0.012, z: 0, keys: DIP }, dance: { energy: -0.3, slow: 0.3, keys: EASE }, lean: 'quiet', weight: 0.7 }),
  ]),
  enjoy: Object.freeze([
    variant({ id: 'enjoy-smile', face: { slider: 'smileEyes', amp: [0.12, 0.18], keys: WARM, style: 'slow' }, head: { x: 0, z: 0.024, keys: LEAN },
      dance: { energy: 0.1, slow: 0, keys: SURGE } }),
    variant({ id: 'enjoy-closed', face: { slider: 'lidSoft', amp: [0.28, 0.38], keys: CLOSE, style: 'soft' }, head: { x: 0.01, z: 0.02, keys: LEAN },
      dance: { energy: 0, slow: 0.4, keys: EASE }, lean: 'soft' }),
    variant({ id: 'enjoy-bob', face: { slider: 'smileEyes', amp: [0.08, 0.12], keys: BRIGHTEN, style: 'quick' }, dance: { energy: 0.15, slow: 0, keys: SURGE }, lean: 'lively' }),
  ]),
  moved: Object.freeze([
    variant({ id: 'moved-soft', face: { slider: 'lidSoft', amp: [0.28, 0.36], keys: SOFTEN, style: 'soft' }, head: { x: 0.03, z: 0, keys: DIP },
      dance: { energy: -0.25, slow: 0.6, keys: EASE }, lean: 'soft' }),
    variant({ id: 'moved-down', face: { slider: 'jitome', amp: [0.06, 0.1], keys: SOFTEN, style: 'slow' }, head: { x: 0.032, z: 0.014, keys: DIP },
      dance: { energy: -0.3, slow: 0.5, keys: EASE } }),
  ]),
  // The intro of a song she knows ("又是这首"): her face and body, not a word. Short, bright, a little bounce; the soft one is a warm look.
  recognize: Object.freeze([
    variant({ id: 'recognize-flash', face: { slider: 'smileEyes', amp: [0.12, 0.17], keys: BRIGHTEN, style: 'quick' }, head: { x: -0.016, z: 0, keys: UP },
      dance: { energy: 0.14, slow: 0, keys: SURGE }, lean: 'lively' }),
    variant({ id: 'recognize-warm', face: { slider: 'smileEyes', amp: [0.1, 0.15], keys: WARM, style: 'slow' }, head: { x: 0, z: 0.022, keys: LEAN },
      dance: { energy: 0.06, slow: 0.2, keys: SURGE }, lean: 'soft' }),
    variant({ id: 'recognize-brows', face: { slider: 'browUp', amp: [0.1, 0.14], keys: BRIGHTEN, style: 'quick' }, head: { x: 0.018, z: 0, keys: [[0, 0], [1, 1], [2, 0.4], [3.5, 0]] },
      dance: { energy: 0.1, slow: 0, keys: SURGE }, weight: 0.8 }),
  ]),
});

/** Last key time of an envelope. */
export const keysEnd = (keys: Keys): number => keys[keys.length - 1]![0];
