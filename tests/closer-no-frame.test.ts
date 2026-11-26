// 2026-11-22: one minute after the dev app started, with screen sharing on,
// her closer look journaled outcome failed / why no-frame / 728 ms to her next word — so the capture gave nothing almost at once. Only two
// branches do that: the screen sampler (electron/senses/screen-snapshots.ts) not ready, or a capture another reader had stopped (or the
// every-second context refresh had interrupted when her mood token rotated) still holding its one physical slot, so every sample meanwhile
// got nothing at once. Her closer look also dropped a picture on any media revision bump (voice input, the camera…), not only on the
// screen's own switch. What is tested here:
//  - the found causes reproduced with the real sampler and the real closer, and fixed: a stopped capture in the slot is waited out and a
//    fresh one taken (never two at once); another reader stopping does not stop the capture she waits for; an interrupted or failed first
//    capture is tried once more within the closer's wait; an unrelated revision bump keeps the clear frame;
//  - the privacy gates: switch off or "别看" (with LookTurns holding, the fallback knob) give no frame and no capture at all, also on the
//    retry; the switch going off or the vision context changing while the picture is taken drop it and are never retried;
//  - the journal says why (closed miss words, the number of tries) and the first-character line carries the send → host span.
// Real: ScreenSnapshots, LookAttachments, LookTurns, MediaRuntime, screenCaptures, LookContinuation, the journal builder. Fake: the native
// capture (a deferred), the chat (scripted), Electron's desktopCapturer. No screen, no camera, no Claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment } from '../shared/foundation/chat';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { CLOSER_MISSES, SEE_AND_SAY } from '../shared/senses/see-and-say';
import { ScreenSnapshots } from '../electron/senses/screen-snapshots';
import { screenCaptures } from '../electron/senses/screen-capture';
import { LookAttachments, type CloserCaptureDetail } from '../electron/senses/look-attachments';
import { LookTurns } from '../electron/senses/look-turns';
import { MediaRuntime, type CameraPolicy } from '../electron/senses/media-runtime';
import { LookContinuation, type CloserLookEntry, type ContinuableChat } from '../electron/brain/look-continuation';
import type { CompanionClaudeTask } from '../electron/brain/claude-session-types';
import { JournalExtras } from '../electron/memory/journal/extras';

const jpeg = (n: number) => 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224, n, 7, 7, 7]).toString('base64');
const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

/** The app's composition of her closer look on the screen: the sampler, the decision's turns, the media switches. */
function kit(over: { holds?: boolean; tries?: number; screen?: boolean; onRefresh?: () => void } = {}) {
  const policy: CameraPolicy = { mode: () => 'share', blocked: () => 'needs-component' };
  const media = new MediaRuntime(undefined, policy);
  media.update({ screenSharing: over.screen !== false }, 'controls');
  let generation = 0, inFlight = 0, most = 0;
  const calls: number[] = [];
  /** Each native capture: the next scripted result (a deferred to settle by hand, a frame, or a throw). */
  const script: (() => Promise<Attachment>)[] = [];
  const snapshots = new ScreenSnapshots({ capture: async (_source, _signal) => {
    calls.push(calls.length + 1); inFlight++; most = Math.max(most, inFlight);
    try { return await (script.shift() ?? (async () => ({ source: 'screen' as const, dataUrl: jpeg(calls.length) })))(); } finally { inFlight--; }
  } });
  const configure = (scope = 'speech-1') => snapshots.configure({ sharing: media.state.screenSharing, visible: true, sourceId: '7', scope });
  configure();
  const turns = new LookTurns(() => 0, undefined, { holds: over.holds ?? false });
  const state = () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: `c|${media.revision}`,
    screenOpening: media.openings.screen, cameraHeld: media.state.cameraHeld === true });
  let refreshes = 0, asks = 0;
  const look = new LookAttachments(turns, {
    noteActivity() {}, state, sharesCameraFrames: () => media.sharesCameraFrames(), revision: () => media.revision, generation: () => generation,
    opening: source => media.openings[source], captureScreen: (signal, miss) => { asks++; return snapshots.sampleOnce(signal, miss); }, captureCamera: async () => null,
    refreshContext: () => { refreshes++; over.onRefresh?.(); configure(); }, closerTries: () => over.tries ?? 2, textFirst: () => true,
  });
  const reports: CloserCaptureDetail[] = [];
  const closer = (signal = new AbortController().signal) => look.closer('screen', signal, detail => reports.push(detail));
  return { media, snapshots, configure, look, closer, reports, calls, script, turns, bump: () => { generation++; }, most: () => most, refreshes: () => refreshes, asks: () => asks };
}

