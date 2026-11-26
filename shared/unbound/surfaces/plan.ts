/**
 * Unbound U4: what she can do with windows. Three plans, all computed from the display's rectangles and her own size: peek
 * around an edge, lean on a window's side, stand in a gap between windows. Output is numbers (where to stand, how far to lean,
 * where the head goes, what you will see); turning them into goals for the body is src/unbound/surfaces/targets.ts, and the spring
 * layer (layer 3) makes them move like a person. Nothing here moves a window or reads one: windows arrive as a list
 * (windows.ts) and she only ever acts on her side of the glass.
 *
 * The "natural" numbers (how much of the head shows, how far she leans, which side) are inputs with sane defaults, not constants
 * of the world: the caller picks them per moment from mood and character (un-fixed on purpose, docs/claude/2026-11-14-unbound-night-e4-surfaces.md).
 */
import { DEPTH_RANGE_M, eyePosition, type Placement, type Vec3, type WorldView } from '../world';
import { findEdges, freeIntervals, right, type Interval, type SurfaceEdge } from './geometry';
import { PARTS, PIVOT_FRACTION, SHOULDER_FRACTION, SHOULDER_HALF_WIDTH_M, UPRIGHT, bodyScale, leanShiftM, metersPerDipAt, occlusion, partRects, unprojectAtDepth, type BodyPose, type Her, type OcclusionReport } from './body';
import type { SurfaceWindow } from './windows';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const part = (name: string) => PARTS.find(p => p.name === name)!;
const HEAD_MID = (part('head').from + part('head').to) / 2;

export interface PlanBase {
  /** Where she stands (root on her floor) and the pose she takes there. */
  stand: Placement;
  pose: BodyPose;
  /** Her head centre and where she looks (your eye), world m. */
  head: Vec3;
  gaze: Vec3;
  /** Head turn toward you, rad (0 = facing +z; + = toward her left, +x), and pitch (+ = down). */
  gazeYaw: number;
  gazePitch: number;
  /** What the windows hide at the end of the plan. */
  predicted: OcclusionReport;
  /** Sideways distance from where she is now to the stand point (m). */
  walkM: number;
  /** She can really do it (the shown parts match the intent). When false, `notes` says what is off. */
  feasible: boolean;
  notes: string[];
}

function finish(view: WorldView, windows: readonly SurfaceWindow[], her: Her, stand: Placement, pose: BodyPose): Pick<PlanBase, 'stand' | 'pose' | 'head' | 'gaze' | 'gazeYaw' | 'gazePitch' | 'predicted' | 'walkM'> | null {
  const next: Her = { ...her, placement: stand };
  const predicted = occlusion(view, windows, next, pose);
  if (!predicted) return null;
  const head: Vec3 = { x: stand.xM + leanShiftM(next, HEAD_MID, pose.leanRad), y: HEAD_MID * her.heightM + pose.riseM, z: -stand.depthM };
  const gaze = eyePosition(view);
  const dx = gaze.x - head.x, dz = gaze.z - head.z, flat = Math.hypot(dx, dz);
  return { stand, pose, head, gaze, gazeYaw: Math.atan2(dx, dz), gazePitch: Math.atan2(head.y - gaze.y, flat), predicted, walkM: Math.abs(stand.xM - her.placement.xM) };
}

// ---- peek around an edge --------------------------------------------------------------------------------------------------------

export interface PeekOptions {
  /** Depth to stand at (m); default: where she is. */
  depthM?: number;
  /** How much of the head shows past the edge, 0..1 (default 0.55: most of a face). */
  reveal?: number;
  /** The largest lean she will make (rad, default 0.6). */
  maxLeanRad?: number;
  /** She leans only as far as she must to keep this share of her torso hidden (default 0.6: a shoulder may show). */
  hideTorso?: number;
  /** The most she will rise on her toes (m, default 0.08), used for a top edge. */
  maxRiseM?: number;
  /** Which edges to consider (default all of left, right, top). */
  sides?: readonly SurfaceEdge['side'][];
  /** Ignore edges whose usable stretch is shorter than this many of her head heights (default 1.2). */
  minSpanHeads?: number;
}
export interface PeekPlan extends PlanBase { kind: 'peek'; edge: SurfaceEdge; reveal: number }

