import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment } from '../shared/contracts';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { ProactiveVision, type ProactiveVisionDependencies, type ProactiveVisionMessage } from '../electron/proactive-vision';

const frame = (source: Attachment['source'] = 'screen'): Attachment => ({ source, dataUrl: 'data:image/jpeg;base64,YQ==' });
const cue = (id = 'accepted-speech', until = 4000) => ({ id, kind: 'speech', until });
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(overrides: Partial<ProactiveVisionDependencies> = {}) {
  let now = 1000, current = true;
  const gate = new ProactiveSpeechGate(() => now); gate.setScope('scope');
  const offered: ProactiveVisionMessage[] = [], archived: ProactiveVisionMessage[] = [], revoked: string[] = [], errors: string[] = [];
  let captures = 0, generations = 0;
  const engine = new ProactiveVision({ gate, clock: () => now,
    capture: async () => { captures++; return [frame()]; },
    generate: async () => { generations++; return '好像在看一篇文章，要聊聊吗？'; },
    offer: message => { offered.push(message); }, current: () => current,
    present: async () => true,
    presentationCurrent: () => true,
    archive: async message => { archived.push(message); },
    cancelOffer: id => { revoked.push(id); }, onError: stage => { errors.push(stage); }, ...overrides,
  });
  return { engine, gate, offered, archived, revoked, errors, counts: () => ({ captures, generations }),
    setNow: (value: number) => { now = value; }, setCurrent: (value: boolean) => { current = value; },
    dispose: () => { engine.dispose(); gate.dispose(); },
  };
}

test('only an eligible, unexpired host speech cue in the current scope can start visual work', async () => {
  const h = harness();
  for (const entry of [{ ...cue(), kind: 'look' }, { ...cue(), kind: 'motion' }, cue('expired', 1000), cue('invalid', NaN), cue('bad id')])
    await h.engine.start('scope', entry, true);
  await h.engine.start('scope', cue(), false);
  await h.engine.start('another-scope', cue(), true);
  h.setCurrent(false); await h.engine.start('scope', cue(), true);
  assert.deepEqual(h.counts(), { captures: 0, generations: 0 });
  assert.equal(h.engine.pendingId, null); assert.equal(h.gate.busy, false); h.dispose();
});

test('one accepted opportunity captures, generates and offers once; ack alone commits one text-only archive', async () => {
  const h = harness();
  const start = h.engine.start('scope', cue(), true);
  assert.equal(h.engine.pendingId, 'accepted-speech');
  await h.engine.start('scope', cue(), true); await start;
  assert.deepEqual(h.counts(), { captures: 1, generations: 1 });
  assert.equal(h.offered.length, 1); assert.equal(h.archived.length, 0);
  assert.equal(h.engine.awaitingOffer, 'accepted-speech');
  assert.deepEqual(h.offered[0].origin, { kind: 'proactive', id: 'accepted-speech', at: 1000, sources: ['screen'], labels: ['屏幕'] });
  assert.equal(await h.engine.ack('someone-else'), false);
  assert.equal(await h.engine.ack('accepted-speech'), true); assert.equal(await h.engine.ack('accepted-speech'), false);
  await flush(); assert.equal(h.archived.length, 1);
  assert.deepEqual(Object.keys(h.archived[0]).sort(), ['id', 'origin', 'text']);
  assert.equal(JSON.stringify(h.archived).includes('data:image'), false);
  await h.engine.start('scope', cue(), true);
  assert.deepEqual(h.counts(), { captures: 1, generations: 1 }); assert.equal(h.gate.busy, false); h.dispose();
});

test('both explicitly enabled observation sources have static honest origin labels and no synthetic user line', async () => {
  const h = harness({ capture: async () => [frame('screen'), frame('camera')] });
  await h.engine.start('scope', cue(), true);
  assert.deepEqual(h.offered[0].origin.sources, ['screen', 'camera']);
  assert.deepEqual(h.offered[0].origin.labels, ['屏幕', '摄像头']);
  assert.equal(await h.engine.ack('accepted-speech'), true); await flush();
  assert.equal('role' in h.archived[0], false); assert.equal('messages' in h.archived[0], false); h.dispose();
});