// ---------------------------------------------------------------- the found causes, reproduced and fixed

test('the found cause: a capture another reader stopped still holds the slot — her closer look waits it out and gets a fresh clear frame', async () => {
  const k = kit();
  const slow = deferred<Attachment>();
  k.script.push(() => slow.promise);
  // 一起看 (or any other reader) starts a screen read and stops waiting for it; the native read goes on (it ignores abort).
  const reader = new AbortController();
  const watch = k.snapshots.sampleOnce(reader.signal);
  await flush();
  reader.abort();
  assert.equal(await watch, null);
  // Her closer look right then. Before: null at once (the stopped capture still held the slot) — the 728 ms "no-frame" of 16:43.
  const look = k.closer();
  await flush();
  assert.equal(k.calls.length, 1, 'never two native reads at once: it waits for the stopped one');
  slow.resolve({ source: 'screen', dataUrl: jpeg(99) });
  const frame = await look;
  assert.ok(frame, 'a clear frame came');
  assert.deepEqual(frame!.dataUrls(), [jpeg(2)], 'a fresh one, not the stopped read\'s picture');
  assert.equal(k.calls.length, 2);
  assert.equal(k.most(), 1, 'one native read at a time');
  assert.deepEqual(k.reports, [{ tries: 1 }]);
  // Sharing turned off while she waits for the slot: nothing is read after it leaves.
  const off = kit();
  const slow3 = deferred<Attachment>();
  off.script.push(() => slow3.promise);
  const r3 = new AbortController();
  const w3 = off.snapshots.sampleOnce(r3.signal);
  await flush(); r3.abort(); await w3;
  const look3 = off.closer();
  await flush();
  off.media.update({ screenSharing: false }, 'controls'); off.configure();
  slow3.resolve({ source: 'screen', dataUrl: jpeg(5) });
  assert.equal(await look3, null);
  assert.equal(off.calls.length, 1, 'no read after the switch went off');
});

test('the found cause: another reader that stops waiting no longer stops the capture her closer look waits for', async () => {
  const k = kit();
  const slow = deferred<Attachment>();
  k.script.push(() => slow.promise);
  const reader = new AbortController();
  const watch = k.snapshots.sampleOnce(reader.signal);
  await flush();
  const look = k.closer(); // shares the same native read
  await flush();
  reader.abort(); // before: this aborted the shared read, and she got nothing
  assert.equal(await watch, null);
  slow.resolve({ source: 'screen', dataUrl: jpeg(42) });
  const frame = await look;
  assert.deepEqual(frame?.dataUrls(), [jpeg(42)]);
  assert.equal(k.calls.length, 1, 'one read served both');
  // Alone, a reader that stops still stops its native read (as before: nothing waits for it).
  const k2 = kit();
  const slow2 = deferred<Attachment>();
  let nativeSignal!: AbortSignal;
  const k2snap = new ScreenSnapshots({ capture: async (_s, signal) => { nativeSignal = signal; return slow2.promise; } });
  k2snap.configure({ sharing: true, visible: true, sourceId: '7', scope: 's' });
  const lone = new AbortController();
  const alone = k2snap.sampleOnce(lone.signal);
  await flush(); lone.abort();
  assert.equal(await alone, null);
  assert.equal(nativeSignal.aborted, true);
  slow2.resolve({ source: 'screen', dataUrl: jpeg(1) }); void k2;
});

test('the found cause: the context refresh interrupts the read part way (her mood token rotated) — one more try within the wait gets it', async () => {
  const k = kit();
  const slow = deferred<Attachment>();
  k.script.push(() => slow.promise);
  const look = k.closer();
  await flush();
  k.configure('speech-1:new-token'); // the every-second refresh with a new scope: the sampler invalidates the read under way
  await flush();
  slow.resolve({ source: 'screen', dataUrl: jpeg(50) }); // the native read leaves the slot; its picture belongs to the old context
  const frame = await look;
  assert.deepEqual(frame?.dataUrls(), [jpeg(2)], 'the retry took a fresh frame of the current context');
  assert.deepEqual(k.reports, [{ tries: 2 }]);
  assert.equal(k.most(), 1);
  // With one try (closerTries 1, the old behaviour) it would have been nothing, and the journal would say why.
  const once = kit({ tries: 1 });
  const slow1 = deferred<Attachment>();
  once.script.push(() => slow1.promise);
  const missed = once.closer();
  await flush(); once.configure('other'); slow1.resolve({ source: 'screen', dataUrl: jpeg(1) });
  assert.equal(await missed, null);
  assert.deepEqual(once.reports, [{ tries: 1, miss: 'interrupted' }]);
});

