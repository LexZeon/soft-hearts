import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_POSE_SIGNAL, POSE_SIGNAL_KEYS, parsePoseSignal, parsePoseView, poseMegabytes, type PoseSensingView } from '../shared/pose-signals';
import { parseSensorFrame, parseWorkerMessage } from '../electron/pose/protocol';
import { trayBitmap } from '../electron/pose/tray';
import { sensorMediaAllowed } from '../electron/pose/sensor-policy';

const good = { present: true, confidence: 0.8765, facing: 'toward', posture: 'sitting', energy: 0.31, rhythm: true, tempo: 98.6, events: ['wave'], hand: null, capability: 'full' };

test('a pose signal is exactly the white-listed fields: enums, booleans and clamped numbers', () => {
  assert.deepEqual(parsePoseSignal(good), { ...good, confidence: 0.88, tempo: 99 });
  assert.deepEqual(Object.keys(parsePoseSignal(good)!).sort(), [...POSE_SIGNAL_KEYS].sort());
  assert.deepEqual(parsePoseSignal(EMPTY_POSE_SIGNAL), EMPTY_POSE_SIGNAL);
  assert.equal(parsePoseSignal({ ...good, energy: 7 })!.energy, 1);
  // Anything that could carry a picture, a body coordinate or free text is refused outright.
  for (const extra of [{ keypoints: [[1, 2]] }, { frame: 'data:image/jpeg;base64,AAAA' }, { box: { x1: 1 } }, { note: 'hi' }])
    assert.equal(parsePoseSignal({ ...good, ...extra }), null, Object.keys(extra)[0]);
  for (const bad of [{ facing: 'left' }, { posture: 'dancing' }, { events: ['wave', 'wave'] }, { events: ['jump'] }, { hand: 'fist' },
    { tempo: 250 }, { rhythm: false, tempo: 90 }, { confidence: 'high' }, { present: 1 }, { capability: 'gpu' }, { events: 'wave' }])
    assert.equal(parsePoseSignal({ ...good, ...bad }), null, JSON.stringify(bad));
  const { hand: _hand, ...missing } = good;
  assert.equal(parsePoseSignal(missing), null);
  assert.equal(parsePoseSignal([good]), null);
});

test('worker messages are validated by type with exact keys; a signal inside must pass the signal check', () => {
  assert.deepEqual(parseWorkerMessage({ type: 'ready', route: 'dml', level: 'normal', p90: { dml: 15.2, cpu: 47.9 }, dmlBad: false }),
    { type: 'ready', route: 'dml', level: 'normal', p90: { dml: 15.2, cpu: 47.9 }, dmlBad: false });
  assert.equal(parseWorkerMessage({ type: 'ready', route: 'npu', level: 'normal', p90: { dml: 1, cpu: 1 }, dmlBad: false }), null);
  assert.equal(parseWorkerMessage({ type: 'ready', route: 'dml', level: 'normal', p90: { dml: 1, cpu: 1 }, dmlBad: false, gpu: 'NVIDIA RTX' }), null);
  assert.deepEqual(parseWorkerMessage({ type: 'signal', signal: good })?.type, 'signal');
  assert.equal(parseWorkerMessage({ type: 'signal', signal: { ...good, keypoints: [] } }), null);
  assert.equal(parseWorkerMessage({ type: 'signal', signal: good, frame: new Uint8Array(4) }), null);
  assert.deepEqual(parseWorkerMessage({ type: 'route', route: 'cpu' }), { type: 'route', route: 'cpu' });
  assert.equal(parseWorkerMessage({ type: 'route', route: 'dml' }), null);
  assert.deepEqual(parseWorkerMessage({ type: 'level', level: 'presence-only' }), { type: 'level', level: 'presence-only' });
  assert.deepEqual(parseWorkerMessage({ type: 'failed', reason: 'runtime' }), { type: 'failed', reason: 'runtime' });
  assert.equal(parseWorkerMessage({ type: 'failed', reason: 'C:\\Users\\me\\secret.dll not found' }), null);
  assert.equal(parseWorkerMessage({ type: 'log', text: 'anything' }), null);
});

test('frames from the sensor window: RGBA of the stated size, bounded', () => {
  const ok = parseSensorFrame({ type: 'frame', width: 32, height: 24, data: new ArrayBuffer(32 * 24 * 4) });
  assert.equal(ok?.rgba.byteLength, 32 * 24 * 4);
  assert.ok(parseSensorFrame({ type: 'frame', width: 32, height: 24, data: new Uint8Array(32 * 24 * 4) }));
  assert.equal(parseSensorFrame({ type: 'frame', width: 32, height: 24, data: new ArrayBuffer(10) }), null);
  assert.equal(parseSensorFrame({ type: 'frame', width: 4000, height: 3000, data: new ArrayBuffer(4000 * 3000 * 4) }), null);
  assert.equal(parseSensorFrame({ type: 'frame', width: 32.5, height: 24, data: new ArrayBuffer(10) }), null);
  assert.equal(parseSensorFrame({ type: 'frame', width: 32, height: 24, data: 'data:image/png;base64,AAAA' }), null);
});

test('the state the control window gets has no free text: enums and byte counts only', () => {
  const view: PoseSensingView = { phase: 'running', prompt: false, downloadBytes: 170_023_451, installedBytes: 132_492_252, progress: null,
    route: 'gpu', level: 'normal', componentVersion: 1, notice: '' };
  assert.deepEqual(parsePoseView(view), view);
  assert.ok(!('path' in (parsePoseView({ ...view, path: 'C:\\Users\\me' }) ?? {})), 'unknown keys are dropped, never forwarded');
  for (const bad of [{ phase: 'hacked' }, { notice: 'see C:\\x' }, { route: 'npu' }, { progress: 2 }, { downloadBytes: -1 }])
    assert.equal(parsePoseView({ ...view, ...bad }), null, JSON.stringify(bad));
  assert.equal(poseMegabytes(170_023_451), 170);
});

test('tray: off is byte-identical to the original drawn dot; sensing adds a visible mark', () => {
  const original = Buffer.alloc(24 * 24 * 4);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    const i = (y * 24 + x) * 4, inside = (x - 12) ** 2 + (y - 12) ** 2 < 100;
    original[i] = 230; original[i + 1] = 170; original[i + 2] = 138; original[i + 3] = inside ? 255 : 0;
  }
  assert.deepEqual(trayBitmap(false), original);
  const on = trayBitmap(true);
  let changed = 0;
  for (let i = 0; i < on.length; i += 4) if (on[i] !== original[i] || on[i + 3] !== original[i + 3]) changed++;
  assert.ok(changed > 40, `${changed} pixels differ`);
});

test('the sensor window may use the camera only: video, its own contents, while open', () => {
  assert.equal(sensorMediaAllowed(true, 7, 7, 'media', ['video']), true);
  assert.equal(sensorMediaAllowed(false, 7, 7, 'media', ['video']), false, 'closed handle: denied');
  assert.equal(sensorMediaAllowed(true, 8, 7, 'media', ['video']), false, 'another window: denied');
  assert.equal(sensorMediaAllowed(true, 7, 7, 'media', ['audio']), false, 'microphone: denied');
  assert.equal(sensorMediaAllowed(true, 7, 7, 'media', ['video', 'audio']), false);
  assert.equal(sensorMediaAllowed(true, 7, 7, 'media', []), false);
  assert.equal(sensorMediaAllowed(true, 7, 7, 'display-capture', ['video']), false);
  assert.equal(sensorMediaAllowed(true, undefined, 7, 'media', ['video']), false);
});