test('source loss during capture cancels without generation, delivery or a late replay', async () => {
  const late = deferred<Attachment[]>(); let signal!: AbortSignal;
  const h = harness({ capture: async current => { signal = current; return late.promise; } });
  const task = h.engine.start('scope', cue(), true); await flush();
  h.setCurrent(false); h.engine.cancel(); await task;
  assert.equal(signal.aborted, true); assert.equal(h.engine.pendingId, null);
  late.resolve([frame()]); await flush();
  assert.equal(h.counts().generations, 0); assert.equal(h.offered.length, 0); assert.equal(h.archived.length, 0);
  assert.deepEqual(h.errors, []); h.dispose();
});

test('user input during generation stops ignored-abort model work from offering or archiving', async () => {
  const late = deferred<string>(); let signal!: AbortSignal;
  const h = harness({ generate: async (_, current) => { signal = current; return late.promise; } });
  const task = h.engine.start('scope', cue(), true); await flush(); h.engine.cancel(); await task;
  assert.equal(signal.aborted, true); late.resolve('This late text must not appear'); await flush();
  assert.equal(h.offered.length, 0); assert.equal(h.archived.length, 0); assert.equal(h.engine.pendingId, null); h.dispose();
});

test('current checks after asynchronous capture and generation fail closed even without explicit cancel', async () => {
  for (const stage of ['capture', 'generation'] as const) {
    const pixels = deferred<Attachment[]>(), text = deferred<string>();
    const h = harness(stage === 'capture' ? { capture: async () => pixels.promise } : { generate: async () => text.promise });
    const task = h.engine.start('scope', cue(), true); await flush(); h.setCurrent(false);
    pixels.resolve([frame()]); text.resolve('late'); await task;
    assert.equal(h.engine.pendingId, null); assert.equal(h.offered.length, 0); assert.equal(h.archived.length, 0); h.dispose();
  }
});

test('shared gate scope change aborts a pending offer and prevents wrong-scope acknowledgement', async () => {
  const h = harness(); await h.engine.start('scope', cue(), true);
  assert.equal(h.engine.awaitingOffer, 'accepted-speech'); h.gate.setScope('new-scope');
  assert.equal(h.engine.pendingId, null); assert.deepEqual(h.revoked, ['accepted-speech']);
  assert.equal(await h.engine.ack('accepted-speech'), false); assert.equal(h.archived.length, 0); h.dispose();
});

test('short visual cue expiry does not cancel the separately bounded generation lease', async () => {
  const late = deferred<string>();
  const h = harness({ generate: async () => late.promise });
  const task = h.engine.start('scope', cue('slow-valid', 2000), true); await flush();
  h.setNow(10_000); late.resolve('仍然是一轮有效的主动短话'); await task;
  assert.equal(h.offered.length, 1); assert.equal(await h.engine.ack('slow-valid'), true); await flush();
  assert.equal(h.archived.length, 1); h.dispose();
});

test('request deadline cancels capture or generation promptly with safe stage-only diagnostics', async () => {
  for (const stage of ['capture', 'generation'] as const) {
    const pixels = deferred<Attachment[]>(), text = deferred<string>();
    const h = harness(stage === 'capture' ? { capture: async () => pixels.promise } : { generate: async () => text.promise });
    const task = h.engine.start('scope', cue(), true); await flush(); h.setNow(36_000);
    assert.equal(h.gate.busy, false); await task;
    assert.equal(h.engine.pendingId, null); assert.deepEqual(h.errors, [stage]);
    pixels.resolve([frame()]); text.resolve('late'); await flush(); assert.equal(h.offered.length, 0); h.dispose();
  }
});

