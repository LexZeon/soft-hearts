import assert from 'node:assert/strict';
import test from 'node:test';
import { clampBox } from '../src/initiative/HandsOverlay';
import { TOUCH_TARGET_MAX_WINDOW_SHARE, touchTargetRadius } from '../src/initiative/touch-target';

// In a close-up her held-out hand's target grew to the whole companion window, and every point
// inside a target is a control, not a pat.
const WINDOW = { width: 478, height: 474 };
const inside = (box: ReturnType<typeof clampBox>, x: number, y: number) => x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;

test('close-up: the target over her hand leaves her head free to pat', () => {
  const r = touchTargetRadius(600, WINDOW.width, WINDOW.height, 26);
  assert.equal(r, WINDOW.height * TOUCH_TARGET_MAX_WINDOW_SHARE);
  const box = clampBox({ x: 240, y: 330, r }, WINDOW.width, WINDOW.height);
  assert.equal(inside(box, 240, 90), false, 'the top of her head is not under the target');
  assert.equal(inside(box, 240, 330), true, 'her hand still is');
  assert.ok(box.width < WINDOW.width / 2 && box.height < WINDOW.height / 2);
});

test('an ordinary full-body target keeps its size', () => {
  assert.equal(touchTargetRadius(30, WINDOW.width, WINDOW.height, 26), 30);
});

test('the floor stays clickable, in a tiny window too', () => {
  assert.equal(touchTargetRadius(5, WINDOW.width, WINDOW.height, 26), 26);
  assert.equal(touchTargetRadius(600, 100, 100, 28), 28);
});

test('an unknown window size does not invent a limit', () => {
  assert.equal(touchTargetRadius(600, 0, 0, 26), 600);
});

// Her held-out hand takes a click only in a ring round her palm.
test('the hand target is a ring round her palm, not the whole hand', async () => {
  const { PALM_TARGET, palmTargetRadius } = await import('../src/initiative/touch-target');
  const SCREEN = { width: 1920, height: 1080 };
  const handPx = 120; // a hand 120 px long on screen
  const r = palmTargetRadius(handPx, SCREEN.width, SCREEN.height);
  assert.equal(r, handPx * PALM_TARGET.ring);
  assert.ok(r < handPx / 2, 'smaller than half the hand: the fingertips are outside the ring');
  assert.ok(PALM_TARGET.centreAt < 0.5, 'centred on the palm, nearer the wrist than the middle of the hand');
  assert.ok(PALM_TARGET.centreAt + PALM_TARGET.ring < 1, 'the ring ends before the fingertips');
  assert.ok(PALM_TARGET.centreAt - PALM_TARGET.ring > -0.25, 'and does not reach far up the wrist');
});

test('a small, far figure keeps a clickable palm ring', async () => {
  const { PALM_TARGET, palmTargetRadius } = await import('../src/initiative/touch-target');
  assert.equal(palmTargetRadius(10, 1920, 1080), PALM_TARGET.floorPx);
  assert.ok(PALM_TARGET.floorPx < 26, 'the floor is smaller than the old 26 px one');
});
