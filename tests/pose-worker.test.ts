import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startPoseWorker } from '../electron/pose/worker';
import type { OrtLike, OrtTensorLike } from '../electron/pose/engine';
import { parseWorkerMessage } from '../electron/pose/protocol';

// The utilityProcess entry with its process boundary replaced: a parent port, a sensor port, a fake runtime.
const fakeOrt: OrtLike = {
  Tensor: class { constructor(public type: string, public data: Float32Array, public dims: number[]) {} } as unknown as OrtLike['Tensor'],
  InferenceSession: { async create(model: Uint8Array) {
    const detector = model[0] === 1;
    return { inputNames: ['input'], outputNames: detector ? ['dets', 'labels'] : ['simcc_x', 'simcc_y'], release: async () => {},
      run: async (): Promise<Record<string, OrtTensorLike>> => detector ? { dets: { data: new Float32Array(0), dims: [1, 0, 5] }, labels: { data: new Float32Array(0), dims: [1, 0] } }
        : { simcc_x: { data: new Float32Array(17 * 384), dims: [1, 17, 384] }, simcc_y: { data: new Float32Array(17 * 512), dims: [1, 17, 512] } } };
  } },
};
function rig(t: { after(fn: () => void): void }, loadRuntime: (entry: string) => OrtLike = () => fakeOrt) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pose-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const detector = path.join(dir, 'd.onnx'), pose = path.join(dir, 'p.onnx');
  writeFileSync(detector, Buffer.from([1])); writeFileSync(pose, Buffer.from([2]));
  const hash = (data: number[]) => createHash('sha256').update(Buffer.from(data)).digest('hex');
  let listener: ((event: { data: unknown; ports: unknown[] }) => void) | null = null;
  const toHost: unknown[] = [], toSensor: unknown[] = [], exits: string[] = [], loaded: string[] = [];
  let sensorListener: ((event: { data: unknown }) => void) | null = null;
  const sensor = { on: (_: string, l: (event: { data: unknown }) => void) => { sensorListener = l; }, postMessage: (m: unknown) => toSensor.push(m), start: () => {}, close: () => {} };
  startPoseWorker({ on: (_event, l) => { listener = l as typeof listener; }, postMessage: m => toHost.push(m) },
    entry => { loaded.push(entry); return loadRuntime(entry); }, reason => exits.push(reason));
  const send = (data: unknown, ports: unknown[] = []) => listener!({ data, ports });
  const init = { type: 'init', runtimeEntry: path.join(dir, 'runtime'), detector, detectorSha256: hash([1]), pose, poseSha256: hash([2]), prefer: null, dmlBad: false };
  const settle = async (until?: () => boolean) => {
    if (!until) { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); return; }
    for (let i = 0; i < 400 && !until(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  };
  return { send, init, toHost, toSensor, exits, loaded, sensor, settle, frame: (data: unknown) => sensorListener!({ data }) };
}

test('init → ready; frames come in over the sensor port and are acknowledged one by one; stop exits cleanly', async t => {
  const r = rig(t);
  r.send(r.init);
  await r.settle(() => r.toHost.length > 0);
  assert.equal(r.loaded.length, 1);
  assert.equal((r.toHost[0] as { type: string }).type, 'ready');
  for (const message of r.toHost) assert.ok(parseWorkerMessage(message), JSON.stringify(message));
  r.send({ type: 'port' }, [r.sensor]);
  assert.deepEqual(r.toSensor[0], { type: 'fps', fps: 2 });
  r.frame({ type: 'frame', width: 320, height: 240, data: new ArrayBuffer(320 * 240 * 4) });
  await r.settle();
  assert.deepEqual(r.toSensor.at(-1), { type: 'ack', fps: 2 });
  r.frame({ type: 'frame', width: 320, height: 240, data: 'not pixels' });
  await r.settle();
  assert.equal(r.toSensor.filter(m => (m as { type: string }).type === 'ack').length, 2, 'a malformed frame is dropped but acknowledged');
  assert.ok(r.toHost.every(message => parseWorkerMessage(message)), 'only protocol messages ever go to the host');
  r.send({ type: 'stop' });
  await r.settle();
  assert.deepEqual(r.exits, ['stopped']);
});

test('relative paths are ignored; a runtime that cannot load reports "failed" (no stack, no path); changed model files are refused', async t => {
  const relative = rig(t);
  relative.send({ ...relative.init, runtimeEntry: 'runtime' });
  await relative.settle();
  assert.deepEqual(relative.loaded, []);
  const broken = rig(t, () => { throw new Error('C:\\…\\onnxruntime_binding.node is not a valid Win32 application'); });
  broken.send(broken.init);
  await broken.settle();
  assert.deepEqual(broken.toHost, [{ type: 'failed', reason: 'runtime' }]);
  const tampered = rig(t);
  tampered.send({ ...tampered.init, poseSha256: '0'.repeat(64) });
  await tampered.settle(() => tampered.toHost.length > 0);
  assert.deepEqual(tampered.toHost, [{ type: 'failed', reason: 'models' }]);
});
