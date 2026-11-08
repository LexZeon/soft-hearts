import test from 'node:test';
import assert from 'node:assert/strict';
import { CheekPinchMotion, type CheekPinchMotionFrame, type CheekPinchMotionInput, type CheekPinchMotionStyle } from '../src/stage/cheek-pinch-feedback';

const style: CheekPinchMotionStyle = { posture: 50, face: 50, playful: 50, mood: 'happy', sensitivity: 1 };
const hold: CheekPinchMotionInput = { pinching: true, x: 0.2, y: 0, side: 'left' };
const release: CheekPinchMotionInput = { pinching: false, x: 0, y: 0, side: null };
function settle(motion: CheekPinchMotion, input = hold, settings = style, seconds = 2, fps = 60) {
  let frame: CheekPinchMotionFrame | undefined;
  for (let i = 0; i < seconds * fps; i++) frame = motion.frame(1 / fps, input, settings);
  return frame!;
}
function within(frame: CheekPinchMotionFrame) {
  assert.ok(Object.values(frame).every(Number.isFinite));
  assert.ok(Math.hypot(frame.headX, frame.headY, frame.headZ) <= Math.PI / 15 + 1e-12);
  assert.ok(Math.hypot(frame.bodyX, frame.bodyY, frame.bodyZ) <= Math.PI / 30 + 1e-12);
  assert.ok(Math.hypot(frame.headOffsetX, frame.headOffsetY) <= 0.025 + 1e-12);
  assert.ok(Math.hypot(frame.bodyOffsetX, frame.bodyOffsetY) <= 0.02 + 1e-12);
  for (const key of ['smile', 'eyelids', 'headWeight', 'bodyWeight'] as const) assert.ok(frame[key] >= 0 && frame[key] <= 1);
}

test('near drag favours the head and distant drag continuously transfers share to the body', () => {
  const near = settle(new CheekPinchMotion());
  const middle = settle(new CheekPinchMotion(), { ...hold, x: 0.75 });
  const far = settle(new CheekPinchMotion(), { ...hold, x: 1.4 });
  assert.ok(near.headWeight > near.bodyWeight);
  assert.ok(far.bodyWeight > far.headWeight);
  assert.ok(near.bodyWeight < middle.bodyWeight && middle.bodyWeight < far.bodyWeight);
  assert.ok(near.headY > 0 && near.headZ < 0 && near.bodyOffsetX > 0);
  const a = settle(new CheekPinchMotion(), { ...hold, x: 0.7499 });
  const b = settle(new CheekPinchMotion(), { ...hold, x: 0.7501 });
  assert.ok(Math.abs(a.bodyWeight - b.bodyWeight) < 0.001);
  const down = settle(new CheekPinchMotion(), { ...hold, x: 0, y: 0.25 });
  assert.ok(down.headX > 0 && down.headOffsetY < 0 && down.bodyOffsetY < 0);
});

test('large drags and strongest card settings remain bounded through changing targets', () => {
  const motion = new CheekPinchMotion();
  const strong = { ...style, sensitivity: 2, posture: 100, face: 100, playful: 100 };
  for (let i = 0; i < 1200; i++) {
    const frame = motion.frame(1 / 60, { ...hold, x: i % 180 < 90 ? 1e9 : -1e9, y: i % 240 < 120 ? 1e9 : -1e9 }, strong);
    within(frame);
  }
});

test('release returns smoothly to rest without changing a frozen drag origin', () => {
  const motion = new CheekPinchMotion();
  const held = settle(motion, { ...hold, x: 0.9, y: -0.4 });
  const first = motion.frame(1 / 60, release, style);
  assert.ok(Math.abs(first.headY) > 0 && Math.abs(first.headY) < Math.abs(held.headY));
  assert.ok(first.smile > 0 && first.smile < held.smile);
  const rest = settle(motion, release);
  for (const value of Object.values(rest)) assert.ok(Math.abs(value) < 1e-8);
  const repeated = settle(motion, { ...hold, x: 0.9, y: -0.4 });
  for (const key of Object.keys(held) as (keyof CheekPinchMotionFrame)[]) assert.ok(Math.abs(held[key] - repeated[key]) < 1e-10);
});

test('closed-form damping agrees across 24, 30 and 60 fps for a fixed target', () => {
  const frames = [24, 30, 60].map(fps => settle(new CheekPinchMotion(), { ...hold, x: 0.7, y: 0.2 }, style, 0.5, fps));
  for (const key of Object.keys(frames[0]) as (keyof CheekPinchMotionFrame)[]) {
    assert.ok(Math.abs(frames[0][key] - frames[1][key]) < 1e-12, key);
    assert.ok(Math.abs(frames[0][key] - frames[2][key]) < 1e-12, key);
  }
});

test('zero, negative and nonfinite time never advances the display; long time is capped', () => {
  const motion = new CheekPinchMotion();
  const held = settle(motion);
  for (const delta of [0, -1, NaN, Infinity, -Infinity]) assert.deepEqual(motion.frame(delta, release, style), held);
  const a = new CheekPinchMotion(), b = new CheekPinchMotion();
  assert.deepEqual(a.frame(999999, hold, style), b.frame(0.1, hold, style));
  a.reset();
  assert.deepEqual(a.frame(0, hold, style), new CheekPinchMotion().frame(0, hold, style));
});

test('invalid movement or missing side decays safely, without retaining a half-valid drag', () => {
  for (const invalid of [{ ...hold, x: NaN }, { ...hold, y: Infinity }, { ...hold, side: null }]) {
    const motion = new CheekPinchMotion();
    settle(motion);
    const rest = settle(motion, invalid);
    within(rest);
    for (const value of Object.values(rest)) assert.ok(Math.abs(value) < 1e-8);
  }
  within(settle(new CheekPinchMotion(), hold, { ...style, sensitivity: NaN, face: Infinity, posture: NaN, playful: -Infinity }));
});

test('mood and character strengths change feeling while zero sensitivity retains small direct movement', () => {
  const happy = settle(new CheekPinchMotion());
  const concerned = settle(new CheekPinchMotion(), hold, { ...style, mood: 'concerned' });
  const unknown = settle(new CheekPinchMotion(), hold, { ...style, mood: 'unknown' });
  assert.equal(concerned.smile, 0);
  assert.ok(happy.smile > unknown.smile && unknown.smile > concerned.smile);
  assert.ok(happy.eyelids > concerned.eyelids);
  const gentle = settle(new CheekPinchMotion(), hold, { ...style, sensitivity: 0, posture: 0 });
  assert.ok(gentle.headY > 0 && gentle.headY < happy.headY);
  const noFace = settle(new CheekPinchMotion(), hold, { ...style, face: 0 });
  assert.equal(noFace.smile, 0); assert.equal(noFace.eyelids, 0);
});

test('repeated held frames do not accumulate drift and inputs and returned frames are independent', () => {
  const input = Object.freeze({ ...hold }), settings = Object.freeze({ ...style });
  const motion = new CheekPinchMotion();
  const atRest = settle(motion, input, settings);
  const later = settle(motion, input, settings, 20);
  for (const key of Object.keys(later) as (keyof CheekPinchMotionFrame)[]) assert.ok(Math.abs(later[key] - atRest[key]) < 1e-10);
  later.headY = 100;
  assert.ok(motion.frame(0, input, settings).headY < 1);
  assert.deepEqual(input, hold); assert.deepEqual(settings, style);
});
