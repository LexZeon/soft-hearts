// I-176 step 3 (docs/claude/2026-11-23-i176-delete.md): the window engine's canvas readouts, the fields the pretrial and the real-Electron smokes
// poll since the old stage's forty are gone. Fake canvas, no WebGL.
//  - presence is written always (and only when it changes); every other field only in developer mode;
//  - each field has the old name and the keys the scripts read (serial / skipped for frameClock, jumps for poseContinuity, active / phase /
//    weight for chatGesture, layerTimes.pose for motionTransition, amount / phase / surface for crying, head / blink / activeContact for moodFeedback);
//  - a readout that cannot be serialised never throws into the frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowReadouts, type ReadoutSources } from '../src/unbound/window-mode/window-readouts';
import { WindowCrying } from '../src/unbound/window-mode/window-tears';
import { WindowPinch } from '../src/unbound/window-mode/window-pinch';

const sources = (over: Partial<ReadoutSources> = {}): ReadoutSources => ({
  presence: () => 1,
  clock: () => ({ speaking: false, waitingForReply: false, inputBlocked: false, pace: { fps: 60 } }),
  guard: () => ({ jumps: 2, maxAngleDeg: 12, lastJump: { property: '頭', size: 12 } }),
  mood: () => ({ phase: 'idle', primary: 'calm', companion: null, head: [0, 0, 0], hover: 0, contact: 0, activeContact: false, eyelids: 0 }),
  blink: () => 0.25, closure: () => 0.95,
  pinch: () => ({ pinching: false, inputX: 0 }),
  clips: () => ({ chat: { active: true, phase: 'hold', weight: 0.5, elapsedMs: 700, blocked: false }, behavior: { state: { active: false }, reaction: { active: false } },
    body: { active: false, pending: false, mode: 'closed' }, bridge: { active: false, elapsedMs: 0, durationMs: 400, weight: 1 } }),
  physics: () => ({ running: false, parts: null }),
  crying: () => ({ frame: null, support: 'no cheeks', surface: null }),
  poseTime: () => 12.5,
  proceduralLife: () => '{"output":{}}', herLife: () => '{"presence":0}', rps: () => null,
  music: () => ({ hearing: false, tier: null, writes: 0 }),
  ...over,
});
const canvasWith = () => ({ dataset: {} as Record<string, string> }) as unknown as HTMLCanvasElement;
const decision = { render: true, delta: 1 / 60, physicsDelta: 1 / 60, previous: 1, due: 2, rearmed: false } as never;
const read = (canvas: HTMLCanvasElement, key: string) => JSON.parse(canvas.dataset[key] ?? 'null');

test('presence is always written, only when it changes; everything else only in developer mode', () => {
  const canvas = canvasWith();
  let developer = false, presence = 0.5;
  const readouts = new WindowReadouts(canvas, () => developer, sources({ presence: () => presence }));
  readouts.decided(decision, 16); readouts.drawn();
  assert.equal(canvas.dataset.presence, '0.5000');
  assert.deepEqual(Object.keys(canvas.dataset), ['presence'], 'nothing else without developer mode');
  presence = 1; readouts.drawn();
  assert.equal(canvas.dataset.presence, '1');
  developer = true;
  readouts.decided(decision, 32); readouts.drawn();
  for (const key of ['frameClock', 'poseContinuity', 'moodFeedback', 'cheekPinch', 'chatGesture', 'behaviorMotion', 'bodyMotion', 'motionTransition', 'modelPhysics', 'crying', 'proceduralLife', 'herLife']) {
    assert.ok(key in canvas.dataset, `${key} is written in developer mode`);
  }
});

test('the fields the scripts read are there in the old shape', () => {
  const canvas = canvasWith();
  const readouts = new WindowReadouts(canvas, () => true, sources());
  readouts.decided(decision, 16); readouts.decided(decision, 33); readouts.drawn();
  assert.equal(read(canvas, 'frameClock').serial, 2, 'the heartbeat counts drawn frames');
  assert.equal(read(canvas, 'frameClock').skipped.throttled, 0);
  assert.equal(read(canvas, 'frameClock').pace.fps, 60);
  assert.deepEqual(read(canvas, 'poseContinuity'), { jumps: 2, maxAngleDeg: 12, lastJump: { property: '頭', size: 12 } });
  assert.equal(read(canvas, 'moodFeedback').blink, 0.25, 'the shown blink morph joins the mood feedback');
  assert.equal(read(canvas, 'moodFeedback').closure, 0.95, 'and how shut her eyes are as shown');
  assert.deepEqual(read(canvas, 'moodFeedback').head, [0, 0, 0]);
  assert.equal(read(canvas, 'chatGesture').active, true);
  assert.equal(read(canvas, 'motionTransition').layerTimes.pose, 12.5);
  assert.deepEqual(read(canvas, 'crying'), { phase: 'idle', amount: 0, support: 'no cheeks', surface: null }, 'no cry yet: the idle shape the scripts wait for');
});

test('the game readout shows while it plays and is "null" once after it; the layers\' own JSON strings pass through as they are', () => {
  const canvas = canvasWith();
  let rps: unknown = { phase: 'count' };
  const readouts = new WindowReadouts(canvas, () => true, sources({ rps: () => rps }));
  readouts.drawn();
  assert.deepEqual(read(canvas, 'rps'), { phase: 'count' });
  assert.deepEqual(read(canvas, 'herLife'), { presence: 0 });
  rps = null; readouts.drawn();
  assert.equal(canvas.dataset.rps, 'null');
  readouts.drawn(); // and stays so
  assert.equal(canvas.dataset.rps, 'null');
  const quiet = canvasWith();
  new WindowReadouts(quiet, () => true, sources({ rps: () => null })).drawn();
  assert.equal(quiet.dataset.rps, undefined, 'never shown: never written');
});

test('a cry shows as the timeline\'s own frame with the tear surface; a field that cannot be serialised never throws into the frame', () => {
  const canvas = canvasWith();
  const loop: Record<string, unknown> = {}; loop.self = loop;
  const readouts = new WindowReadouts(canvas, () => true, sources({
    crying: () => ({ frame: { id: 'c1', phase: 'crying', amount: 0.4, elapsedMs: 1200 }, support: '', surface: { supported: true, compiled: 2 } }),
    physics: () => loop,
  }));
  assert.doesNotThrow(() => readouts.drawn());
  assert.deepEqual(read(canvas, 'crying'), { id: 'c1', phase: 'crying', amount: 0.4, elapsedMs: 1200, support: '', surface: { supported: true, compiled: 2 } });
  assert.equal(canvas.dataset.modelPhysics, undefined, 'the broken readout is skipped');
});

test('the crying timeline and the pinch layer keep their last frame for the readout, and clear it when they stop', () => {
  const crying = new WindowCrying();
  assert.equal(crying.latest, null);
  crying.frame(1 / 60, { view: null, visible: true, adjusting: false, faceBlocked: false, supported: true, nowMs: 0 });
  assert.equal(crying.latest, null, 'no mood view: no frame');
  const pinch = new WindowPinch();
  assert.equal(pinch.latest, null);
  pinch.frame(1 / 60, { contact: false, hover: 0 } as never, null, 1.6, { face: false, head: false });
  assert.equal(pinch.latest, null, 'no mood view: no pinch');
});
