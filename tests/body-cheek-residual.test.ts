import assert from 'node:assert/strict';
import test from 'node:test';
import { MmdStage } from '../src/stage/MmdStage';
import { CheekPinchMotion } from '../src/stage/cheek-pinch-feedback';

const released = { pinching: false, x: 0, y: 0, side: null } as const;
const held = { pinching: true, x: 0.8, y: 0.3, side: 'left' } as const;
const style = { posture: 50, face: 50, playful: 50, mood: 'happy', sensitivity: 1 };
function withStage(check: (stage: any, motion: CheekPinchMotion) => void): void {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false } });
  const motion = new CheekPinchMotion();
  const stage = Object.assign(Object.create(MmdStage.prototype), {
    cheekMotion: motion, disposed: false, hostVisible: true, container: { clientWidth: 400, clientHeight: 560 },
    mesh: {}, animation: {}, bodyReady: true, controls: { interacting: false },
    moodView: { expressions: true, snapshot: { phase: 'idle', intensity: { posture: 50 } } },
    moodContact: { contact: false, feeding: false, hover: 0, pinch: released },
    musicEnabled: false, speaking: false,
  });
  try { check(stage, motion); }
  finally {
    if (prior) Object.defineProperty(globalThis, 'document', prior);
    else delete (globalThis as any).document;
  }
}

test('released cheek presentation blocks body until the real spring reaches zero', () => withStage((stage, motion) => {
  for (let index = 0; index < 20; index++) motion.frame(1 / 60, held, style);
  const releasedFrame = motion.frame(1 / 60, released, style);
  assert.ok(Object.values(releasedFrame).some(value => value !== 0));
  assert.equal(stage.moodView.snapshot.phase, 'idle');
  assert.equal(stage.bodyGates().directContact, true, 'Pinch is released and host is idle, but its display layer still owns a residual.');
  const before = motion.frame(0, released, style);
  for (let index = 0; index < 4; index++) assert.equal(stage.bodyGates().directContact, true);
  assert.deepEqual(motion.frame(0, released, style), before, 'Admission checks must not advance the spring.');
  let settled = false;
  for (let index = 0; index < 300; index++) {
    const frame = motion.frame(1 / 60, released, style);
    const residual = Object.values(frame).some(value => value !== 0);
    assert.equal(stage.bodyGates().directContact, residual);
    if (!residual) { settled = true; break; }
  }
  assert.equal(settled, true);
  assert.equal(stage.bodyGates().directContact, false);
}));

test('immediate local pinch and host phase gates remain independently authoritative', () => withStage(stage => {
  assert.equal(stage.bodyGates().directContact, false);
  stage.moodContact.pinch = held;
  assert.equal(stage.bodyGates().directContact, true, 'Before the first spring tick, local input must already block body.');
  stage.moodContact.pinch = released;
  stage.moodView.snapshot.phase = 'cheek';
  assert.equal(stage.bodyGates().directContact, true);
  stage.moodView.snapshot.phase = 'idle';
  assert.equal(stage.bodyGates().directContact, false);
}));
