import assert from "node:assert/strict";
import test from "node:test";
import { petRecovery } from "../electron/pet-view";
import { DEFAULT_SETTINGS } from "../shared/defaults";

test("pet recovery resets presentation while preserving assets, accounts, voice and agent state", () => {
  const current = structuredClone(DEFAULT_SETTINGS);
  current.model = { path: "private/model.pmx", name: "model.pmx", url: "mmd-asset://model/model.pmx" };
  current.motion = { path: "private/motion.vmd", name: "motion.vmd", url: "mmd-asset://motion/motion.vmd" };
  current.provider = { kind: "claude", baseUrl: "https://example.invalid/v1", model: "private-model" };
  current.persona = "Keep this active character persona";
  current.voice = { enabled: true, voiceURI: "existing-voice", rate: 1.2, volume: 0.7 };
  current.agent = { workingDirectory: "existing-workspace", model: "existing-model", writable: true };
  current.pet = { visible: false, alwaysOnTop: false, clickThrough: true, followMouse: false, fps: 60, breath: 2, scale: 1.8 };
  current.camera = { yaw: 135, pitch: 60, distance: 300, targetX: 100, targetY: -200, targetZ: 40, fov: 70 };
  const before = structuredClone(current);
  const recovered = petRecovery(current, { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(recovered.bounds, { x: 760, y: 240, width: 400, height: 560 });
  assert.deepEqual(recovered.settings.pet, DEFAULT_SETTINGS.pet);
  assert.deepEqual(recovered.settings.camera, DEFAULT_SETTINGS.camera);
  for (const key of ["model", "motion", "provider", "persona", "voice", "voiceInput", "agent"] as const)
    assert.deepEqual(recovered.settings[key], current[key], `preserve ${key}`);
  assert.deepEqual(current, before, "the caller's live settings must not be mutated");
  recovered.settings.camera.targetX = 42;
  recovered.settings.pet.visible = false;
  assert.notEqual(DEFAULT_SETTINGS.camera.targetX, 42, "defaults are not shared mutable objects");
  assert.equal(DEFAULT_SETTINGS.pet.visible, true);
});

test("pet recovery centers on a negative-coordinate display work area", () => {
  const recovered = petRecovery(DEFAULT_SETTINGS, { x: -1920, y: -100, width: 1920, height: 1080 });
  assert.deepEqual(recovered.bounds, { x: -1160, y: 160, width: 400, height: 560 });
  assert.equal(recovered.settings.pet.scale, 1);
});

test("pet recovery fits a small display without retaining an old oversized scale", () => {
  const area = { x: 100, y: -200, width: 240, height: 320 };
  const recovered = petRecovery({ ...structuredClone(DEFAULT_SETTINGS), pet: { ...DEFAULT_SETTINGS.pet, scale: 2 } }, area);
  assert.equal(recovered.settings.pet.scale, 320 / 560);
  assert.deepEqual(recovered.bounds, { x: 106, y: -200, width: 228, height: 320 });
  assert.ok(recovered.bounds.width <= area.width && recovered.bounds.height <= area.height);
});

test("pet recovery rejects unusable display geometry", () => {
  for (const area of [
    { x: 0, y: 0, width: 0, height: 100 },
    { x: 0, y: 0, width: 100, height: -1 },
    { x: Number.NaN, y: 0, width: 100, height: 100 },
    { x: 0, y: Number.POSITIVE_INFINITY, width: 100, height: 100 },
  ]) assert.throws(() => petRecovery(DEFAULT_SETTINGS, area), /工作区无效/);
});
