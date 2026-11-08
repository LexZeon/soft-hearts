import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, lstat, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AudioReadingArchive, stageReadingArchive, type ReadingArchiveStage } from '../electron/audio-reading-archive';
import { AmbientAudioStore } from '../electron/ambient-audio-store';
import { atomicWriteFile } from '../electron/atomic-file';
import type { AudioReadingPublication } from '../electron/audio-reading-host-broker';
import type { AmbientScope, AmbientLanguage, AmbientTranscriptInput } from '../shared/ambient-audio';

const NOW = 100_000;
const SCOPE: AmbientScope = { characterId: 'public-audio-a', providerScope: 'local-fixture-a' };
const OTHER: AmbientScope = { characterId: 'public-audio-b', providerScope: 'local-fixture-a' };
const LANGUAGE: AmbientLanguage = { status: 'detected', language: 'en', source: 'provider' };
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const held = () => {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
};
async function ownTemp(t: TestContext) {
  const parent = await realpath(os.tmpdir()), prefix = 'soft-hearts-reading-archive-';
  const directory = await realpath(await mkdtemp(path.join(parent, prefix)));
  const releases: (() => void)[] = [], work: Promise<unknown>[] = [];
  t.after(async () => {
    for (const release of releases) release();
    await Promise.allSettled(work);
    // Recheck the exact root created here before any recursive removal.
    assert.equal(await realpath(directory), directory);
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.isAbsolute(directory) && path.basename(directory).startsWith(prefix));
    const info = await lstat(directory);
    assert.equal(info.isSymbolicLink(), false); assert.equal(info.isDirectory(), true);
    await rm(directory, { recursive: true, force: false });
  });
  return { directory, releaseWithCleanup: (release: () => void) => releases.push(release),
    track<T>(promise: Promise<T>): Promise<T> { work.push(promise); void promise.catch(() => {}); return promise; } };
}
function publication(segmentId: string, overrides: Partial<AudioReadingPublication> = {}) {
  const controller = new AbortController();
  let purposes: ('music' | 'movie')[] = ['music'], finishes = 0;
  const value: AudioReadingPublication = {
    scopeId: 'listening-a', source: 'system-audio', epoch: 1, captureId: 'capture-a', segmentId,
    sequence: 1, startedAtMs: NOW - 5000, endedAtMs: NOW - 4000,
    origin: 'ambient', text: 'A public repeated audio sentence.', purposes,
    signal: controller.signal, currentPurposes: () => [...purposes], finish: () => { finishes++; }, ...overrides,
  };
  return { value, controller, setPurposes(next: ('music' | 'movie')[]) { purposes = [...next]; }, finishes: () => finishes };
}
const legacyInput = (id: string, text = 'Shared public topic in the old archive.'): AmbientTranscriptInput => ({
  id, sessionId: 'listening-a', mode: 'music', startedAt: NOW - 6000, endedAt: NOW - 5500, text, language: LANGUAGE,
});
const sidecar = async (directory: string) => JSON.parse(await readFile(path.join(directory, 'audio-reading-v2.json'), 'utf8'));
const noTemps = async (directory: string) => assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);

test('abort while real staging awaits discards its actual temp and creates no durable reading or recent text', async t => {
  const area = await ownTemp(t), entered = held(), release = held();
  area.releaseWithCleanup(release.open);
  const store = new AudioReadingArchive(area.directory, { now: () => NOW, stage: async (file, text) => {
    const staged = await stageReadingArchive(file, text); entered.open(); await release.promise; return staged;
  } });
  await store.load();
  const item = publication('cancel-before-commit');
  const pending = area.track(store.appendReading(SCOPE, item.value, LANGUAGE));
  await entered.promise;
  assert.ok((await readdir(area.directory)).some(name => name.startsWith('audio-reading-v2.json.') && name.endsWith('.tmp')));
  assert.equal((await readdir(area.directory)).includes('audio-reading-v2.json'), false);
  item.controller.abort(); release.open();
  assert.deepEqual(await pending, { state: 'cancelled', committed: false, publishable: false, inserted: false, record: null });
  assert.equal(store.list(SCOPE).total, 0);
  assert.deepEqual(store.context(SCOPE, { sessionId: 'listening-a', now: NOW }), []);
  assert.equal((await readdir(area.directory)).includes('audio-reading-v2.json'), false);
  await noTemps(area.directory);
});

