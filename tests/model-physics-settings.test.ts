import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL_PHYSICS,
  DEFAULT_MODEL_PHYSICS_SETTINGS,
  normalizeModelPhysicsSettings,
  type ModelPhysicsSettings,
} from "../shared/model-physics";

const tuned: ModelPhysicsSettings = {
  hair: { enabled: true, strength: 0.81 },
  chest: { enabled: true, strength: 0.27 },
  quality: "high",
};

test("legacy or malformed settings keep both new effects disabled", () => {
  for (const input of [undefined, null, false, true, 1, "true", [], [tuned], {}, {
    enabled: true, hairEnabled: true, chestEnabled: true, strength: 1, physics: tuned,
  }]) {
    assert.deepEqual(normalizeModelPhysicsSettings(input), {
      hair: { enabled: false, strength: 0.65 },
      chest: { enabled: false, strength: 0.35 },
      quality: "standard",
    });
  }
});

test("independent partial updates preserve tuned fields and explicit false or zero", () => {
  assert.deepEqual(normalizeModelPhysicsSettings({ hair: { enabled: false } }, tuned), {
    ...tuned, hair: { enabled: false, strength: tuned.hair.strength },
  });
  assert.deepEqual(normalizeModelPhysicsSettings({ chest: { strength: 0 } }, tuned), {
    ...tuned, chest: { enabled: true, strength: 0 },
  });
  assert.deepEqual(normalizeModelPhysicsSettings(undefined, tuned), tuned);
  assert.deepEqual(normalizeModelPhysicsSettings({ hair: null, chest: [], quality: undefined }, tuned), tuned);
});

test("bad values cannot turn effects on or replace previously valid settings", () => {
  for (const value of [null, "false", "true", 0, 1, [], {}, NaN]) {
    const next = normalizeModelPhysicsSettings({ hair: { enabled: value }, chest: { enabled: value } });
    assert.equal(next.hair.enabled, false);
    assert.equal(next.chest.enabled, false);
  }
  for (const value of [undefined, null, "0.1", true, false, [], {}, NaN, Infinity, -Infinity]) {
    assert.deepEqual(normalizeModelPhysicsSettings({
      hair: { enabled: "false", strength: value },
      chest: { enabled: 0, strength: value },
      quality: "economy",
    }, tuned), tuned);
  }
});

test("finite output strengths clamp to their independent 0 to 1 boundaries", () => {
  assert.deepEqual(normalizeModelPhysicsSettings({
    hair: { strength: -0.2 }, chest: { strength: 7 },
  }, tuned), {
    ...tuned,
    hair: { enabled: true, strength: 0 },
    chest: { enabled: true, strength: 1 },
  });
  for (const value of [0, 0.19, 0.5, 1]) {
    const next = normalizeModelPhysicsSettings({ hair: { strength: value }, chest: { strength: value } });
    assert.equal(next.hair.strength, value);
    assert.equal(next.chest.strength, value);
  }
});

test("quality changes solver selection without changing the saved output strengths", () => {
  for (const quality of ["low", "standard", "high"] as const) {
    const next = normalizeModelPhysicsSettings({ quality }, tuned);
    assert.equal(next.quality, quality);
    assert.deepEqual(next.hair, tuned.hair);
    assert.deepEqual(next.chest, tuned.chest);
  }
  for (const quality of ["LOW", "", 0, null, ["high"], { quality: "high" }]) {
    assert.equal(normalizeModelPhysicsSettings({ quality }, tuned).quality, tuned.quality);
    assert.equal(normalizeModelPhysicsSettings({ quality }).quality, "standard");
  }
});

test("malformed previous values fall back field by field without losing valid ones", () => {
  assert.deepEqual(normalizeModelPhysicsSettings({}, {
    hair: { enabled: true, strength: NaN },
    chest: { enabled: "true", strength: 0 },
    quality: "low",
  }), {
    hair: { enabled: true, strength: 0.65 },
    chest: { enabled: false, strength: 0 },
    quality: "low",
  });
  for (const previous of [null, false, "high", [tuned]]) {
    assert.deepEqual(normalizeModelPhysicsSettings({}, previous), DEFAULT_MODEL_PHYSICS);
  }
});

test("normalization owns fresh objects and preserves frozen inputs and defaults", () => {
  const previous = Object.freeze({
    hair: Object.freeze({ ...tuned.hair }),
    chest: Object.freeze({ ...tuned.chest }),
    quality: tuned.quality,
  });
  const patch = Object.freeze({ chest: Object.freeze({ enabled: false }) });
  const first = normalizeModelPhysicsSettings(patch, previous);
  const second = normalizeModelPhysicsSettings(patch, previous);
  first.hair.strength = 0;
  first.chest.enabled = true;
  assert.deepEqual(previous, tuned);
  assert.deepEqual(second, { ...tuned, chest: { ...tuned.chest, enabled: false } });
  assert.equal(Object.isFrozen(DEFAULT_MODEL_PHYSICS), true);
  assert.equal(Object.isFrozen(DEFAULT_MODEL_PHYSICS.hair), true);
  assert.equal(Object.isFrozen(DEFAULT_MODEL_PHYSICS.chest), true);
  assert.equal(DEFAULT_MODEL_PHYSICS_SETTINGS, DEFAULT_MODEL_PHYSICS);
  assert.deepEqual(normalizeModelPhysicsSettings(undefined), DEFAULT_MODEL_PHYSICS);
});

test("inherited fields and unrelated asset, card, history or permission data are not accepted", () => {
  const next = normalizeModelPhysicsSettings({
    hair: Object.create({ enabled: true, strength: 1 }),
    chest: { enabled: false, strength: 0.4, spring: 999, damping: 0 },
    modelPath: "must-not-be-copied.pmx",
    characterId: "must-not-be-copied",
    history: ["must-not-be-copied"],
    permissions: { execute: true },
    quality: "low",
  });
  assert.deepEqual(next, {
    hair: { enabled: false, strength: 0.65 },
    chest: { enabled: false, strength: 0.4 },
    quality: "low",
  });
  assert.deepEqual(normalizeModelPhysicsSettings(Object.create(tuned)), DEFAULT_MODEL_PHYSICS);
  const plain = JSON.parse('{"__proto__":{"enabled":true},"hair":{"enabled":false,"__proto__":{"strength":1}}}');
  assert.deepEqual(normalizeModelPhysicsSettings(plain), DEFAULT_MODEL_PHYSICS);
});
