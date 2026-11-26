/**
 * I-193 (the plan's decisions "按推荐"):
 * how near and how far she can stand on THIS screen with HER height, and what the user sees at a few distances in between.
 *
 *  - nearestWalkSize: the nearest she walks to by herself is "only the face" (the seen band 'face'); nearer ("脸贴得很近", 'face-close') stays for
 *    the kiss / hug close moments, which walk up to the lens by their own path. Also never through the glass (her world's DEPTH_RANGE_M).
 *  - FARTHEST: the farthest is go-far's limit (knobs.farthestSize), so the table and the walks agree.
 *  - nearTable: a few rows "about X m: what the user sees", from the real framing (seen.ts herSeen at each size), with the told metres of the ONE
 *    screen formula (shared/unbound/screen-terms toldDistanceM; the turn's own distance uses the same function).
 * Pure: the host gives the world and her height.
 */
import { DEPTH_RANGE_M } from '../world';
import type { FramingWorld } from '../framing/floor';
import { depthForSize, sizeAtDepth, toldDistanceM } from '../screen-terms';
import { HER_POSITION_KNOBS, type HerPositionKnobs } from './knobs';
import { herSeen, type HerSeen } from './seen';

export interface NearRow { seen: HerSeen; distanceM: number }
export interface NearTable { rows: readonly NearRow[]; nearest: { size: number; distanceM: number }; farthest: { size: number; distanceM: number } }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const seenAt = (world: FramingWorld, heightM: number, size: number, knobs: HerPositionKnobs): HerSeen | null => {
  const depth = depthForSize(world, heightM, size);
  return depth === null ? null : herSeen(world, { heightM }, depth, knobs)?.seen ?? null;
};

/**
 * The largest size she walks to by herself: the user still sees her face whole ('face', not 'face-close'), and she stays behind the glass.
 * null when it cannot be worked out (no world, no height).
 */
export function nearestWalkSize(world: FramingWorld | null | undefined, heightM: number | null | undefined, knobs: HerPositionKnobs = HER_POSITION_KNOBS): number | null {
  if (!world || !finite(heightM) || heightM <= 0) return null;
  const glass = sizeAtDepth(world, heightM, DEPTH_RANGE_M[0]);
  if (glass === null || glass <= 0) return null;
  const tooNear = (size: number) => seenAt(world, heightM, size, knobs) === 'face-close';
  if (!tooNear(glass)) return glass;
  let lo = Math.min(1, glass), hi = glass;
  if (tooNear(lo)) return lo; // an odd frame: not even her whole height is nearer than the close-up; keep to where she fits
  for (let i = 0; i < 48; i++) { const mid = Math.sqrt(lo * hi); if (tooNear(mid)) hi = mid; else lo = mid; }
  return lo;
}

/** The farthest she walks to by herself (go-far's limit). */
export const farthestWalkSize = (knobs: HerPositionKnobs = HER_POSITION_KNOBS): number => knobs.farthestSize;

/** How many sizes the table looks at between the farthest and the nearest (log-spaced). */
const TABLE_STEPS = 96;

/**
 * The near-far table for this screen and her height: one row per seen band from far to near (whole, knees up, waist up, chest up, only the face),
 * each at the middle of that band's sizes, with the told metres; and the nearest and farthest she can walk to. null when nothing is known.
 */
export function nearTable(world: FramingWorld | null | undefined, heightM: number | null | undefined, knobs: HerPositionKnobs = HER_POSITION_KNOBS): NearTable | null {
  const nearest = nearestWalkSize(world, heightM, knobs), farthest = farthestWalkSize(knobs);
  if (!world || nearest === null || !finite(heightM) || !(farthest > 0)) return null;
  const nearM = toldDistanceM(heightM, nearest), farM = toldDistanceM(heightM, farthest);
  if (nearM === null || farM === null) return null;
  const lo = Math.min(farthest, nearest), hi = Math.max(farthest, nearest);
  const bands: { seen: HerSeen; from: number; to: number }[] = [];
  for (let i = 0; i <= TABLE_STEPS; i++) {
    const size = lo * (hi / lo) ** (i / TABLE_STEPS), seen = seenAt(world, heightM, size, knobs);
    if (!seen || seen === 'face-close') continue;
    const last = bands.at(-1);
    if (last && last.seen === seen) last.to = size; else bands.push({ seen, from: size, to: size });
  }
  const rows: NearRow[] = [];
  for (const band of bands) {
    const distanceM = toldDistanceM(heightM, Math.sqrt(band.from * band.to));
    if (distanceM !== null && !rows.some(row => row.seen === band.seen)) rows.push({ seen: band.seen, distanceM });
  }
  return { rows, nearest: { size: nearest, distanceM: nearM }, farthest: { size: farthest, distanceM: farM } };
}
