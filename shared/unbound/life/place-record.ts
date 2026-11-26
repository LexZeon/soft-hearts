/**
 * Unbound v1 step 4: where she last stood, as kept in the profile (`unbound-place.json`, electron/unbound/place-store.ts). Two
 * numbers and a version, nothing about you. Anything missing, unreadable or out of range gives null: she comes out where she always did.
 *
 * I-212: a record keeps how she looked on the screen, not metres:
 *   version 2   { across, size }   across 0..1 of the screen width, size = her height as a share of the usable height (shared/unbound/screen-terms);
 *   version 1   { across, depthM } an old record (metres behind the screen). It is read as it is and converted ONCE, with the screen and her
 *               height at hand (legacyToLook), then written in the new form (the place keeper does it: electron/unbound/place-keeper.ts).
 * So another screen shows her as the user set her: the same share of the width, the same share of the height.
 */
import { placementAcross, type Placement, type WorldView } from '../world';
import { sizeAtDepth, type LookSpot, type ScreenFrame } from '../screen-terms';

export interface SavedLook { version: 2; across: number; size: number }
export interface SavedDepth { version: 1; across: number; depthM: number }
export type SavedPlace = SavedLook | SavedDepth;
/** What the full-screen panel shows about the user's default place (2026-11-23): one is set, and she can be kept where she stands now. */
export interface DefaultPlaceLook { set: boolean; here: boolean;
  /** Only the panel click's own answer: why it kept nothing (closed words; the panel says it in words). A plain read never has it. */
  refused?: PlaceKeepRefusal | null }
/** Why the user's "set as default" click kept nothing (electron/unbound/place-keeper.ts keepHere); the journal row's outcome uses the same words. */
export type PlaceKeepRefusal = 'not-out' | 'no-height' | 'out-of-reach' | 'moving' | 'not-saved';
/**
 * What a saved place may be (outside: not used). Inside the screen with a margin, not so near that she fills it, not so far she is a speck.
 * size: 0.327-0.771 is the old 5-12.5 m on the reference laptop (8 m = 0.5); depthM: the old records' own range, for reading them.
 */
export const SAVED_PLACE_RANGES = Object.freeze({ across: Object.freeze([0.05, 0.95] as const), size: Object.freeze([0.327, 0.771] as const), depthM: Object.freeze([5, 12.5] as const) });

/**
 * What the USER'S DEFAULT PLACE may be: anywhere she can stand by walking. across as above; size from
 * the far walk limit up to the near one (the far end is go.ts GO_SIZE[0]; the near end is only a sanity cap (12: the nearest walk on a small tablet screen with a tall model is about 8), the screen's own near limit "only the face" is
 * checked when it is set, electron/unbound/place-keeper.ts keepHere, because it depends on the screen and her height). Only the default place's
 * file and the keeper's checks use it; pulls and the last place keep SAVED_PLACE_RANGES.
 */
export const DEFAULT_PLACE_RANGES = Object.freeze({ across: SAVED_PLACE_RANGES.across, size: Object.freeze([0.327, 12] as const), depthM: SAVED_PLACE_RANGES.depthM });
export type PlaceSizeRange = readonly [number, number];

const inRange = (value: unknown, [lo, hi]: readonly [number, number]): value is number => typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;
const clamp = (value: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, value));

export function parseSavedPlace(value: unknown, sizeRange: PlaceSizeRange = SAVED_PLACE_RANGES.size): SavedPlace | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!inRange(v.across, SAVED_PLACE_RANGES.across)) return null;
  if (v.version === 2 && !('places' in v)) return inRange(v.size, sizeRange) ? { version: 2, across: v.across, size: v.size } : null;
  if (v.version === 1) return inRange(v.depthM, SAVED_PLACE_RANGES.depthM) ? { version: 1, across: v.across, depthM: v.depthM } : null;
  return null;
}

/** The record for a look (null when it is outside what may be kept). */
export function savedPlaceOf(spot: LookSpot, sizeRange: PlaceSizeRange = SAVED_PLACE_RANGES.size): SavedLook | null { return parseSavedPlace({ version: 2, across: spot.across, size: spot.size }, sizeRange) as SavedLook | null; }
/** A place brought inside the last-place range (the default place, nearer than a last place may be, is also where she last stood: kept at the edge, never dropped). */
export function withinSavedSizes(record: SavedPlace): SavedPlace { return record.version === 2 ? { ...record, size: clamp(record.size, SAVED_PLACE_RANGES.size) } : record; }

/**
 * An old record's look on this screen for her height, brought inside the kept range (another screen may put an old metre value outside it:
 * kept at the edge, never dropped). null: the screen or her height is not known yet.
 */
export function legacyToLook(frame: ScreenFrame | null | undefined, heightM: number | null | undefined, record: SavedDepth): SavedLook | null {
  const size = sizeAtDepth(frame, heightM, record.depthM); // across is a share of the screen already
  return size === null ? null : { version: 2, across: record.across, size: clamp(size, SAVED_PLACE_RANGES.size) };
}

/**
 * A spot measured in metres behind the screen (the company's lanes plan in metres: shared/unbound/company/lanes.ts): across ↔ her floor x only.
 * Not a size conversion (that is shared/unbound/screen-terms).
 */
export interface DepthSpot { across: number; depthM: number }
/** Her placement for a depth spot on this screen. */
export function placementOfSpot(view: Pick<WorldView, 'screen' | 'viewerDistanceM'>, spot: DepthSpot): Placement { return placementAcross(view, spot.across, spot.depthM); }
/** The depth spot of a placement on this screen (placementAcross backwards). */
export function spotOfPlacement(view: Pick<WorldView, 'screen' | 'viewerDistanceM'>, placement: Placement): DepthSpot | null {
  const d = view.viewerDistanceM, w = view.screen.widthM;
  if (!(d > 0) || !(w > 0) || !Number.isFinite(placement.xM) || !Number.isFinite(placement.depthM)) return null;
  return { across: 0.5 + placement.xM * d / ((d + placement.depthM) * w), depthM: placement.depthM };
}
