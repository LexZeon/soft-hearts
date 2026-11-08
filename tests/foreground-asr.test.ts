import test from 'node:test';
import assert from 'node:assert/strict';
import { ForegroundAsr } from '../electron/foreground-asr';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('aborted legacy request holds the real recognizer until settlement before grouped successor can enter', async () => {
  const first = deferred<string>(), calls: number[] = [], events: string[] = [];
  const host = new ForegroundAsr({ pauseAndDrain: async () => {},
    transcribe: async wav => { calls.push(wav.byteLength); return calls.length === 1 ? first.promise : 'new'; },
    entered: owner => { events.push('enter-' + owner); }, exited: () => { events.push('exit'); } });
  const legacy = new AbortController(), capture = new AbortController();
  const old = host.run('controls', new ArrayBuffer(44), legacy.signal, () => true); const oldRejected = assert.rejects(old);
  await tick(); assert.deepEqual(calls, [44]); legacy.abort();
  const next = host.run('pet', new ArrayBuffer(46), capture.signal, () => true);
  await tick(); assert.deepEqual(calls, [44]); assert.equal(host.busy, true);
  first.resolve('late legacy'); await oldRejected; assert.equal(await next, 'new');
  assert.deepEqual(calls, [44, 46]); assert.deepEqual(events, ['enter-controls', 'exit', 'enter-pet', 'exit']);
  assert.equal(host.busy, false);
});
test('one successor is bounded, queued cancellation cannot enter the recognizer and does not free an ignored pause', async () => {
  const pause = deferred<void>(), events: string[] = [], oldController = new AbortController(), nextController = new AbortController();
  const host = new ForegroundAsr({ pauseAndDrain: () => pause.promise, transcribe: async () => { events.push('transcribe'); return 'bad'; },
    entered: owner => { events.push(owner); }, exited: () => { events.push('exit'); } });
  const old = host.run('controls', new ArrayBuffer(44), oldController.signal, () => true), oldRejected = assert.rejects(old);
  await tick();
  const next = host.run('pet', new ArrayBuffer(44), nextController.signal, () => true), nextRejected = assert.rejects(next);
  await assert.rejects(host.run('pet', new ArrayBuffer(44), new AbortController().signal, () => true), /队列/);
  oldController.abort(); nextController.abort(); await tick();
  assert.equal(host.busy, true); assert.deepEqual(events, ['controls']);
  pause.resolve(); await oldRejected; await nextRejected;
  assert.deepEqual(events, ['controls', 'exit']); assert.equal(host.busy, false);
});
test('scope change during the real ASR await rejects its late final before releasing the lane', async () => {
  const result = deferred<string>(); let current = true, exited = 0;
  const host = new ForegroundAsr({ pauseAndDrain: async () => {}, transcribe: () => result.promise,
    entered: () => {}, exited: () => { exited++; } });
  const operation = host.run('pet', new ArrayBuffer(44), new AbortController().signal, () => current);
  const rejected = assert.rejects(operation, /停止/); await tick(); current = false;
  assert.equal(host.busy, true); assert.equal(exited, 0);
  result.resolve('must not publish'); await rejected;
  assert.equal(host.busy, false); assert.equal(exited, 1);
});