/** The sign of "outward" from the window for a side edge (+1: toward +x). */
const outward = (side: SurfaceEdge['side']) => (side === 'right' ? 1 : -1);

function scanLean(view: WorldView, windows: readonly SurfaceWindow[], her: Her, xe: number, dir: number, reveal: number, maxLean: number, hideTorso: number): { stand: Placement; pose: BodyPose } {
  const k = bodyScale(her), headHalf = part('head').halfWidthM * k;
  const headX = xe + dir * headHalf * (2 * reveal - 1);
  let best: { stand: Placement; pose: BodyPose; torso: number } | null = null;
  for (let step = 0; step <= 40; step++) {
    const lean = dir * maxLean * step / 40;
    const stand = { xM: headX - leanShiftM(her, HEAD_MID, lean), depthM: her.placement.depthM };
    const pose = { leanRad: lean, riseM: 0 };
    const o = occlusion(view, windows, { ...her, placement: stand }, pose);
    const torso = o?.parts.find(p => p.name === 'torso')?.hidden ?? 0;
    if (torso >= hideTorso) return { stand, pose };
    if (!best || torso > best.torso) best = { stand, pose, torso };
  }
  return best!;
}

/**
 * The best edge to peek around, or null when there is none (no windows, all edges on the display border, windows too small to
 * hide behind...). Left and right edges: she stands behind the window and leans her head out past the edge until `reveal` of it
 * shows; top edges: she stands behind the window's top and rises until her head clears it. Cost: how far she must walk, plus a
 * large penalty when the result is not what was asked for (still returned if it is the best there is, with feasible = false).
 */
export function planPeek(view: WorldView, rawWindows: readonly SurfaceWindow[], her: Her, options: PeekOptions = {}): PeekPlan | null {
  const windows = rawWindows;
  const depthM = clamp(options.depthM ?? her.placement.depthM, DEPTH_RANGE_M[0], DEPTH_RANGE_M[1]);
  const here: Her = { ...her, placement: { xM: her.placement.xM, depthM } };
  const reveal = clamp(options.reveal ?? 0.55, 0.15, 0.95), maxLean = clamp(options.maxLeanRad ?? 0.6, 0, 0.9), hideTorso = clamp(options.hideTorso ?? 0.6, 0, 1);
  const maxRise = clamp(options.maxRiseM ?? 0.08, 0, 0.2), sides = options.sides ?? ['left', 'right', 'top'];
  const upright = partRects(view, here, UPRIGHT);
  if (!upright) return null;
  const headRect = upright.find(p => p.name === 'head')!.rect;
  const mpd = metersPerDipAt(view, depthM), k = bodyScale(here);
  const display = view.display;
  let best: { plan: PeekPlan; cost: number } | null = null;
  for (const edge of findEdges(windows, display, headRect.height * (options.minSpanHeads ?? 1.2))) {
    if (!sides.includes(edge.side)) continue;
    const notes: string[] = [];
    let stand: Placement, pose: BodyPose;
    if (edge.side === 'top') {
      // Rise until the head's centre sits `reveal` of its height above the edge; stand where the head is inside the stretch.
      const hhDip = headRect.height / 2, centreY = edge.at + hhDip * (1 - 2 * reveal);
      const natural = headRect.y + hhDip, rise = clamp((natural - centreY) * mpd.y, 0, maxRise);
      const xDip = clamp(unprojectToDipX(view, her.placement.xM, depthM), edge.span[0] + headRect.width, edge.span[1] - headRect.width);
      stand = { xM: unprojectAtDepth(view, { x: xDip, y: 0 }, depthM).x, depthM };
      pose = { leanRad: 0, riseM: rise };
      const reached = natural - rise * (1 / mpd.y);
      if (reached - centreY > hhDip * 0.5) notes.push('even on her toes her head stays below the edge: stand farther back or pick another edge');
    } else {
      const dir = outward(edge.side), xe = unprojectAtDepth(view, { x: edge.at, y: 0 }, depthM).x;
      const found = scanLean(view, windows, here, xe, dir, reveal, maxLean, hideTorso);
      stand = found.stand; pose = found.pose;
      // Her head must be level with the usable stretch (not past the window's top or bottom).
      const headMid = headRect.y + headRect.height / 2;
      if (headMid < edge.span[0] + headRect.height * 0.3 || headMid > edge.span[1] - headRect.height * 0.3) notes.push('her head is not level with this edge at her depth');
    }
    const done = finish(view, windows, here, stand, pose);
    if (!done) continue;
    const headShown = done.predicted.headShown, torsoHidden = done.predicted.parts.find(p => p.name === 'torso')?.hidden ?? 0;
    if (Math.abs(headShown - reveal) > 0.2) notes.push(`head shows ${(headShown * 100).toFixed(0)}% instead of ${(reveal * 100).toFixed(0)}%`);
    if (edge.side !== 'top' && torsoHidden < hideTorso - 0.25) notes.push(`her body shows (${((1 - torsoHidden) * 100).toFixed(0)}% of the torso): window too narrow to hide behind`);
    void k;
    const plan: PeekPlan = { kind: 'peek', edge, reveal, ...done, feasible: notes.length === 0, notes };
    const cost = done.walkM + (plan.feasible ? 0 : 50 + notes.length * 5);
    if (!best || cost < best.cost) best = { plan, cost };
  }
  return best?.plan ?? null;
}
const unprojectToDipX = (view: WorldView, xM: number, depthM: number) => {
  const t = view.viewerDistanceM / (view.viewerDistanceM + depthM);
  return view.display.x + view.display.width / 2 + xM * t / (view.screen.widthM / view.display.width);
};