test('revoke after commit starts allows the real rename receipt but suppresses publication and recent context', async t => {
  const area = await ownTemp(t), commitStarted = held(), release = held();
  area.releaseWithCleanup(release.open); let commits = 0;
  const store = new AudioReadingArchive(area.directory, { now: () => NOW, stage: async (file, text) => {
    const staged = await stageReadingArchive(file, text);
    return { async commit() { if (++commits === 1) { commitStarted.open(); await release.promise; } await staged.commit(); },
      discard: () => staged.discard() };
  } });
  await store.load();
  const old = publication('commit-linearized');
  const pending = area.track(store.appendReading(SCOPE, old.value, LANGUAGE));
  await commitStarted.promise;
  store.clearTransient(SCOPE); old.controller.abort();
  const fresh = publication('other-scope-fresh', { scopeId: 'listening-b' });
  const next = area.track(store.appendReading(OTHER, fresh.value, LANGUAGE));
  release.open();
  const result = await pending;
  assert.equal(result.state, 'committed'); assert.equal(result.committed, true);
  assert.equal(result.publishable, false); assert.equal(result.inserted, true);
  assert.equal(store.read(SCOPE, 'listening-a:1')?.text, old.value.text);
  assert.equal((await sidecar(area.directory)).records.some((r: { id: string }) => r.id === 'listening-a:1'), true);
  assert.deepEqual(store.context(SCOPE, { sessionId: 'listening-a', now: NOW }), []);
  assert.equal((await next).publishable, true);
  assert.deepEqual(store.context(OTHER, { sessionId: 'listening-b', now: NOW }).map(r => r.id), ['listening-b:1']);
  assert.equal(store.read(OTHER, 'listening-a:1'), null);
  await noTemps(area.directory);
});

test('closing music during staging discards its first metadata and really restages only movie', async t => {
  const area = await ownTemp(t), entered = held(), release = held(); area.releaseWithCleanup(release.open);
  const drafts: { records: { purposes: string[] }[] }[] = []; let commits = 0, discards = 0;
  const store = new AudioReadingArchive(area.directory, { now: () => NOW, stage: async (file, text) => {
    const staged = await stageReadingArchive(file, text); drafts.push(JSON.parse(text));
    if (drafts.length === 1) { entered.open(); await release.promise; }
    return { async commit() { commits++; await staged.commit(); }, async discard() { discards++; await staged.discard(); } };
  } });
  await store.load();
  const item = publication('purpose-rechecked', { purposes: ['music','movie'] }); item.setPurposes(['music','movie']);
  const pending = area.track(store.appendReading(SCOPE, item.value, LANGUAGE));
  await entered.promise; item.setPurposes(['movie']); release.open();
  const result = await pending;
  assert.equal(result.publishable, true); assert.equal(drafts.length, 2);
  assert.deepEqual(drafts[0].records[0].purposes, ['music','movie']);
  assert.deepEqual(drafts[1].records[0].purposes, ['movie']);
  assert.equal(commits, 1); assert.equal(discards, 1);
  assert.equal(result.record?.mode, 'movie'); assert.deepEqual(result.record?.purposes, ['movie']);
  assert.deepEqual(result.record?.observations?.[0].purposes, ['movie']);
  assert.equal(result.record?.tags.includes('music'), false);
  assert.deepEqual((await sidecar(area.directory)).records[0].purposes, ['movie']);
  await noTemps(area.directory);
});

