import test from 'node:test';
import assert from 'node:assert/strict';
import { CRASH_LIMIT, FIRST_SIGNAL_MS, PoseSupervisor, RESTART_DELAYS_MS, type SensorStatus } from '../electron/pose/supervisor';
import type { HostToWorker } from '../electron/pose/protocol';
import { KILL_WAIT_MS, QUIT_GRACE_MS, STOP_GRACE_MS } from '../electron/pose/worker-exit';

const signal = { present: true, confidence: 0.9, facing: 'toward', posture: 'sitting', energy: 0.2, rhythm: false, tempo: null, events: ['wave'], hand: null, capability: 'full' };
const READY = { type: 'ready', route: 'dml', level: 'normal', p90: { dml: 15, cpu: 45 }, dmlBad: false };

/**
 * How the next fake inference process behaves when asked to stop / killed: by default it ends on "stop" like
 * the real one (worker.ts); 'ignore' models one busy in a long native call, or one that cannot even be killed.
 */
interface Behaviour { onStop: 'exit' | 'ignore'; onKill: 'exit' | 'ignore' }

function rig() {
  let now = 0, id = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const workers: { posted: { message: HostToWorker; transfer?: unknown[] }[]; message?: (m: unknown) => void; exit?: (code: number) => void; killed: boolean; exited: boolean }[] = [];
  const sensors: { port: unknown; status: (s: SensorStatus) => void; closed: boolean }[] = [];
  const disabled: string[] = [], signals: unknown[] = [], routes: unknown[] = [];
  const log: string[] = [];
  let behaviour: Behaviour = { onStop: 'exit', onKill: 'exit' };
  const supervisor = new PoseSupervisor({
    prepare: async () => ({ runtimeEntry: 'C:\\c\\runtime', detector: 'C:\\c\\d.onnx', detectorSha256: 'a', pose: 'C:\\c\\p.onnx', poseSha256: 'b', prefer: null, dmlBad: false }),
    fork: () => {
      const worker = { posted: [] as { message: HostToWorker; transfer?: unknown[] }[], killed: false, exited: false } as (typeof workers)[number];
      const index = workers.push(worker) - 1, own = behaviour;
      log.push(`fork ${index}`);
      const end = (code: number) => { if (worker.exited) return; worker.exited = true; log.push(`exit ${index}`); worker.exit?.(code); };
      return {
        postMessage: (message, transfer) => {
          worker.posted.push({ message, transfer }); log.push(`${message.type} → ${index}`);
          if (message.type === 'stop' && own.onStop === 'exit') queueMicrotask(() => end(1));
        },
        onMessage: l => { worker.message = l; }, onExit: l => { worker.exit = l; },
        kill: () => { worker.killed = true; log.push(`kill ${index}`); if (own.onKill === 'exit') queueMicrotask(() => end(1)); },
      };
    },
    channel: () => ({ worker: 'worker-port', sensor: 'sensor-port' }),
    openSensor: (port, status) => { const sensor = { port, status, closed: false }; sensors.push(sensor); return { close: () => { sensor.closed = true; log.push('sensor closed'); } }; },
    saveRoute: result => routes.push(result),
    disableCamera: reason => disabled.push(reason),
    changed: () => {},
    signal: value => signals.push(value),
    now: () => now,
    setTimer: (run, ms) => { timers.set(++id, { at: now + ms, run }); return id; },
    clearTimer: handle => { timers.delete(handle as number); },
  });
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].run(); await flush();
    }
    now = end;
  };
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { supervisor, workers, sensors, disabled, signals, routes, advance, flush, log, worker: () => workers.at(-1)!,
    nextWorker: (next: Partial<Behaviour>) => { behaviour = { ...behaviour, ...next }; }, now: () => now };
}

test('camera on: init → self-test → sensor window; only validated abstract signals get through', async () => {
  const r = rig();
  r.supervisor.setWanted(true); await r.flush();
  assert.equal(r.supervisor.phase, 'starting');
  assert.equal(r.worker().posted[0].message.type, 'init');
  assert.equal(r.sensors.length, 0, 'the camera is not opened before the models are ready');
  r.worker().message!(READY);
  assert.equal(r.supervisor.phase, 'running');
  assert.deepEqual(r.worker().posted[1], { message: { type: 'port' }, transfer: ['worker-port'] });
  assert.equal(r.sensors[0].port, 'sensor-port');
  assert.equal(r.supervisor.route, 'gpu');
  r.worker().message!({ type: 'signal', signal });
  r.worker().message!({ type: 'signal', signal: { ...signal, keypoints: [[100, 120]] } });
  r.worker().message!({ type: 'signal', signal, image: 'data:image/jpeg;base64,AAAA' });
  r.worker().message!({ type: 'debug', text: 'C:\\Users\\me' });
  assert.equal(r.signals.length, 1);
  assert.deepEqual(Object.fromEntries(r.supervisor.diagnostics), { present: 1, wave: 1 }, 'diagnostics: categories and counts only');
});

