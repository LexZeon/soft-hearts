// Unbound U1: her world in meters and the screen as a camera (shared/unbound/world.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apparentHeightM, depthForApparentHeight, eyeHeightFor, eyePosition, metersPerDip, pixelsPerMeter, placementAcross, plausibleMeasurement,
  projectToDip, resolvePhysicalScreen, standingPoint, windowFrustum, DEFAULT_DEPTH_M, HOME_FEET_MARGIN_DIP,
  type DisplayFacts, type MonitorMeasurement, type Rect, type Vec3, type WorldView,
} from '../shared/unbound/world';

// This laptop as U0 measured it: 1536x960 DIP at 2.5, an embedded panel, EDID and WMI both 34 x 22 cm; a 48 DIP taskbar.
const LAPTOP: DisplayFacts = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };
const EDID: MonitorMeasurement = { widthCm: 34, heightCm: 22, source: 'edid', internal: true };
const close = (actual: number, expected: number, tolerance: number, label = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} ≉ ${expected} (±${tolerance})`);

function view(display = LAPTOP, distance = 0.55): WorldView {
  const screen = resolvePhysicalScreen(display, [EDID]);
  return { screen, display: display.bounds, viewerDistanceM: distance, eyeHeightM: eyeHeightFor(screen, display, distance) };
}
/** The same point through the off-axis frustum, as the GPU would draw it into `win` (pixels in that window). */
function throughFrustum(v: WorldView, through: Rect, win: Rect, point: Vec3): { x: number; y: number } {
  const f = windowFrustum(v, through), eye = eyePosition(v), ahead = eye.z - point.z;
  const xn = (point.x - eye.x) * f.near / ahead, yn = (point.y - eye.y) * f.near / ahead;
  const ndcX = (xn - (f.left + f.right) / 2) / ((f.right - f.left) / 2), ndcY = (yn - (f.top + f.bottom) / 2) / ((f.top - f.bottom) / 2);
  return { x: win.x + (ndcX + 1) / 2 * win.width, y: win.y + (1 - ndcY) / 2 * win.height };
}

test('the screen size comes from the monitor when it is believable, with the pixels\' aspect', () => {
  const screen = resolvePhysicalScreen(LAPTOP, [EDID]);
  assert.equal(screen.source, 'measured');
  close(screen.widthM, 0.34, 1e-9, 'width');
  close(screen.heightM, 0.2125, 1e-9, 'height (34 cm / 1.6, not the rounded 22)');
  // A WMI row that agrees within a centimeter is the same monitor.
  assert.equal(resolvePhysicalScreen(LAPTOP, [EDID, { ...EDID, source: 'wmi', heightCm: 21 }]).source, 'measured');
});

test('placeholder, implausible or ambiguous sizes fall back to 96 DIP per inch', () => {
  const dpiWidth = 1536 / 96 * 0.0254;
  for (const measured of [null, [], [{ widthCm: 16, heightCm: 9, source: 'edid', internal: true }], [{ widthCm: 34, heightCm: 34, source: 'edid', internal: true }],
    [{ widthCm: 0, heightCm: 0, source: 'wmi', internal: null }], [EDID, { widthCm: 60, heightCm: 34, source: 'edid', internal: true }]] as (MonitorMeasurement[] | null)[]) {
    const screen = resolvePhysicalScreen(LAPTOP, measured);
    assert.equal(screen.source, 'dpi', JSON.stringify(measured));
    close(screen.widthM, dpiWidth, 1e-9);
    close(screen.widthM / screen.heightM, 1.6, 1e-9);
  }
  assert.equal(plausibleMeasurement({ widthCm: 160, heightCm: 90, source: 'edid', internal: false }, 16 / 9), false);
});

test('an external display takes the external monitor\'s numbers when the laptop panel also reports', () => {
  const external: DisplayFacts = { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1392 }, scaleFactor: 1, internal: false };
  const screen = resolvePhysicalScreen(external, [EDID, { widthCm: 60, heightCm: 34, source: 'edid', internal: false }]);
  assert.equal(screen.source, 'measured');
  close(screen.widthM, 0.6, 1e-9);
  assert.equal(resolvePhysicalScreen(external, [EDID], { widthCm: 59.7 }).source, 'override');
});

test('farther is smaller and closer is bigger, exactly as through a window', () => {
  const d = 0.55, h = 1.6;
  let previous = Infinity;
  for (const depth of [0.6, 1, 2, 4, 8, 15]) {
    const size = apparentHeightM(h, depth, d);
    assert.ok(size < previous, `depth ${depth}`);
    previous = size;
    close(depthForApparentHeight(h, size, d), depth, 1e-9, 'inverse');
  }
  // Twice as far from the eye → half the size.
  close(apparentHeightM(h, 2 * (8 + d) - d, d) / apparentHeightM(h, 8, d), 0.5, 1e-12);
  // At her home depth she is about half the laptop screen tall (≈10 cm of 21 cm).
  close(apparentHeightM(h, DEFAULT_DEPTH_M, d) * 100, 10.29, 0.01, 'cm on screen');
});

test('the eye height puts her feet just above the work area at home, and the floor never moves', () => {
  const v = view();
  close(v.eyeHeightM, 1.46, 0.02, 'eye height (m) for a laptop at 55 cm');
  const home = placementAcross(v);
  const feet = projectToDip(v, standingPoint(home))!;
  close(feet.y, LAPTOP.workArea.height - HOME_FEET_MARGIN_DIP, 1e-6, 'feet at home');
  close(feet.x, LAPTOP.bounds.width * 0.78, 1e-6, 'across');
  // Closer: her feet go below the screen's bottom edge (the window sill), her head stays near eye level.
  const near = projectToDip(v, standingPoint({ xM: 0, depthM: 2 }))!;
  assert.ok(near.y > LAPTOP.bounds.height, `feet at 2 m: ${near.y}`);
  // A point at eye height on the screen plane is the screen's centre.
  const centre = projectToDip(v, { x: 0, y: v.eyeHeightM, z: 0 })!;
  close(centre.x, 768, 1e-9); close(centre.y, 480, 1e-9);
  assert.equal(projectToDip(v, { x: 0, y: 1, z: 1 }), null, 'behind the eye');
});

test('her projected height on the screen is her apparent height', () => {
  const v = view(), m = metersPerDip(v);
  for (const depth of [1, 3, 8]) {
    const feet = projectToDip(v, { x: 0.2, y: 0, z: -depth })!, head = projectToDip(v, { x: 0.2, y: 1.6, z: -depth })!;
    close((feet.y - head.y) * m.y, apparentHeightM(1.6, depth, v.viewerDistanceM), 1e-9, `depth ${depth}`);
  }
});

test('the off-axis frustum draws every point where the screen shows it (full window, part of the screen, and the fit preview)', () => {
  const v = view();
  const points: Vec3[] = [{ x: 0, y: 0, z: -8 }, { x: 2.5, y: 1.6, z: -8 }, { x: -0.4, y: 1.2, z: -1.5 }, { x: 0.05, y: 1.45, z: -0.3 }];
  const work = LAPTOP.workArea, corner = { x: 1000, y: 500, width: 400, height: 300 };
  for (const p of points) {
    const expected = projectToDip(v, p)!;
    for (const win of [LAPTOP.bounds, work, corner]) {
      const drawn = throughFrustum(v, win, win, p);
      close(drawn.x, expected.x, 1e-6, `x through ${JSON.stringify(win)}`);
      close(drawn.y, expected.y, 1e-6, `y through ${JSON.stringify(win)}`);
    }
    // 'fit': the whole display's view scaled into a small window.
    const small = { x: 40, y: 60, width: 480, height: 300 };
    const fit = throughFrustum(v, v.display, small, p);
    close(fit.x, small.x + expected.x * small.width / v.display.width, 1e-6, 'fit x');
    close(fit.y, small.y + expected.y * small.height / v.display.height, 1e-6, 'fit y');
  }
  const centred = windowFrustum(v, v.display);
  close(centred.left, -centred.right, 1e-12, 'eye centred: symmetric');
});

test('pixels per meter at a depth match the projection', () => {
  const v = view(), win = LAPTOP.workArea, f = windowFrustum(v, win);
  for (const depth of [1, 8]) {
    const ahead = v.viewerDistanceM + depth;
    const viaFrustum = pixelsPerMeter(f, win.height, ahead);
    const viaProjection = (projectToDip(v, { x: 0, y: 0, z: -depth })!.y - projectToDip(v, { x: 0, y: 1, z: -depth })!.y);
    close(viaFrustum, viaProjection, 1e-6, `depth ${depth}`);
  }
});
