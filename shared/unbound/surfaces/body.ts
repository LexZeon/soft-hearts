/**
 * Unbound U4: her body as a few boxes behind the glass, seen through the screen (the same perspective as world.ts), and how much
 * of each box the windows hide.
 *
 * She stands `depthM` behind the glass; a box at that depth shows on the display scaled by d / (d + depth) (d: your eye to the
 * screen), so the same rectangle of glass hides a different slice of her at 2 m than at 8 m. Boxes (fractions of her height H, half
 * widths in meters for a 1.6 m body, scaled with her): legs, hips, torso (shoulders), head. Arms, hair and skirts are not modelled
 * (a box is a rough stand-in; the preview shows by how much). A lean about the waist pivot moves everything above it sideways by
 * (height above the pivot) x sin(lean); the boxes stay axis-aligned (the tilt's own widening is ignored: second order for the
 * leans she makes, <= 0.5 rad).
 */
import { projectToDip, type Placement, type Rect, type Vec3, type WorldView } from '../world';
import { coveredArea } from './geometry';
import type { SurfaceWindow } from './windows';

export type PartName = 'legs' | 'hips' | 'torso' | 'head';
export interface PartSpec { name: PartName; from: number; to: number; halfWidthM: number }
/** Heights as fractions of H; half widths for a 1.6 m body. */
export const PARTS: readonly PartSpec[] = Object.freeze(([
  { name: 'legs', from: 0, to: 0.5, halfWidthM: 0.13 },
  { name: 'hips', from: 0.5, to: 0.6, halfWidthM: 0.16 },
  { name: 'torso', from: 0.6, to: 0.84, halfWidthM: 0.2 },
  { name: 'head', from: 0.85, to: 1, halfWidthM: 0.09 },
] as PartSpec[]).map(p => Object.freeze(p)));
/** The waist pivot of a lean (fraction of H) and the shoulder line (fraction of H). */
export const PIVOT_FRACTION = 0.58;
export const SHOULDER_FRACTION = 0.82;
export const SHOULDER_HALF_WIDTH_M = 0.22;
const REFERENCE_HEIGHT_M = 1.6;

export interface Her { placement: Placement; heightM: number }
export interface BodyPose {
  /** Lean about the waist, rad; + = toward world +x (her left when she faces you, the right of the screen). */
  leanRad: number;
  /** Raised on her toes / her hips lifted (m). */
  riseM: number;
}
export const UPRIGHT: Readonly<BodyPose> = Object.freeze({ leanRad: 0, riseM: 0 });

/** Her scale against the reference body. */
export const bodyScale = (her: Her) => her.heightM / REFERENCE_HEIGHT_M;

/** Sideways shift (m) of a point at `fraction` of her height caused by the lean. */
export function leanShiftM(her: Her, fraction: number, leanRad: number): number {
  return fraction > PIVOT_FRACTION ? (fraction - PIVOT_FRACTION) * her.heightM * Math.sin(leanRad) : 0;
}

export interface PartRect { name: PartName; rect: Rect }
/** Where each box shows on the display (DIP). null when the box is not in front of the eye (never for depth >= 0.6 m). */
export function partRects(view: WorldView, her: Her, pose: BodyPose = UPRIGHT): PartRect[] | null {
  const k = bodyScale(her), x0 = her.placement.xM, z = -her.placement.depthM;
  const out: PartRect[] = [];
  for (const spec of PARTS) {
    const mid = (spec.from + spec.to) / 2, shift = leanShiftM(her, mid, pose.leanRad);
    const hw = spec.halfWidthM * k;
    const lo = projectToDip(view, { x: x0 + shift - hw, y: spec.from * her.heightM + pose.riseM, z } as Vec3);
    const hi = projectToDip(view, { x: x0 + shift + hw, y: spec.to * her.heightM + pose.riseM, z } as Vec3);
    if (!lo || !hi) return null;
    out.push({ name: spec.name, rect: { x: Math.min(lo.x, hi.x), y: Math.min(lo.y, hi.y), width: Math.abs(hi.x - lo.x), height: Math.abs(hi.y - lo.y) } });
  }
  return out;
}

export interface OcclusionReport {
  parts: { name: PartName; hidden: number; rect: Rect }[];
  /** Area-weighted over the four boxes, 0 = all of her shows, 1 = none. */
  hidden: number;
  /** Fraction of the head box that shows (1 - hidden of the head). */
  headShown: number;
  /** Whole figure's bounding rectangle on the display (DIP). */
  box: Rect;
}

/** How much of her the windows hide. All windows are in front of her; the union is what counts. */
export function occlusion(view: WorldView, windows: readonly SurfaceWindow[], her: Her, pose: BodyPose = UPRIGHT): OcclusionReport | null {
  const rects = partRects(view, her, pose);
  if (!rects) return null;
  const covers = windows.map(w => w.rect);
  let total = 0, hiddenArea = 0;
  const parts = rects.map(p => {
    const area = p.rect.width * p.rect.height, hidden = area > 0 ? coveredArea(p.rect, covers) : 0;
    total += area; hiddenArea += hidden;
    return { name: p.name, hidden: area > 0 ? hidden / area : 0, rect: p.rect };
  });
  const xs = rects.flatMap(p => [p.rect.x, p.rect.x + p.rect.width]), ys = rects.flatMap(p => [p.rect.y, p.rect.y + p.rect.height]);
  const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  return { parts, hidden: total > 0 ? hiddenArea / total : 0, headShown: 1 - (parts.find(p => p.name === 'head')?.hidden ?? 0), box };
}

/** The world point on her depth plane that shows at this display point. */
export function unprojectAtDepth(view: WorldView, dip: { x: number; y: number }, depthM: number): Vec3 {
  const t = view.viewerDistanceM / (view.viewerDistanceM + depthM);
  const mx = view.screen.widthM / view.display.width, my = view.screen.heightM / view.display.height;
  return {
    x: (dip.x - (view.display.x + view.display.width / 2)) * mx / t,
    y: view.eyeHeightM - (dip.y - (view.display.y + view.display.height / 2)) * my / t,
    z: -depthM,
  };
}

/** Meters at her depth per DIP of display (horizontal, vertical). */
export function metersPerDipAt(view: WorldView, depthM: number): { x: number; y: number } {
  const s = (view.viewerDistanceM + depthM) / view.viewerDistanceM;
  return { x: view.screen.widthM / view.display.width * s, y: view.screen.heightM / view.display.height * s };
}