test('stable segments retry once, conflicts reject, only positive cross-source overlap shares a canonical, and same-source repeats survive', async t => {
  const area = await ownTemp(t), store = new AudioReadingArchive(area.directory, { now: () => NOW }); await store.load();
  const first = publication('system-first');
  const inserted = await store.appendReading(SCOPE, first.value, LANGUAGE);
  assert.equal(inserted.inserted, true); assert.equal(inserted.publishable, true);
  const retry = await store.appendReading(SCOPE, first.value, LANGUAGE);
  assert.equal(retry.inserted, false); assert.equal(retry.publishable, false);
  assert.equal(retry.record?.id, inserted.record?.id);
  await assert.rejects(store.appendReading(SCOPE, { ...first.value, text: 'A different original sentence.' }, LANGUAGE), /identity conflict/iu);
  assert.equal(store.list(SCOPE).total, 1); assert.equal(store.read(SCOPE, inserted.record!.id)?.observations?.length, 1);
  const otherRaw = 'A public repeated audio sentence!';
  const cross = publication('microphone-overlap', { source: 'microphone', captureId: 'capture-microphone', text: otherRaw,
    startedAtMs: NOW - 4900, endedAtMs: NOW - 3900 });
  const merged = await store.appendReading(SCOPE, cross.value, LANGUAGE);
  assert.equal(merged.inserted, false); assert.equal(merged.publishable, false);
  assert.equal(merged.record?.id, inserted.record?.id); assert.equal(store.list(SCOPE).total, 1);
  assert.deepEqual(merged.record?.observations?.map(o => ({ source: o.source, text: o.text })), [
    { source: 'system-audio', text: first.value.text }, { source: 'microphone', text: otherRaw },
  ]);
  const sameSource = publication('system-repeat', { startedAtMs: NOW - 3000, endedAtMs: NOW - 2000 });
  assert.equal((await store.appendReading(SCOPE, sameSource.value, LANGUAGE)).inserted, true);
  assert.equal(store.list(SCOPE).total, 2);
  // PCM end timestamps are exclusive. Touching endpoints have no shared audio.
  const touching = publication('microphone-touch-only', { source: 'microphone', captureId: 'capture-microphone',
    startedAtMs: sameSource.value.endedAtMs, endedAtMs: sameSource.value.endedAtMs + 500 });
  assert.equal((await store.appendReading(SCOPE, touching.value, LANGUAGE)).inserted, true);
  assert.equal(store.list(SCOPE).total, 3);
  assert.equal((await sidecar(area.directory)).records.flatMap((r: { observations: unknown[] }) => r.observations).length, 4);
  await noTemps(area.directory);
});

