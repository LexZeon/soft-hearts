import test from 'node:test';
import assert from 'node:assert/strict';
import { PoseEngine, type OrtLike, type OrtSessionLike, type OrtTensorLike } from '../electron/pose/engine';
import { parseWorkerMessage, type WorkerToHost } from '../electron/pose/protocol';
import { syntheticFrame } from '../electron/pose/pipeline';

// onnxruntime stand-in: per-route cost (ms on a fake clock), optional DirectML failures, a switchable "person".
// The detector model is the byte [1], the pose model [2]; outputs have the real models' names and shapes.
function rig(options: { cost: { dml: number; cpu: number }; dmlCreateFails?: boolean; person?: () => boolean }) {
  let clock = 0, dmlRunFails = false;
  const created: string[] = [];
  const ort: OrtLike = {
    Tensor: class { constructor(public type: string, public data: Float32Array, public dims: number[]) {} } as unknown as OrtLike['Tensor'],
    InferenceSession: {
      async create(model: Uint8Array, opts: Record<string, unknown>): Promise<OrtSessionLike> {
        const providers = opts.executionProviders as unknown[];
        const route = providers[0] === 'cpu' ? 'cpu' : 'dml';
        if (route === 'cpu') assert.equal(opts.intraOpNumThreads, 2, 'CPU uses 2 threads');
        if (route === 'dml' && options.dmlCreateFails) throw new Error('DXGI_ERROR_UNSUPPORTED');
        const detector = model[0] === 1;
        created.push(`${route}:${detector ? 'det' : 'pose'}`);
        return {
          inputNames: ['input'], outputNames: detector ? ['dets', 'labels'] : ['simcc_x', 'simcc_y'],
          async run(): Promise<Record<string, OrtTensorLike>> {
            if (route === 'dml' && dmlRunFails) throw new Error('device removed');
            clock += options.cost[route] / 2;
            if (detector) {
              const person = options.person?.() ?? true;
              return { dets: { data: person ? new Float32Array([100, 30, 220, 238, 0.92]) : new Float32Array(0), dims: [1, person ? 1 : 0, 5] }, labels: { data: new Float32Array(0), dims: [1, 0] } };
            }
            const x = new Float32Array(17 * 384), y = new Float32Array(17 * 512);
            for (let k = 0; k < 17; k++) { x[k * 384 + 150 + k * 4] = 0.9; y[k * 512 + 120 + k * 15] = 0.9; }
            return { simcc_x: { data: x, dims: [1, 17, 384] }, simcc_y: { data: y, dims: [1, 17, 512] } };
          },
          async release() { created.push(`${route}:released`); },
        };
      },
    },
  };
  const messages: WorkerToHost[] = [];
  const engine = new PoseEngine({ ort, now: () => clock, emit: m => messages.push(m), selfTestFrames: 20,
    loadModels: async () => ({ detector: new Uint8Array([1]), pose: new Uint8Array([2]) }) });
  const frame = syntheticFrame(320, 240);
  return { engine, messages, created, frame, failDml: () => { dmlRunFails = true; }, advance: (ms: number) => { clock += ms; },
    frames: async (n: number, gap = 200) => { for (let i = 0; i < n; i++) { clock += gap; await engine.frame(frame, 320, 240); } } };
}

test('self-test on synthetic frames picks DirectML when faster, keeps only that route open, reports p90s', async () => {
  const r = rig({ cost: { dml: 12, cpu: 45 } });
  await r.engine.init({ prefer: null, dmlBad: false });
  assert.deepEqual(r.messages, [{ type: 'ready', route: 'dml', level: 'normal', p90: { dml: 12, cpu: 45 }, dmlBad: false }]);
  assert.ok(r.created.includes('cpu:released'), 'the losing CPU sessions were released');
  for (const message of r.messages) assert.deepEqual(parseWorkerMessage(message), message, 'every message passes the host check');
});

test('DirectML that cannot start: CPU without a technical error; remembered as dmlBad', async () => {
  const r = rig({ cost: { dml: 12, cpu: 45 }, dmlCreateFails: true });
  await r.engine.init({ prefer: null, dmlBad: false });
  assert.deepEqual(r.messages, [{ type: 'ready', route: 'cpu', level: 'normal', p90: { dml: null, cpu: 45 }, dmlBad: true }]);
  const cached = rig({ cost: { dml: 12, cpu: 45 } });
  await cached.engine.init({ prefer: 'cpu', dmlBad: true });
  assert.ok(!cached.created.some(name => name.startsWith('dml')), 'a remembered DirectML failure is not retried');
});

test('slow computers start lower on the ladder; far too slow ones pause instead of spinning', async () => {
  const slow = rig({ cost: { dml: 0, cpu: 300 }, dmlCreateFails: true });
  await slow.engine.init({ prefer: null, dmlBad: false });
  assert.equal((slow.messages[0] as { level: string }).level, 'minimal');
  const hopeless = rig({ cost: { dml: 0, cpu: 3000 }, dmlCreateFails: true });
  await hopeless.engine.init({ prefer: null, dmlBad: false });
  assert.deepEqual(hopeless.messages, [{ type: 'paused' }]);
  assert.equal(hopeless.engine.desiredFps(), 0);
});

test('DirectML failing mid-run falls back to the CPU inside the process and keeps going', async () => {
  const r = rig({ cost: { dml: 12, cpu: 45 } });
  await r.engine.init({ prefer: null, dmlBad: false });
  await r.frames(3);
  r.failDml();
  await r.frames(1);
  assert.deepEqual(r.messages.filter(m => m.type === 'route'), [{ type: 'route', route: 'cpu' }]);
  assert.equal(r.engine.route, 'cpu');
  const before = r.messages.length;
  await r.frames(12, 600);
  assert.ok(r.messages.slice(before).some(m => m.type === 'signal'), 'signals continue on the CPU');
});

test('adaptive frame rate: 2 fps while nobody is there, 5 fps once somebody is', async () => {
  let person = false;
  const r = rig({ cost: { dml: 12, cpu: 45 }, person: () => person });
  await r.engine.init({ prefer: null, dmlBad: false });
  await r.frames(3, 500);
  assert.equal(r.engine.desiredFps(), 2);
  const signal = [...r.messages].reverse().find(m => m.type === 'signal');
  assert.equal(signal && signal.type === 'signal' && signal.signal.present, false);
  person = true;
  await r.frames(3, 200);
  assert.equal(r.engine.desiredFps(), 5);
  assert.ok(r.messages.some(m => m.type === 'signal' && m.signal.present), 'a presence change is sent at once');
});

test('a CPU that becomes too slow steps down the ladder and finally pauses', async () => {
  const costs = { dml: 0, cpu: 45 };
  const r = rig({ cost: costs, dmlCreateFails: true });
  await r.engine.init({ prefer: null, dmlBad: false });
  costs.cpu = 160;
  await r.frames(10, 200);
  assert.deepEqual(r.messages.filter(m => m.type === 'level'), [{ type: 'level', level: 'reduced' }]);
  costs.cpu = 5000;
  await r.frames(60, 1000);
  assert.equal(r.messages.at(-1)?.type, 'paused');
  const count = r.messages.length;
  await r.frames(5, 1000);
  assert.equal(r.messages.length, count, 'paused: frames are ignored');
});
