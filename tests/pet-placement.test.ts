// Test windows never land on top of the user's own companion (bottom right of the primary display).
import assert from 'node:assert/strict';
import test from 'node:test';
import { initialPetPosition } from '../electron/pet-placement';

const area = { x: 0, y: 0, width: 1536, height: 912 };

test('the pet opens at the bottom right by default, exactly where it always did', () => {
  assert.deepEqual(initialPetPosition(area, {}, undefined), { x: 1536 - 430, y: 912 - 590 });
  assert.deepEqual(initialPetPosition({ x: 100, y: 50, width: 1000, height: 800 }, {}, 'development'), { x: 100 + 1000 - 430, y: 50 + 800 - 590 });
});

test('a test launch puts its pet at the top left, away from the user', () => {
  assert.deepEqual(initialPetPosition(area, { SOFT_HEARTS_TEST_PET_CORNER: 'top-left' }, undefined), { x: 30, y: 30 });
  assert.deepEqual(initialPetPosition(area, { SOFT_HEARTS_TEST_PET_CORNER: 'top-left' }, 'development'), { x: 30, y: 30 });
});

test('the stable channel ignores the test switch, and unknown values change nothing', () => {
  assert.deepEqual(initialPetPosition(area, { SOFT_HEARTS_TEST_PET_CORNER: 'top-left' }, 'stable'), { x: 1106, y: 322 });
  assert.deepEqual(initialPetPosition(area, { SOFT_HEARTS_TEST_PET_CORNER: 'middle' }, undefined), { x: 1106, y: 322 });
});