test('the real v1 reader and bytes stay compatible while merged search/comments and deletion work in both directions', async t => {
  const area = await ownTemp(t), legacyFile = path.join(area.directory, 'system-audio-transcripts.json');
  const old = new AmbientAudioStore(area.directory, { now: () => NOW }); await old.load();
  await old.append(SCOPE, legacyInput('legacy-one'));
  await old.append(SCOPE, legacyInput('legacy-two', 'A second legacy-only public sentence.'));
  await old.appendComment(SCOPE, { id: 'old-comment', sessionId: 'listening-a', recordIds: ['legacy-one'], text: 'An old public comment.', createdAt: NOW - 100 });
  const original = await readFile(legacyFile), originalHash = digest(original);
  const store = new AudioReadingArchive(area.directory, { now: () => NOW }); await store.load();
  const own = await store.appendReading(SCOPE, publication('new-one', { text: 'Shared public topic in the new archive.' }).value, LANGUAGE);
  await store.appendComment(SCOPE, { id: 'cross-one', sessionId: 'listening-a', recordIds: ['legacy-one',own.record!.id], text: 'A mixed-archive public comment.', createdAt: NOW });
  assert.equal(digest(await readFile(legacyFile)), originalHash);
  assert.deepEqual(await readFile(legacyFile), original);
  const independent = new AmbientAudioStore(area.directory, { now: () => NOW }); await independent.load();
  assert.equal(independent.list(SCOPE).total, 2); assert.equal(independent.read(SCOPE, own.record!.id), null);
  assert.deepEqual(independent.comments(SCOPE).map(c => c.id), ['old-comment']);
  assert.equal(store.list(SCOPE, { query: 'Shared public topic' }).total, 2);
  assert.deepEqual(store.comments(SCOPE, 'legacy-one').map(c => c.id), ['old-comment','cross-one']);
  assert.deepEqual(store.comments(SCOPE, own.record!.id).map(c => c.id), ['cross-one']);
  const removedOwn = await store.delete(SCOPE, own.record!.id);
  assert.equal(removedOwn.deleted, true); assert.deepEqual(removedOwn.deletedCommentIds, ['cross-one']);
  assert.equal(store.read(SCOPE, own.record!.id), null);
  assert.deepEqual(store.comments(SCOPE, 'legacy-one').map(c => c.id), ['old-comment']);
  assert.equal(digest(await readFile(legacyFile)), originalHash);
  const another = await store.appendReading(SCOPE, publication('new-two').value, LANGUAGE);
  await store.appendComment(SCOPE, { id: 'cross-two', sessionId: 'listening-a', recordIds: ['legacy-two',another.record!.id], text: 'Another mixed public comment.', createdAt: NOW + 1 });
  const removedOld = await store.delete(SCOPE, 'legacy-two');
  assert.equal(removedOld.deleted, true); assert.deepEqual(removedOld.deletedCommentIds, ['cross-two']);
  assert.equal(store.read(SCOPE, 'legacy-two'), null); assert.ok(store.read(SCOPE, another.record!.id));
  assert.deepEqual(store.comments(SCOPE, another.record!.id), []);
  const oldReloaded = new AmbientAudioStore(area.directory); await oldReloaded.load();
  assert.deepEqual(oldReloaded.list(SCOPE).records.map(r => r.id), ['legacy-one']);
  assert.equal(JSON.parse(await readFile(legacyFile,'utf8')).version, 1);
  const reloaded = new AudioReadingArchive(area.directory); await reloaded.load(); await reloaded.reconcile(SCOPE);
  assert.equal(reloaded.list(SCOPE).total, 2);
  assert.deepEqual(reloaded.comments(SCOPE).map(c => c.id), ['old-comment']);
  await noTemps(area.directory);
});

