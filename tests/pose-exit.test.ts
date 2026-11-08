// 2026-11-03 exit hang (docs/claude/2026-11-03-pose-exit-hang.md): how a pose inference process ends.
// Order inside the process: stop taking frames → the frame / self-test in flight finishes → every session is
// released → the process ends. Order outside: "stop" → wait (bounded) → kill only then; app quit is bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PoseEngine, type OrtLike, type OrtSessionLike, type OrtTensorLike } from '../electron/pose/engine';
import { syntheticFrame } from '../electron/pose/pipeline';
import { startPoseWorker, type WorkerEnd } from '../electron/pose/worker';
import { KILL_WAIT_MS, QUIT_GRACE_MS, STOP_GRACE_MS, WorkerExits } from '../electron/pose/worker-exit';
import { createPoseQuitGate, POSE_QUIT_LIMIT_MS } from '../electron/pose/quit-gate';

// ---------------------------------------------------------------- a runtime whose runs can be held open

/** Fake onnxruntime: every create/run/release is logged; `hold()` keeps the next runs pending until `release()`. */
function heldOrt(log: string[], options: { dmlRunFails?: boolean; cpuRunFails?: boolean } = {}) {
  let held: (() => void)[] | null = null;
  let sessionId = 0;
  const ort: OrtLike = {
    Tensor: class { constructor(public type: string, public data: Float32Array, public dims: number[]) {} } as unknown as OrtLike['Tensor'],
    InferenceSession: {
      async create(model: Uint8Array, opts: Record<string, unknown>): Promise<OrtSessionLike> {
        const route = (opts.executionProviders as unknown[])[0] === 'cpu' ? 'cpu' : 'dml';
        const detector = model[0] === 1, name = `${route}:${detector ? 'det' : 'pose'}#${++sessionId}`;
        log.push(`create ${name}`);
        let released = false;
        return {
          inputNames: ['input'], outputNames: detector ? ['dets', 'labels'] : ['simcc_x', 'simcc_y'],
          async run(): Promise<Record<string, OrtTensorLike>> {
            assert.equal(released, false, `run on released session ${name}`);
            log.push(`run ${name}`);
            if (held) await new Promise<void>(resolve => held!.push(resolve));
            if (released) throw new Error('run finished on a released session');
            log.push(`ran ${name}`);
            if (route === 'dml' && options.dmlRunFails) throw new Error('device removed');
            if (route === 'cpu' && options.cpuRunFails) throw new Error('out of memory');
            if (detector) return { dets: { data: new Float32Array([100, 30, 220, 238, 0.92]), dims: [1, 1, 5] }, labels: { data: new Float32Array(0), dims: [1, 0] } };
            return { simcc_x: { data: new Float32Array(17 * 384), dims: [1, 17, 384] }, simcc_y: { data: new Float32Array(17 * 512), dims: [1, 17, 512] } };
          },
          async release() { released = true; log.push(`release ${name}`); },
        };
      },
    },
  };
  return {
    ort,
    hold: () => { held = []; },
    /** Let every pending run finish (and stop holding). */
    letGo: () => { const pending = held ?? []; held = null; for (const resolve of pending) resolve(); },
    pending: () => held?.length ?? 0,
    failCpu: () => { options.cpuRunFails = true; },
  };
}
const ticks = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const models = async () => ({ detector: new Uint8Array([1]), pose: new Uint8Array([2]) });

// ---------------------------------------------------------------- engine

test('dispose during a frame in flight: the frame finishes first, then the sessions are released; nothing new opens', async () => {
  const log: string[] = [];
  const fake = heldOrt(log);
  const engine = new PoseEngine({ ort: fake.ort, loadModels: models, emit: () => {}, selfTestFrames: 2 });
  await engine.init({ prefer: 'dml', dmlBad: false });
  assert.equal(engine.route, 'dml');
  fake.hold();
  const frame = engine.frame(syntheticFrame(320, 240), 320, 240);
  await ticks();
  assert.equal(fake.pending(), 1, 'the detector run is on the graphics card');
  let disposed = false;
  const disposing = engine.dispose().then(() => { disposed = true; });
  await ticks();
  assert.equal(disposed, false, 'not released while a run is in flight');
  assert.ok(!log.some(line => line.startsWith('release')), 'no session released under a running frame');
  log.length = 0;
  fake.letGo();
  await frame; await disposing;
  assert.deepEqual(log.filter(line => !line.startsWith('run') && !line.startsWith('ran')), ['release dml:det#1', 'release dml:pose#2']);
  assert.ok(log.indexOf('release dml:det#1') > log.lastIndexOf('ran dml:det#1'), 'released only after the run came back');
  assert.ok(!log.some(line => line.startsWith('create')), 'stopping never falls back to new (CPU) sessions');
  log.length = 0;
  await engine.frame(syntheticFrame(320, 240), 320, 240);
  assert.deepEqual(log, [], 'frames after dispose are dropped');
});

