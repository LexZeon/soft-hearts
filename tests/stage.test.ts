import assert from 'node:assert/strict';
import test from 'node:test';
import { blinkWeight, damp, relaxedArmRoll } from '../src/stage/procedural';

test('damping is frame-rate independent over one second', () => {
  function sample(fps: number): number {
    let value = 0;
    for (let frame = 0; frame < fps; frame++) value = damp(value, 1, 5, 1 / fps);
    return value;
  }
  assert.ok(Math.abs(sample(30) - sample(60)) < 1e-12);
});

test('blink closes and reopens without values outside valid range', () => {
  assert.equal(blinkWeight(-0.01), 0);
  assert.equal(blinkWeight(1), 0);
  assert.equal(blinkWeight(0.08), 1);
  assert.ok(blinkWeight(0.04) > 0 && blinkWeight(0.04) < 1);
});

test('relaxed pose lowers mirrored T-pose arms and preserves lowered arms', () => {
  assert.equal(relaxedArmRoll(1, 0), -relaxedArmRoll(-1, 0));
  assert.equal(relaxedArmRoll(0, -1), 0);
  assert.equal(relaxedArmRoll(0.1, -1), 0);
  assert.ok(relaxedArmRoll(1, 0) < 0);
});
