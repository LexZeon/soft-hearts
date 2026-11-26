// The pose worker ends itself at once on stop (docs/claude/2026-11-03-pose-exit-hang.md): process.exit after DirectML
// inference could hang with one thread, impossible to kill until a restart, and even a worker that loaded nothing native
// lingered on a freshly copied package. The packaged smoke check (scripts/smoke.mjs checkPoseHost) only measures how
// quickly the system reports the exit, which a busy machine or a virus scan of a fresh package can delay; this test
// guards the code-level rule itself, independent of load.
import assert from 'node:assert/strict';
import test from 'node:test';
import { endProcess, startPoseWorker } from '../electron/senses/pose/worker';

type Kill = typeof process.kill;

test('endProcess kills its own process with SIGKILL and never takes the normal exit path', () => {
  const calls: unknown[][] = [];
  const realKill = process.kill, realExit = process.exit;
  let exited = false;
  process.kill = ((...args: unknown[]) => { calls.push(args); return true; }) as unknown as Kill;
  process.exit = (() => { exited = true; }) as unknown as typeof process.exit;
  try { endProcess(); } finally { process.kill = realKill; process.exit = realExit; }
  assert.deepEqual(calls, [[process.pid, 'SIGKILL']]);
  assert.equal(exited, false);
});

test('a stop message ends the worker through its end function at once (nothing loaded, nothing in flight)', async () => {
  const sent: unknown[] = [];
  const heard: { listener?: (event: { data: unknown; ports: unknown[] }) => void } = {};
  const parent = { on: (_: 'message', listener: (event: { data: unknown; ports: unknown[] }) => void) => { heard.listener = listener; }, postMessage: (value: unknown) => { sent.push(value); } };
  const ends: string[] = [];
  startPoseWorker(parent as never, () => { throw new Error('no runtime in this test'); }, reason => { ends.push(reason); });
  assert.ok(heard.listener, 'the worker listens to its parent');
  heard.listener({ data: { type: 'stop' }, ports: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ends, ['stopped']);
});
