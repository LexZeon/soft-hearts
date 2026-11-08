import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import {
  clampPetBounds,
  petViewSettings,
  scaledPetBounds,
  sizedPetBounds,
} from "../electron/pet-view";

test("pet view edits preserve every unrelated setting and native file grant", () => {
  const current = structuredClone(DEFAULT_SETTINGS);
  current.model = {
    name: "private model",
    path: "C:/models/model.pmx",
    url: "mmd-asset://token/model.pmx",
  };
  current.persona = "custom persona";
  current.voiceInput!.apiKey = "host-only-key";
  current.agent.workingDirectory = "C:/selected-workspace";
  const camera = { ...current.camera, yaw: 42, pitch: -12, targetZ: 3 };
  const next = petViewSettings(current, { camera, scale: 1.4 });
  assert.deepEqual(next.camera, camera);
  assert.equal(next.pet.scale, 1.4);
  assert.deepEqual(
    {
      ...next,
      camera: current.camera,
      pet: { ...next.pet, scale: current.pet.scale },
    },
    current,
  );
  assert.equal(current.pet.scale, 1);
});

test('independent window dimensions survive camera saves and fit without forcing the legacy aspect', () => {
  const current = structuredClone(DEFAULT_SETTINGS);
  current.pet.size = { width: 650, height: 320 };
  const camera = { ...current.camera, yaw: 28, targetZ: 4 };
  assert.deepEqual(petViewSettings(current, { camera, scale: current.pet.scale }).pet.size, current.pet.size);
  assert.deepEqual(petViewSettings(current, { camera }).pet.size, current.pet.size);
  assert.equal(petViewSettings(current, { scale: 1.5 }).pet.size, undefined);
  assert.deepEqual(sizedPetBounds({ x: 180, y: 120, width: 400, height: 560 }, current.pet.size,
    { x: 0, y: 0, width: 800, height: 600 }), { x: 150, y: 120, width: 650, height: 320 });
  assert.deepEqual(sizedPetBounds({ x: -700, y: 100, width: 400, height: 560 }, { width: 900, height: 1000 },
    { x: -800, y: 0, width: 800, height: 600 }), { x: -800, y: 0, width: 800, height: 600 });
});

test("pet view rejects extra privileges, partial cameras and non-finite values", () => {
  for (const view of [
    null,
    [],
    {},
    { scale: undefined },
    { persona: "injected" },
    { scale: 1, provider: {} },
    { scale: Number.NaN },
    { scale: Infinity },
    { camera: { yaw: 2 } },
    { camera: { ...DEFAULT_SETTINGS.camera, targetZ: Infinity } },
    { camera: { ...DEFAULT_SETTINGS.camera, url: "file:///secret" } },
  ]) {
    assert.throws(() => petViewSettings(DEFAULT_SETTINGS, view));
  }
  assert.equal(petViewSettings(DEFAULT_SETTINGS, { scale: 20 }).pet.scale, 2);
  assert.equal(petViewSettings(DEFAULT_SETTINGS, { scale: -2 }).pet.scale, 0.5);
});

test("window scaling keeps bottom-center anchored when the work area permits it", () => {
  const current = { x: 500, y: 300, width: 400, height: 560 };
  const result = scaledPetBounds(current, 1.5, {
    x: 0,
    y: 0,
    width: 1920,
    height: 1200,
  });
  assert.equal(result.scale, 1.5);
  assert.deepEqual(result.bounds, { x: 400, y: 20, width: 600, height: 840 });
  assert.equal(
    result.bounds.x + result.bounds.width / 2,
    current.x + current.width / 2,
  );
  assert.equal(
    result.bounds.y + result.bounds.height,
    current.y + current.height,
  );
});

test("window scale fits a different monitor and very small work areas", () => {
  const current = { x: 1000, y: 200, width: 400, height: 560 };
  for (const area of [
    { x: -1280, y: 40, width: 1280, height: 720 },
    { x: 0, y: 0, width: 100, height: 100 },
  ]) {
    const { bounds, scale } = scaledPetBounds(current, 2, area);
    assert.ok(bounds.x >= area.x && bounds.y >= area.y);
    assert.ok(bounds.x + bounds.width <= area.x + area.width);
    assert.ok(bounds.y + bounds.height <= area.y + area.height);
    assert.ok(Math.abs(bounds.width / bounds.height - 400 / 560) < 0.02);
    assert.ok(scale <= 2);
    if (area.width === 100) assert.ok(scale < 0.5);
  }
});

test("movement stays within negative-coordinate monitors", () => {
  const area = { x: -1280, y: 40, width: 1280, height: 720 };
  assert.deepEqual(
    clampPetBounds({ x: -1500, y: -500, width: 400, height: 560 }, area),
    { x: -1280, y: 40, width: 400, height: 560 },
  );
  assert.deepEqual(
    clampPetBounds({ x: 300, y: 1000, width: 400, height: 560 }, area),
    { x: -400, y: 200, width: 400, height: 560 },
  );
});