test('one failed real legacy write leaves durable pending suppression and reload reconciliation removes the ghost once', async t => {
  const area = await ownTemp(t), legacyFile = path.join(area.directory, 'system-audio-transcripts.json');
  let failNext = false, failures = 0;
  const store = new AudioReadingArchive(area.directory, { now: () => NOW, legacyWriteFile: async (file,text) => {
    if (failNext) { failNext = false; failures++; throw Error('Synthetic one-shot legacy write failure.'); }
    await atomicWriteFile(file,text);
  } });
  await store.load(); await store.append(SCOPE, legacyInput('legacy-pending'));
  const item = publication('own-survives'), own = await store.appendReading(SCOPE, item.value, LANGUAGE);
  await store.appendComment(SCOPE, { id: 'pending-cross-comment', sessionId: 'listening-a', recordIds: ['legacy-pending',own.record!.id], text: 'A public linked comment.', createdAt: NOW });
  const before = digest(await readFile(legacyFile)); failNext = true;
  await assert.rejects(store.delete(SCOPE, 'legacy-pending'), /one-shot legacy write failure/iu);
  assert.equal(failures, 1); assert.equal(digest(await readFile(legacyFile)), before);
  assert.equal((await sidecar(area.directory)).legacyDeletes.find((r: { id: string }) => r.id === 'legacy-pending').pending, true);
  assert.equal(store.read(SCOPE, 'legacy-pending'), null); assert.equal(store.list(SCOPE).total, 1);
  assert.deepEqual(store.comments(SCOPE, own.record!.id), []);
  const oldBeforeRetry = new AmbientAudioStore(area.directory); await oldBeforeRetry.load();
  assert.ok(oldBeforeRetry.read(SCOPE, 'legacy-pending'));
  const reloaded = new AudioReadingArchive(area.directory, { now: () => NOW }); await reloaded.load();
  assert.equal(reloaded.read(SCOPE, 'legacy-pending'), null);
  await reloaded.reconcile(SCOPE);
  assert.equal((await sidecar(area.directory)).legacyDeletes.find((r: { id: string }) => r.id === 'legacy-pending').pending, false);
  const oldAfterRetry = new AmbientAudioStore(area.directory); await oldAfterRetry.load();
  assert.equal(oldAfterRetry.read(SCOPE, 'legacy-pending'), null);
  assert.equal(reloaded.list(SCOPE).total, 1); assert.equal((await sidecar(area.directory)).records.length, 1);
  const settledHash = digest(await readFile(path.join(area.directory,'audio-reading-v2.json')));
  await reloaded.reconcile(SCOPE);
  assert.equal(digest(await readFile(path.join(area.directory,'audio-reading-v2.json'))), settledHash);
  assert.equal((await reloaded.appendReading(SCOPE, item.value, LANGUAGE)).inserted, false);
  assert.equal(reloaded.list(SCOPE).total, 1);
  await noTemps(area.directory);
});

test('scope clear, pending invalidation and global clear cancel late staging without clearing a fresh other scope', async t => {
  const area = await ownTemp(t);
  for (const change of ['scope-clear','pending-invalidate','global-clear'] as const) {
    const directory = path.join(area.directory, change), entered = held(), release = held(); area.releaseWithCleanup(release.open);
    let stages = 0;
    const store = new AudioReadingArchive(directory, { now: () => NOW, stage: async (file,text): Promise<ReadingArchiveStage> => {
      const staged = await stageReadingArchive(file,text); if (++stages === 1) { entered.open(); await release.promise; } return staged;
    } });
    await store.load();
    const pending: ReturnType<AudioReadingArchive['appendReading']> = area.track(store.appendReading(SCOPE, publication('old-'+change).value, LANGUAGE));
    await entered.promise;
    if (change === 'scope-clear') store.clearTransient(SCOPE);
    else if (change === 'pending-invalidate') store.invalidatePendingTransient(SCOPE);
    else store.clearTransient();
    const fresh: ReturnType<AudioReadingArchive['appendReading']> = area.track(store.appendReading(OTHER, publication('new-'+change, { scopeId: 'fresh-'+change }).value, LANGUAGE));
    release.open();
    assert.equal((await pending).state, 'cancelled'); assert.equal((await fresh).publishable, true);
    assert.equal(store.list(SCOPE).total, 0); assert.equal(store.list(OTHER).total, 1);
    assert.deepEqual(store.context(SCOPE, { sessionId: 'listening-a', now: NOW }), []);
    assert.deepEqual(store.context(OTHER, { sessionId: 'fresh-'+change, now: NOW }).map(r => r.id), ['fresh-'+change+':1']);
    await noTemps(directory);
  }
});

