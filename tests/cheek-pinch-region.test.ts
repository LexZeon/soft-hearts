import assert from 'node:assert/strict';
import test from 'node:test';
import { Bone, Group, PerspectiveCamera, Vector3 } from 'three';
import { CHEEK_HIT_RANGE, projectCheekRegions } from '../src/stage/cheek-pinch-region';
import { hitCheek, type CheekRegion } from '../src/ui/CheekPinch';
import type { BlushAnchors } from '../src/stage/procedural-blush';

const anchors: BlushAnchors = {
  leftEye: [-0.5, 0.5, 0], rightEye: [0.5, 0.5, 0], mouth: [0, -0.4, 0],
  leftCheek: [-0.54, 0, 0], rightCheek: [0.54, 0, 0],
  leftNormal: [0, 0, 1], rightNormal: [0, 0, 1],
  right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1], eyeDistance: 1,
  boneEyeDistance: 1, eyeReference: 'eye-bones', mouthEstimated: false,
  surfaceSource: 'named-face', materialIndices: [0],
};
function setup() {
  const head = new Bone();
  const camera = new PerspectiveCamera(45, 800 / 600, 0.1, 100);
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0);
  return { head, camera, project: (value: BlushAnchors | null = anchors) => projectCheekRegions(value, head, camera, 800, 600, 100) };
}
function screen(point: number[], head: Bone, camera: PerspectiveCamera) {
  const projected = new Vector3().fromArray(point).applyMatrix4(head.matrixWorld).project(camera);
  return { x: (projected.x + 1) * 400, y: (1 - projected.y) * 300 };
}

test('a front-facing calibrated head projects two bounded cheeks without hitting the mouth or scalp', () => {
  const h = setup(), regions = h.project();
  assert.equal(regions.length, 2); assert.deepEqual(regions.map(region => region.side), ['left', 'right']);
  for (const region of regions) {
    assert.equal(hitCheek(region.x, region.y, regions)?.side, region.side);
    assert.equal(region.referenceWidth, 100);
    assert.ok(Math.hypot(region.axisXX, region.axisXY) > Math.hypot(region.axisYX, region.axisYY));
  }
  for (const point of [anchors.mouth, [0, 0.8, 0], [0, 0, 0]]) {
    const value = screen(point, h.head, h.camera);
    assert.equal(hitCheek(value.x, value.y, regions), null);
  }
});

test('head-local calibration follows translated and rolled bones without changing their pose', () => {
  const h = setup(); const parent = new Group(); parent.position.set(0.1, 0.2, 0); parent.add(h.head);
  h.head.position.set(0.3, -0.1, 0.4); h.head.rotation.z = Math.PI / 5;
  const before = { position: h.head.position.toArray(), quaternion: h.head.quaternion.toArray(), scale: h.head.scale.toArray(), aspect: h.camera.aspect };
  const regions = h.project(); assert.equal(regions.length, 2);
  const left = regions[0], expected = screen(anchors.leftCheek, h.head, h.camera);
  assert.ok(Math.abs(left.x - expected.x) < 1e-10 && Math.abs(left.y - expected.y) < 1e-10);
  assert.ok(left.axisXY < -5 && left.axisYX < -5, 'both ellipse axes rotate with the head');
  assert.deepEqual({ position: h.head.position.toArray(), quaternion: h.head.quaternion.toArray(), scale: h.head.scale.toArray(), aspect: h.camera.aspect }, before);
  const mouth = screen(anchors.mouth, h.head, h.camera);
  assert.equal(hitCheek(mouth.x, mouth.y, regions), null);
});

test('rear-facing, extreme side views and normals pointing away from the camera do not offer cheek hits', () => {
  for (const angle of [Math.PI, Math.PI / 2, -Math.PI / 2, Math.PI * 0.49]) {
    const h = setup(); h.head.rotation.y = angle;
    assert.deepEqual(h.project(), []);
  }
  const h = setup();
  assert.deepEqual(h.project({ ...anchors, leftNormal: [0, 0, -1], rightNormal: [0, 0, -1] }), []);
  assert.deepEqual(h.project({ ...anchors, leftNormal: [0, 0, 0], rightNormal: [0, 0, 0] }), []);
});

test('surface normals use inverse-transpose under non-uniform scale', () => {
  const h = setup(); h.camera.position.z = 30; h.head.scale.set(10, 1, 0.1);
  const tilted: BlushAnchors = { ...anchors, leftNormal: [1, 0, 0.02], rightNormal: [1, 0, 0.02] };
  // Inverse transpose magnifies the small +Z component here, so this
  // arrangement faces the camera; a direction transform would fail the gate.
  // The farther camera keeps the deliberately wide head fully on screen.
  assert.equal(h.project(tilted).length, 2);
  h.head.scale.set(0.1, 1, 10);
  assert.deepEqual(h.project(tilted), []);
});