test('an unrelated revision bump (voice input, the camera switch) while the clear frame is taken keeps it; the screen\'s own switch drops it', async () => {
  const k = kit();
  const slow = deferred<Attachment>();
  k.script.push(() => slow.promise);
  const look = k.closer();
  await flush();
  const before = k.media.revision;
  k.media.update({ voiceInput: true }, 'controls'); // another switch: the media revision moves, screen sharing does not
  k.media.update({ cameraImages: true }, 'controls');
  assert.ok(k.media.revision > before);
  slow.resolve({ source: 'screen', dataUrl: jpeg(7) });
  const frame = await look;
  assert.deepEqual(frame?.dataUrls(), [jpeg(7)], 'kept (before: dropped as "no-frame")');
  // Screen sharing turned off and on again while it is taken: a new opening, dropped, never retried.
  const k2 = kit();
  const slow2 = deferred<Attachment>();
  k2.script.push(() => slow2.promise);
  const look2 = k2.closer();
  await flush();
  k2.media.update({ screenSharing: false }, 'controls'); k2.media.update({ screenSharing: true }, 'controls'); k2.configure();
  slow2.resolve({ source: 'screen', dataUrl: jpeg(8) });
  assert.equal(await look2, null);
  assert.equal(k2.reports.at(-1)?.miss, 'changed');
  assert.equal(k2.calls.length, 1, 'not retried');
});

test('the real screen read: another switch moving the media revision keeps the picture; sharing off, or off and on, drops it', async () => {
  const policy: CameraPolicy = { mode: () => 'share', blocked: () => 'needs-component' };
  const media = new MediaRuntime(undefined, policy);
  media.update({ screenSharing: true }, 'controls');
  const thumbnail = { isEmpty: () => false, getSize: () => ({ width: 1600, height: 1000 }), resize: () => thumbnail, toJPEG: () => Buffer.from('jpeg') };
  let during: () => void = () => {};
  const captures = screenCaptures({ media, companion: () => null, onScreen: () => true, displayOf: () => ({ id: 7 }), intervalSeconds: () => 5,
    visualSelf: () => ({ runtime: {} as never, sourceId: null }), capturer: { getSources: async () => { during(); return [{ display_id: '7', thumbnail }] as never; } } });
  during = () => { media.update({ voiceInput: true }, 'controls'); };
  assert.match((await captures.shared('7', new AbortController().signal)).dataUrl, /^data:image\/jpeg;base64,/, 'voice input turned on meanwhile: kept');
  during = () => { media.update({ screenSharing: false }, 'controls'); media.update({ screenSharing: true }, 'controls'); };
  await assert.rejects(captures.shared('7', new AbortController().signal), /Sharing changed/, 'off and on again: a new opening, dropped');
  during = () => { media.update({ screenSharing: false }, 'controls'); };
  await assert.rejects(captures.shared('7', new AbortController().signal), /Sharing changed/, 'off: dropped');
});

// ---------------------------------------------------------------- the privacy gates

test('switch off or "别看" (when LookTurns holds): no clear frame and no capture at all; the switch going off meanwhile drops it, never retried', async () => {
  const off = kit({ screen: false });
  assert.equal(await off.closer(), null);
  assert.equal(off.calls.length, 0, 'not even captured');
  assert.deepEqual(off.reports, [{ tries: 0, miss: 'off' }]);
  const held = kit({ holds: true });
  await held.look.request({ text: '别看我屏幕' });
  assert.equal(await held.closer(), null, 'the screen\'s "别看" holds her closer look (the holdOnNo fallback)');
  assert.equal(held.calls.length, 0);
  assert.equal(held.reports.at(-1)?.miss, 'off');
  const during = kit();
  const slow = deferred<Attachment>();
  during.script.push(() => slow.promise);
  const look = during.closer();
  await flush();
  during.media.update({ screenSharing: false }, 'controls');
  slow.resolve({ source: 'screen', dataUrl: jpeg(3) });
  assert.equal(await look, null);
  assert.equal(during.reports.at(-1)?.miss, 'held');
  assert.equal(during.calls.length, 1, 'not retried');
});

