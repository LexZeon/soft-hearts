import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmVisionPresentation, VisionPresentationGuard, type VisionPresentationSurface } from '../electron/vision-presentation-adapter';
import { formatVisionPresentation, isVisualAttentionCue, type VisionInitiative } from '../shared/vision-runtime';

const message = (): VisionInitiative => ({ id: 'visual-id', text: '看起来是一片蓝色。',
  origin: { kind: 'proactive', id: 'visual-id', at: 1000, sources: ['screen'], labels: ['屏幕'] } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

test('host and renderer presentation uses the same bounded source prefix and unchanged original', () => {
  const original = message();
  assert.equal(formatVisionPresentation(original), '主动 · 屏幕\n看起来是一片蓝色。');
  const dual = message(); dual.origin.sources.push('camera'); dual.origin.labels.push('摄像头');
  assert.equal(formatVisionPresentation(dual), '主动 · 屏幕、摄像头\n看起来是一片蓝色。');
  assert.equal(original.text, '看起来是一片蓝色。');
});
test('malformed, ambient, mismatched or excessive source identities cannot create visual receipts', () => {
  for (const patch of [
    { sources: ['ambient'], labels: ['播放声音'] }, { sources: ['screen', 'screen'], labels: ['屏幕', '屏幕'] },
    { sources: [], labels: [] }, { sources: ['screen'], labels: ['伪来源'] }, { id: 'another-id' },
  ]) { const value = message(); Object.assign(value.origin, patch); assert.throws(() => formatVisionPresentation(value)); }
  assert.throws(() => formatVisionPresentation({ ...message(), text: 'x'.repeat(401) }));
});
test('only unscoped valid speech cues qualify; audio, null and foreign source markers are rejected', () => {
  const cue = { id: 'cue-id', kind: 'speech', until: 2000 };
  assert.equal(isVisualAttentionCue(cue), true);
  for (const source of [{ kind: 'ambient', sessionId: 's', observationId: 'o' }, null, false, '', { kind: 'future' }])
    assert.equal(isVisualAttentionCue({ ...cue, source }), false);
  for (const value of [null, [], { ...cue, kind: 'motion' }, { ...cue, until: NaN }, { ...cue, id: '../bad' }]) assert.equal(isVisualAttentionCue(value), false);
});
test('confirmation is not accepted before the exact real-surface receipt resolves', async () => {
  const pending = deferred<boolean>(), calls: string[] = [], abort = new AbortController();
  const surface: VisionPresentationSurface = { waitForPresentation: async (text, signal) => {
    calls.push(text); assert.equal(signal, abort.signal); return pending.promise;
  }, isPresentationCurrent: () => true };
  let completed = false;
  const task = confirmVisionPresentation(message(), abort.signal, { surface: () => surface, identity: () => 'scope:revision', eligible: () => true }).then(value => { completed = true; return value; });
  await Promise.resolve(); assert.equal(completed, false);
  assert.deepEqual(calls, ['主动 · 屏幕\n看起来是一片蓝色。']);
  pending.resolve(true); assert.equal(await task, true);
});
test('abort, scope change, source closure and replacement window invalidate a late true receipt', async () => {
  for (const change of ['abort', 'identity', 'eligible', 'surface']) {
    const pending = deferred<boolean>(), abort = new AbortController(); let identity = 'old', eligible = true;
    let surface: VisionPresentationSurface | null = { waitForPresentation: () => pending.promise, isPresentationCurrent: () => true };
    const task = confirmVisionPresentation(message(), abort.signal, { surface: () => surface, identity: () => identity, eligible: () => eligible });
    if (change === 'abort') abort.abort();
    else if (change === 'identity') identity = 'new';
    else if (change === 'eligible') eligible = false;
    else surface = { waitForPresentation: async () => true, isPresentationCurrent: () => true };
    pending.resolve(true); assert.equal(await task, false, change);
  }
});
test('unavailable, invisible or failing presentation never grants confirmation', async () => {
  const abort = new AbortController(); let calls = 0;
  const surface = { waitForPresentation: async () => { calls++; return false; }, isPresentationCurrent: () => false };
  assert.equal(await confirmVisionPresentation(message(), abort.signal, { surface: () => null, identity: () => 'scope', eligible: () => true }), false);
  assert.equal(await confirmVisionPresentation(message(), abort.signal, { surface: () => surface, identity: () => 'scope', eligible: () => false }), false);
  assert.equal(calls, 0);
  assert.equal(await confirmVisionPresentation(message(), abort.signal, { surface: () => surface, identity: () => 'scope', eligible: () => true }), false);
  assert.equal(await confirmVisionPresentation(message(), abort.signal, { surface: () => ({ waitForPresentation: async () => { throw new Error('private failure'); }, isPresentationCurrent: () => false }), identity: () => 'scope', eligible: () => true }), false);
});

test('a historical true receipt is rejected if the surface no longer confirms its current revision', async () => {
  const pending = deferred<boolean>(); let visibleRevision = true;
  const surface = { waitForPresentation: () => pending.promise, isPresentationCurrent: () => visibleRevision };
  const task = confirmVisionPresentation(message(), new AbortController().signal,
    { surface: () => surface, identity: () => 'scope', eligible: () => true });
  pending.resolve(true); visibleRevision = false;
  assert.equal(await task, false);
});
test('guard rechecks the exact receipt synchronously for lease commit and every later cloud segment', async () => {
  let visibleRevision = true; const abort = new AbortController();
  const surface = { waitForPresentation: async () => true, isPresentationCurrent: () => visibleRevision };
  const guard = new VisionPresentationGuard({ surface: () => surface, identity: () => 'scope', eligible: () => true });
  assert.equal(await guard.present(message(), abort.signal), true);
  assert.equal(guard.current(message()), true); assert.equal(guard.canSpeak('visual-id'), true);
  assert.equal(guard.canSpeak('another-reply'), false);
  visibleRevision = false;
  assert.equal(guard.current(message()), false); assert.equal(guard.canSpeak('visual-id'), false);
  visibleRevision = true; guard.clear();
  assert.equal(guard.canSpeak('visual-id'), false);
});
test('clearing a guard during presentation prevents a delayed proof from acquiring speech authority', async () => {
  const pending = deferred<boolean>();
  const surface = { waitForPresentation: () => pending.promise, isPresentationCurrent: () => true };
  const guard = new VisionPresentationGuard({ surface: () => surface, identity: () => 'scope', eligible: () => true });
  const task = guard.present(message(), new AbortController().signal);
  guard.clear(); pending.resolve(true);
  assert.equal(await task, false); assert.equal(guard.canSpeak('visual-id'), false);
});