test('points behind the camera, before the near plane and beyond the far plane are rejected', () => {
  for (const z of [10.5, 9.95, -200]) {
    const h = setup(); h.head.position.z = z;
    assert.deepEqual(h.project(), []);
  }
});

test('offscreen geometry, tiny projections and degenerate projected axes fail closed', () => {
  const h = setup(); h.head.position.x = 30;
  assert.deepEqual(h.project(), []);
  h.head.position.set(0, 0, -80);
  assert.deepEqual(h.project(), [], 'the projected cheek half-axis is below three CSS pixels');
  h.head.position.set(0, 0, 0);
  assert.deepEqual(h.project({ ...anchors, up: [1, 1e-8, 0] }), []);
  h.head.scale.set(0, 1, 1);
  assert.deepEqual(h.project(), []);
});

test('missing anchors and non-finite input produce no regions', () => {
  const h = setup(); assert.deepEqual(h.project(null), []);
  for (const value of [
    { ...anchors, eyeDistance: NaN }, { ...anchors, up: [0, Infinity, 0] as [number, number, number] },
    { ...anchors, leftCheek: [NaN, 0, 0] as [number, number, number] },
  ]) assert.deepEqual(h.project(value), []);
  for (const [width, height, reference] of [[NaN, 600, 100], [800, 0, 100], [800, 600, Infinity], [800, 600, 7]])
    assert.deepEqual(projectCheekRegions(anchors, h.head, h.camera, width, height, reference), []);
  h.head.position.x = NaN; assert.deepEqual(h.project(), []); h.head.position.x = 0;
  h.camera.fov = NaN; assert.deepEqual(h.project(), []);
});

test('camera parent/world changes are synchronized before projection', () => {
  const h = setup(); const parent = new Group(); parent.add(h.camera); parent.position.x = 1;
  const regions = h.project(); assert.equal(regions.length, 2);
  assert.ok(regions[0].x < 360, 'camera parent translation is reflected in the hit location');
  parent.position.x = 0;
  assert.ok(h.project()[0].x > regions[0].x);
});

// R05: the reviewed Gene cheek range (CHEEK_HIT_RANGE).
// A flat face laid out like the bundled Gene's probed frame, in eye-distance
// units E: eyes at y=0, mouth 0.889 E below, blush anchors 0.60 E out and 56%
// of the way down (see probeBlushAnchors). Scale multiplies every length.
function geneLikeFace(scale = 1): BlushAnchors {
  const p = (x: number, y: number, z = 0): [number, number, number] => [x * scale, y * scale, z * scale];
  return {
    leftEye: p(-0.5, 0), rightEye: p(0.5, 0), mouth: p(0, -0.889),
    leftCheek: p(-0.6, -0.498, 0.01), rightCheek: p(0.6, -0.498, 0.01),
    leftNormal: [0, 0, 1], rightNormal: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1],
    eyeDistance: scale, boneEyeDistance: scale, eyeReference: 'main-eye-geometry', mouthEstimated: true,
    surfaceSource: 'named-face', materialIndices: [0],
  };
}
const W = 800, H = 600;
function view(scale = 1, target = new Vector3(0, -0.45, 0), distance = 8) {
  const head = new Bone();
  const camera = new PerspectiveCamera(32, W / H, 0.05, 100);
  camera.position.set(target.x * scale, target.y * scale, distance * scale); camera.lookAt(target.clone().multiplyScalar(scale));
  const regions = projectCheekRegions(geneLikeFace(scale), head, camera, W, H, 100, true);
  const at = (x: number, y: number) => {
    const point = new Vector3(x * scale, y * scale, 0).applyMatrix4(head.matrixWorld).project(camera);
    return hitCheek((point.x + 1) * W / 2, (1 - point.y) * H / 2, regions);
  };
  return { regions, at };
}
/** Face-frame points (right cheek; mirrored for the left). */
const COVERED = [
  [0.62, -0.85],  // lower cheek toward the jaw, beside the mouth guard
  [0.72, -0.82],
  [0.85, -0.75],
  [0.95, -0.62],  // outer cheek (the Gene outer-face witness sits at 0.95, -0.68)
  [1.08, -0.45],  // out toward the face edge
  [0.65, -0.38],  // just under the eye guard
];
const NEVER = [
  [0, -0.45], [0.27, -0.45], [0.45, -0.45], [0.45, -0.7],  // nose and the strip beside it
  [0, -0.889], [0.35, -0.9], [0.5, -1.2],                  // mouth, mouth corner, chin
  [0.5, 0], [0.5, -0.3], [0.8, -0.1],                      // eye, lower lid, outer corner
  [1.0, 0.2], [0, 0.5],                                    // temple above the cheek, forehead
];

