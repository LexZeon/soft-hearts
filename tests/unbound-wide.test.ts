// docs/claude/2026-11-21-unbound-wide.md: in full-screen Unbound she is drawn at her true
// width / height. The world camera is an off-axis frustum written straight into its projection matrix; the cheek projection used to
// call camera.updateProjectionMatrix(), which rebuilt that matrix from the camera's unused fov 50 / aspect 1 and left her about 1.6
// times too wide for the rest of the session (until the next scene).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Bone, Vector3 } from 'three';
import { applyWorldCamera, WorldCamera } from '../src/unbound/camera';
import { UNITS_PER_M } from '../src/unbound/figure';
import { projectCheekRegions } from '../src/mood/cheek-pinch-region';
import type { BlushAnchors } from '../src/stage/procedural-blush';
import type { UnboundWorld } from '../shared/unbound/scene';
import { DEFAULT_VIEWER_DISTANCE_M, VIEWER_DISTANCE_RANGE_M, eyeHeightFor, placementAcross, resolvePhysicalScreen, type DisplayFacts } from '../shared/unbound/world';

// The user's display (2026-11-21): 1536 x 960 DIP, one monitor, a 48 DIP taskbar. Her saved place: across 0.3255, 5.4675 m back.
const DISPLAY: DisplayFacts = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };
const CANVAS = { width: 1536, height: 912 };

function worldAt(viewerDistanceM: number, across = 0.3255, depthM = 5.4675): UnboundWorld {
  const screen = resolvePhysicalScreen(DISPLAY, null);
  return { screen, display: DISPLAY.bounds, workArea: DISPLAY.workArea, window: DISPLAY.workArea, mapping: 'physical', viewerDistanceM,
    eyeHeightM: eyeHeightFor(screen, DISPLAY, viewerDistanceM), placement: placementAcross({ screen, viewerDistanceM }, across, depthM) };
}

/** An upright box facing the screen where she stands (0.45 m wide, 1.6 m tall): its on-screen width / height over the true 0.45 / 1.6. */
function boxAspectError(camera: WorldCamera, world: UnboundWorld): number {
  const k = UNITS_PER_M, x = world.placement.xM, z = -world.placement.depthM;
  const px = (p: Vector3) => { const v = p.clone().multiplyScalar(k).project(camera); return { x: (v.x + 1) / 2 * CANVAS.width, y: (1 - v.y) / 2 * CANVAS.height }; };
  const a = px(new Vector3(x - 0.225, 0, z)), b = px(new Vector3(x + 0.225, 0, z)), c = px(new Vector3(x - 0.225, 1.6, z));
  const shown = Math.abs(b.x - a.x) / Math.abs(c.y - a.y);
  return shown / (0.45 / 1.6) - 1;
}

const anchors: BlushAnchors = {
  leftEye: [-0.5, 0.5, 0], rightEye: [0.5, 0.5, 0], mouth: [0, -0.4, 0], leftCheek: [-0.54, 0, 0], rightCheek: [0.54, 0, 0],
  leftNormal: [0, 0, 1], rightNormal: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1], eyeDistance: 1,
  boneEyeDistance: 1, eyeReference: 'eye-bones', mouthEstimated: false, surfaceSource: 'named-face', materialIndices: [0],
};

test('the world camera draws an upright figure at its true width / height at the user display, place and every viewer distance the panel allows', () => {
  for (const d of [VIEWER_DISTANCE_RANGE_M[0], DEFAULT_VIEWER_DISTANCE_M, 0.8, VIEWER_DISTANCE_RANGE_M[1]]) {
    for (const [across, depth] of [[0.3255, 5.4675], [0.05, 0.6], [0.95, 15]] as const) {
      const camera = new WorldCamera(), world = worldAt(d, across, depth);
      applyWorldCamera(camera, world);
      const error = boxAspectError(camera, world);
      assert.ok(Math.abs(error) < 0.01, `viewer ${d} m, across ${across}, ${depth} m back: off by ${(error * 100).toFixed(2)} %`);
    }
  }
});

test('touching her cheeks (the head region) leaves the off-axis projection alone: she does not turn wide and short', () => {
  for (const d of [VIEWER_DISTANCE_RANGE_M[0], DEFAULT_VIEWER_DISTANCE_M, VIEWER_DISTANCE_RANGE_M[1]]) {
    const camera = new WorldCamera(), world = worldAt(d);
    applyWorldCamera(camera, world);
    const before = camera.projectionMatrix.toArray();
    const head = new Bone();
    head.position.set(world.placement.xM * UNITS_PER_M, 1.5 * UNITS_PER_M, -world.placement.depthM * UNITS_PER_M);
    head.updateMatrixWorld(true);
    const regions = projectCheekRegions(anchors, head, camera, CANVAS.width, CANVAS.height, 60);
    assert.equal(regions.length, 2, 'both cheeks project (the call does its work)');
    assert.deepEqual(camera.projectionMatrix.toArray(), before, 'the projection matrix is untouched');
    const error = boxAspectError(camera, world);
    assert.ok(Math.abs(error) < 0.01, `viewer ${d} m: off by ${(error * 100).toFixed(1)} % after the cheek projection`);
  }
});

test('the world camera keeps its frustum through any updateProjectionMatrix() call (a guard for code written for an ordinary camera)', () => {
  const camera = new WorldCamera(), world = worldAt(DEFAULT_VIEWER_DISTANCE_M);
  applyWorldCamera(camera, world);
  const before = camera.projectionMatrix.toArray();
  camera.fov = 50; camera.aspect = 1; camera.updateProjectionMatrix();
  assert.deepEqual(camera.projectionMatrix.toArray(), before);
  assert.ok(Math.abs(boxAspectError(camera, world)) < 0.01);
  // Before any frustum it is an ordinary perspective camera (three's own constructor calls updateProjectionMatrix()).
  const fresh = new WorldCamera(40, 2);
  assert.ok(Math.abs(fresh.projectionMatrix.elements[5] / fresh.projectionMatrix.elements[0] - 2) < 1e-9);
});
