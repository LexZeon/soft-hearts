/**
 * How far her lips part, read from the model's own geometry.
 *
 * A morph's weight says nothing about how open a mouth looks: VRoid's い at 1 parts the lips by a sliver, Gene's あ at 1 is a wide yawn. So the
 * gap is measured once per model, on the vertices: the inner edge of the lower lip (the highest front vertex in the middle column that the
 * open-mouth morph pulls down) and the inner edge of the upper lip (the lowest front vertex above it that the open morph leaves where it is).
 * `gap(weights)` is the vertical distance between those two at a mix of morphs, in face units (the eye line to the lip line), so the same number
 * means the same look on every model. The flap reads it (`MouthGapProfile`): how much each vowel opens against あ (a smile's い must not shut the
 * mouth) and how wide あ itself opens (the per-model calibration: lip-sync lands in one band, never a sliver, never a yawn).
 * Pure: arrays in, numbers out; no three.js.
 */
import { VOWELS, type Vowel } from './interface';

export interface LipGapInput {
  /** Rest positions (x, y, z per vertex), +Y up, in any space the morph deltas share. */
  readonly positions: ArrayLike<number>;
  /** Each named mix's offsets per vertex (relative, same layout as positions). Must include 'a' (the open mouth). */
  readonly morphs: Readonly<Record<string, ArrayLike<number> | undefined>>;
  /** Which way her face looks along z (+1: she faces +z). */
  readonly frontZ: 1 | -1;
  /** The eye line's height in the same space (the face unit is the eye line to the lip line). */
  readonly eyeY: number;
}

export interface LipGapMeter {
  /** The two lip vertices (indices) and the face unit (model units). */
  readonly upper: number;
  readonly lower: number;
  readonly unit: number;
  /** The lip gap at this mix (names of `morphs` → weights), in face units, ≥ 0. */
  gap(weights: Readonly<Record<string, number>>): number;
}

const finite = (v: number) => Number.isFinite(v);

/** The meter for one face, or null when the open-mouth morph moves nothing measurable (no lip pair found). */
export function lipGapMeter(input: LipGapInput): LipGapMeter | null {
  const p = input.positions, a = input.morphs.a, count = Math.floor(p.length / 3);
  if (!a || a.length < count * 3 || count < 3) return null;
  // The open morph's moving vertices: where the mouth is and how wide.
  let maxMove = 0;
  for (let v = 0; v < count; v++) { const m = Math.hypot(a[v * 3], a[v * 3 + 1], a[v * 3 + 2]); if (finite(m) && m > maxMove) maxMove = m; }
  if (!(maxMove > 0)) return null;
  const moving: number[] = [];
  for (let v = 0; v < count; v++) if (Math.hypot(a[v * 3], a[v * 3 + 1], a[v * 3 + 2]) > 0.1 * maxMove) moving.push(v);
  if (moving.length < 3) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, sumX = 0, sumW = 0;
  for (const v of moving) {
    const x = p[v * 3], y = p[v * 3 + 1], w = Math.hypot(a[v * 3], a[v * 3 + 1], a[v * 3 + 2]);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); sumX += x * w; sumW += w;
  }
  const midX = sumX / sumW, width = Math.max(maxX - minX, 1e-6), padY = 0.25 * Math.max(maxY - minY, width * 0.2);
  // The middle column of the mouth region (widened when the mesh is coarse).
  let column: number[] = [];
  for (const share of [0.06, 0.12, 0.2]) {
    column = [];
    for (let v = 0; v < count; v++) {
      const x = p[v * 3], y = p[v * 3 + 1];
      if (Math.abs(x - midX) <= share * width && y >= minY - padY && y <= maxY + padY) column.push(v);
    }
    if (column.length >= 6) break;
  }
  if (column.length < 2) return null;
  // The lips are the surface of the column (teeth and tongue sit behind them): a vertex counts when nothing at about its height (±4% of the
  // mouth's width) is more than a tenth of the mouth's width in front of it.
  const band = 0.04 * width, depth = 0.1 * width;
  const surface = column.filter(v => {
    const y = p[v * 3 + 1], z = p[v * 3 + 2] * input.frontZ;
    for (const w of column) if (Math.abs(p[w * 3 + 1] - y) <= band && p[w * 3 + 2] * input.frontZ > z + depth) return false;
    return true;
  });
  let maxDown = 0;
  for (const v of surface) maxDown = Math.max(maxDown, -a[v * 3 + 1]);
  if (!(maxDown > 0)) return null;
  // The lower lip's inner edge: the highest surface vertex the open morph pulls down (at least half as far as the most).
  let lower = -1;
  for (const v of surface) if (-a[v * 3 + 1] >= 0.5 * maxDown && (lower < 0 || p[v * 3 + 1] > p[lower * 3 + 1])) lower = v;
  if (lower < 0) return null;
  // The upper lip's inner edge: the lowest surface vertex at or above it that the open morph does not pull down with the jaw.
  let upper = -1;
  const lowY = p[lower * 3 + 1] - 0.02 * width;
  for (const v of surface) {
    if (-a[v * 3 + 1] > 0.25 * maxDown || p[v * 3 + 1] < lowY || v === lower) continue;
    if (upper < 0 || p[v * 3 + 1] < p[upper * 3 + 1]) upper = v;
  }
  if (upper < 0) return null;
  const unit = Math.abs(input.eyeY - p[lower * 3 + 1]);
  if (!(unit > 0)) return null;
  const morphs = input.morphs;
  return {
    upper, lower, unit,
    gap(weights) {
      let uy = p[upper * 3 + 1], ly = p[lower * 3 + 1];
      for (const key of Object.keys(weights)) {
        const w = weights[key], d = morphs[key];
        if (!d || !(w !== 0) || !finite(w)) continue;
        uy += w * d[upper * 3 + 1]; ly += w * d[lower * 3 + 1];
      }
      const gap = (uy - ly) / unit;
      return finite(gap) && gap > 0 ? gap : 0;
    },
  };
}

/** What the flap needs of one model's lips: each vowel's gap at full weight against あ's (1 for あ), and あ's own gap at full (face units). */
export interface MouthGapProfile {
  readonly openness: Readonly<Record<Vowel, number>>;
  /** The gap of あ at weight 1, in face units (eye line to lip line). */
  readonly fullGap: number;
}

/**
 * The profile from a meter (vowels missing from `morphs` keep 1: their share falls back to あ anyway). null meter or an あ that does not part the
 * lips: null (the flap then runs as before, uncalibrated).
 */
export function mouthGapProfile(meter: LipGapMeter | null, morphs: Readonly<Record<string, unknown>>): MouthGapProfile | null {
  if (!meter) return null;
  const full = meter.gap({ a: 1 });
  if (!(full > 1e-4)) return null;
  const openness = { a: 1, i: 1, u: 1, e: 1, o: 1 } as Record<Vowel, number>;
  for (const vowel of VOWELS) if (vowel !== 'a' && morphs[vowel]) openness[vowel] = Math.min(1.5, meter.gap({ [vowel]: 1 }) / full);
  return { openness, fullGap: full };
}
