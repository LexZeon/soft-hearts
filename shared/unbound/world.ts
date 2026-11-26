/**
 * Unbound U1 (docs/claude/2026-11-12-unbound-u1-part1.md): her world in meters, and the screen as a camera into it.
 *
 * The world: y is up, her floor is y = 0 (her home's floor, not the taskbar), the screen is the plane z = 0 and the viewer's
 * eye is in front of it at z = +viewerDistance, level with the screen's centre. She lives behind the screen (z < 0). A point
 * `depth` meters behind the screen is seen through the screen at d / (d + depth) of its size: farther is smaller, closer is
 * bigger, and her feet sink below the bottom of the screen as she comes close, as through a real window.
 *
 * The screen's physical size comes from the monitor (EDID / WMI, whole centimeters) when it is believable, otherwise from the
 * nominal 96 DIP per inch. A window shows the part of the world behind its own rectangle of the screen: an off-axis frustum
 * (the generalized perspective projection idea of R. Kooima, 2008; our own code). Pure math, no Three.js and no Electron.
 */

/** The common MMD convention: one model unit is about 8 cm (a 20-unit model stands about 1.6 m). */
export const MMD_UNIT_M = 0.08;
/** Assumed distance from the eye to the screen until the viewer is measured (a knob; laptops ~50-60 cm). */
export const DEFAULT_VIEWER_DISTANCE_M = 0.55;
export const VIEWER_DISTANCE_RANGE_M = Object.freeze([0.3, 1.2] as const);
/**
 * How far behind the screen she may stand. Closer than 0.6 m her body would cut through the glass. I-212 (2026-11-24): 25 m far, so a tall model on a
 * small laptop can still be as small on the screen as the far end of her places (a third of the usable height needs about 20 m there).
 */
export const DEPTH_RANGE_M = Object.freeze([0.6, 25] as const);
/**
 * The host's home depth for its eye fit (eyeHeightFor) and the developer knob's start. Not where she first appears any more: since I-212 (2026-11-24) that is
 * half the usable screen height on every screen (shared/unbound/screen-terms, SCREEN_TERMS_KNOBS.firstSize); 8 m was that on the laptop it was judged on.
 */
export const DEFAULT_DEPTH_M = 8;
/** At her home depth her feet stand this far above the bottom of the work area (DIP). */
export const HOME_FEET_MARGIN_DIP = 12;
/** Her centre, as a fraction of the display width, at first (the companion's usual corner). */
export const DEFAULT_ACROSS = 0.78;
const NOMINAL_DIP_PER_INCH = 96;
const INCH_M = 0.0254;

export interface Rect { x: number; y: number; width: number; height: number }
export interface Vec3 { x: number; y: number; z: number }
/** Electron's display facts, in DIP (logical pixels). */
export interface DisplayFacts { bounds: Rect; workArea: Rect; scaleFactor: number; internal: boolean }
/** One monitor's size as the system reports it (whole centimeters). `internal`: an embedded panel, when known. */
export interface MonitorMeasurement { widthCm: number; heightCm: number; source: 'edid' | 'wmi'; internal: boolean | null }
export interface PhysicalScreen {
  widthM: number;
  heightM: number;
  /** measured: the monitor's own numbers; dpi: the nominal 96 DIP per inch (can be ~20% off); override: set by hand. */
  source: 'measured' | 'dpi' | 'override';
  /** Short reason, for the developer view (no serial numbers, no model names). */
  detail: string;
}
export interface Placement { xM: number; depthM: number }
export interface WorldView {
  screen: PhysicalScreen;
  /** The whole display, DIP (its centre is the screen's centre). */
  display: Rect;
  viewerDistanceM: number;
  /**
   * The eye's height above her floor. The host sends its home fit (eyeHeightFor); full-screen's page frames her with its own every frame
   * (the floor follows her depth, shared/unbound/framing/floor.ts, 2026-11-21).
   */
  eyeHeightM: number;
}
export interface Frustum { left: number; right: number; top: number; bottom: number; near: number; far: number }

