import assert from "node:assert/strict";
import test from "node:test";
import { Bone, PerspectiveCamera, Quaternion, Vector3 } from "three";
import type { AppSettings } from "../shared/foundation/settings";
import { gazeTargets } from "../src/stage/procedural";

interface GazeHarness {
  settings: AppSettings;
  head: Bone;
  eyes: Bone[];
  camera: PerspectiveCamera;
  gaze: { x: number; y: number };
  eyeGaze: { x: number; y: number };
  animation: unknown;
  arms: { bone: Bone; roll: number }[];
  boneLayers: unknown[];
  morphLayers: unknown[];
  setPointer(pointer: { x: number; y: number }): void;
  animateIdle(delta: number): void;
  restoreLayers(): void;
}
function advance(stage: GazeHarness, frames = 180): void {
  for (let frame = 0; frame < frames; frame++) {
    stage.restoreLayers();
    stage.animateIdle(1 / 60);
  }
}
function close(actual: number, expected: number, tolerance = 1e-12): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`,
  );
}
function samePose(
  actual: Bone,
  quaternion: Quaternion,
  position: number[],
): void {
  // Components also detect sign/normalization changes hidden by angleTo.
  actual.quaternion
    .toArray()
    .forEach((value, index) => close(value, quaternion.toArray()[index]));
  assert.deepEqual(actual.position.toArray(), position);
}

function screenOrigin(stage: GazeHarness): Vector3 {
  const origin = new Vector3();
  if (stage.eyes.length) {
    for (const eye of stage.eyes)
      origin.add(eye.getWorldPosition(new Vector3()));
    origin.divideScalar(stage.eyes.length);
  } else stage.head.getWorldPosition(origin);
  return origin.project(stage.camera);
}

test("nearby gaze is eye-led while head participation rises smoothly with distance", () => {
  const near = gazeTargets(0.1, 0.05);
  const far = gazeTargets(1, 0.5);
  assert.ok(
    Math.hypot(near.eyeX, near.eyeY) > Math.hypot(near.headX, near.headY) * 2,
  );
  assert.ok(Math.hypot(far.headX, far.headY) > Math.hypot(far.eyeX, far.eyeY));
  assert.ok(far.headWeight > near.headWeight);
  let previous = -Infinity;
  for (let index = 0; index <= 100; index++) {
    const result = gazeTargets(index / 100, 0);
    assert.ok(result.headWeight >= previous);
    assert.ok(result.headWeight >= 0 && result.headWeight < 1);
    if (index)
      assert.ok(
        result.headWeight - previous < 0.03,
        "head share must not jump at a threshold",
      );
    previous = result.headWeight;
  }
});

test("gaze directions mirror consistently and invalid/extreme input remains finite and bounded", () => {
  const rightUp = gazeTargets(0.73, 0.41);
  const leftUp = gazeTargets(-0.73, 0.41);
  const rightDown = gazeTargets(0.73, -0.41);
  close(rightUp.headWeight, leftUp.headWeight);
  close(rightUp.headX, -leftUp.headX);
  close(rightUp.eyeX, -leftUp.eyeX);
  close(rightUp.headY, leftUp.headY);
  close(rightUp.eyeY, leftUp.eyeY);
  close(rightUp.headX, rightDown.headX);
  close(rightUp.eyeX, rightDown.eyeX);
  close(rightUp.headY, -rightDown.headY);
  close(rightUp.eyeY, -rightDown.eyeY);
  for (const [x, y] of [
    [0, 0],
    [1e20, -1e20],
    [-1e20, 1e20],
    [NaN, Infinity],
    [-Infinity, NaN],
  ]) {
    const result = gazeTargets(x, y);
    assert.ok(Object.values(result).every(Number.isFinite));
    assert.ok(Math.abs(result.headX) <= 0.38 && Math.abs(result.headY) <= 0.22);
    assert.ok(Math.abs(result.eyeX) <= 0.18 && Math.abs(result.eyeY) <= 0.12);
  }
  assert.deepEqual(Object.values(gazeTargets(0, 0)).slice(1), [0, 0, 0, 0]);
});
