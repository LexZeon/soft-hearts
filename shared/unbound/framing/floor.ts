/**
 * Full-screen Unbound: the floor follows her (the user's choice A).
 *
 * The world camera (shared/unbound/world.ts) used one eye height for a whole session, fitted so that only at her home depth (8 m) her feet
 * stood on the work area's bottom; nearer, her feet sank behind the taskbar. Here the eye height is a function of how far back she stands,
 * in three bands (pure math, meters; the page follows it every frame, src/unbound/floor-framing.ts):
 *
 *   floor     she fits the work area: her feet are on the floor line (the work area's bottom, HOME_FEET_MARGIN_DIP above it), at any depth;
 *             nearer only makes her bigger. Eye = floorPerM × (viewer distance + depth): eyeHeightFor() at that depth.
 *   fit       nearer than `fitDepthM` she no longer fits with her feet on the line: her crown stays `topMarginShare` below the work area's
 *             top and her feet sink (a smooth max of the two, so the hand-over has no kink).
 *   close     from `fitDepthM` down to `closeDepthM` the eye moves on (a quintic ease) to her face's height: the close-up. There her face is on
 *             the window's middle line, so coming to the lens (the peek) or being pulled to the nearest stations fills the screen with her face
 *             or one eye, as the I-159 E stations were designed ("the camera is at eye height").
 *
 * The camera never turns and its frustum does not depend on the eye height, so moving the eye moves the whole world up or down on the screen
 * and nothing else: hit testing, her bubble, her gaze and the hands read the same camera in the same frame.
 */
import { HOME_FEET_MARGIN_DIP, type PhysicalScreen, type Rect } from '../world';
import { FLOOR_FRAMING_KNOBS, type FloorFramingKnobs } from './knobs';

/** What of the scene's world the framing needs (shared/unbound/scene.ts UnboundWorld has all of it). */
export interface FramingWorld { screen: PhysicalScreen; display: Rect; workArea: Rect; viewerDistanceM: number }
export interface FramingGeometry {
  viewerDistanceM: number;
  /** The eye height per meter of (viewer distance + depth) that puts her soles on the floor line. */
  floorPerM: number;
  /** Per meter of (viewer distance + depth): how far below her crown the eye may be with her crown on the top line. */
  crownPerM: number;
}
export interface FramingBand { fitDepthM: number; closeDepthM: number }
/** Her measures for the framing: height (m) and her face's height above her floor (m; the head's middle). */
export interface FramedBody { heightM: number; faceM: number }

/** The width of the smooth max between the floor and the crown bands (m of eye height): exact outside it. */
export const FIT_SOFT_M = 0.03;
/** Her face's height as a share of her height when the model does not tell (the bundled Gene: 0.92). */
export const FACE_SHARE_FALLBACK = 0.92;

const finite = (value: number) => typeof value === 'number' && Number.isFinite(value);
const S5 = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 + x * (-15 + 6 * x)); };
/** max(a, b), rounded over a width k (C1, exact when |a − b| ≥ k). */
export function smoothMax(a: number, b: number, k = FIT_SOFT_M): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k / 4;
}

export function framingGeometry(world: FramingWorld, knobs: FloorFramingKnobs = FLOOR_FRAMING_KNOBS): FramingGeometry | null {
  const { screen, display, workArea } = world, d = world.viewerDistanceM;
  if (!finite(d) || d <= 0 || !(display.height > 0) || !(screen.heightM > 0) || !(workArea.height > 0)) return null;
  const my = screen.heightM / display.height, centreY = display.y + display.height / 2;
  const feetY = workArea.y + workArea.height - HOME_FEET_MARGIN_DIP, topY = workArea.y + workArea.height * knobs.topMarginShare;
  // Same as eyeHeightFor(): the floor line below the screen's centre (at least 5 mm), seen from the eye.
  return { viewerDistanceM: d, floorPerM: Math.max(0.005, (feetY - centreY) * my) / d, crownPerM: Math.max(0, (centreY - topY) * my) / d };
}

/** The eye height that puts her soles on the floor line at `depthM` (eyeHeightFor at that depth). */
export const floorEyeHeight = (g: FramingGeometry, depthM: number) => g.floorPerM * (g.viewerDistanceM + depthM);
/** The eye height that puts the crown of someone `heightM` tall on the top line at `depthM`. */
export const crownEyeHeight = (g: FramingGeometry, depthM: number, heightM: number) => heightM - g.crownPerM * (g.viewerDistanceM + depthM);

/** Where the bands meet for her height: nearer than `fitDepthM` she does not fit with her feet on the line; at `closeDepthM` the close-up holds. */
export function framingBand(g: FramingGeometry, heightM: number, knobs: FloorFramingKnobs = FLOOR_FRAMING_KNOBS): FramingBand | null {
  const per = g.floorPerM + g.crownPerM;
  if (!(heightM > 0) || !(per > 0)) return null;
  const fitDepthM = heightM / per - g.viewerDistanceM;
  if (!(fitDepthM > 0)) return null; // she fits even at the glass: the floor band everywhere
  return { fitDepthM, closeDepthM: fitDepthM * Math.min(0.95, Math.max(0, knobs.closeShare)) };
}

/** The eye height for her standing `depthM` behind the screen. */
export function framedEyeHeight(g: FramingGeometry, depthM: number, body: FramedBody, knobs: FloorFramingKnobs = FLOOR_FRAMING_KNOBS): number {
  const depth = Math.max(depthM, 0.01 - g.viewerDistanceM); // nearer than the eye: as at the eye (she may bring an eye a few cm from the lens)
  const floor = floorEyeHeight(g, depth), band = framingBand(g, body.heightM, knobs);
  if (!band) return floor;
  const fit = smoothMax(floor, crownEyeHeight(g, depth, body.heightM));
  const span = band.fitDepthM - band.closeDepthM, face = finite(body.faceM) && body.faceM > 0 ? body.faceM : body.heightM * FACE_SHARE_FALLBACK;
  const w = span > 1e-6 ? S5((band.fitDepthM - depth) / span) : depth < band.fitDepthM ? 1 : 0;
  return fit + (face - fit) * w;
}