// ---- lean on a window's side ----------------------------------------------------------------------------------------------------

export interface LeanOptions {
  depthM?: number;
  /** How far she leans into the window (rad, default 0.12: leaning, not falling). */
  leanRad?: number;
  /** Space left between her shoulder and the edge (m, default 0: touching). */
  gapM?: number;
  sides?: readonly ('left' | 'right')[];
}
export interface LeanPlan extends PlanBase { kind: 'lean'; edge: SurfaceEdge; /** Where the shoulder touches the edge, world m. */ contact: Vec3 }

/**
 * Stand beside a window with the shoulder on its side edge. The edge must be the border of free glass over her whole body's
 * height (the usable stretch covers her torso at this depth), and the free glass beside it must be wide enough for her.
 */
export function planLeanOn(view: WorldView, windows: readonly SurfaceWindow[], her: Her, options: LeanOptions = {}): LeanPlan | null {
  const depthM = clamp(options.depthM ?? her.placement.depthM, DEPTH_RANGE_M[0], DEPTH_RANGE_M[1]);
  const here: Her = { ...her, placement: { xM: her.placement.xM, depthM } };
  const theta = clamp(options.leanRad ?? 0.12, 0, 0.4), gap = Math.max(0, options.gapM ?? 0), sides = options.sides ?? ['left', 'right'];
  const upright = partRects(view, here, UPRIGHT);
  if (!upright) return null;
  const torso = upright.find(p => p.name === 'torso')!.rect, k = bodyScale(here);
  let best: { plan: LeanPlan; cost: number } | null = null;
  for (const edge of findEdges(windows, view.display, torso.height)) {
    if (edge.side === 'top' || !sides.includes(edge.side)) continue;
    const dir = outward(edge.side); // she stands on the outside
    const lean = -dir * theta;
    const xe = unprojectAtDepth(view, { x: edge.at, y: 0 }, depthM).x;
    const stand: Placement = { xM: xe + dir * (SHOULDER_HALF_WIDTH_M * k + gap + (SHOULDER_FRACTION - PIVOT_FRACTION) * her.heightM * Math.sin(theta)), depthM };
    const pose: BodyPose = { leanRad: lean, riseM: 0 };
    const done = finish(view, windows, here, stand, pose);
    if (!done) continue;
    const notes: string[] = [];
    if (torso.y < edge.span[0] - 1 || torso.y + torso.height > edge.span[1] + 1) notes.push('the edge does not reach all of her torso at this depth (she would lean on a corner)');
    if (done.predicted.hidden > 0.03) notes.push(`${(done.predicted.hidden * 100).toFixed(0)}% of her is behind another window or past the screen edge`);
    const plan: LeanPlan = { kind: 'lean', edge, contact: { x: xe, y: SHOULDER_FRACTION * her.heightM, z: -depthM }, ...done, feasible: notes.length === 0, notes };
    const cost = done.walkM + (plan.feasible ? 0 : 50 + notes.length * 5);
    if (!best || cost < best.cost) best = { plan, cost };
  }
  return best?.plan ?? null;
}

