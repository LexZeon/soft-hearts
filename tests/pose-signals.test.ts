import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_POSE_SIGNAL, POSE_SIGNAL_KEYS, parsePoseSignal, parsePoseView, poseMegabytes, type PoseSensingView } from '../shared/senses/pose-signals';
import { parseSensorFrame, parseWorkerMessage } from '../electron/senses/pose/protocol';
import { trayBitmap } from '../electron/senses/pose/tray';
import { sensorMediaAllowed } from '../electron/senses/pose/sensor-policy';

const good = { present: true, confidence: 0.8765, facing: 'toward', facingConfidence: 0.81, posture: 'sitting', postureConfidence: 0.72, energy: 0.31, rhythm: true, tempo: 98.6, events: ['wave'], eventConfidence: { wave: 0.66 }, hand: null, capability: 'full',
  face: null as { x: number; y: number } | null, points: [] as ({ x: number; y: number } | null)[], head: null as { yaw: number; pitch: number; distance: number } | null };
/** I-081: a face and 17 points (some unseen). */
const body = Array.from({ length: 17 }, (_, i) => i % 5 === 4 ? null : { x: 0.3 + i * 0.02, y: 0.2 + i * 0.03 });

test('a pose signal is exactly the white-listed fields: enums, booleans and clamped numbers', () => {
  assert.deepEqual(parsePoseSignal(good), { ...good, confidence: 0.88, tempo: 99, people: 0 }); // I-189: no people count (an older signal) reads as 0
  assert.deepEqual(Object.keys(parsePoseSignal(good)!).sort(), [...POSE_SIGNAL_KEYS].sort());
  assert.deepEqual(parsePoseSignal(EMPTY_POSE_SIGNAL), EMPTY_POSE_SIGNAL);
  assert.equal(parsePoseSignal({ ...good, energy: 7 })!.energy, 1);
  // Anything that could carry a picture, pixels outside the two position fields, or free text is refused outright.
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

test('I-081: the face and the body points pass as 0..1 numbers with two decimals; clamped; malformed ones refuse the whole message', () => {
  const withBody = { ...good, face: { x: 0.4567, y: 0.25 }, points: body };
  const parsed = parsePoseSignal(withBody)!;
  assert.deepEqual(parsed.face, { x: 0.46, y: 0.25 });
  assert.equal(parsed.points.length, 17);
  assert.deepEqual(parsed.points[0], { x: 0.3, y: 0.2 });
  assert.equal(parsed.points[4], null);
  // Out of range is clamped to the frame (like the other numbers), never refused for that alone.
  assert.deepEqual(parsePoseSignal({ ...withBody, face: { x: 1.4, y: -0.2 } })!.face, { x: 1, y: 0 });
  // Refused: not finite, a wrong count, extra keys in a point, a point that is not an object, text, a position without anyone there.
  const bad: Record<string, unknown>[] = [
    { face: { x: NaN, y: 0.5 } }, { face: { x: Infinity, y: 0.5 } }, { face: { x: '0.5', y: 0.5 } }, { face: { x: 0.5 } }, { face: { x: 0.5, y: 0.5, z: 1 } },
    { face: [0.5, 0.5] }, { face: 'center' }, { points: body.slice(0, 16) }, { points: [...body, null] }, { points: Array(200).fill(null) },
    { points: body.map((p, i) => i === 3 ? { x: 0.1, y: 0.2, score: 0.9 } : p) }, { points: body.map((p, i) => i === 3 ? { x: NaN, y: 0.2 } : p) },
    { points: body.map((p, i) => i === 3 ? [0.1, 0.2] : p) }, { points: 'none' }, { present: false, rhythm: false, tempo: null }, { capability: 'presence-only' },
    { face: null, points: body },
  ];
  for (const change of bad) assert.equal(parsePoseSignal({ ...withBody, ...change }), null, JSON.stringify(change));
  // Absent fields are refused too (the shape is exact).
  const { face: _face, ...noFace } = withBody;
  assert.equal(parsePoseSignal(noFace), null);
  // Nobody there, or presence only: no position.
  assert.deepEqual(parsePoseSignal({ ...good, present: false, rhythm: false, tempo: null })!.points, []);
  assert.equal(parsePoseSignal({ ...good, capability: 'presence-only' })!.face, null);
});

test('I-167: the head reading passes as whole degrees and metres (two decimals), clamped, only with a face; anything else refuses the message', () => {
  const withHead = { ...good, face: { x: 0.5, y: 0.4 }, points: body, head: { yaw: 12.6, pitch: -95, distance: 0.6349 } };
  assert.deepEqual(parsePoseSignal(withHead)!.head, { yaw: 13, pitch: -90, distance: 0.63 });
  assert.deepEqual(parsePoseSignal({ ...withHead, head: { yaw: 0, pitch: 0, distance: 9 } })!.head, { yaw: 0, pitch: 0, distance: 5 });
  assert.equal(parsePoseSignal({ ...withHead, head: null })!.head, null);
  for (const head of [{ yaw: 1, pitch: 2 }, { yaw: 1, pitch: 2, distance: 0.6, roll: 3 }, { yaw: NaN, pitch: 0, distance: 0.6 }, { yaw: '1', pitch: 0, distance: 0.6 },
    [1, 2, 0.6], 'left', { yaw: 1, pitch: 2, distance: Infinity }])
    assert.equal(parsePoseSignal({ ...withHead, head }), null, JSON.stringify(head));
  assert.equal(parsePoseSignal({ ...withHead, face: null, points: [] }), null, 'a head reading without a face is refused');
  const { head: _head, ...noHead } = withHead;
  assert.equal(parsePoseSignal(noHead), null, 'the field is required (the shape is exact)');
});

test('I-081: every place that lists what pose sensing recognises says the position and the body points, local only, not stored, not uploaded', async () => {
  const { POSE_RECOGNISES, POSE_LOCAL_ONLY } = await import('../shared/senses/pose-signals');
  const { CAMERA_POSE_HINT } = await import('../src/senses/CameraSharingPanel');
  const { posePromptText } = await import('../src/senses/PoseSensingPanel');
  const { CAPABILITIES } = await import('../shared/settings/capabilities');
  const { readFileSync } = await import('node:fs');
  const words = ['在不在', '朝向', '坐着还是站着', '动作幅度', '挥手', '画面里的位置', '身体各个点的坐标'];
  for (const word of words) assert.ok(POSE_RECOGNISES.includes(word), word);
  const places: [string, string][] = [
    ['camera panel', CAMERA_POSE_HINT],
    ['download question', posePromptText({ phase: 'not-installed', prompt: true, downloadBytes: 170_000_000, installedBytes: 0, progress: null, route: null, level: null, componentVersion: 1, notice: '' })],
    ['handbook entry', CAPABILITIES.find(entry => entry.id === 'camera_pose')!.description],
  ];
  for (const [where, text] of places) {
    for (const word of words) assert.ok(text.includes(word), `${where}: ${word}`);
    assert.match(text, /不保存/u, where); assert.match(text, /不上传/u, where); assert.match(text, /电脑/u, where);
  }
  assert.match(CAMERA_POSE_HINT, /打开就算你同意/u, 'on = consent, said where it is turned on');
  // The internal channel's confirmation (camera_pose and the old camera switch) is built from the same words (its dialog text, read
  // from the tool itself: the source moved to electron/safety/agent-channel/tools/senses.ts on 2026-11-17).
  const { createAppTools } = await import('../electron/safety/agent-channel/app-tools');
  const perception = createAppTools({} as never).find(tool => tool.name === 'set_perception')!;
  for (const kind of ['camera_pose', 'camera'] as const)
    assert.ok(perception.confirmation!({ kind, enabled: true, purposes: [] }).detail.includes(`姿势识别会识别${POSE_RECOGNISES}；${POSE_LOCAL_ONLY}`), kind);
  assert.ok(!perception.confirmation!({ kind: 'screen', enabled: true, purposes: [] }).detail.includes(POSE_RECOGNISES), 'only the pose switches say it');
  assert.ok(POSE_LOCAL_ONLY.includes('不保存') && POSE_LOCAL_ONLY.includes('不上传'));
  // The control window's row says it in the same words as the companion's panel.
  assert.ok(readFileSync(new URL('../src/settings/layout.ts', import.meta.url), 'utf8').includes(`'${CAMERA_POSE_HINT}'`));
});
