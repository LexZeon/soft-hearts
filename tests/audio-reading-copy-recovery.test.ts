import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, lstat, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AudioReadingArchive, stageReadingArchive } from '../electron/audio-reading-archive';
import { AmbientAudioStore } from '../electron/ambient-audio-store';
import { MemoryStore } from '../electron/memory';
import type { AudioReadingPublication } from '../electron/audio-reading-host-broker';
import type { AmbientCommentInput, AmbientLanguage, AmbientScope } from '../shared/ambient-audio';

const NOW = 200_000;
const SCOPE: AmbientScope = { characterId: 'public-copy-character', providerScope: 'local-copy-fixture' };
const LANGUAGE: AmbientLanguage = { status: 'detected', language: 'en', source: 'provider' };
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function ownTemp(t: TestContext) {
  const parent = await realpath(os.tmpdir()), prefix = 'soft-hearts-audio-copy-';
  const directory = await realpath(await mkdtemp(path.join(parent, prefix)));
  t.after(async () => {
    // Each awaited store operation has settled; removal owns only this exact root.
    assert.equal(await realpath(directory), directory); assert.equal(path.dirname(directory), parent);
    assert.ok(path.isAbsolute(directory) && path.basename(directory).startsWith(prefix));
    const info = await lstat(directory);
    assert.equal(info.isSymbolicLink(), false); assert.equal(info.isDirectory(), true);
    await rm(directory, { recursive: true, force: false });
  });
  return directory;
}
function publication(segmentId: string): AudioReadingPublication {
  return { scopeId: 'copy-session', source: 'system-audio', epoch: 1, captureId: 'public-capture', segmentId,
    sequence: 1, startedAtMs: NOW - 2000, endedAtMs: NOW - 1000, origin: 'ambient',
    text: 'A public audio original for archive recovery.', purposes: ['music'], signal: new AbortController().signal,
    currentPurposes: () => ['music'], finish() { /* The actual driver owns completion release, not this archive test. */ } };
}
async function acceptedComment(archive: AudioReadingArchive, id: string, recordIds?: string[]) {
  const raw = await archive.appendReading(SCOPE, publication(id+'-segment'), LANGUAGE);
  assert.equal(raw.record?.id, 'copy-session:1');
  // This existing host archive API represents an already accepted display ack.
  // The test does not fabricate a native display or call an initiative generator.
  const comment: AmbientCommentInput = { id, sessionId: 'copy-session', recordIds: recordIds ?? ['copy-session:1'],
    text: 'A completed public audio comment.', createdAt: NOW };
  await archive.appendComment(SCOPE, comment);
  return comment;
}
const noTemps = async (directory: string) => assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);

test('an acknowledged v2 source comment repairs one actual Memory copy exactly once without changing v1 audio bytes', async t => {
  const directory = await ownTemp(t), archive = new AudioReadingArchive(directory, { now: () => NOW });
  const memory = new MemoryStore(directory); await archive.load(); await memory.load();
  const legacyFile = path.join(directory, 'system-audio-transcripts.json'), original = await readFile(legacyFile);
  const comment = await acceptedComment(archive, 'copy-missing');
  assert.equal(memory.findInitiative(SCOPE, comment.id), null);
  assert.deepEqual(await archive.repairCommentCopies(SCOPE, memory), { copied: 1, deleted: 0, pending: 0 });
  const handle = memory.findInitiative(SCOPE, comment.id); assert.ok(handle);
  assert.equal(handle.turnId, comment.id); assert.equal(memory.list(SCOPE, {}, NOW).total, 1);
  const record = memory.read(SCOPE, handle.recordId, {}, NOW); assert.ok(record);
  assert.deepEqual(record.messages.map(message => ({ role: message.role, text: message.content, status: message.status })),
    [{ role: 'assistant', text: comment.text, status: 'complete' }]);
  assert.deepEqual(record.origin?.sources, ['ambient']);
  const journalHash = hash(await readFile(path.join(directory, 'memories.jsonl')));
  assert.deepEqual(await archive.repairCommentCopies(SCOPE, memory), { copied: 0, deleted: 0, pending: 0 });
  assert.deepEqual(memory.findInitiative(SCOPE, comment.id), handle);
  assert.equal(memory.list(SCOPE, {}, NOW).total, 1);
  assert.equal(hash(await readFile(path.join(directory, 'memories.jsonl'))), journalHash);
  assert.deepEqual(await readFile(legacyFile), original);
  assert.equal(hash(await readFile(legacyFile)), hash(original));
  const oldReader = new AmbientAudioStore(directory); await oldReader.load();
  assert.equal(oldReader.list(SCOPE).total, 0); assert.equal(JSON.parse(original.toString('utf8')).version, 1);
  await noTemps(directory);
});