// ---- between two windows ---------------------------------------------------------------------------------------------------------

export interface BetweenOptions { depthM?: number; /** Free room she wants on each side of her torso (m, default 0.04). */ clearanceM?: number }
export interface BetweenPlan extends PlanBase {
  kind: 'between';
  /** The free stretch she is in or goes to (display DIP), its width at her depth (m), and what bounds it on each side. */
  gap: Interval; gapM: number; bounds: { left: 'window' | 'display'; right: 'window' | 'display' };
  /** frontal: her shoulders fit squarely; sideways: only if she turns (shoulders about half as deep as wide); none: she is cut off by a window. */
  mode: 'frontal' | 'sideways' | 'none';
}

/** The free stretch of glass nearest to her body band, and how she stands in it. null when the whole display is covered. */
export function planBetween(view: WorldView, windows: readonly SurfaceWindow[], her: Her, options: BetweenOptions = {}): BetweenPlan | null {
  const depthM = clamp(options.depthM ?? her.placement.depthM, DEPTH_RANGE_M[0], DEPTH_RANGE_M[1]);
  const here: Her = { ...her, placement: { xM: her.placement.xM, depthM } };
  const clear = Math.max(0, options.clearanceM ?? 0.04);
  const upright = partRects(view, here, UPRIGHT);
  if (!upright) return null;
  const box = occlusion(view, windows, here)?.box;
  if (!box) return null;
  const free = freeIntervals(windows, view.display, [box.y, box.y + box.height]);
  if (!free.length) return null;
  const herX = box.x + box.width / 2;
  const gap = free.reduce((a, b) => dist(a, herX) <= dist(b, herX) ? a : b);
  const mpd = metersPerDipAt(view, depthM), k = bodyScale(here);
  const gapM = (gap[1] - gap[0]) * mpd.x;
  const torsoHalf = part('torso').halfWidthM * k, sidewaysHalf = torsoHalf * 0.55;
  const mode = gapM >= 2 * (torsoHalf + clear) ? 'frontal' : gapM >= 2 * (sidewaysHalf + clear) ? 'sideways' : 'none';
  const centre = unprojectAtDepth(view, { x: (gap[0] + gap[1]) / 2, y: 0 }, depthM).x;
  // Inside a gap she stays where she is when her body already fits; otherwise she goes to the middle.
  const stand: Placement = { xM: mode === 'none' ? her.placement.xM : centre, depthM };
  const done = finish(view, windows, here, stand, UPRIGHT);
  if (!done) return null;
  const notes: string[] = [];
  if (mode === 'none') notes.push('the gap is narrower than a turned body: she is cut off by the windows');
  if (mode === 'sideways') notes.push('only fits turned sideways; shoulders square she would be clipped by the windows');
  const bounds = { left: gap[0] <= view.display.x + 0.5 ? 'display' as const : 'window' as const, right: gap[1] >= right(view.display) - 0.5 ? 'display' as const : 'window' as const };
  return { kind: 'between', gap, gapM, bounds, mode, ...done, feasible: mode === 'frontal', notes };
}
const dist = (i: Interval, x: number) => (x < i[0] ? i[0] - x : x > i[1] ? x - i[1] : 0);

// ---- how far to stand --------------------------------------------------------------------------------------------------------------

/**
 * The depth (m) at which she looks `fraction` as tall as `windowHeightDip` on the display: the size of a window decides how far
 * back she stands (a big window she hides behind from far away, a small one she can only be next to). Clamped to her depth range.
 */
export function depthToFitWindow(view: WorldView, heightM: number, windowHeightDip: number, fraction = 0.8): number {
  const apparentM = fraction * windowHeightDip * view.screen.heightM / view.display.height;
  const depth = heightM * view.viewerDistanceM / Math.max(1e-6, apparentM) - view.viewerDistanceM;
  return clamp(depth, DEPTH_RANGE_M[0], DEPTH_RANGE_M[1]);
}