test('camera off stops at once: sensor window closed first, then "stop"; a process that ends by itself is never killed', async () => {
  const r = rig();
  r.supervisor.setWanted(true); await r.flush();
  r.worker().message!(READY);
  r.supervisor.setWanted(false);
  assert.equal(r.sensors[0].closed, true);
  assert.equal(r.worker().posted.at(-1)!.message.type, 'stop');
  assert.equal(r.supervisor.phase, 'off');
  assert.equal(r.supervisor.latest, null);
  assert.deepEqual(r.log, ['fork 0', 'init → 0', 'port → 0', 'sensor closed', 'stop → 0']);
  await r.flush();
  assert.deepEqual(r.log.slice(-1), ['exit 0']);
  assert.equal(r.supervisor.busy, false);
  await r.advance(120_000);
  assert.equal(r.worker().killed, false, '2026-11-03: killing it mid-release was the hazard; it ended by itself');
  assert.equal(r.workers.length, 1, 'an exit after "off" never restarts anything');
  assert.deepEqual(Object.fromEntries(r.supervisor.diagnostics), {});
});

test('an inference process that does not end after "stop" is killed only after the grace period', async () => {
  const r = rig();
  r.nextWorker({ onStop: 'ignore' }); // busy in a long native call
  r.supervisor.setWanted(true); await r.flush();
  r.worker().message!(READY);
  r.supervisor.setWanted(false);
  assert.equal(r.supervisor.busy, true);
  await r.advance(STOP_GRACE_MS - 1);
  assert.equal(r.worker().killed, false, 'not while it may still be finishing a frame or releasing its sessions');
  await r.advance(1);
  assert.equal(r.worker().killed, true);
  await r.flush();
  assert.equal(r.supervisor.busy, false);
  assert.deepEqual(r.log.slice(-3), ['stop → 0', 'kill 0', 'exit 0']);
  assert.equal(r.supervisor.diagnostics.get('stop-killed'), 1);
});

test('camera off and on again quickly: the new inference process starts only after the old one has ended', async () => {
  const r = rig();
  r.nextWorker({ onStop: 'ignore' });
  r.supervisor.setWanted(true); await r.flush();
  r.worker().message!(READY);
  r.supervisor.setWanted(false);
  r.nextWorker({ onStop: 'exit' });
  r.supervisor.setWanted(true); await r.flush();
  assert.equal(r.workers.length, 1, 'two inference processes never hold the graphics card at once');
  assert.equal(r.supervisor.phase, 'starting');
  await r.advance(STOP_GRACE_MS); await r.flush();
  assert.equal(r.workers.length, 2);
  assert.deepEqual(r.log.slice(-4), ['kill 0', 'exit 0', 'fork 1', 'init → 1']);
  r.worker().message!(READY);
  assert.equal(r.supervisor.phase, 'running');
});

test('app quit: stop, start nothing new, resolve once the inference process has ended by itself', async () => {
  const r = rig();
  r.supervisor.setWanted(true); await r.flush();
  r.worker().message!(READY);
  let ended = false;
  void r.supervisor.shutdown().then(() => { ended = true; });
  assert.equal(r.sensors[0].closed, true);
  assert.equal(r.worker().posted.at(-1)!.message.type, 'stop');
  await r.flush(); await r.flush();
  assert.equal(ended, true);
  assert.equal(r.worker().killed, false);
  r.supervisor.setWanted(true); await r.flush();
  await r.advance(10 * 60_000);
  assert.equal(r.workers.length, 1, 'nothing starts once quitting has begun');
  assert.equal(r.supervisor.phase, 'off');
});

test('app quit is bounded: a stuck process is killed after QUIT_GRACE_MS, one that cannot be killed is given up on', async () => {
  for (const onKill of ['exit', 'ignore'] as const) {
    const r = rig();
    r.nextWorker({ onStop: 'ignore', onKill });
    r.supervisor.setWanted(true); await r.flush();
    r.worker().message!(READY);
    let endedAt: number | null = null;
    void r.supervisor.shutdown().then(() => { endedAt = r.now(); });
    await r.advance(QUIT_GRACE_MS - 1);
    assert.equal(r.worker().killed, false);
    await r.advance(1); await r.flush();
    assert.equal(r.worker().killed, true);
    if (onKill === 'exit') assert.equal(endedAt, QUIT_GRACE_MS);
    else {
      assert.equal(endedAt, null);
      await r.advance(KILL_WAIT_MS); await r.flush();
      assert.equal(endedAt, QUIT_GRACE_MS + KILL_WAIT_MS, 'quitting never waits longer than this');
      assert.equal(r.supervisor.diagnostics.get('stop-unresponsive'), 1);
    }
  }
});