test('persistent host IDs satisfy the existing comment contract, keep source context separate and never reuse deleted sequences', async t => {
  const area = await ownTemp(t), store = new AudioReadingArchive(area.directory, { now: () => NOW }); await store.load();
  const system = publication('identity-system', { scopeId: 'identity-session', text: 'An original public system audio sentence.' });
  const first = await store.appendReading(SCOPE, system.value, LANGUAGE);
  assert.equal(first.record?.id, 'identity-session:1');
  const microphone = publication('identity-microphone', { scopeId: 'identity-session', source: 'microphone', captureId: 'capture-mic',
    text: 'A separate microphone-only public sentence.', startedAtMs: NOW - 3000, endedAtMs: NOW - 2000 });
  const second = await store.appendReading(SCOPE, microphone.value, LANGUAGE);
  assert.equal(second.record?.id, 'identity-session:2');
  const overlapping = publication('identity-overlap', { scopeId: 'identity-session', source: 'microphone', captureId: 'capture-mic',
    text: system.value.text, startedAtMs: NOW - 4900, endedAtMs: NOW - 3900 });
  const merged = await store.appendReading(SCOPE, overlapping.value, LANGUAGE);
  assert.equal(merged.record?.id, 'identity-session:1'); assert.equal(merged.inserted, false);
  assert.equal((await sidecar(area.directory)).sequences[0].last, 2, 'cross-source merge must not consume a canonical sequence');
  assert.deepEqual(store.context(SCOPE, { sessionId: 'identity-session', now: NOW }).map(r => r.id), ['identity-session:1','identity-session:2']);
  store.clearSourceTransient(SCOPE, 'system-audio');
  assert.deepEqual(store.context(SCOPE, { sessionId: 'identity-session', now: NOW }).map(r => r.id), ['identity-session:2']);
  assert.equal(store.list(SCOPE).total, 2); assert.equal(store.read(SCOPE, 'identity-session:1')?.observations?.length, 2);
  assert.equal((await store.appendReading(SCOPE, system.value, LANGUAGE)).publishable, false);
  assert.deepEqual(store.context(SCOPE, { sessionId: 'identity-session', now: NOW }).map(r => r.id), ['identity-session:2'], 'a duplicate must not reauthorize withdrawn shared-source context');
  assert.equal((await store.delete(SCOPE, 'identity-session:1')).deleted, true);
  const reloaded = new AudioReadingArchive(area.directory, { now: () => NOW }); await reloaded.load();
  assert.equal((await sidecar(area.directory)).sequences[0].last, 2);
  assert.equal(reloaded.read(SCOPE, 'identity-session:1'), null);
  const next = publication('identity-after-reload', { scopeId: 'identity-session', text: 'A new public sentence after deletion and reload.',
    startedAtMs: NOW - 1000, endedAtMs: NOW - 500 });
  assert.equal((await reloaded.appendReading(SCOPE, next.value, LANGUAGE)).record?.id, 'identity-session:3');
  await assert.rejects(reloaded.appendReading(SCOPE, system.value, LANGUAGE), /Deleted ambient segment/iu);
  await assert.rejects(reloaded.appendReading(SCOPE, overlapping.value, LANGUAGE), /Deleted ambient segment/iu);
  assert.equal(reloaded.list(SCOPE).total, 2);
  assert.deepEqual(reloaded.list(SCOPE).records.map(r => r.id).sort(), ['identity-session:2','identity-session:3']);
  const valid = await sidecar(area.directory);
  const corruptions: [string, (value: typeof valid) => void][] = [
    ['zero-counter', value => { value.sequences[0].last = 0; }],
    ['counter-behind-record', value => { value.sequences[0].last = 1; }],
    ['duplicate-counter', value => { value.sequences.push({ ...value.sequences[0] }); }],
    ['missing-counter', value => { value.sequences = []; }],
    ['leading-zero-id', value => { value.records[0].id = 'identity-session:02'; }],
    ['wrong-session-id', value => { value.records[0].id = 'different-session:2'; }],
    ['duplicate-canonical-id', value => { value.records[1].id = value.records[0].id; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const directory = path.join(area.directory, 'invalid-'+label); await mkdir(directory);
    const invalid = structuredClone(valid); corrupt(invalid);
    await writeFile(path.join(directory, 'audio-reading-v2.json'), JSON.stringify(invalid)+'\n');
    const reader = new AudioReadingArchive(directory);
    await assert.rejects(reader.load(), /Invalid audio observation (?:counter|identity)/u, label);
  }
  await noTemps(area.directory);
});
