import assert from "node:assert/strict";
import test from "node:test";
import {
  Bone,
  Euler,
  PerspectiveCamera,
  Quaternion,
  SkinnedMesh,
  Vector3,
} from "three";
import type { AppSettings } from "../shared/contracts";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { MmdStage } from "../src/stage/MmdStage";
import { gazeTargets } from "../src/stage/procedural";
import { EMPTY_CONTACT, MoodFeedback } from '../src/stage/mood-feedback';

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
function harness(hasEyes = true): GazeHarness {
  // Exercise the real procedural methods without constructing a canvas/renderer.
  const stage = Object.create(MmdStage.prototype) as GazeHarness;
  const head = new Bone();
  const eyes = hasEyes ? [new Bone(), new Bone()] : [];
  head.position.set(0, 15, 0);
  for (const [index, eye] of eyes.entries()) {
    eye.position.set(index ? 0.5 : -0.5, 0.8, 0.5);
    head.add(eye);
  }
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.pet.breath = 0;
  settings.pet.followMouse = true;
  const camera = new PerspectiveCamera(32, 1, 0.1, 3000);
  camera.position.set(0, 15.8, 30);
  camera.lookAt(0, 15.8, 0);
  camera.updateMatrixWorld(true);
  Object.assign(stage, {
    settings,
    head,
    eyes,
    camera,
    gazeOrigin: new Vector3(),
    eyePoint: new Vector3(),
    mesh: new SkinnedMesh(),
    animation: null,
    arms: [],
    pointer: { x: 0, y: 0 },
    gaze: { x: 0, y: 0 },
    eyeGaze: { x: 0, y: 0 },
    elapsed: 0,
    height: 20,
    nextBlink: Infinity,
    blinkStart: -10,
    speaking: false,
    mouth: 0,
    blinkIndex: -1,
    mouthIndex: -1,
    boneLayers: [],
    morphLayers: [],
    rotation: new Euler(),
    offset: new Quaternion(),
  });
  return stage;
}
function advance(stage: GazeHarness, frames = 180): void {
  for (let frame = 0; frame < frames; frame++) {
    stage.restoreLayers();
    stage.animateIdle(1 / 60);
  }
}

test('head gaze fades with local attention instead of dropping at contact or jumping back on exit', () => {
  const stage = harness() as any;
  stage.moodFeedback = new MoodFeedback(); stage.moodView = {};
  stage.setPointer({ x: 1, y: -0.7 });
  const inputMood = { mood: 'neutral', phase: 'idle', expressive: true, face: 50, posture: 50, playful: 50, responding: false };
  const step = (input = EMPTY_CONTACT) => {
    stage.restoreLayers(); stage.animateIdle(1 / 30);
    const displayed = stage.head.quaternion.clone();
    stage.moodFeedback.frame(1 / 30, input, inputMood);
    return displayed;
  };
  let base = step(); for (let frame = 0; frame < 90; frame++) base = step();
  assert.ok(base.angleTo(new Quaternion()) > 0.01);
  let previous = base;
  for (let frame = 0; frame <= 60; frame++) {
    const current = step({ ...EMPTY_CONTACT, hover: frame / 60 });
    assert.ok(current.angleTo(previous) < 0.01, 'no binary handoff from gaze to local contact'); previous = current;
  }
  const contact = step({ ...EMPTY_CONTACT, hover: 1, contact: true });
  assert.ok(contact.angleTo(previous) < 0.01);
  const exit = step(); assert.ok(exit.angleTo(contact) < 0.01);
  for (let frame = 0; frame < 180; frame++) previous = step();
  assert.ok(previous.angleTo(base) < 1e-6, 'normal head gaze returns after the smooth exit');
});
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