const finite = (value: number) => typeof value === 'number' && Number.isFinite(value);
const clampTo = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, value));

/**
 * A believable measurement for a display with this pixel aspect: sizes in a real range, the aspect within 12% of the pixels'
 * (EDID heights are often rounded), and not the 16 x 9 / 160 x 90 placeholder that many external monitors and TVs report.
 */
export function plausibleMeasurement(measurement: MonitorMeasurement, pixelAspect: number): boolean {
  const { widthCm: w, heightCm: h } = measurement;
  if (!finite(w) || !finite(h) || w < 10 || h < 5 || w > 400 || h > 300 || !(pixelAspect > 0)) return false;
  if ((w === 16 && h === 9) || (w === 160 && h === 90)) return false;
  return Math.abs(w / h / pixelAspect - 1) <= 0.12;
}

/**
 * The primary display's physical size. A measurement is used when it is believable and it is clear which monitor it is (an
 * internal display prefers the internal panel's numbers, an external one the others; several that agree within 1 cm count as
 * one). The longer side is taken from the measurement (whole cm: the smaller relative error) and the other from the pixels'
 * aspect, so the size never disagrees with the picture. Otherwise the nominal 96 DIP per inch.
 */
export function resolvePhysicalScreen(display: DisplayFacts, measurements: readonly MonitorMeasurement[] | null, override?: { widthCm: number } | null): PhysicalScreen {
  const { width, height } = display.bounds;
  const aspect = width / height;
  const fromWidth = (widthM: number, source: PhysicalScreen['source'], detail: string): PhysicalScreen => ({ widthM, heightM: widthM / aspect, source, detail });
  if (override && finite(override.widthCm) && override.widthCm >= 10 && override.widthCm <= 400) return fromWidth(override.widthCm / 100, 'override', 'set by hand');
  const dpi = () => fromWidth(width / NOMINAL_DIP_PER_INCH * INCH_M, 'dpi', measurements === null ? 'no measurement' : 'measurement not usable');
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return { widthM: 0.34, heightM: 0.21, source: 'dpi', detail: 'no display size' };
  if (!measurements?.length) return dpi();
  let candidates = measurements.filter(m => plausibleMeasurement(m, aspect));
  const sameKind = candidates.filter(m => m.internal === display.internal);
  if (sameKind.length) candidates = sameKind;
  if (!candidates.length) return dpi();
  const first = candidates[0];
  if (candidates.some(m => Math.abs(m.widthCm - first.widthCm) > 1 || Math.abs(m.heightCm - first.heightCm) > 1)) return { ...dpi(), detail: 'monitors disagree' };
  const longM = Math.max(first.widthCm, first.heightCm) / 100;
  const result = aspect >= 1 ? fromWidth(longM, 'measured', first.source) : { widthM: longM * aspect, heightM: longM, source: 'measured' as const, detail: first.source };
  return result;
}

export function metersPerDip(view: Pick<WorldView, 'screen' | 'display'>): { x: number; y: number } {
  return { x: view.screen.widthM / view.display.width, y: view.screen.heightM / view.display.height };
}

/**
 * The eye's height above her floor such that someone standing `homeDepthM` behind the screen has their feet `feetMarginDip`
 * above the bottom of the work area. The host's eye for the scene (her home fit); since 2026-11-21 the full-screen page moves the eye
 * with her depth (shared/unbound/framing/floor.ts: the same formula at the depth she stands), so her feet stay on that line wherever she
 * fits on the screen.
 */
export function eyeHeightFor(screen: PhysicalScreen, display: DisplayFacts, viewerDistanceM: number, homeDepthM = DEFAULT_DEPTH_M, feetMarginDip = HOME_FEET_MARGIN_DIP): number {
  const my = screen.heightM / display.bounds.height;
  const centreY = display.bounds.y + display.bounds.height / 2;
  const feetY = display.workArea.y + display.workArea.height - feetMarginDip;
  const belowCentreM = Math.max(0.005, (feetY - centreY) * my);
  return belowCentreM * (viewerDistanceM + homeDepthM) / viewerDistanceM;
}