test('offer acknowledgement expires after twenty seconds and on current-source loss', async () => {
  for (const reason of ['elapsed', 'source'] as const) {
    const h = harness(); await h.engine.start('scope', cue(), true);
    if (reason === 'elapsed') h.setNow(21_000); else h.setCurrent(false);
    assert.equal(await h.engine.ack('accepted-speech'), false);
    assert.equal(h.archived.length, 0); assert.deepEqual(h.revoked, ['accepted-speech']);
    assert.deepEqual(h.errors, ['delivery']); h.dispose();
  }
});

test('cancelling an offered line revokes it and never counts renderer display as a user reply', async () => {
  const h = harness(); await h.engine.start('scope', cue(), true); h.engine.cancel();
  assert.deepEqual(h.revoked, ['accepted-speech']); assert.equal(h.archived.length, 0);
  assert.equal(await h.engine.ack('accepted-speech'), false);
  await h.engine.start('scope', cue(), true); assert.equal(h.offered.length, 1); h.dispose();
});

test('empty, repeated-source, invalid and oversized frames cannot reach the provider', async () => {
  for (const frames of [[], [frame(), frame()], [frame(), frame('camera'), frame()],
    [{ ...frame(), dataUrl: 'file:///private.jpg' }], [{ ...frame(), dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(4_000_000) }]]) {
    const h = harness({ capture: async () => frames }); await h.engine.start('scope', cue(), true);
    assert.equal(h.counts().generations, 0); assert.equal(h.offered.length, 0);
    assert.deepEqual(h.errors, ['capture']); assert.equal(h.engine.pendingId, null); h.dispose();
  }
});

test('capture, generation and delivery exceptions never expose private error bodies or auto-retry', async () => {
  const secretError = new Error('PRIVATE screen and provider response');
  for (const stage of ['capture', 'generation', 'delivery'] as const) {
    const h = harness(stage === 'capture' ? { capture: async () => { throw secretError; } }
      : stage === 'generation' ? { generate: async () => { throw secretError; } } : { offer: () => { throw secretError; } });
    await h.engine.start('scope', cue(), true); await h.engine.start('scope', cue(), true);
    assert.deepEqual(h.errors, [stage]); assert.equal(h.engine.pendingId, null);
    assert.equal(h.archived.length, 0); h.dispose();
  }
  const h = harness({ offer: () => false }); await h.engine.start('scope', cue(), true);
  assert.deepEqual(h.errors, ['delivery']); assert.equal(h.engine.pendingId, null); h.dispose();
});

test('archive failure is reported after one successful ack without a repeat offer, commit or archive', async () => {
  let count = 0;
  const h = harness({ archive: async () => { count++; throw new Error('private storage detail'); } });
  await h.engine.start('scope', cue(), true); assert.equal(await h.engine.ack('accepted-speech'), true);
  await flush(); assert.deepEqual(h.errors, ['archive']); assert.equal(count, 1);
  assert.equal(await h.engine.ack('accepted-speech'), false); await h.engine.start('scope', cue(), true);
  assert.equal(h.offered.length, 1); assert.equal(count, 1); h.dispose();
});

test('remarks are bounded to four hundred UTF-16 units and empty output is not delivered', async () => {
  const h = harness({ generate: async () => '\0' + 'a'.repeat(399) + '🙂private tail' });
  await h.engine.start('scope', cue(), true);
  assert.equal(h.offered[0].text.length, 399); assert.equal(h.offered[0].text.includes('\0'), false); h.dispose();
  const empty = harness({ generate: async () => ' \n\0 ' }); await empty.engine.start('scope', cue(), true);
  assert.equal(empty.offered.length, 0); assert.deepEqual(empty.errors, ['generation']); empty.dispose();
});

test('disposed engine and zero-duration expired acknowledgements cannot restart or archive', async () => {
  const h = harness(); h.engine.dispose(); await h.engine.start('scope', cue(), true);
  assert.deepEqual(h.counts(), { captures: 0, generations: 0 }); assert.equal(await h.engine.ack('accepted-speech'), false); h.dispose();
});