test('the retry asks the switch and "别看" again first: off between the tries means no second capture', async () => {
  const k = kit();
  k.script.push(async () => { k.media.update({ screenSharing: false }, 'controls'); throw new Error('Selected screen unavailable'); });
  assert.equal(await k.closer(), null);
  assert.equal(k.calls.length, 1, 'the second capture never ran');
  assert.equal(k.reports.at(-1)?.miss, 'held');
  // "别看" between the tries (LookTurns holding): the same.
  const h = kit({ holds: true });
  h.script.push(async () => { void h.look.request({ text: '别看我屏幕' }); throw new Error('Selected screen unavailable'); });
  assert.equal(await h.closer(), null);
  assert.equal(h.calls.length, 1);
  // Off right before the retry (here while the context is read again after "not ready"): the closer never asks for the second capture.
  let k2!: ReturnType<typeof kit>;
  k2 = kit({ onRefresh: () => { k2.media.update({ screenSharing: false }, 'controls'); } });
  k2.snapshots.configure({ sharing: true, visible: true, sourceId: null, scope: 's' }); // not ready yet
  assert.equal(await k2.closer(), null);
  assert.equal(k2.asks(), 1, 'one ask; the retry was never asked for');
  assert.equal(k2.reports.at(-1)?.miss, 'held');
  let h2!: ReturnType<typeof kit>;
  h2 = kit({ holds: true, onRefresh: () => { void h2.look.request({ text: '别看我屏幕' }); } });
  h2.snapshots.configure({ sharing: true, visible: true, sourceId: null, scope: 's' });
  assert.equal(await h2.closer(), null);
  assert.equal(h2.asks(), 1, '"别看" right before the retry: no second ask');
});

test('the vision context cleared while it is taken: dropped and never retried; a frame taken and then turned off is empty when read', async () => {
  const k = kit();
  const slow = deferred<Attachment>();
  k.script.push(() => slow.promise);
  const look = k.closer();
  await flush();
  k.bump();
  slow.resolve({ source: 'screen', dataUrl: jpeg(4) });
  assert.equal(await look, null);
  assert.deepEqual(k.reports, [{ tries: 1, miss: 'changed' }]);
  const later = kit();
  const frame = await later.closer();
  later.media.update({ screenSharing: false }, 'controls');
  assert.deepEqual(frame?.dataUrls(), [], 'sharing off after it was taken: nothing goes');
});

test('retry on a first failure: the screen gives nothing once, the second try within the wait gets it; one try only gives up', async () => {
  const k = kit();
  k.script.push(async () => { throw new Error('Selected screen unavailable'); });
  const frame = await k.closer();
  assert.deepEqual(frame?.dataUrls(), [jpeg(2)]);
  assert.deepEqual(k.reports, [{ tries: 2 }]);
  const both = kit();
  both.script.push(async () => { throw new Error('x'); }, async () => { throw new Error('y'); });
  assert.equal(await both.closer(), null);
  assert.deepEqual(both.reports, [{ tries: 2, miss: 'capture-failed' }], 'at most closerTries');
  assert.equal(both.calls.length, 2);
  // Not ready (the companion just moved, no screen chosen yet): the context is read again, then one more try.
  const unready = kit();
  unready.snapshots.configure({ sharing: true, visible: true, sourceId: null, scope: 's' });
  assert.deepEqual((await unready.closer())?.dataUrls(), [jpeg(1)]);
  assert.equal(unready.refreshes(), 1);
  assert.deepEqual(unready.reports, [{ tries: 2 }]);
  assert.equal(SEE_AND_SAY.closerTries, 2, 'the shipped knob');
});

// ---------------------------------------------------------------- the journal says why