/** Where a world point shows on the display, in DIP; `scale`: on-screen meters per world meter at its depth. null: not in front of the eye. */
export function projectToDip(view: WorldView, point: Vec3): { x: number; y: number; scale: number } | null {
  const d = view.viewerDistanceM, ahead = d - point.z;
  if (!(ahead > 1e-6)) return null;
  const t = d / ahead, m = metersPerDip(view);
  return {
    x: view.display.x + view.display.width / 2 + point.x * t / m.x,
    y: view.display.y + view.display.height / 2 - (point.y - view.eyeHeightM) * t / m.y,
    scale: t,
  };
}

/** How tall something `heightM` tall looks on the screen when it stands `depthM` behind it. */
export function apparentHeightM(heightM: number, depthM: number, viewerDistanceM: number): number {
  return heightM * viewerDistanceM / (viewerDistanceM + depthM);
}
/** The depth at which something `heightM` tall looks `apparentM` tall on the screen. */
export function depthForApparentHeight(heightM: number, apparentM: number, viewerDistanceM: number): number {
  return heightM * viewerDistanceM / apparentM - viewerDistanceM;
}

export function eyePosition(view: WorldView): Vec3 { return { x: 0, y: view.eyeHeightM, z: view.viewerDistanceM }; }

/**
 * The frustum through `through` (a rectangle of the display, DIP) from the eye: near-plane extents relative to the eye, for an
 * off-axis perspective camera at eyePosition() looking down -z. With the window's own bounds it is a true window into her
 * world (a small window shows a small part of it); with the display's bounds it shows the whole screen's view scaled into
 * whatever window draws it (the small preview).
 */
export function windowFrustum(view: WorldView, through: Rect, near = 0.05, far = 200): Frustum {
  const m = metersPerDip(view), d = view.viewerDistanceM;
  const cx = view.display.x + view.display.width / 2, cy = view.display.y + view.display.height / 2;
  const k = near / d;
  return {
    left: (through.x - cx) * m.x * k, right: (through.x + through.width - cx) * m.x * k,
    top: (cy - through.y) * m.y * k, bottom: (cy - through.y - through.height) * m.y * k,
    near, far,
  };
}

/** Pixels per world meter, on a viewport `viewportHeightPx` tall drawing `frustum`, for a point `aheadM` in front of the eye. */
export function pixelsPerMeter(frustum: Frustum, viewportHeightPx: number, aheadM: number): number {
  return aheadM > 1e-6 ? viewportHeightPx / (frustum.top - frustum.bottom) * frustum.near / aheadM : 0;
}

export function clampPlacement(placement: Placement): Placement {
  return { xM: finite(placement.xM) ? clampTo(placement.xM, [-50, 50]) : 0, depthM: finite(placement.depthM) ? clampTo(placement.depthM, DEPTH_RANGE_M) : DEFAULT_DEPTH_M };
}

/** She stands `depthM` behind the screen with her centre at `across` of the display width (as seen from the eye). */
export function placementAcross(view: Pick<WorldView, 'screen' | 'viewerDistanceM'>, across = DEFAULT_ACROSS, depthM = DEFAULT_DEPTH_M): Placement {
  const onScreen = (across - 0.5) * view.screen.widthM;
  return clampPlacement({ xM: onScreen * (view.viewerDistanceM + depthM) / view.viewerDistanceM, depthM });
}

/** Her standing point in the world (on the floor). */
export function standingPoint(placement: Placement): Vec3 { return { x: placement.xM, y: 0, z: -placement.depthM }; }

export function clampViewerDistance(value: number): number {
  return finite(value) ? clampTo(value, VIEWER_DISTANCE_RANGE_M) : DEFAULT_VIEWER_DISTANCE_M;
}