test('the existing Memory v1 delete tombstone survives reload and withdraws only the source comment, never raw audio text', async t => {
  const directory = await ownTemp(t), archive = new AudioReadingArchive(directory, { now: () => NOW });
  const memory = new MemoryStore(directory); await archive.load(); await memory.load();
  const comment = await acceptedComment(archive, 'copy-user-deleted');
  await archive.repairCommentCopies(SCOPE, memory);
  const handle = memory.findInitiative(SCOPE, comment.id); assert.ok(handle);
  assert.equal(await memory.delete(SCOPE, handle.recordId), true);
  assert.equal(memory.hasDeletedTurn(SCOPE, comment.id), true);
  const journalFile = path.join(directory, 'memories.jsonl'), deletedJournal = await readFile(journalFile);
  const header = JSON.parse(deletedJournal.toString('utf8').split('\n')[0]);
  assert.equal(header.type, 'header'); assert.equal(header.version, 1);
  assert.ok(header.tombstones.some((value: string) => value.endsWith(':'+comment.id)));
  const restoredMemory = new MemoryStore(directory), restoredArchive = new AudioReadingArchive(directory);
  await restoredMemory.load(); await restoredArchive.load();
  assert.equal(restoredMemory.hasDeletedTurn(SCOPE, comment.id), true);
  assert.equal(restoredMemory.findInitiative(SCOPE, comment.id), null);
  assert.equal(restoredArchive.comments(SCOPE).length, 1);
  assert.deepEqual(await restoredArchive.repairCommentCopies(SCOPE, restoredMemory), { copied: 0, deleted: 1, pending: 0 });
  assert.deepEqual(restoredArchive.comments(SCOPE), []);
  assert.equal(restoredArchive.read(SCOPE, 'copy-session:1')?.text, publication('unused').text);
  assert.equal(restoredArchive.list(SCOPE).total, 1);
  assert.equal(restoredMemory.findInitiative(SCOPE, comment.id), null);
  assert.equal(restoredMemory.list(SCOPE, {}, NOW).total, 0);
  assert.deepEqual(await readFile(journalFile), deletedJournal);
  assert.deepEqual(await restoredArchive.repairCommentCopies(SCOPE, restoredMemory), { copied: 0, deleted: 0, pending: 0 });
  assert.deepEqual(await readFile(journalFile), deletedJournal);
  await noTemps(directory);
});

test('a real legacy-source deletion repairs both comment copies after one staged-save failure, preserving the independent new raw', async t => {
  const directory = await ownTemp(t), legacy = new AmbientAudioStore(directory, { now: () => NOW }); await legacy.load();
  await legacy.append(SCOPE, { id: 'copy-session:40', sessionId: 'copy-session', mode: 'music', startedAt: NOW - 4000,
    endedAt: NOW - 3000, text: 'A public original stored by the legacy audio writer.', language: LANGUAGE });
  const archive = new AudioReadingArchive(directory, { now: () => NOW }), memory = new MemoryStore(directory);
  await archive.load(); await memory.load();
  const comment = await acceptedComment(archive, 'copy-legacy-linked', ['copy-session:40','copy-session:1']);
  assert.deepEqual(await archive.repairCommentCopies(SCOPE, memory), { copied: 1, deleted: 0, pending: 0 });
  assert.ok(memory.findInitiative(SCOPE, comment.id));
  assert.equal((await legacy.delete(SCOPE, 'copy-session:40')).deleted, true);
  const legacyAfterDelete = await readFile(path.join(directory, 'system-audio-transcripts.json'));
  let injectedFailures = 0;
  const damagedCopy = new AudioReadingArchive(directory, { stage: async (file,text) => {
    const actual = await stageReadingArchive(file,text);
    return { async commit() {
      if (!injectedFailures) {
        assert.equal(memory.hasDeletedTurn(SCOPE, comment.id), true, 'the real Memory deletion must be durable before source-comment saving');
        injectedFailures++;
        throw Error('Synthetic one-shot source-comment save failure.');
      }
      await actual.commit();
    }, discard: () => actual.discard() };
  } });
  await damagedCopy.load();
  assert.equal(damagedCopy.read(SCOPE, 'copy-session:40'), null);
  await assert.rejects(damagedCopy.repairCommentCopies(SCOPE, memory), /one-shot source-comment save failure/iu);
  assert.equal(injectedFailures, 1);
  assert.equal(memory.hasDeletedTurn(SCOPE, comment.id), true);
  assert.equal(memory.findInitiative(SCOPE, comment.id), null);
  assert.equal(damagedCopy.comments(SCOPE).length, 1, 'failed source save must retain the source receipt for a real retry');
  await noTemps(directory);
  const journalAfterDelete = await readFile(path.join(directory, 'memories.jsonl'));
  const recoveredMemory = new MemoryStore(directory), recoveredArchive = new AudioReadingArchive(directory);
  await recoveredMemory.load(); await recoveredArchive.load();
  assert.equal(recoveredMemory.hasDeletedTurn(SCOPE, comment.id), true);
  assert.equal(recoveredArchive.comments(SCOPE).length, 1);
  assert.deepEqual(await recoveredArchive.repairCommentCopies(SCOPE, recoveredMemory), { copied: 0, deleted: 1, pending: 0 });
  assert.deepEqual(recoveredArchive.comments(SCOPE), []);
  assert.equal(recoveredMemory.findInitiative(SCOPE, comment.id), null);
  assert.equal(recoveredMemory.list(SCOPE, {}, NOW).total, 0);
  assert.equal(recoveredArchive.read(SCOPE, 'copy-session:40'), null);
  assert.equal(recoveredArchive.read(SCOPE, 'copy-session:1')?.text, publication('unused').text);
  assert.equal(recoveredArchive.list(SCOPE).total, 1);
  assert.deepEqual(await readFile(path.join(directory, 'memories.jsonl')), journalAfterDelete);
  assert.deepEqual(await readFile(path.join(directory, 'system-audio-transcripts.json')), legacyAfterDelete);
  assert.deepEqual(await recoveredArchive.repairCommentCopies(SCOPE, recoveredMemory), { copied: 0, deleted: 0, pending: 0 });
  await noTemps(directory);
});