function chatKit(capture: ConstructorParameters<typeof LookContinuation>[0]['capture'], timeoutMs = 1000) {
  const entries: CloserLookEntry[] = [];
  const chat: ContinuableChat = {
    async stream(_task, _signal, emit) { emit('delta', '<sh-open>我看看⟦look-screen⟧'); return { superseded: false, output: '' }; },
    async continueReply(task, _signal, emit) { void task.imageDataUrls; void task.prompt; emit('delta', '嗯。'); return { superseded: false, output: '嗯。' }; },
  };
  const look = new LookContinuation({ senses: () => ({ camera: false, screen: true }), capture, note: () => 'note', journal: entry => entries.push(entry),
    knobs: { closerLook: true, closerTimeoutMs: timeoutMs, dots: '……' }, opening: '<sh-open>' });
  const task = { kind: 'chat', model: 'm', workingDirectory: '.', writable: false, prompt: 'p', replyId: 'r1' } as CompanionClaudeTask;
  return { entries, run: () => look.stream(chat, task, new AbortController().signal, () => {}) };
}

test('the closer line carries a closed miss word and the tries; the journal keeps only those words and shows them', async () => {
  const failed = chatKit(async (_sense, _signal, report) => { report?.({ tries: 2, miss: 'capture-failed' }); return null; });
  await failed.run();
  assert.deepEqual(failed.entries.map(({ ms: _ms, ...rest }) => rest), [{ sense: 'screen', outcome: 'failed', why: 'no-frame', miss: 'capture-failed', tries: 2 }]);
  const retried = chatKit(async (_sense, _signal, report) => { report?.({ tries: 2 }); return { dataUrls: () => [jpeg(1)] }; });
  await retried.run();
  assert.equal(retried.entries[0].outcome, 'taken');
  assert.equal(retried.entries[0].tries, 2);
  assert.equal(retried.entries[0].miss, undefined);
  const slow = chatKit((_sense, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), 20);
  await slow.run();
  assert.equal(slow.entries[0].miss, 'timeout');
  const dropped = chatKit(async (_sense, _signal, report) => { report?.({ tries: 1 }); return { dataUrls: () => [] }; });
  await dropped.run();
  assert.equal(dropped.entries[0].miss, 'dropped', 'taken, but gone when it was to be sent');
  // The journal: closed words only, a bounded count.
  const line = buildJournalEntry({ type: 'see-and-say', characterId: 'c', event: 'closer', sense: 'screen', outcome: 'failed', why: 'no-frame', ms: 728, miss: 'interrupted', tries: 2 }, 0);
  assert.ok(line && line.type === 'see-and-say' && line.event === 'closer');
  assert.equal((line as { miss?: string }).miss, 'interrupted');
  assert.equal((line as { tries?: number }).tries, 2);
  assert.match(describeJournalEntry(line!, plain), /拍到一半被打断了.*试了 2 次/u);
  assert.equal(buildJournalEntry({ type: 'see-and-say', characterId: 'c', event: 'closer', sense: 'screen', outcome: 'failed', miss: 'the screen said hi' }, 0), null);
  assert.equal(buildJournalEntry({ type: 'see-and-say', characterId: 'c', event: 'closer', sense: 'screen', outcome: 'failed', tries: 4 }, 0), null);
  for (const miss of CLOSER_MISSES) assert.ok(buildJournalEntry({ type: 'see-and-say', characterId: 'c', event: 'closer', sense: 'camera', outcome: 'failed', miss }, 0), miss);
});

test('the first-character line carries the send → host span (a renderer-timed reply only), and the journal keeps it as a number', () => {
  const extras = new JournalExtras({ sink: { record: () => null } as never, characterId: () => 'c', engine: () => 'local', uptimeMs: () => 0, blushStage: () => {} });
  const timed = extras.firstChar({ firstContentMs: 12130, firstBubbleMs: 12626, origin: 'renderer-send', sendToHostMs: 4700, claude: { process: 'prewarmed', sessionTurn: 1, firstDeltaMs: 12031 } });
  assert.equal(timed.sendMs, 4700);
  assert.equal(extras.firstChar({ firstContentMs: 1, firstBubbleMs: 2, origin: 'host-receipt', sendToHostMs: null }).sendMs, undefined);
  const line = buildJournalEntry({ type: 'first-char', characterId: 'c', ms: 12658, pauseTalk: false, carried: false, ...timed }, 0);
  assert.equal((line as { sendMs?: number }).sendMs, 4700);
  assert.match(describeJournalEntry(line!, plain), /发出后 4\.70 秒主进程才收到/u);
});
