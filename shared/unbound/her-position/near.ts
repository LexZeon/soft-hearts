/**
 * I-193 /: how near "come-near" walks her.
 *
 * Not one small step from where she stands: to the size of the user's default place (the spot kept with "设为默认位置", the place the user
 * chose for her); with no default place set, to a chest-up framing computed for her height from the floor framing's own bands
 * (shared/unbound/framing/floor.ts: from the distance where her whole body just fits down to the one where the face close-up holds, this far into
 * it). Never closer than that: closer is the kiss / hug close moments, which walk up to the lens by their own path.
 * I-212: the answer is a size on the screen (shared/unbound/screen-terms), like every place decision.
 * Pure: the host gives the default place, her height and the world; null when none of it is known (come-near then takes its old small step).
 */
import { framingBand, framingGeometry, type FramingWorld } from '../framing/floor';
import { sizeAtDepth } from '../screen-terms';

/** How far from "her whole body just fits" toward "the face close-up holds" the chest-up framing sits (0 = whole body, 1 = face close-up). A trial value. */
export const CHEST_UP_SHARE = 0.5;

export type NearFrom = 'default' | 'chest-up';
export interface NearSize { size: number; from: NearFrom }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The distance (m behind the screen) at which her chest-up fills the frame, for her height; null when it cannot be worked out. */
export function chestUpDepthM(world: FramingWorld | null | undefined, heightM: number | null | undefined): number | null {
  if (!world || !finite(heightM) || heightM <= 0) return null;
  const g = framingGeometry(world), band = g ? framingBand(g, heightM) : null;
  if (!band) return null;
  const depth = band.fitDepthM - CHEST_UP_SHARE * (band.fitDepthM - band.closeDepthM);
  return finite(depth) && depth > 0 ? depth : null;
}

/** Where "come-near" ends: the default place's size when one is set, else the chest-up size for her height, else null. */
export function comeNearSize(input: { defaultPlace?: { size: number } | null; world?: FramingWorld | null; heightM?: number | null }): NearSize | null {
  const place = input.defaultPlace;
  if (place && finite(place.size) && place.size > 0) return { size: place.size, from: 'default' };
  const chest = chestUpDepthM(input.world, input.heightM), size = chest === null ? null : sizeAtDepth(input.world, input.heightM, chest);
  return size === null ? null : { size, from: 'chest-up' };
}