test('dispose during the self-test: it stops part-way, every opened session is released, no "ready"', async () => {
  const log: string[] = [], messages: unknown[] = [];
  const fake = heldOrt(log);
  const engine = new PoseEngine({ ort: fake.ort, loadModels: models, emit: message => messages.push(message), selfTestFrames: 20 });
  fake.hold();
  const init = engine.init({ prefer: null, dmlBad: false });
  await ticks();
  assert.equal(fake.pending(), 1, 'self-test running on DirectML');
  let disposed = false;
  const disposing = engine.dispose().then(() => { disposed = true; });
  await ticks();
  assert.equal(disposed, false, 'dispose waits for the self-test');
  fake.letGo();
  await init; await disposing;
  assert.deepEqual(messages, [], 'a stopped self-test reports nothing');
  const created = log.filter(line => line.startsWith('create')).map(line => line.slice(7));
  const released = log.filter(line => line.startsWith('release')).map(line => line.slice(8));
  assert.deepEqual(released.sort(), created.sort(), 'every session that was opened is released');
  assert.ok(!created.some(name => name.startsWith('cpu')), 'the CPU route is not even opened after the stop');
  assert.ok(log.filter(line => line.startsWith('run')).length <= 4, 'the self-test stops within a frame, not after 20');
});

test('a DirectML run that fails while stopping does not fall back to new CPU sessions or report a route change', async () => {
  const log: string[] = [], messages: { type: string }[] = [];
  const options: { dmlRunFails?: boolean } = {};
  const fake = heldOrt(log, options);
  const engine = new PoseEngine({ ort: fake.ort, loadModels: models, emit: message => messages.push(message), selfTestFrames: 2 });
  await engine.init({ prefer: 'dml', dmlBad: false });
  messages.length = 0;
  fake.hold();
  const frame = engine.frame(syntheticFrame(320, 240), 320, 240);
  await ticks();
  const disposing = engine.dispose();
  options.dmlRunFails = true; // e.g. the device is lost just as the camera goes off
  fake.letGo();
  await frame; await disposing;
  assert.ok(!log.some(line => line.startsWith('create cpu')), 'no CPU sessions are opened while stopping');
  assert.deepEqual(messages, []);
  assert.ok(log.includes('release dml:det#1') && log.includes('release dml:pose#2'));
});

test('a route that fails part-way through the self-test releases its sessions (it used to keep them open)', async () => {
  const log: string[] = [], messages: { type: string }[] = [];
  const fake = heldOrt(log, { dmlRunFails: true });
  const engine = new PoseEngine({ ort: fake.ort, loadModels: models, emit: message => messages.push(message), selfTestFrames: 2 });
  await engine.init({ prefer: null, dmlBad: false });
  assert.ok(log.includes('release dml:det#1') && log.includes('release dml:pose#2'));
  assert.equal(messages[0]?.type, 'ready');
  assert.equal(engine.route, 'cpu');
});

// ---------------------------------------------------------------- worker (utilityProcess entry, boundary faked)

