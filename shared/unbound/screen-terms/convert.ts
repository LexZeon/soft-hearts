/**
 * I-212: the one place where "how she looks on the user's screen" turns into
 * metres of her world and back. Every decision about where she stands (first appearance, the saved places, her own walks, her go-words, the
 * pull's bounds, the company's places) is made in SCREEN TERMS and converted here, for this screen and this model's own height:
 *
 *   across  her centre as a share of the display width (as seen from the eye; as before: shared/unbound/world.ts placementAcross);
 *   size    her whole height as a share of the USABLE height: from the floor line (HOME_FEET_MARGIN_DIP above the work area's bottom) to the
 *           work area's top. 1: from the taskbar's edge to the top of the screen; above 1 she does not fit whole (the framing bands of
 *           shared/unbound/framing/floor.ts take over, unchanged).
 *
 *   size(depth) = H·d / ((d + depth) · usableHeightM)        depth(size) = H·d / (size · usableHeightM) − d
 *   (d: the viewer's distance, H: her model's height; H·d/(d + depth) is how tall she looks on the glass: world.ts apparentHeightM.)
 *
 * Her world keeps metres inside (walking, the camera, physics, foot contact need them). Pure: no Electron, no Three.js, no clock.
 */
import { DEPTH_RANGE_M, HOME_FEET_MARGIN_DIP, clampPlacement, placementAcross, type Placement, type PhysicalScreen, type Rect } from '../world';

/** What of her world the conversion needs (shared/unbound/scene.ts UnboundWorld and framing/floor.ts FramingWorld have all of it). */
export interface ScreenFrame { screen: PhysicalScreen; display: Rect; workArea: Rect; viewerDistanceM: number }
/** A spot as the user sees it: across 0..1 of the screen width, size = her height as a share of the usable height. */
export interface LookSpot { across: number; size: number }

/** A model's height when the page has not reported it yet (a 20-unit MMD model; shared/unbound/world.ts MMD_UNIT_M). Only for a first guess. */
export const FALLBACK_HEIGHT_M = 1.6;
/**
 * The reference the metre knobs were converted against (2026-11-24): today's 8 m at 55 cm equals 0.5 (about half the screen on the laptop the
 * numbers were judged on). referenceSize(m) is what an old metre value looks like there; the knob tests hold every converted knob to it (2%).
 */
export const REFERENCE = Object.freeze({ viewerDistanceM: 0.55, depthM: 8, size: 0.5 });
export const referenceSize = (depthM: number): number => REFERENCE.size * (REFERENCE.viewerDistanceM + REFERENCE.depthM) / (REFERENCE.viewerDistanceM + depthM);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const usableHeight = (h: unknown): h is number => finite(h) && h > 0;

/** The usable height on the glass (m): the work area from its top down to the floor line. null: the frame is not usable. */
export function usableHeightM(frame: ScreenFrame | null | undefined): number | null {
  if (!frame || !(frame.display?.height > 0) || !(frame.screen?.heightM > 0) || !(frame.workArea?.height > 0)) return null;
  const usable = (frame.workArea.height - HOME_FEET_MARGIN_DIP) * frame.screen.heightM / frame.display.height;
  return usable > 0 ? usable : null;
}

/** Her size when she stands `depthM` behind the screen (null: not known). */
export function sizeAtDepth(frame: ScreenFrame | null | undefined, heightM: number | null | undefined, depthM: number): number | null {
  const usable = usableHeightM(frame), d = frame?.viewerDistanceM;
  if (usable === null || !usableHeight(heightM) || !finite(d) || d <= 0 || !finite(depthM) || d + depthM <= 0) return null;
  return heightM * d / ((d + depthM) * usable);
}

/** The depth (m behind the screen) at which she has this size (null: not known). Not clamped: placementOfLook clamps. */
export function depthForSize(frame: ScreenFrame | null | undefined, heightM: number | null | undefined, size: number): number | null {
  const usable = usableHeightM(frame), d = frame?.viewerDistanceM;
  if (usable === null || !usableHeight(heightM) || !finite(d) || d <= 0 || !finite(size) || size <= 0) return null;
  return heightM * d / (size * usable) - d;
}

/** Her placement (world m) for a look on this screen, kept inside DEPTH_RANGE_M; null when it cannot be worked out. */
export function placementOfLook(frame: ScreenFrame | null | undefined, heightM: number | null | undefined, look: LookSpot | null | undefined): Placement | null {
  if (!frame || !look || !finite(look.across)) return null;
  const depth = depthForSize(frame, heightM, look.size);
  return depth === null ? null : clampPlacement(placementAcross(frame, look.across, Math.min(DEPTH_RANGE_M[1], Math.max(DEPTH_RANGE_M[0], depth))));
}

/** The look of a placement on this screen (placementOfLook backwards); null when it cannot be worked out. */
export function lookOfPlacement(frame: ScreenFrame | null | undefined, heightM: number | null | undefined, placement: Placement | null | undefined): LookSpot | null {
  if (!frame || !placement || !finite(placement.xM) || !finite(placement.depthM)) return null;
  const d = frame.viewerDistanceM, w = frame.screen?.widthM;
  if (!finite(d) || d <= 0 || !finite(w) || w <= 0) return null;
  const size = sizeAtDepth(frame, heightM, placement.depthM);
  return size === null ? null : { across: 0.5 + placement.xM * d / ((d + placement.depthM) * w), size };
}

/** A size changed by a factor (a step nearer: above 1; further: below 1); NaN-safe. */
export function scaleSize(size: number, factor: number): number { return finite(size) && finite(factor) && factor > 0 ? size * factor : size; }
/** How much bigger `a` looks than `b` (a ratio; 1: the same). */
export function sizeRatio(a: number, b: number): number { return finite(a) && finite(b) && b > 0 ? a / b : 1; }