test('a renderer ack retains the lease and archives nothing until the host confirms actual presentation', async () => {
  const displayed = deferred<boolean>(); let presents = 0, signal!: AbortSignal;
  const h = harness({ present: async (_message, current) => { presents++; signal = current; return displayed.promise; } });
  await h.engine.start('scope', cue(), true);
  const confirmation = h.engine.ack('accepted-speech'); await flush();
  assert.equal(presents, 1); assert.equal(signal.aborted, false);
  assert.equal(h.gate.busy, true); assert.equal(h.engine.pendingId, 'accepted-speech');
  assert.equal(h.archived.length, 0);
  displayed.resolve(true); assert.equal(await confirmation, true); await flush();
  assert.equal(h.gate.busy, false); assert.equal(h.engine.pendingId, null); assert.equal(h.archived.length, 1);
  assert.deepEqual(h.revoked, []); h.dispose();
});

test('concurrent ack requests trigger one presentation, one commit and one text archive', async () => {
  const displayed = deferred<boolean>(); let presents = 0;
  const h = harness({ present: async () => { presents++; return displayed.promise; } });
  await h.engine.start('scope', cue(), true);
  const first = h.engine.ack('accepted-speech');
  assert.equal(await h.engine.ack('accepted-speech'), false);
  assert.equal(await h.engine.ack('other-id'), false);
  assert.equal(presents, 1); assert.equal(h.archived.length, 0); assert.equal(h.gate.busy, true);
  displayed.resolve(true); assert.equal(await first, true);
  assert.equal(await h.engine.ack('accepted-speech'), false); await flush();
  assert.equal(presents, 1); assert.equal(h.archived.length, 1);
  await h.engine.start('scope', cue(), true); assert.equal(h.offered.length, 1); h.dispose();
});

test('presentation receives deeply frozen text and static origin metadata without mutable frame references', async () => {
  const h = harness({ present: async message => {
    assert.equal(Object.isFrozen(message), true); assert.equal(Object.isFrozen(message.origin), true);
    assert.equal(Object.isFrozen(message.origin.sources), true); assert.equal(Object.isFrozen(message.origin.labels), true);
    assert.deepEqual(Object.keys(message).sort(), ['id', 'origin', 'text']);
    assert.equal(JSON.stringify(message).includes('data:image'), false);
    assert.throws(() => { (message as ProactiveVisionMessage).text = 'changed'; }, TypeError);
    assert.throws(() => { message.origin.labels.push('changed'); }, TypeError);
    return true;
  } });
  await h.engine.start('scope', cue(), true);
  const original = h.offered[0].text;
  assert.equal(await h.engine.ack('accepted-speech'), true); await flush();
  assert.equal(h.archived[0].text, original); assert.deepEqual(h.archived[0].origin.labels, ['屏幕']); h.dispose();
});

test('missing, false, non-boolean and throwing presentation adapters never commit, archive or refund a cue', async () => {
  for (const present of [undefined as unknown as ProactiveVisionDependencies['present'], async () => false,
    async () => 'shown' as unknown as boolean, async () => { throw new Error('private native/renderer details'); }]) {
    const h = harness({ present }); await h.engine.start('scope', cue(), true);
    assert.equal(await h.engine.ack('accepted-speech'), false); assert.equal(h.archived.length, 0);
    assert.equal(h.engine.pendingId, null); assert.equal(h.gate.busy, false);
    assert.deepEqual(h.errors, ['delivery']); assert.deepEqual(h.revoked, ['accepted-speech']);
    await h.engine.start('scope', cue(), true); assert.equal(h.offered.length, 1); h.dispose();
  }
});

