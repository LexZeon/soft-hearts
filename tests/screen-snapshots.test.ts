import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment } from '../shared/contracts';
import { ScreenSnapshots, type ScreenSnapshotContext } from '../electron/screen-snapshots';
import { DEFAULT_SCREEN_SNAPSHOT_OPTIONS, validateScreenSnapshotOptions } from '../shared/screen-snapshots';

const frame = (text = 'YQ=='): Attachment => ({ source: 'screen', dataUrl: `data:image/jpeg;base64,${text}` });
const shared: ScreenSnapshotContext = { sharing: true, visible: true, sourceId: 'screen:2:0', scope: 'character-provider-model' };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function harness(capture: (source: string, signal: AbortSignal) => Promise<Attachment> = async () => frame()) {
  let now = 1000, sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const snapshots = new ScreenSnapshots({ capture, clock: () => now,
    setTimeout: (callback, delay) => {
      const id = ++sequence; timers.set(id, { at: now + delay, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: id => { timers.delete(id as unknown as number); },
  });
  return { snapshots, timers, setNow: (value: number) => { now = value; },
    advance: async (ms: number) => {
      const target = now + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].callback(); await flush();
      }
      now = target; await flush();
    },
  };
}

test('screen auto capture starts off and never captures without explicit sharing, visibility and source', async () => {
  let count = 0;
  const h = harness(async () => { count++; return frame(); });
  assert.deepEqual(h.snapshots.state, { enabled: false, intervalSeconds: 10, active: false, pending: false, capturedAt: null });
  h.snapshots.setOptions({ enabled: true });
  await h.advance(60_000);
  assert.equal(await h.snapshots.sampleOnce(), null);
  for (const invalidContext of [{ ...shared, sharing: false }, { ...shared, visible: false }, { ...shared, sourceId: null }, { ...shared, scope: '' }]) {
    h.snapshots.configure(invalidContext); await h.advance(60_000);
    assert.equal(await h.snapshots.sampleOnce(), null);
  }
  assert.equal(count, 0); assert.equal(h.timers.size, 0);
  h.snapshots.dispose();
});

test('auto options strictly reject invalid intervals, types and extra capability fields', () => {
  for (const value of [null, [], {}, { enabled: 1 }, { intervalSeconds: '10' }, { intervalSeconds: 1 },
    { intervalSeconds: 301 }, { intervalSeconds: 2.5 }, { intervalSeconds: NaN }, { intervalSeconds: Infinity },
    { enabled: true, path: '/arbitrary' }, { sourceId: 'untrusted' }])
    assert.throws(() => validateScreenSnapshotOptions(value, { ...DEFAULT_SCREEN_SNAPSHOT_OPTIONS }));
  assert.deepEqual(validateScreenSnapshotOptions({ intervalSeconds: 2 }, { ...DEFAULT_SCREEN_SNAPSHOT_OPTIONS }), { enabled: false, intervalSeconds: 2 });
  assert.equal(validateScreenSnapshotOptions({ intervalSeconds: 300 }, { ...DEFAULT_SCREEN_SNAPSHOT_OPTIONS }).intervalSeconds, 300);
  const h = harness(); assert.throws(() => h.snapshots.setOptions({ enabled: true, intervalSeconds: 0 }));
  assert.equal(h.snapshots.state.enabled, false); h.snapshots.dispose();
});

test('accepted one-shot samples use the exact selected source with auto off and retain no frame or timer', async () => {
  const sources: string[] = [];
  const h = harness(async source => { sources.push(source); return frame(); });
  h.snapshots.configure(shared);
  assert.deepEqual(await h.snapshots.sampleOnce(), frame());
  assert.deepEqual(sources, [shared.sourceId]);
  assert.equal(h.snapshots.currentAttachment(), null);
  assert.equal(h.snapshots.state.capturedAt, null);
  assert.equal(h.timers.size, 0); h.snapshots.dispose();
});

test('automatic captures serialize slow work and schedule the next interval only after completion', async () => {
  const result = deferred<Attachment>(); let count = 0;
  const h = harness(async () => { count++; return count === 1 ? result.promise : frame('Yg=='); });
  h.snapshots.configure(shared); h.snapshots.setOptions({ enabled: true, intervalSeconds: 2 });
  await h.advance(0); assert.equal(count, 1); assert.equal(h.snapshots.state.pending, true);
  await h.advance(30_000); assert.equal(count, 1); assert.equal(h.timers.size, 0);
  result.resolve(frame()); await flush();
  assert.equal(h.snapshots.state.pending, false); assert.equal(h.timers.size, 1);
  await h.advance(1999); assert.equal(count, 1);
  await h.advance(1); assert.equal(count, 2);
  assert.deepEqual(h.snapshots.currentAttachment(), frame('Yg==')); h.snapshots.dispose();
});

test('disabling auto aborts and clears immediately; ignored late native results never repopulate', async () => {
  const late = deferred<Attachment>(); let signal!: AbortSignal;
  const h = harness(async (_, current) => { signal = current; return late.promise; });
  h.snapshots.configure(shared); h.snapshots.setOptions({ enabled: true }); await h.advance(0);
  h.snapshots.setOptions({ enabled: false });
  assert.equal(signal.aborted, true); assert.equal(h.snapshots.currentAttachment(), null);
  late.resolve(frame()); await flush();
  assert.equal(h.snapshots.state.capturedAt, null); assert.equal(h.timers.size, 0);
  h.snapshots.dispose();
});

test('changing source cancels old generation without overlap and never falls back to the old screen', async () => {
  const late = deferred<Attachment>(); const sources: string[] = []; const signals: AbortSignal[] = [];
  const h = harness(async (source, signal) => { sources.push(source); signals.push(signal); return sources.length === 1 ? late.promise : frame('Yg=='); });
  h.snapshots.configure(shared); h.snapshots.setOptions({ enabled: true, intervalSeconds: 2 }); await h.advance(0);
  h.snapshots.configure({ ...shared, sourceId: 'screen:7:0' });
  assert.equal(signals[0].aborted, true);
  assert.equal(await h.snapshots.sampleOnce(), null);
  await h.advance(20_000); assert.equal(sources.length, 1);
  late.resolve(frame()); await flush(); assert.equal(h.snapshots.currentAttachment(), null);
  await h.advance(2_000);
  assert.deepEqual(sources, ['screen:2:0', 'screen:7:0']);
  assert.deepEqual(h.snapshots.currentAttachment(), frame('Yg==')); h.snapshots.dispose();
});

test('share off, hidden, scope change and teardown clear cached frames and all scheduled work', async () => {
  for (const context of [{ ...shared, sharing: false }, { ...shared, visible: false }, { ...shared, scope: 'next-character' }]) {
    const h = harness(); h.snapshots.configure(shared); h.snapshots.setOptions({ enabled: true }); await h.advance(0);
    assert.ok(h.snapshots.currentAttachment());
    h.snapshots.configure(context);
    assert.equal(h.snapshots.currentAttachment(), null);
    if (!context.sharing || !context.visible) assert.equal(h.timers.size, 0);
    h.snapshots.dispose(); assert.equal(h.timers.size, 0); assert.equal(h.snapshots.state.active, false);
    assert.throws(() => h.snapshots.setOptions({ enabled: true }));
  }
});

test('late one-shot work is discarded for every revoked context and dispose', async () => {
  for (const action of ['sharing', 'visible', 'source', 'scope', 'dispose'] as const) {
    const late = deferred<Attachment>(); let signal!: AbortSignal;
    const h = harness(async (_, current) => { signal = current; return late.promise; });
    h.snapshots.configure(shared); const sample = h.snapshots.sampleOnce(); await flush();
    if (action === 'dispose') h.snapshots.dispose();
    else h.snapshots.configure({ ...shared, ...(action === 'sharing' ? { sharing: false } : action === 'visible'
      ? { visible: false } : action === 'source' ? { sourceId: 'screen:3:0' } : { scope: 'new-context' }) });
    assert.equal(signal.aborted, true); late.resolve(frame()); assert.equal(await sample, null);
    assert.equal(h.snapshots.currentAttachment(), null); h.snapshots.dispose();
  }
});

test('cache freshness is bounded by twice interval and sixty seconds, including backward clocks', async () => {
  for (const [seconds, age] of [[2, 4000], [300, 60_000]]) {
    const h = harness(); h.snapshots.configure(shared); h.snapshots.setOptions({ enabled: true, intervalSeconds: seconds }); await h.advance(0);
    h.setNow(1000 + age - 1); assert.ok(h.snapshots.currentAttachment());
    h.setNow(1000 + age); assert.equal(h.snapshots.currentAttachment(), null); assert.equal(h.snapshots.state.capturedAt, null);
    h.snapshots.dispose();
  }
  const h = harness(); h.snapshots.configure(shared); h.snapshots.setOptions({ enabled: true }); await h.advance(0);
  h.setNow(999); assert.equal(h.snapshots.currentAttachment(), null); h.snapshots.dispose();
});

test('one-shot cancellation returns promptly and aborts its manual native request without retaining late pixels', async () => {
  const late = deferred<Attachment>(); let nativeSignal!: AbortSignal;
  const h = harness(async (_, signal) => { nativeSignal = signal; return late.promise; });
  h.snapshots.configure(shared); const controller = new AbortController();
  const pending = h.snapshots.sampleOnce(controller.signal); await flush(); controller.abort();
  assert.equal(await pending, null); assert.equal(nativeSignal.aborted, true);
  late.resolve(frame()); await flush(); assert.equal(h.snapshots.currentAttachment(), null); h.snapshots.dispose();
});

test('concurrent attention and automatic sampling share one capture while caller abort never steals auto cache', async () => {
  const late = deferred<Attachment>(); let count = 0, nativeSignal!: AbortSignal;
  const h = harness(async (_, signal) => { count++; nativeSignal = signal; return late.promise; });
  h.snapshots.configure(shared); h.snapshots.setOptions({ enabled: true }); await h.advance(0);
  const controller = new AbortController(); const one = h.snapshots.sampleOnce(controller.signal), two = h.snapshots.sampleOnce();
  controller.abort(); assert.equal(await one, null); assert.equal(nativeSignal.aborted, false);
  late.resolve(frame()); assert.deepEqual(await two, frame()); assert.equal(count, 1);
  assert.deepEqual(h.snapshots.currentAttachment(), frame()); h.snapshots.dispose();
});

test('malformed, oversized, wrong-source and failed captures yield no cache and no immediate retry', async () => {
  for (const capture of [async () => ({ source: 'camera' as const, dataUrl: frame().dataUrl }),
    async () => frame('!bad'), async () => ({ source: 'screen' as const, dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(4_000_000) }),
    async () => { throw new Error('unavailable'); }]) {
    const h = harness(capture); h.snapshots.configure(shared); h.snapshots.setOptions({ enabled: true }); await h.advance(0);
    assert.equal(h.snapshots.currentAttachment(), null); assert.equal(h.snapshots.state.pending, false);
    assert.equal(h.timers.size, 1); h.snapshots.dispose();
  }
});