test('each reviewed cheek reaches out to the face edge and down toward the jaw', () => {
  const h = view();
  assert.equal(h.regions.length, 2);
  for (const [x, y] of COVERED) {
    assert.equal(h.at(x, y)?.side, 'right', `right cheek covers (${x}, ${y})`);
    assert.equal(h.at(-x, y)?.side, 'left', `left cheek covers (${-x}, ${y})`);
  }
});

test('the larger range still never offers the nose, mouth, eyes, chin or temple', () => {
  const h = view();
  for (const [x, y] of NEVER) {
    assert.equal(h.at(x, y), null, `(${x}, ${y}) stays out`);
    assert.equal(h.at(-x, y), null, `(${-x}, ${y}) stays out`);
  }
  // Not hugging the nose: nothing within half an eye distance of the midline,
  // anywhere between the eye guard and the mouth.
  for (let y = -0.3; y >= -0.95; y -= 0.05) for (let x = 0; x < 0.5; x += 0.02) {
    assert.equal(h.at(x, y), null, `(${x.toFixed(2)}, ${y.toFixed(2)})`);
    assert.equal(h.at(-x, y), null);
  }
});

test('most of the reachable cheek is a hit, not a small spot', () => {
  const h = view();
  // The front-view cheek skin a pointer can reach on the bundled Gene: from the
  // mouth guard (0.58 E) out to the jaw silhouette, from under the eye guard
  // down to the jaw. Edge x per height was read off the real geometry.
  const jaw: [number, number][] = [[-0.32, 1.1], [-0.5, 1.1], [-0.6, 1.05], [-0.67, 0.95], [-0.75, 0.85], [-0.82, 0.75], [-0.9, 0.68]];
  const edge = (y: number) => {
    for (let i = 1; i < jaw.length; i++) if (y >= jaw[i][0]) {
      const [y0, x0] = jaw[i - 1], [y1, x1] = jaw[i]; return x0 + (x1 - x0) * (y - y0) / (y1 - y0);
    }
    return 0;
  };
  let samples = 0, hits = 0;
  for (let y = -0.32; y >= -0.9; y -= 0.02) for (let x = 0.58; x <= edge(y); x += 0.02) { samples++; if (h.at(x, y)) hits++; }
  // On this flat stand-in the previous range (0.15 / 0.10 / 0.38 x 0.23 E, no
  // tilt) hit 73% and the current one 88%; on real Gene geometry 77% vs 98%.
  assert.ok(hits / samples >= 0.85, `cheek coverage ${(hits / samples).toFixed(2)}`);
});

test('the range is model-relative: a face twice the size keeps the same cheek', () => {
  const small = view(1), large = view(2);
  for (const [x, y] of [...COVERED, ...NEVER]) {
    assert.equal(large.at(x, y)?.side ?? null, small.at(x, y)?.side ?? null, `(${x}, ${y})`);
  }
});

test('a close framing keeps a cheek whose ellipse runs past the window edge', () => {
  // Looking at the right cheek from close: its center is on the canvas while
  // the long axis reaches past the right edge. The far cheek is off the canvas.
  const h = view(1, new Vector3(0.45, -0.55, 0), 1.6);
  const right = h.regions.find((region: CheekRegion) => region.side === 'right');
  assert.ok(right, 'the visible cheek is still offered');
  const reach = Math.hypot(right!.axisXX, right!.axisXY);
  assert.ok(right!.x + reach > W, 'the ellipse extends beyond the canvas');
  assert.equal(hitCheek(right!.x, right!.y, h.regions)?.side, 'right');
  assert.equal(h.regions.some((region: CheekRegion) => region.side === 'left'), false, 'an off-canvas center is not offered');
});

test('the tunable range is frozen and expressed in eye distances', () => {
  assert.ok(Object.isFrozen(CHEEK_HIT_RANGE));
  for (const value of Object.values(CHEEK_HIT_RANGE)) assert.ok(Number.isFinite(value));
  assert.ok(CHEEK_HIT_RANGE.halfWidth > CHEEK_HIT_RANGE.halfHeight && CHEEK_HIT_RANGE.halfWidth <= 1);
});