function workerRig(t: { after(fn: () => void): void }, fake: ReturnType<typeof heldOrt>, log: string[], cache: { prefer: 'dml' | 'cpu'; dmlBad: boolean } = { prefer: 'dml', dmlBad: false }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pose-exit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const detector = path.join(dir, 'd.onnx'), pose = path.join(dir, 'p.onnx');
  writeFileSync(detector, Buffer.from([1])); writeFileSync(pose, Buffer.from([2]));
  const hash = (data: number[]) => createHash('sha256').update(Buffer.from(data)).digest('hex');
  let listener: ((event: { data: unknown; ports: unknown[] }) => void) | null = null;
  let frameListener: ((event: { data: unknown }) => void) | null = null;
  const toHost: { type: string }[] = [], ends: WorkerEnd[] = [];
  const sensor = { on: (_: string, l: (event: { data: unknown }) => void) => { frameListener = l; },
    postMessage: (m: { type: string; fps: number }) => log.push(`sensor ${m.type} ${m.fps}`), start: () => {}, close: () => log.push('sensor port closed') };
  startPoseWorker({ on: (_event, l) => { listener = l as typeof listener; }, postMessage: m => toHost.push(m as { type: string }) },
    () => fake.ort, reason => { ends.push(reason); log.push(`end ${reason}`); });
  const send = (data: unknown, ports: unknown[] = []) => listener!({ data, ports });
  send({ type: 'init', runtimeEntry: path.join(dir, 'runtime'), detector, detectorSha256: hash([1]), pose, poseSha256: hash([2]), ...cache });
  return { send, toHost, ends, sensor, frame: () => frameListener!({ data: { type: 'frame', width: 320, height: 240, data: new ArrayBuffer(320 * 240 * 4) } }) };
}

test('worker "stop" with a frame in flight: frames stop, the frame finishes, sessions are released, then the process ends', async t => {
  const log: string[] = [];
  const fake = heldOrt(log);
  const r = workerRig(t, fake, log);
  for (let i = 0; i < 400 && !r.toHost.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(r.toHost[0]?.type, 'ready');
  r.send({ type: 'port' }, [r.sensor]);
  fake.hold();
  r.frame();
  await ticks();
  assert.equal(fake.pending(), 1);
  log.length = 0;
  r.send({ type: 'stop' });
  r.frame(); // a frame that arrives after "stop" is not run
  r.send({ type: 'init' }); r.send({ type: 'pressure', on: true }); // nor is anything else acted on
  await ticks();
  assert.deepEqual(log, ['sensor fps 0', 'sensor port closed'], 'frames stop at once; nothing is released under the running frame');
  assert.deepEqual(r.ends, []);
  fake.letGo();
  await ticks();
  const order = log.filter(line => /^(ran|release|end)/.test(line));
  assert.deepEqual(order.slice(-3), ['release dml:det#1', 'release dml:pose#2', 'end stopped']);
  assert.ok(order.indexOf('ran dml:det#1') < order.indexOf('release dml:det#1'));
  assert.deepEqual(r.ends, ['stopped'], 'ends exactly once');
  assert.ok(!log.some(line => line.startsWith('sensor ack')), 'no acknowledgement after the stop');
  r.send({ type: 'stop' }); await ticks();
  assert.deepEqual(r.ends, ['stopped']);
});

test('worker "stop" before anything was loaded ends at once; a CPU failure releases first, then ends as "failed"', async t => {
  const log: string[] = [];
  let listener: ((event: { data: unknown; ports: unknown[] }) => void) | null = null;
  const ends: WorkerEnd[] = [];
  startPoseWorker({ on: (_e, l) => { listener = l as typeof listener; }, postMessage: () => {} }, () => heldOrt(log).ort, reason => ends.push(reason));
  listener!({ data: { type: 'stop' }, ports: [] });
  await ticks();
  assert.deepEqual(ends, ['stopped']);

  const cpuLog: string[] = [];
  const fake = heldOrt(cpuLog);
  const r = workerRig(t, fake, cpuLog, { prefer: 'cpu', dmlBad: true });
  for (let i = 0; i < 400 && !r.toHost.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(r.toHost[0]?.type, 'ready');
  r.send({ type: 'port' }, [r.sensor]);
  fake.failCpu();
  r.frame();
  await ticks();
  assert.deepEqual(r.ends, ['failed']);
  assert.deepEqual(cpuLog.filter(line => /^(release|end)/.test(line)), ['release cpu:det#1', 'release cpu:pose#2', 'end failed'],
    'even a failing process releases its sessions before it ends');
});

// ---------------------------------------------------------------- main-process side

function clock() {
  let now = 0, id = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return {
    timers: { now: () => now, setTimer: (run: () => void, ms: number) => { timers.set(++id, { at: now + ms, run }); return id; }, clearTimer: (h: unknown) => { timers.delete(h as number); } },
    flush,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].run(); await flush();
      }
      now = end; await flush();
    },
    now: () => now,
  };
}
function fakeProcess(log: string[], name: string, { endsOnStop = true, killable = true } = {}) {
  let exited!: () => void;
  const process = { exited: new Promise<void>(resolve => { exited = () => { log.push(`${name} exited`); resolve(); }; }),
    stop: () => { log.push(`${name} stop`); if (endsOnStop) queueMicrotask(exited); },
    kill: () => { log.push(`${name} kill`); if (killable) queueMicrotask(exited); } };
  return process;
}

