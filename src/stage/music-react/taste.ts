/**
 * I-077 step 2, "她的口味": how much she likes the song she hears, from the card's music taste (shared/senses/music-taste.ts) and what the
 * hearing layer knows of the song (tempo, brightness, energy), and what that changes. Pure.
 *
 * - `liking` is -1 (nothing like her taste) ... +1 (just what she likes), and exactly 0 for a neutral taste or when the song says
 *   nothing about the axes she has an opinion on: then every gain below is exactly 1 and step 1's numbers are unchanged.
 * - It only scales how engaged she is: how often she reacts, how big, how lively the dance. The floor stays well above zero, and
 *   nothing here ever makes a face: a song she does not care for is followed lightly, never frowned at.
 * - Per axis: the song's value f (0..1) against her preference p (0..1): the nearer, the more she likes it; an axis counts as much
 *   as she has an opinion on it (|p - 0.5|).
 */
import { MUSIC_TASTE_AXES, isNeutralMusicTaste, type MusicTaste } from '../../../shared/senses';
import { MUSIC_REACT_KNOBS } from './knobs';

/** What the stage knows of the song right now (the same numbers the hearing layer reports). */
export interface SongFeel { bpm: number | null; brightness: number; density: number; pluck: number; bass: number }

const clamp = (x: number, lo = 0, hi = 1) => Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;

/** 0 (calm) ... 1 (intense): onset density, plucked attacks and weight of the low end. */
export function songEnergyOf(feel: SongFeel): number {
  const t = MUSIC_REACT_KNOBS.taste;
  return clamp(t.energyDensity * clamp(feel.density / t.denseOnsets) + t.energyPluck * clamp(feel.pluck) + t.energyBass * clamp(feel.bass));
}

/** The song's position on each axis (null: not known yet, that axis then says nothing). */
function featuresOf(feel: SongFeel): Record<'tempo' | 'brightness' | 'energy', number | null> {
  const t = MUSIC_REACT_KNOBS.taste;
  return { tempo: feel.bpm !== null && feel.bpm > 0 ? clamp((feel.bpm - t.slowBpm) / (t.fastBpm - t.slowBpm)) : null, brightness: clamp(feel.brightness), energy: songEnergyOf(feel) };
}

export function tasteLiking(taste: Readonly<MusicTaste> | null | undefined, feel: SongFeel): number {
  if (!taste || isNeutralMusicTaste(taste)) return 0;
  const f = featuresOf(feel);
  let weight = 0, sum = 0;
  for (const axis of MUSIC_TASTE_AXES) {
    const value = f[axis], p = clamp(taste[axis] / 100), w = Math.abs(p - 0.5) * 2;
    if (value === null || w === 0) continue;
    weight += w; sum += w * (1 - 2 * Math.abs(value - p));
  }
  if (weight === 0) return 0;
  // How strongly she has opinions at all (one axis at 100 or two at 75 say a lot; everything at 55 says little).
  const strength = clamp(weight / MUSIC_REACT_KNOBS.taste.strongAt);
  return clamp(strength * sum / weight, -1, 1);
}

export interface TasteGains {
  /** Multiplies the chance of a reaction. */
  often: number;
  /** Multiplies a reaction's size. */
  size: number;
  /** Multiplies the dance's own sway, bounce and nod while she dances to it. */
  dance: number;
  /** Multiplies the mood moment of an enjoyed or recognized song. */
  mood: number;
}
export const NEUTRAL_GAINS: Readonly<TasteGains> = Object.freeze({ often: 1, size: 1, dance: 1, mood: 1 });

/** One liking → the gains (all exactly 1 at 0; bounded below by 1 - k > 0 for every k, so never none). */
export function tasteGains(liking: number): TasteGains {
  if (!(liking !== 0) || !Number.isFinite(liking)) return NEUTRAL_GAINS;
  const t = MUSIC_REACT_KNOBS.taste, l = clamp(liking, -1, 1);
  return { often: 1 + t.often * l, size: 1 + t.size * l, dance: 1 + t.dance * l, mood: 1 + t.mood * l };
}
