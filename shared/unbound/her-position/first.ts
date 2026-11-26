/**
 * night ("每个角色出来的默认位置是比较近的（半身以上）"): where a character comes out when she has no default place and no last place.
 * It replaces the I-212 B rule (about half the screen high, whole body). She comes out fairly near: the user sees her from about the waist up.
 *
 * "From the waist up" is the seen band 'waist-up' (seen.ts: the work area's bottom edge cuts her between `seenWaistFrom` and `seenChestFrom` of her
 * height), found for THIS screen and HER height with the same framing the page draws (herSeen), so a short and a tall model, a laptop and a big
 * monitor all show about the same part of her. The size is the log-middle of that band's sizes (knob `firstBandPosition`).
 * Pure: the host gives the world and her height. null when it cannot be worked out (the caller then keeps the old fixed size).
 */
import type { FramingWorld } from '../framing/floor';
import { depthForSize } from '../screen-terms';
import { HER_POSITION_KNOBS, type HerPositionKnobs } from './knobs';
import { farthestWalkSize, nearestWalkSize } from './reach';
import { herSeen } from './seen';

/** How many sizes are tried between the farthest and the nearest walk limit (log-spaced); the band's edges are found to this resolution. */
const STEPS = 192;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The size (her height as a share of the usable screen height) at which the user sees her from the waist up; null when unknown. */
export function firstWaistUpSize(world: FramingWorld | null | undefined, heightM: number | null | undefined, knobs: HerPositionKnobs = HER_POSITION_KNOBS): number | null {
  const nearest = nearestWalkSize(world, heightM, knobs), farthest = farthestWalkSize(knobs);
  if (!world || !finite(heightM) || nearest === null || !(farthest > 0)) return null;
  const lo = Math.min(farthest, nearest), hi = Math.max(farthest, nearest);
  let from = NaN, to = NaN;
  for (let i = 0; i <= STEPS; i++) {
    const size = lo * (hi / lo) ** (i / STEPS), depth = depthForSize(world, heightM, size);
    if (depth !== null && herSeen(world, { heightM }, depth, knobs)?.seen === 'waist-up') { if (Number.isNaN(from)) from = size; to = size; }
  }
  if (Number.isNaN(from)) return null;
  const at = Math.min(1, Math.max(0, knobs.firstBandPosition));
  return from * (to / from) ** at;
}