test('app quit right after camera off shortens the wait for the process still ending', async () => {
  const r = rig();
  r.nextWorker({ onStop: 'ignore' });
  r.supervisor.setWanted(true); await r.flush();
  r.worker().message!(READY);
  r.supervisor.setWanted(false);
  await r.advance(500);
  let endedAt: number | null = null;
  void r.supervisor.shutdown().then(() => { endedAt = r.now(); });
  await r.advance(QUIT_GRACE_MS); await r.flush();
  assert.equal(r.worker().killed, true);
  assert.equal(endedAt, 500 + QUIT_GRACE_MS, 'not the camera-off grace of ' + STOP_GRACE_MS + ' ms');
});

test('a restart after a stall waits for the stalled process to end; a quit during the restart delay starts nothing', async () => {
  const r = rig();
  r.supervisor.setWanted(true); await r.flush();
  r.worker().message!(READY);
  await r.advance(FIRST_SIGNAL_MS); await r.flush();
  assert.equal(r.supervisor.phase, 'restarting');
  assert.deepEqual(r.log.slice(-3), ['sensor closed', 'stop → 0', 'exit 0'], 'camera closed first, then the inference process');
  await r.supervisor.shutdown();
  await r.advance(10 * 60_000);
  assert.equal(r.workers.length, 1);
});

test('crashes restart with backoff (5 s, 20 s); the third within 5 minutes gives up and turns the camera off', async () => {
  const r = rig();
  r.supervisor.setWanted(true); await r.flush();
  r.worker().message!(READY);
  r.worker().exit!(3);
  assert.equal(r.supervisor.phase, 'restarting');
  assert.equal(r.sensors[0].closed, true);
  await r.advance(RESTART_DELAYS_MS[0] - 1);
  assert.equal(r.workers.length, 1);
  await r.advance(1);
  assert.equal(r.workers.length, 2);
  r.worker().exit!(3);
  await r.advance(RESTART_DELAYS_MS[1]);
  assert.equal(r.workers.length, 3);
  r.worker().exit!(3);
  assert.equal(CRASH_LIMIT, 3);
  assert.deepEqual(r.disabled, ['crashed']);
  assert.equal(r.supervisor.phase, 'off');
  await r.advance(10 * 60_000);
  assert.equal(r.workers.length, 3, 'no restart after giving up');
  assert.equal(r.supervisor.diagnostics.get('crash'), 3);
});

test('crashes far apart do not add up; turning the camera on again starts with a clean count', async () => {
  const r = rig();
  r.supervisor.setWanted(true); await r.flush();
  for (let i = 0; i < 4; i++) {
    r.worker().message!(READY);
    for (let beat = 0; beat < 72; beat++) { r.worker().message!({ type: 'signal', signal }); await r.advance(5_000); } // six healthy minutes
    r.worker().exit!(3);
    await r.advance(RESTART_DELAYS_MS[0]);
  }
  assert.deepEqual(r.disabled, []);
  assert.equal(r.workers.length, 5);
  r.supervisor.setWanted(false);
  r.supervisor.setWanted(true); await r.flush();
  r.worker().message!(READY); r.worker().exit!(3); await r.advance(RESTART_DELAYS_MS[0]);
  r.worker().message!(READY); r.worker().exit!(3);
  assert.deepEqual(r.disabled, [], 'a fresh switch-on forgets the earlier crashes');
});

test('a sensor that never delivers frames, a blocked camera, a too-slow computer', async () => {
  const stalled = rig();
  stalled.supervisor.setWanted(true); await stalled.flush();
  stalled.worker().message!(READY);
  await stalled.advance(FIRST_SIGNAL_MS);
  assert.equal(stalled.supervisor.phase, 'restarting', 'no first signal: treated as a stall');
  assert.equal(stalled.sensors[0].closed, true);

  const blocked = rig();
  blocked.supervisor.setWanted(true); await blocked.flush();
  blocked.worker().message!(READY);
  blocked.sensors[0].status('camera-error');
  assert.deepEqual(blocked.disabled, ['camera-unavailable']);
  assert.equal(blocked.supervisor.phase, 'off');
  await blocked.advance(120_000);
  assert.equal(blocked.workers.length, 1, 'a camera the system refuses is not retried');

  const slow = rig();
  slow.supervisor.setWanted(true); await slow.flush();
  slow.worker().message!(READY);
  slow.worker().message!({ type: 'paused' });
  assert.deepEqual(slow.disabled, ['too-slow']);
  assert.equal(slow.sensors[0].closed, true);
});

test('GPU fallback inside the process is remembered for this computer', async () => {
  const r = rig();
  r.supervisor.setWanted(true); await r.flush();
  r.worker().message!(READY);
  r.worker().message!({ type: 'route', route: 'cpu' });
  assert.equal(r.supervisor.route, 'cpu');
  assert.deepEqual(r.routes.at(-1), { route: 'cpu', dmlBad: true, p90: { dml: null, cpu: null } });
});