test('cancel, scope transfer and dispose abort pending presentation; a late true receipt cannot revive it', async () => {
  for (const mode of ['cancel', 'scope', 'dispose'] as const) {
    const displayed = deferred<boolean>(); let signal!: AbortSignal;
    const h = harness({ present: async (_message, current) => { signal = current; return displayed.promise; } });
    await h.engine.start('scope', cue(), true); const confirmation = h.engine.ack('accepted-speech'); await flush();
    if (mode === 'cancel') h.engine.cancel(); else if (mode === 'scope') h.gate.setScope('another-scope'); else h.engine.dispose();
    assert.equal(await confirmation, false); assert.equal(signal.aborted, true); assert.equal(h.archived.length, 0);
    displayed.resolve(true); await flush();
    assert.equal(h.archived.length, 0); assert.equal(h.engine.pendingId, null);
    assert.deepEqual(h.revoked, ['accepted-speech']); assert.equal(await h.engine.ack('accepted-speech'), false); h.dispose();
  }
});

test('source or role eligibility lost during presentation is rechecked after a true receipt', async () => {
  const displayed = deferred<boolean>(); let signal!: AbortSignal;
  const h = harness({ present: async (_message, current) => { signal = current; return displayed.promise; } });
  await h.engine.start('scope', cue(), true); const confirmation = h.engine.ack('accepted-speech'); await flush();
  h.setCurrent(false); displayed.resolve(true);
  assert.equal(await confirmation, false); assert.equal(signal.aborted, true);
  assert.equal(h.archived.length, 0); assert.deepEqual(h.revoked, ['accepted-speech']); h.dispose();
});

test('presentation still expires at the original offer twenty-second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const displayed = deferred<boolean>(); let signal!: AbortSignal;
  const h = harness({ present: async (_message, current) => { signal = current; return displayed.promise; } });
  await h.engine.start('scope', cue(), true);
  h.setNow(20_000); t.mock.timers.tick(19_000);
  const confirmation = h.engine.ack('accepted-speech'); await flush();
  assert.equal(h.gate.busy, true); assert.equal(h.archived.length, 0);
  h.setNow(21_000); t.mock.timers.tick(1000);
  assert.equal(await confirmation, false); assert.equal(signal.aborted, true);
  displayed.resolve(true); await flush(); assert.equal(h.archived.length, 0);
  assert.deepEqual(h.errors, ['delivery']); h.dispose();
});

test('slow generation leaves only the remaining original thirty-five-second budget for presentation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const text = deferred<string>(), displayed = deferred<boolean>(); let signal!: AbortSignal;
  const h = harness({ generate: async () => text.promise, present: async (_message, current) => { signal = current; return displayed.promise; } });
  const task = h.engine.start('scope', cue(), true); await flush();
  h.setNow(31_000); t.mock.timers.tick(30_000); text.resolve('生成较慢但仍然有界'); await task;
  const confirmation = h.engine.ack('accepted-speech'); await flush();
  h.setNow(35_999); t.mock.timers.tick(4999); assert.equal(signal.aborted, false); assert.equal(h.archived.length, 0);
  h.setNow(36_000); t.mock.timers.tick(1); assert.equal(await confirmation, false);
  assert.equal(signal.aborted, true); displayed.resolve(true); await flush();
  assert.equal(h.archived.length, 0); assert.deepEqual(h.revoked, ['accepted-speech']); h.dispose();
});

test('a late true presentation callback cannot clear or archive a newer pending opportunity', async () => {
  const oldDisplay = deferred<boolean>(), nextDisplay = deferred<boolean>(); let presents = 0;
  const h = harness({ present: async () => ++presents === 1 ? oldDisplay.promise : nextDisplay.promise });
  await h.engine.start('scope', cue('old'), true); const first = h.engine.ack('old'); await flush();
  h.engine.cancel(); assert.equal(await first, false);
  await h.engine.start('scope', cue('next'), true); const next = h.engine.ack('next'); await flush();
  oldDisplay.resolve(true); await flush();
  assert.equal(h.engine.pendingId, 'next'); assert.equal(h.archived.length, 0); assert.equal(h.gate.busy, true);
  nextDisplay.resolve(true); assert.equal(await next, true); await flush();
  assert.equal(h.archived.length, 1); assert.equal(h.archived[0].id, 'next'); h.dispose();
});

