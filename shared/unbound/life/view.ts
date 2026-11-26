/**
 * Unbound v1 step 4: what the developer panel sees of her free time, and what it may ask (「试一下」 per action, 「快进」, the starting
 * numbers). Plain words and numbers only: never a program name, never a word of yours. Nothing here is for the user's own settings.
 */
import type { GazeOwner } from './arbiter';
import { LIFE_KNOB_RANGES, type LifeKnobs, type LifeRates } from './mood-read';
import type { LifeLevel } from './types';

export interface LifeView {
  knobs: LifeKnobs;
  rates: LifeRates | null;
  running: { action: string; words: string; easing: boolean; trial: boolean } | null;
  /** Why nothing new starts now (plain words), or null. */
  why: string | null;
  gaze: GazeOwner;
  /** What you are doing, as she reads it (plain words). */
  doing: string | null;
  fastForward: { phase: string; leftS: number } | null;
  actions: { id: string; words: string; level: LifeLevel; inS: number | null; notNow: string | null }[];
  /** The last thing she noticed you do (plain words, "好像" for a maybe). */
  lastCue: string | null;
}

/** The panel's requests (inside UnboundControlPatch). */
export interface LifePatch { lifeTry?: string; lifeFast?: boolean; lifeKnobs?: Partial<LifeKnobs> }

/** Checks the panel's part of a patch; throws in plain words. `known`: the registered action ids. */
export function parseLifePatch(value: Record<string, unknown>, known: readonly string[]): LifePatch {
  const patch: LifePatch = {};
  if ('lifeTry' in value) {
    if (typeof value.lifeTry !== 'string' || !known.includes(value.lifeTry)) throw new Error('“试一下”的动作不认识。');
    patch.lifeTry = value.lifeTry;
  }
  if ('lifeFast' in value) { if (typeof value.lifeFast !== 'boolean') throw new Error('“快进”格式不正确。'); patch.lifeFast = value.lifeFast; }
  if ('lifeKnobs' in value) {
    const knobs = value.lifeKnobs;
    if (!knobs || typeof knobs !== 'object' || Array.isArray(knobs)) throw new Error('起点数字格式不正确。');
    const out: Partial<LifeKnobs> = {};
    for (const [key, raw] of Object.entries(knobs)) {
      const range = LIFE_KNOB_RANGES[key as keyof LifeKnobs];
      if (!range) throw new Error('起点数字格式不正确。');
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < range[0] || raw > range[1]) throw new Error(`起点数字要在 ${range[0]} 到 ${range[1]} 之间。`);
      out[key as keyof LifeKnobs] = raw;
    }
    patch.lifeKnobs = out;
  }
  return patch;
}