test("off-center projected eye position is neutral and nearby cursor movement stays eye-led", () => {
  const stage = harness();
  stage.camera.position.y = 10;
  stage.camera.lookAt(0, 10, 0);
  stage.camera.updateMatrixWorld(true);
  const origin = screenOrigin(stage);
  assert.ok(
    origin.y > 0.5 && origin.y < 0.9,
    "fixture eyes must be far from the window center",
  );
  stage.setPointer({ x: origin.x, y: origin.y });
  stage.animateIdle(1 / 60);
  for (const bone of [stage.head, ...stage.eyes])
    samePose(bone, new Quaternion(), bone.position.toArray());
  close(stage.gaze.x, 0);
  close(stage.gaze.y, 0);
  close(stage.eyeGaze.x, 0);
  close(stage.eyeGaze.y, 0);

  stage.restoreLayers();
  stage.setPointer({ x: origin.x + 0.08, y: origin.y + 0.03 });
  advance(stage);
  const head = stage.head.quaternion.angleTo(new Quaternion());
  const eye = stage.eyes[0].quaternion.angleTo(new Quaternion());
  assert.ok(
    head > 0 && eye > head * 2,
    "physical proximity to projected eyes must outweigh the window Y offset",
  );
});

test("off-center animated base poses use averaged eyes and the head fallback without resetting pose", () => {
  for (const hasEyes of [true, false]) {
    const stage = harness(hasEyes);
    stage.animation = {};
    stage.settings.motion = { name: "test.vmd", path: "test.vmd", url: "mmd-asset://test/test.vmd" };
    stage.head.rotation.set(0.08, -0.1, 0.03, "YXZ");
    stage.camera.position.set(-1, 10, 30);
    stage.camera.lookAt(-1, 10, 0);
    stage.camera.updateMatrixWorld(true);
    const bones = [stage.head, ...stage.eyes];
    const bases = bones.map((bone) => ({
      quaternion: bone.quaternion.clone(),
      position: bone.position.toArray(),
    }));
    const origin = screenOrigin(stage);
    assert.ok(Math.abs(origin.y) > 0.5 && Math.abs(origin.y) < 1);
    stage.setPointer({ x: origin.x, y: origin.y });
    advance(stage, 30);
    bones.forEach((bone, index) =>
      samePose(bone, bases[index].quaternion, bases[index].position),
    );
    stage.restoreLayers();
    bones.forEach((bone, index) =>
      samePose(bone, bases[index].quaternion, bases[index].position),
    );
  }
});

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

test("missing eye bones fall back to bounded head gaze without inventing eye motion", () => {
  const withEyes = gazeTargets(0.2, 0.1);
  const fallback = gazeTargets(0.2, 0.1, false);
  assert.equal(fallback.headWeight, 1);
  assert.equal(fallback.eyeX, 0);
  assert.equal(fallback.eyeY, 0);
  assert.ok(fallback.headX > withEyes.headX && fallback.headY > withEyes.headY);
  const stage = harness(false);
  stage.setPointer({ x: 0.5, y: 0.2 });
  assert.doesNotThrow(() => advance(stage));
  assert.ok(stage.head.quaternion.angleTo(new Quaternion()) > 0);
  stage.restoreLayers();
  samePose(stage.head, new Quaternion(), [0, 15, 0]);
});

test("real eye bones react faster and dominate near targets, while distant targets recruit the head", () => {
  const near = harness();
  near.setPointer({ x: 0.12, y: 0 });
  near.animateIdle(1 / 60);
  const identity = new Quaternion();
  const firstHead = near.head.quaternion.angleTo(identity);
  const firstEye = near.eyes[0].quaternion.angleTo(identity);
  assert.ok(firstHead > 0 && firstEye > firstHead * 2);
  advance(near);
  const nearHead = near.head.quaternion.angleTo(identity);
  const nearEye = near.eyes[0].quaternion.angleTo(identity);
  assert.ok(nearEye > nearHead * 2);
  assert.ok(near.eyes[0].quaternion.equals(near.eyes[1].quaternion));
  const far = harness();
  far.setPointer({ x: 1, y: 0 });
  advance(far);
  const farHead = far.head.quaternion.angleTo(identity);
  const farEye = far.eyes[0].quaternion.angleTo(identity);
  assert.ok(farHead > farEye && farEye > 0);
  assert.ok(farHead / (farHead + farEye) > nearHead / (nearHead + nearEye));
  assert.ok(farHead < 0.39 && farEye < 0.19);
});