test('source-bearing cues are never visual opportunities and do not spend the underlying mood cue', async () => {
  const h = harness();
  for (const source of ['ambient', 'vision', 'screen', null, false, 0, '', {}, ['ambient']]) {
    await h.engine.start('scope', { ...cue(), source }, true);
    assert.deepEqual(h.counts(), { captures: 0, generations: 0 }); assert.equal(h.gate.busy, false);
  }
  await h.engine.start('scope', { ...cue(), source: undefined }, true);
  assert.deepEqual(h.counts(), { captures: 1, generations: 1 }); assert.equal(h.offered.length, 1);
  assert.equal(await h.engine.ack('accepted-speech'), true); await flush(); assert.equal(h.archived.length, 1); h.dispose();
});

test('an earlier true presentation cannot commit when the final synchronous host proof is false, missing or throws', async () => {
  for (const presentationCurrent of [() => false, () => { throw new Error('private host proof detail'); },
    undefined as unknown as ProactiveVisionDependencies['presentationCurrent'], () => 'current' as unknown as boolean]) {
    let presents = 0;
    const h = harness({ present: async () => { presents++; return true; }, presentationCurrent });
    await h.engine.start('scope', cue(), true);
    assert.equal(await h.engine.ack('accepted-speech'), false);
    assert.equal(presents, 1); assert.equal(h.archived.length, 0); assert.equal(h.gate.busy, false);
    assert.deepEqual(h.errors, ['delivery']); assert.deepEqual(h.revoked, ['accepted-speech']);
    await h.engine.start('scope', cue(), true); assert.equal(h.offered.length, 1); h.dispose();
  }
});

test('same visible text in a new presentation revision cannot reuse a resolved old receipt', async () => {
  const receipt = deferred<boolean>(); let revision = 1, provedRevision = 0, checks = 0;
  let presented!: Readonly<ProactiveVisionMessage>;
  const h = harness({ present: async message => { presented = message; provedRevision = revision; return receipt.promise; },
    presentationCurrent: message => {
      checks++; assert.equal(message, presented); assert.equal(Object.isFrozen(message), true);
      assert.equal(message.text, presented.text); return provedRevision === revision;
    } });
  await h.engine.start('scope', cue(), true); const confirmation = h.engine.ack('accepted-speech'); await flush();
  receipt.resolve(true); revision = 2; // No text change; only the host-visible revision changed before continuation.
  assert.equal(await confirmation, false); assert.equal(checks, 1); assert.equal(h.archived.length, 0);
  assert.deepEqual(h.revoked, ['accepted-speech']); h.dispose();
});

test('cancellation after a receipt resolves still prevents final proof, commit and archive', async () => {
  const receipt = deferred<boolean>(); let checks = 0;
  const h = harness({ present: async () => receipt.promise, presentationCurrent: () => { checks++; return true; } });
  await h.engine.start('scope', cue(), true); const confirmation = h.engine.ack('accepted-speech'); await flush();
  receipt.resolve(true); h.engine.cancel();
  assert.equal(await confirmation, false); assert.equal(checks, 0); assert.equal(h.archived.length, 0);
  assert.deepEqual(h.revoked, ['accepted-speech']); h.dispose();
});

test('final presentation proof and commit share one synchronous continuation with no awaited gap', async () => {
  let changedAfterProof = false, archives = 0;
  const h = harness({ presentationCurrent: () => {
    queueMicrotask(() => { changedAfterProof = true; }); return true;
  }, archive: async () => {
    assert.equal(changedAfterProof, false); archives++;
  } });
  await h.engine.start('scope', cue(), true);
  assert.equal(await h.engine.ack('accepted-speech'), true); await flush();
  assert.equal(archives, 1); assert.equal(changedAfterProof, true); assert.deepEqual(h.errors, []);
  assert.equal(await h.engine.ack('accepted-speech'), false); h.dispose();
});