test('WorkerExits: stop first; kill only after the grace; give up after KILL_WAIT_MS; app quit hurries the grace', async () => {
  const c = clock(), log: string[] = [];
  const exits = new WorkerExits(c.timers);
  const outcomes: string[] = [];
  void exits.retire(fakeProcess(log, 'a')).then(o => outcomes.push(`a ${o}`));
  await c.flush();
  assert.deepEqual(log, ['a stop', 'a exited']);
  assert.deepEqual(outcomes, ['a stopped']);
  assert.equal(exits.pending, 0);

  void exits.retire(fakeProcess(log, 'b', { endsOnStop: false })).then(o => outcomes.push(`b ${o}`));
  await c.advance(STOP_GRACE_MS - 1);
  assert.ok(!log.includes('b kill'));
  await c.advance(1);
  assert.deepEqual(log.slice(-3), ['b stop', 'b kill', 'b exited']);
  assert.deepEqual(outcomes.at(-1), 'b killed');

  const t0 = c.now();
  void exits.retire(fakeProcess(log, 'c', { endsOnStop: false, killable: false })).then(o => outcomes.push(`c ${o}`));
  let settled = false;
  void exits.settled().then(() => { settled = true; });
  await c.advance(500);
  exits.hurry(QUIT_GRACE_MS); // the app quits 0.5 s after the camera went off
  await c.advance(QUIT_GRACE_MS);
  assert.equal(log.at(-1), 'c kill', 'killed 1.5 s after the quit, not 3 s after the stop');
  assert.equal(settled, false);
  await c.advance(KILL_WAIT_MS);
  assert.equal(outcomes.at(-1), 'c unresponsive');
  assert.equal(settled, true, 'never waits forever');
  assert.equal(c.now() - t0, 500 + QUIT_GRACE_MS + KILL_WAIT_MS);
});

test('quit gate: no pose host or nothing running → the quit is not held; otherwise held once, resumed once, bounded', async () => {
  const quits: number[] = [];
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const setTimer = (run: () => void, ms: number) => { timers.push({ at: now + ms, run }); return timers.length; };
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  assert.equal(createPoseQuitGate(() => null, () => quits.push(now), setTimer).hold(), false);

  let shutdowns = 0;
  const idle = createPoseQuitGate(() => ({ busy: false, shutdown: async () => { shutdowns++; } }), () => quits.push(now), setTimer);
  assert.equal(idle.hold(), false);
  assert.equal(shutdowns, 1, 'still told to stop and start nothing new');
  assert.equal(idle.hold(), false);
  assert.equal(shutdowns, 1);

  let end!: () => void;
  const busy = createPoseQuitGate(() => ({ busy: true, shutdown: () => new Promise<void>(resolve => { end = resolve; }) }), () => quits.push(now), setTimer);
  assert.equal(busy.hold(), true);
  assert.equal(busy.hold(), true, 'a second before-quit while waiting is held too');
  now = 300; end(); await flush();
  assert.deepEqual(quits, [300], 'the quit resumes as soon as the inference process has ended');
  for (const timer of timers.splice(0)) { now = timer.at; timer.run(); }
  assert.deepEqual(quits, [300], 'and only once');
  assert.equal(busy.hold(), false, 'the resumed quit goes through');

  now = 0; quits.length = 0;
  const stuck = createPoseQuitGate(() => ({ busy: true, shutdown: () => new Promise<void>(() => {}) }), () => quits.push(now), setTimer);
  assert.equal(stuck.hold(), true);
  for (const timer of timers.splice(0)) { now = timer.at; timer.run(); }
  assert.deepEqual(quits, [POSE_QUIT_LIMIT_MS], 'a process that never ends cannot hold the app open');
  assert.ok(POSE_QUIT_LIMIT_MS >= QUIT_GRACE_MS + KILL_WAIT_MS, 'the limit leaves room for the normal stop → kill path');
});