test("real bone rotations preserve upward/rightward signs and remain normalized", () => {
  const stage = harness();
  stage.setPointer({ x: 0.5, y: 0.4 });
  advance(stage);
  for (const bone of [stage.head, ...stage.eyes]) {
    const rotation = new Euler().setFromQuaternion(bone.quaternion, "YXZ");
    assert.ok(
      rotation.x < 0,
      "upward pointer must rotate local X upward, not down",
    );
    assert.ok(rotation.y > 0, "rightward pointer must rotate local Y right");
    close(bone.quaternion.length(), 1);
  }
  const mirrored = harness();
  mirrored.setPointer({ x: -0.5, y: -0.4 });
  advance(mirrored);
  for (const bone of [mirrored.head, ...mirrored.eyes]) {
    const rotation = new Euler().setFromQuaternion(bone.quaternion, "YXZ");
    assert.ok(rotation.x > 0 && rotation.y < 0);
  }
});

test("gaze restores each changing VMD base pose and never accumulates across frames", () => {
  const stage = harness();
  stage.animation = {}; // VMD owns the underlying pose; procedural offsets are temporary.
  stage.settings.motion = { name: "test.vmd", path: "test.vmd", url: "mmd-asset://test/test.vmd" };
  const arm = new Bone();
  arm.rotation.z = 0.25;
  const armPose = arm.quaternion.clone();
  stage.arms = [{ bone: arm, roll: -1 }];
  stage.setPointer({ x: 0.7, y: -0.3 });
  for (let frame = 0; frame < 240; frame++) {
    stage.restoreLayers();
    const bones = [stage.head, ...stage.eyes];
    for (const [index, bone] of bones.entries()) {
      bone.rotation.set(0.12 + frame * 0.0002, -0.2 + index * 0.03, 0.1, "YXZ");
      bone.position.x = frame * 0.0001 + index;
    }
    const bases = bones.map((bone) => ({
      quaternion: bone.quaternion.clone(),
      position: bone.position.toArray(),
    }));
    stage.animateIdle(1 / 60);
    for (const [index, bone] of bones.entries()) {
      const offset = bone.quaternion.angleTo(bases[index].quaternion);
      assert.ok(offset > 0 && offset < 0.5);
    }
    assert.ok(
      arm.quaternion.equals(armPose),
      "VMD arm pose must not receive the idle relaxed-arm correction",
    );
    stage.restoreLayers();
    bones.forEach((bone, index) =>
      samePose(bone, bases[index].quaternion, bases[index].position),
    );
    assert.equal(stage.boneLayers.length, 0);
    assert.equal(stage.morphLayers.length, 0);
  }
});

test("disabling mouse following smoothly removes gaze while retaining the existing animation pose", () => {
  const stage = harness();
  stage.head.rotation.set(0.1, 0.2, -0.15, "YXZ");
  const base = stage.head.quaternion.clone();
  stage.setPointer({ x: 1, y: 0.8 });
  advance(stage);
  const before = stage.head.quaternion.angleTo(base);
  assert.ok(before > 0.1);
  stage.settings.pet.followMouse = false;
  advance(stage, 360);
  assert.ok(stage.head.quaternion.angleTo(base) < before * 0.0001);
  assert.ok(
    stage.eyes.every((eye) => eye.quaternion.angleTo(new Quaternion()) < 1e-6),
  );
  stage.restoreLayers();
  samePose(stage.head, base, [0, 15, 0]);
});
