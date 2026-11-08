import test from 'node:test';
import assert from 'node:assert/strict';
import { ForegroundAsr } from '../electron/foreground-asr';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const systemResult = {
  text: 'synthetic-system', language: { status: 'mixed', languages: ['zh', 'en'], source: 'provider' },
  languageDetection: { version: 2, scope: 'subwindow-observations', windowAnalysis: 'complete' },
} as const;
const microphoneResult = {
  text: 'synthetic-microphone', language: { status: 'detected', language: 'ja', source: 'provider' },
  languageDetection: { version: 2, scope: 'whole-result', windowAnalysis: 'not-requested' },
} as const;

test('system and microphone background recognition share one actual lane and retain the complete metadata objects', async () => {
  const system = deferred<typeof systemResult>(), microphone = deferred<typeof microphoneResult>();
  const calls: string[] = []; let active = 0, peak = 0, foregroundCalls = 0, foregroundHooks = 0;
  const host = new ForegroundAsr({ pauseAndDrain: async () => { foregroundHooks++; },
    transcribe: async () => { foregroundCalls++; return 'synthetic-foreground'; }, entered: () => { foregroundHooks++; }, exited: () => { foregroundHooks++; } });
  const first = host.runBackground(new AbortController().signal, () => true, async () => {
    calls.push('system-audio'); peak = Math.max(peak, ++active);
    try { return await system.promise; } finally { active--; }
  });
  const second = host.runBackground(new AbortController().signal, () => true, async () => {
    calls.push('microphone'); peak = Math.max(peak, ++active);
    try { return await microphone.promise; } finally { active--; }
  });
  await tick(); assert.deepEqual(calls, ['system-audio']); assert.equal(host.busy, true); assert.equal(host.foregroundBusy, false);
  system.resolve(systemResult); assert.equal(await first, systemResult);
  await tick(); assert.deepEqual(calls, ['system-audio', 'microphone']); assert.equal(peak, 1);
  microphone.resolve(microphoneResult); assert.equal(await second, microphoneResult);
  assert.equal(foregroundCalls, 0); assert.equal(foregroundHooks, 0); assert.equal(active, 0); assert.equal(host.busy, false);
});

test('foreground input aborts an ignored background signal but waits for its real promise to settle before entering', async () => {
  const background = deferred<typeof systemResult>(), foreground = deferred<string>();
  const order: string[] = [], observed: { signal?: AbortSignal } = {}; let active = 0, peak = 0;
  const host = new ForegroundAsr({ pauseAndDrain: async () => {},
    transcribe: async () => {
      order.push('foreground'); peak = Math.max(peak, ++active);
      try { return await foreground.promise; } finally { active--; }
    }, entered: () => { order.push('foreground-enter'); }, exited: () => { order.push('foreground-exit'); } });
  const old = host.runBackground(new AbortController().signal, () => true, async signal => {
    observed.signal = signal; order.push('background'); peak = Math.max(peak, ++active);
    try { return await background.promise; } finally { active--; order.push('background-exit'); }
  });
  const oldRejected = assert.rejects(old); await tick();
  const next = host.run('controls', new ArrayBuffer(44), new AbortController().signal, () => true);
  assert.equal(observed.signal?.aborted, true); await tick();
  assert.deepEqual(order, ['background']); assert.equal(host.foregroundBusy, true); assert.equal(active, 1);
  background.resolve(systemResult); await oldRejected; await tick();
  assert.deepEqual(order, ['background', 'background-exit', 'foreground-enter', 'foreground']);
  assert.equal(peak, 1); assert.equal(active, 1);
  foreground.resolve('synthetic-foreground'); assert.equal(await next, 'synthetic-foreground');
  assert.equal(active, 0); assert.equal(host.busy, false); assert.equal(order.at(-1), 'foreground-exit');
});

test('background admission is bounded to two and foreground priority rejects new background without starting queued work', async () => {
  const held = deferred<typeof systemResult>(), foreground = deferred<string>();
  const observed: { signal?: AbortSignal } = {}; let secondCalls = 0, rejectedCalls = 0, foregroundCalls = 0;
  const host = new ForegroundAsr({ pauseAndDrain: async () => {},
    transcribe: () => { foregroundCalls++; return foreground.promise; }, entered: () => {}, exited: () => {} });
  const first = host.runBackground(new AbortController().signal, () => true, signal => { observed.signal = signal; return held.promise; });
  const firstRejected = assert.rejects(first);
  const second = host.runBackground(new AbortController().signal, () => true, async () => { secondCalls++; return microphoneResult; });
  const secondRejected = assert.rejects(second);
  await assert.rejects(host.runBackground(new AbortController().signal, () => true, async () => { rejectedCalls++; return systemResult; }), /正忙/);
  await tick();
  const next = host.run('pet', new ArrayBuffer(44), new AbortController().signal, () => true);
  assert.equal(observed.signal?.aborted, true);
  await assert.rejects(host.runBackground(new AbortController().signal, () => true, async () => { rejectedCalls++; return systemResult; }), /正忙/);
  assert.equal(foregroundCalls, 0); assert.equal(secondCalls, 0); assert.equal(rejectedCalls, 0);
  held.resolve(systemResult); await firstRejected; await secondRejected; await tick();
  assert.equal(foregroundCalls, 1); assert.equal(secondCalls, 0);
  foreground.resolve('synthetic-foreground'); await next;
  assert.equal(host.busy, false); assert.equal(host.foregroundBusy, false);
});

test('unapproved, queued-invalid and late-invalid background scopes never dispatch or publish a result', async () => {
  const host = new ForegroundAsr({ pauseAndDrain: async () => {}, transcribe: async () => 'synthetic-foreground', entered: () => {}, exited: () => {} });
  let deniedCalls = 0;
  await assert.rejects(host.runBackground(new AbortController().signal, () => false, async () => { deniedCalls++; return systemResult; }), /暂停/);
  assert.equal(deniedCalls, 0); assert.equal(host.busy, false);
  const held = deferred<typeof systemResult>(); let queuedCurrent = true, queuedCalls = 0;
  const first = host.runBackground(new AbortController().signal, () => true, () => held.promise);
  const queued = host.runBackground(new AbortController().signal, () => queuedCurrent, async () => { queuedCalls++; return microphoneResult; });
  const queuedRejected = assert.rejects(queued, /暂停/);
  await tick(); queuedCurrent = false; held.resolve(systemResult); assert.equal(await first, systemResult); await queuedRejected;
  assert.equal(queuedCalls, 0); assert.equal(host.busy, false);
  const late = deferred<typeof microphoneResult>(); let lateCurrent = true, entered = false, published = false;
  const guarded = host.runBackground(new AbortController().signal, () => lateCurrent, () => { entered = true; return late.promise; })
    .then(value => { published = true; return value; });
  const lateRejected = assert.rejects(guarded, /范围已变更/);
  await tick(); assert.equal(entered, true); lateCurrent = false; late.resolve(microphoneResult); await lateRejected;
  assert.equal(published, false); assert.equal(host.busy, false);
});
