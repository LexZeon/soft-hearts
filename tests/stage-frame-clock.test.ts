import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptStageFrame, FrameHeartbeat, frameRate, MAX_ANIMATION_DELTA, type FrameSurface } from '../src/stage/frame-clock';
import { SpeakingSources } from '../src/stage/speaking-sources';

const VISIBLE: FrameSurface = { hostVisible: true, documentHidden: false, width: 400, height: 560 };

/** Drive the pure decision exactly like the stage's rAF loop does. */
function loop(fps: unknown = 30) {
  let previous = 0, due = 0;
  const heartbeat = new FrameHeartbeat();
  const rendered: { time: number; delta: number; physicsDelta: number }[] = [];
  const step = (time: number, surface: FrameSurface = VISIBLE) => {
    const decision = acceptStageFrame(previous, time, fps, surface, due);
    heartbeat.record(decision, time);
    previous = decision.previous; due = decision.due;
    if (decision.render) rendered.push({ time, delta: decision.delta, physicsDelta: decision.physicsDelta });
    return decision;
  };
  return { step, rendered, heartbeat, previous: () => previous };
}

test('a 60 Hz display under the 30 FPS cap renders every other callback with a steady clock', () => {
  const h = loop(30);
  for (let i = 0; i < 120; i++) h.step(1000 + i * 1000 / 60);
  assert.equal(h.rendered.length, 60);
  for (const frame of h.rendered.slice(1)) assert.ok(Math.abs(frame.delta - 1 / 30) < 1e-9);
  assert.equal(h.heartbeat.getState().serial, 60);
  assert.equal(h.heartbeat.getState().skipped.throttled, 60);
  assert.equal(h.heartbeat.getState().lastReason, null);
});

test('a timestamp earlier than the last accepted frame re-arms instead of freezing the loop', () => {
  const h = loop(30);
  h.step(10_000); h.step(10_000 + 1000 / 30);
  // The previous comparison skipped every callback until real time passed the
  // stored frame time again: a one-second step back meant a one-second freeze.
  const resumed = h.step(9_000);
  assert.equal(resumed.render, true);
  assert.ok(resumed.render && resumed.rearmed);
  assert.ok(resumed.render && Math.abs(resumed.delta - 1 / 30) < 1e-9, 'no negative or catch-up step');
  for (let i = 1; i <= 30; i++) h.step(9_000 + i * 1000 / 30);
  assert.equal(h.rendered.length, 33, 'every following capped frame renders');
  assert.equal(h.heartbeat.getState().rearmed, 1);
});

test('hidden and zero-size surfaces skip, forget the frame time and resume without a catch-up step', () => {
  const h = loop(30);
  h.step(1000); h.step(1000 + 1000 / 30);
  assert.deepEqual(h.step(1100, { ...VISIBLE, documentHidden: true }), { render: false, reason: 'hidden', previous: 0, due: 0 });
  assert.equal(h.heartbeat.getState().lastReason, 'hidden');
  assert.deepEqual(h.step(1200, { ...VISIBLE, hostVisible: false }), { render: false, reason: 'hidden', previous: 0, due: 0 });
  assert.deepEqual(h.step(1300, { ...VISIBLE, width: 0 }), { render: false, reason: 'zero-size', previous: 0, due: 0 });
  assert.equal(h.heartbeat.getState().lastReason, 'zero-size');
  const back = h.step(61_000);
  assert.ok(back.render && Math.abs(back.physicsDelta - 1 / 30) < 1e-9, 'a hidden gap is not replayed into physics');
  assert.equal(h.heartbeat.getState().lastReason, null);
  assert.equal(h.heartbeat.getState().lastRenderAt, 61_000);
});

test('a real visible stall keeps physics honest while animation stays bounded', () => {
  const h = loop(30);
  h.step(1000);
  const stalled = h.step(1600);
  assert.ok(stalled.render);
  assert.ok(stalled.render && Math.abs(stalled.physicsDelta - 0.6) < 1e-9);
  assert.ok(stalled.render && stalled.delta === MAX_ANIMATION_DELTA);
});

test('the FPS setting is clamped and a missing or invalid value uses 60 (R29f; was 30)', () => {
  assert.equal(frameRate(90), 60); assert.equal(frameRate(5), 15); assert.equal(frameRate(undefined), 60); assert.equal(frameRate(Number.NaN), 60);
  const h = loop(Number.NaN);
  for (let i = 0; i < 120; i++) h.step(1000 + i * 1000 / 120);
  assert.equal(h.rendered.length, 60, 'NaN no longer disables the cap (a 120 Hz display at the 60 default)');
});

test('speech owners clear only their own flag, so one window cannot cut or strand the other', () => {
  const speaking = new SpeakingSources();
  // The other window starts playback; this window's own output then reports its
  // routine stop (it emits false on every stop/start even when it was silent).
  assert.equal(speaking.set('remote', true), true);
  assert.equal(speaking.set('local', false), true, 'a local stop must not end remote lip-sync');
  assert.equal(speaking.set('local', true), true);
  assert.equal(speaking.set('remote', false), true, 'a remote stop must not end local lip-sync');
  assert.equal(speaking.set('local', false), false);
  speaking.set('remote', true); speaking.clear();
  assert.equal(speaking.speaking, false);
});
