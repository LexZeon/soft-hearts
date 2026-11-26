import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTouchEvent } from '../shared/mood/touch';

test('a click on her shoulder parses; pull-only fields are dropped from a click', () => {
  const event = parseTouchEvent({ kind: 'click', part: 'shoulder', side: 'left', where: 'unbound', at: 5, strength: 0.9, ended: 'released' });
  assert.deepEqual(event, { kind: 'click', part: 'shoulder', side: 'left', where: 'unbound', at: 5 });
});

test('a pull keeps its fields, clamped; the direction is normalised', () => {
  const event = parseTouchEvent({ kind: 'pull', part: 'hand', side: 'right', where: 'pet', at: 1, strength: 3, direction: { x: 3, y: 4 }, heldMs: -5, ended: 'holding' });
  assert.deepEqual(event, { kind: 'pull', part: 'hand', side: 'right', where: 'pet', at: 1, strength: 1, direction: { x: 0.6, y: 0.8 }, heldMs: 0, ended: 'holding' });
});

test('anything else is null: unknown kind, part or place, a bad side, no time', () => {
  for (const bad of [null, [], 'click', { kind: 'kiss', part: 'face', side: null, where: 'pet', at: 1 },
    { kind: 'click', part: 'chest', side: null, where: 'pet', at: 1 }, { kind: 'click', part: 'face', side: 'up', where: 'pet', at: 1 },
    { kind: 'click', part: 'face', side: null, where: 'desk', at: 1 }, { kind: 'click', part: 'face', side: null, where: 'pet' }]) {
    assert.equal(parseTouchEvent(bad), null);
  }
  assert.deepEqual(parseTouchEvent({ kind: 'click', part: 'face', where: 'pet', at: 2 }), { kind: 'click', part: 'face', side: null, where: 'pet', at: 2 });
});

test('the sink: dropped until set, validated, never throws', async () => {
  const { reportTouch, setTouchSink } = await import('../electron/mood/touch/sink');
  const seen: unknown[] = [];
  assert.equal(reportTouch({ kind: 'click', part: 'hand', side: null, where: 'unbound', at: 1 }), false);
  setTouchSink(event => { seen.push(event); });
  assert.equal(reportTouch({ kind: 'click', part: 'hand', side: null, where: 'unbound', at: 1 }), true);
  assert.equal(reportTouch({ kind: 'click', part: 'nose', side: null, where: 'unbound', at: 1 }), false);
  setTouchSink(() => { throw new Error('x'); });
  assert.equal(reportTouch({ kind: 'click', part: 'hand', side: null, where: 'unbound', at: 2 }), false);
  setTouchSink(null);
  assert.equal(seen.length, 1);
});
