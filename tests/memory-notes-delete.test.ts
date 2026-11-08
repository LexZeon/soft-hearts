// I-021 删除一致性 (docs/claude/2026-11-04-memory-notes-delete.md; Codex T-208 found the six): what the user deleted stays
// deleted on every path, and a deletion that failed says so, changes nothing and can be tried again. Every conversation here is
// made up for the test; each test uses its own temporary folder; no profile directory is read and no real Claude is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from '../electron/atomic-file';
import { forgetCharacterMemories, forgettableProviderScopes } from '../electron/character-forget';
import { CompanionService, memoryProviderScope } from '../electron/companion';
import { localDateKey } from '../electron/diary/diary-dates';
import { MemoryStore } from '../electron/memory';
import { MemoryNotesCore, PARKED_DAYS } from '../electron/memory-notes/core';
import { MemoryNotes } from '../electron/memory-notes/host';
import { MEMORY_NOTES_FILE, MemoryNotesStore, type MemoryNotesFile } from '../electron/memory-notes/store';
import { MemoryRecycleBin, RECYCLE_DIRECTORY, RECYCLE_MAX_DAYS } from '../electron/memory-recycle-bin';
import { forgetRecoverably, restoreRecoverably, type RecoverableForgetPorts } from '../electron/recoverable-forget';
import { UserProfileStore } from '../electron/user-profile';
import { validateProvider } from '../electron/validation';
import type { MemoryScope } from '../shared/memory';
import type { MemoryNoteBody } from '../shared/memory-notes/interface';
import { MEMORY_NOTES_KNOBS } from '../shared/memory-notes/knobs';
import { FakeNoteArchive, FakeNoteWriter, fakeNoteBody } from '../shared/memory-notes/fake';

const T0 = Date.UTC(2026, 10, 4, 4);
const HOUR = 3_600_000;
const CHARACTER = 'synthetic-delete-girl';
const NAME = '合成角色';
const provider = (model: string) => validateProvider({ kind: 'claude', baseUrl: '', model });
const scopeFor = (model: string, characterId = CHARACTER): MemoryScope => ({ characterId, providerScope: memoryProviderScope(provider(model)) });
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const eio = (what: string) => Object.assign(new Error(`synthetic ${what} write failure`), { code: 'EIO' });

const RAMEN = { user: '学校旁边新开了一家拉面店，周末我想和朋友去尝尝', her: '听起来不错！去了记得告诉我味道怎么样～' };
const MOVIE = { user: '昨天看了一部科幻电影，特效很震撼', her: '哇，是哪一部呀？我也想听你讲讲。' };
const MOVIE_NOTE: MemoryNoteBody = { title: '看了一部科幻电影', summary: '用户昨天看了一部科幻电影，觉得特效很震撼。', people: [], things: ['科幻电影', '特效'],
  mood: '兴奋', plans: [], tags: ['科幻电影', '电影', '特效', '看电影'] };

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-memory-notes-delete-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
async function chat(store: MemoryStore, scope: MemoryScope, id: string, user: string, her: string, at: number,
  { conversationId = `c-${id}`, seal = true }: { conversationId?: string; seal?: boolean } = {}): Promise<string> {
  const handle = await store.beginTurn(scope, { id, userText: user, at, conversationId });
  await store.appendAssistant(scope, id, her, at + 1_000);
  await store.finishTurn(scope, id, 'complete', at + 2_000);
  if (seal) await store.seal(scope);
  return handle.recordId;
}
function writerFor(extra: Record<string, MemoryNoteBody> = {}): FakeNoteWriter {
  const writer = new FakeNoteWriter(JSON.stringify(fakeNoteBody({ title: '一段别的聊天', things: [], plans: [], tags: ['别的', '杂事', '随便聊聊'] })));
  for (const [word, body] of Object.entries(extra)) writer.when(word, body); // the first rule that matches answers
  return writer.when('拉面店', fakeNoteBody()).when('科幻电影', MOVIE_NOTE);
}
async function notebook(directory: string, archive: MemoryStore, clock: { t: number }, writer: FakeNoteWriter,
  scope: () => MemoryScope | null, storage?: MemoryNotesStore): Promise<MemoryNotes> {
  const notes = new MemoryNotes({ directory, archive, write: writer.write, userBusy: () => false, modelBusy: () => false, lastActivityAt: () => null,
    scope, now: () => clock.t, tickMs: 3_600_000 }, storage);
  await notes.start();
  clock.t += MEMORY_NOTES_KNOBS.pace.startDelaySeconds * 1000;
  return notes;
}
async function tickAll(notes: MemoryNotes, clock: { t: number }, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) { clock.t += MEMORY_NOTES_KNOBS.pace.spacingSeconds * 1000; notes.core.tick(); await settle(); }
  await notes.core.flush();
}
const notesFile = async (directory: string) => JSON.parse(await readFile(path.join(directory, MEMORY_NOTES_FILE), 'utf8')) as MemoryNotesFile;
async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }).catch(() => [])) if (entry.isFile()) found.push(path.join(entry.parentPath, entry.name));
  return found;
}

// ---- 1. a deleted segment's tags do not stay behind on the continuation that inherited them ----

test('1 · deleting a segment takes the tags it passed on out of its continuations; a tag the continuation says itself stays', async () => {
  await withDirectory(async directory => {
    const scope = scopeFor('sonnet');
    const store = new MemoryStore(directory); await store.load();
    const marker = '紫钴试验馆';
    // One conversation that runs on past the segment gap twice: A, then B and C carry on from it (continuations inherit tags).
    const a = await chat(store, scope, 'a', `今天打算去《${marker}》看展`, '好呀，祝你看展开心。', T0, { conversationId: 'chat-a', seal: false });
    const b = await chat(store, scope, 'b', '现在想安静地坐一会儿，喝口水休息一下', '我陪你坐一会儿。', T0 + HOUR, { conversationId: 'chat-a', seal: false });
    const c = await chat(store, scope, 'c', '晚上吃什么好呢，有点饿了', '煮碗面怎么样？', T0 + 2 * HOUR, { conversationId: 'chat-a', seal: false });
    // A second conversation where the continuation names the place itself.
    const shop = '星砂书店';
    const d = await chat(store, scope, 'd', `下午路过《${shop}》，进去看了看`, '有没有买到喜欢的书？', T0 + 3 * HOUR, { conversationId: 'chat-d', seal: false });
    const e = await chat(store, scope, 'e', `${shop}的二楼还有个小咖啡角`, '听起来很适合待一下午。', T0 + 4 * HOUR, { conversationId: 'chat-d' });
    const now = T0 + 5 * HOUR;
    assert.equal(store.read(scope, b, {}, now)?.continuationOf, a);
    assert.equal(store.read(scope, c, {}, now)?.continuationOf, b);
    assert.ok(store.read(scope, b, {}, now)!.tags.includes(marker) && store.read(scope, c, {}, now)!.tags.includes(marker), 'fixture: both continuations inherited the tag');
    assert.equal(store.list(scope, { tag: marker }, now).total, 3);

    assert.equal(await store.delete(scope, a), true);
    for (const archive of [store, await (async () => { const again = new MemoryStore(directory); await again.load(); return again; })()]) {
      const page = archive.list(scope, { tag: marker }, now);
      assert.equal(page.total, 0, 'no segment is filed under the deleted segment\'s tag any more');
      assert.ok(!page.tags.includes(marker), 'and the tag is no longer offered');
      assert.deepEqual(archive.retrieve(scope, `还记得${marker}吗`, {}, now), [], 'asking about it finds nothing');
      assert.deepEqual(archive.read(scope, b, { messageLimit: 10 }, now)!.messages.map(message => message.content), ['现在想安静地坐一会儿，喝口水休息一下', '我陪你坐一会儿。'], 'the continuation\'s originals are untouched');
      assert.ok(archive.read(scope, b, {}, now)!.tags.length > 0, 'it keeps tags of its own');
      assert.equal(archive.read(scope, b, {}, now)!.continuationOf, undefined, 'no link to the deleted segment is left');
      assert.equal(archive.read(scope, c, {}, now)!.continuationOf, b, 'the rest of the chain stays linked');
    }
    assert.ok(!(await readFile(path.join(directory, 'memories.jsonl'), 'utf8')).includes(marker), 'nothing of the deleted segment is left in the journal');

    // Control: a continuation that names the place itself keeps that tag.
    assert.equal(await store.delete(scope, d), true);
    assert.ok(store.read(scope, e, {}, now)!.tags.includes(shop));
    assert.equal(store.list(scope, { tag: shop }, now).total, 1);
    await store.flush();
  });
});

// ---- 2. forgetting all of a character's chat covers the connections she was talked to under before ----

test('2 · recycle bin and "delete the character with her memories" both cover a model she was talked to under before, across a restart', async () => {
  await withDirectory(async directory => {
    const oldScope = scopeFor('claude-sonnet-4-6'), current = scopeFor('sonnet'), other = scopeFor('claude-sonnet-4-6', 'someone-else');
    assert.ok(!forgettableProviderScopes(provider('sonnet'), memoryProviderScope).includes(oldScope.providerScope), 'fixture: the old model is not one of the usual aliases');
    const clock = { t: T0 + 10 * HOUR };
    {
      const store = new MemoryStore(directory); await store.load();
      await chat(store, oldScope, 'old', RAMEN.user, RAMEN.her, T0);
      await chat(store, current, 'new', MOVIE.user, MOVIE.her, T0 + HOUR);
      await chat(store, other, 'theirs', '另一个角色在准备期末考试，想要复习笔记', '加油！', T0 + 2 * HOUR);
      const notes = await notebook(directory, store, clock, writerFor(), () => current);
      await tickAll(notes, clock);
      assert.equal((await notesFile(directory)).notes.length, 3, 'fixture: every segment has a note');
      await notes.dispose(); await store.flush();
    }
    // Recycle bin (agent channel delete_memories), after a restart, with the current connection on "sonnet".
    const store = new MemoryStore(directory); await store.load();
    const notes = await notebook(directory, store, clock, writerFor(), () => current);
    const bin = new MemoryRecycleBin(directory, () => clock.t); await bin.load();
    const ports: RecoverableForgetPorts = { providerScopes: () => forgettableProviderScopes(provider('sonnet'), memoryProviderScope), chat: store, profiles: null, bin };
    const moved = await forgetRecoverably(CHARACTER, NAME, ['chat'], ports);
    assert.deepEqual(moved.failed, []);
    assert.equal(moved.entries.length, 2, 'one bin entry per connection she has memories under');
    assert.equal(store.list(oldScope, {}, clock.t).total, 0, 'the old model\'s chat left too');
    assert.equal(store.list(current, {}, clock.t).total, 0);
    assert.equal(store.list(other, {}, clock.t).total, 1, 'another character is untouched');
    await notes.core.flush();
    assert.equal((await notesFile(directory)).notes.length, 1, 'only the other character\'s note is left');
    const journal = await readFile(path.join(directory, 'memories.jsonl'), 'utf8');
    assert.ok(!journal.includes(RAMEN.user) && !journal.includes(MOVIE.user));
    for (const entry of moved.entries) await restoreRecoverably(entry.id, ports);
    assert.equal(store.list(oldScope, {}, clock.t).total, 1, 'and both come back from the bin');
    assert.equal(store.list(current, {}, clock.t).total, 1);

    // "删除角色" with "同时删除她的记忆": permanent, also for her profile and diary under the old model.
    const profiles = new UserProfileStore(path.join(directory, 'user-profiles'));
    try {
      await profiles.activate(oldScope); profiles.setEnabled(true);
      assert.equal(await profiles.saveDiary(profiles.diaryTicket()!, localDateKey(Date.now() - 86_400_000), '旧模型下写的一篇日记'), true);
      const forgotten = await forgetCharacterMemories(CHARACTER, { providerScopes: () => forgettableProviderScopes(provider('sonnet'), memoryProviderScope),
        memory: store, profiles, relationship: { forget: async () => {} }, rps: { forget: () => true } });
      assert.deepEqual(forgotten.failed, []);
      assert.equal(forgotten.records, 2);
      assert.equal(forgotten.profiles, 1, 'the profile under the old model went too');
      assert.equal(store.list(oldScope, {}, clock.t).total, 0);
      assert.equal(store.list(current, {}, clock.t).total, 0);
      await notes.core.flush();
      assert.equal((await notesFile(directory)).notes.filter(note => note.recordId !== store.list(other, {}, clock.t).records[0].id).length, 0);
    } finally { profiles.dispose(); }
    await notes.dispose(); await store.flush();
  });
});

test('2 · memories written before this build learn their connection when that connection is used, so a later forget finds them', async () => {
  await withDirectory(async directory => {
    const oldScope = scopeFor('claude-sonnet-4-6'), current = scopeFor('sonnet');
    {
      const store = new MemoryStore(directory); await store.load();
      await chat(store, oldScope, 'old', RAMEN.user, RAMEN.her, T0);
      await store.flush();
    }
    // An archive from before the connection list existed: nothing but memories.jsonl.
    for (const name of await readdir(directory)) if (name !== 'memories.jsonl') await rm(path.join(directory, name), { force: true });
    const service = new CompanionService(directory, () => {});
    try {
      await service.load();
      await service.context(CHARACTER, provider('claude-sonnet-4-6'), NAME); // she is opened once under the old model…
      await service.context(CHARACTER, provider('sonnet'), NAME);            // …then the user switches to sonnet
      const bin = new MemoryRecycleBin(directory); await bin.load();
      const moved = await service.forgetCurrentMemories(() => forgetRecoverably(CHARACTER, NAME, ['chat'],
        { providerScopes: () => forgettableProviderScopes(provider('sonnet'), memoryProviderScope), chat: service.memory, profiles: null, bin }));
      assert.deepEqual(moved.failed, []);
      assert.equal(service.memory.list(oldScope, {}, Date.now()).total, 0, 'the chat under the old model went into the bin');
      assert.equal(service.memory.list(current, {}, Date.now()).total, 0);
      const names = await readdir(directory);
      for (const name of names.filter(name => name.endsWith('.json'))) {
        const text = await readFile(path.join(directory, name), 'utf8');
        assert.ok(!text.includes(RAMEN.user) && !text.includes('claude-sonnet-4-6'), `${name} holds no conversation and no model name`);
      }
    } finally { await service.flush(); }
  });
});

// ---- 3. a note the user deleted on its own is not written again when its memory comes back from the bin ----

test('3 · a separately deleted note stays deleted after its memory goes to the bin and comes back, across restarts; other notes are rewritten', async () => {
  await withDirectory(async directory => {
    const scope = scopeFor('sonnet');
    const clock = { t: T0 + 10 * HOUR };
    let ramen = '', movie = '', entryId = '';
    {
      const store = new MemoryStore(directory); await store.load();
      ramen = await chat(store, scope, 'ramen', RAMEN.user, RAMEN.her, T0);
      movie = await chat(store, scope, 'movie', MOVIE.user, MOVIE.her, T0 + HOUR);
      const notes = await notebook(directory, store, clock, writerFor(), () => scope);
      await tickAll(notes, clock);
      assert.equal(notes.state(ramen).status, 'written');
      assert.equal((await notes.deleteNote(ramen)).status, 'deleted');
      assert.equal(store.retrieve(scope, '那家店去了吗', {}, clock.t).length, 0, 'fixture: without its note the segment is not recalled by that question');
      const bin = new MemoryRecycleBin(directory, () => clock.t); await bin.load();
      const moved = await forgetRecoverably(CHARACTER, NAME, ['chat'], { providerScopes: () => [scope.providerScope], chat: store, profiles: null, bin });
      assert.deepEqual(moved.failed, []);
      entryId = moved.entries[0].id;
      await notes.dispose(); await store.flush();
    }
    // Restart while the memories are in the bin, then restore them.
    {
      const store = new MemoryStore(directory); await store.load();
      const writer = writerFor({ 拉面店: fakeNoteBody({ title: '放回以后重新写的拉面笔记' }) });
      const notes = await notebook(directory, store, clock, writer, () => scope);
      await tickAll(notes, clock, 2);
      const bin = new MemoryRecycleBin(directory, () => clock.t); await bin.load();
      assert.equal((await restoreRecoverably(entryId, { providerScopes: () => [scope.providerScope], chat: store, profiles: null, bin })).count, 2);
      assert.equal(notes.state(ramen).status, 'deleted', 'right after the restore it already reads as deleted');
      assert.equal(notes.state(movie).status, 'waiting', 'a note that went with its memory is written again (as documented)');
      await tickAll(notes, clock);
      assert.equal(notes.state(ramen).status, 'deleted');
      assert.equal(notes.state(movie).status, 'written');
      assert.ok(!writer.calls.some(call => call.prompt.includes(RAMEN.user)), 'no call was made for the segment whose note the user deleted');
      assert.equal(store.retrieve(scope, '那家店去了吗', {}, clock.t).length, 0);
      await notes.dispose(); await store.flush();
    }
    {
      const store = new MemoryStore(directory); await store.load();
      const writer = writerFor();
      const notes = await notebook(directory, store, clock, writer, () => scope);
      await tickAll(notes, clock);
      assert.equal(notes.state(ramen).status, 'deleted', 'and after another restart');
      assert.equal(writer.calls.length, 0);
      // Deleting the memory itself for good clears every trace of it from the notes file.
      assert.equal(await store.delete(scope, ramen), true);
      await notes.core.flush();
      assert.ok(!JSON.stringify(await notesFile(directory)).includes(ramen));
      await notes.dispose(); await store.flush();
    }
  });
});

test('3 · the kept mark leaves no lasting trace: it goes once the bin can no longer hold its memory, and a permanent removal keeps nothing', async () => {
  assert.ok(PARKED_DAYS > RECYCLE_MAX_DAYS, 'a mark waits at least as long as the bin can keep the memory');
  const clock = { t: T0 + HOUR };
  const fake = new FakeNoteArchive()
    .add('a', 'mine', T0, [{ role: 'user', content: RAMEN.user }, { role: 'assistant', content: RAMEN.her }])
    .add('b', 'mine', T0, [{ role: 'user', content: MOVIE.user }, { role: 'assistant', content: MOVIE.her }]);
  const last: { file?: MemoryNotesFile } = {};
  const knobs = { ...MEMORY_NOTES_KNOBS, pace: { ...MEMORY_NOTES_KNOBS.pace, startDelaySeconds: 0, spacingSeconds: 0, quietSeconds: 0 } };
  const core = new MemoryNotesCore({ archive: fake, write: writerFor().write, save: async file => { last.file = structuredClone(file); },
    userBusy: () => false, modelBusy: () => false, lastActivityAt: () => null, currentScope: () => 'mine', now: () => clock.t, knobs });
  for (let i = 0; i < 4; i++) { clock.t += 1_000; core.tick(); await settle(); }
  await core.deleteNote('a', 'mine'); await core.deleteNote('b', 'mine');
  fake.remove('a'); core.removed(['a'], { recoverable: true });
  fake.remove('b'); core.removed(['b'], { recoverable: false });
  await core.flush();
  assert.deepEqual(last.file!.parked.map(item => item.recordId), ['a'], 'into the bin: kept; deleted for good: nothing kept');
  assert.deepEqual(last.file!.deleted, []);
  clock.t += RECYCLE_MAX_DAYS * 86_400_000;
  assert.equal(core.reconcile(), false, 'still kept while the bin may hold the memory');
  clock.t += (PARKED_DAYS - RECYCLE_MAX_DAYS) * 86_400_000 + 1;
  assert.equal(core.reconcile(), true);
  await core.flush();
  assert.deepEqual(last.file!.parked, [], 'gone once it cannot come back');
  core.dispose();
});

// ---- 4. a note deleted while a turn is being prepared does not ride along in that turn ----

test('4 · a note deleted while a chat turn is being prepared is not in the memories that turn hands to her', async () => {
  await withDirectory(async directory => {
    const marker = '只在笔记里出现的标题';
    const service = new CompanionService(directory, () => {});
    let notes: MemoryNotes | null = null;
    try {
      await service.load();
      await service.context(CHARACTER, provider('sonnet'), NAME);
      const scope = service.currentScope();
      const id = await chat(service.memory, scope, 'ramen', RAMEN.user, RAMEN.her, Date.now() - 2 * HOUR);
      const clock = { t: Date.now() };
      notes = await notebook(directory, service.memory, clock, writerFor({ 拉面店: fakeNoteBody({ title: marker }) }), () => service.currentScope());
      await tickAll(notes, clock);
      assert.equal(notes.state(id).status, 'written');
      // Control: a turn prepared with the note present carries its title.
      const control = await service.begin('control-turn', '那家店去了吗', NAME, () => {});
      assert.ok(control.persona.includes(marker), 'fixture: the note\'s title reaches the turn while the note exists');
      await control.finish('stopped');

      const relationship = service.relationship;
      const original = relationship.resolveNickname.bind(relationship);
      const entered = deferred<void>(), release = deferred<void>();
      relationship.resolveNickname = (async (...args: Parameters<typeof original>) => { entered.resolve(); await release.promise; return original(...args); }) as typeof original;
      const preparing = service.begin('racing-turn', '那家店去了吗', NAME, () => {});
      try {
        await entered.promise; // recall has run; the turn waits before it is put together
        assert.equal((await notes.deleteNote(id)).status, 'deleted');
      } finally { release.resolve(); relationship.resolveNickname = original; }
      const turn = await preparing;
      await turn.finish('stopped');
      assert.ok(!turn.persona.includes(marker), 'the deleted note\'s title is not handed over');
    } finally { await notes?.dispose(); await service.flush(); }
  });
});

// ---- 5. a move to the bin that failed leaves nothing in the bin that could bring the memory back ----

test('5 · a move to the bin whose archive write failed leaves no restorable copy, so a later permanent delete stays permanent', async () => {
  await withDirectory(async directory => {
    const scope = scopeFor('sonnet');
    let failNext = false;
    const store = new MemoryStore(directory, 'conversation', async (file, data) => {
      if (failNext) { failNext = false; throw eio('archive'); }
      await atomicWriteFile(file, data);
    });
    await store.load();
    const id = await chat(store, scope, 'ramen', RAMEN.user, RAMEN.her, T0);
    const bin = new MemoryRecycleBin(directory); await bin.load();
    const ports: RecoverableForgetPorts = { providerScopes: () => [scope.providerScope], chat: store, profiles: null, bin };
    failNext = true;
    const attempted = await forgetRecoverably(CHARACTER, NAME, ['chat'], ports);
    assert.deepEqual(attempted.failed, ['chat'], 'the failure is reported');
    assert.deepEqual(attempted.entries, [], 'and no entry is offered');
    assert.deepEqual(bin.summaries(), []);
    assert.ok(store.read(scope, id), 'the memory itself is still where it was');
    for (const file of await filesUnder(path.join(directory, RECYCLE_DIRECTORY)))
      assert.ok(!(await readFile(file, 'utf8')).includes(RAMEN.user), 'no copy of the conversation is left in the bin folder');
    // The user then deletes it for good: nothing can bring it back.
    assert.equal(await store.delete(scope, id), true);
    const reloaded = new MemoryRecycleBin(directory); await reloaded.load();
    assert.deepEqual(reloaded.summaries(), []);
    assert.ok(!(await readFile(path.join(directory, 'memories.jsonl'), 'utf8')).includes(RAMEN.user));
    // Retrying after the disk recovers works.
    const again = await chat(store, scope, 'movie', MOVIE.user, MOVIE.her, T0 + HOUR);
    const retried = await forgetRecoverably(CHARACTER, NAME, ['chat'], ports);
    assert.deepEqual(retried.failed, []);
    assert.equal(retried.entries.length, 1);
    assert.equal(store.read(scope, again), undefined);
    await store.flush();
  });
});

test('5 · the same for her profile; and a half-written bin entry left by a crash is cleared when the bin loads', async () => {
  await withDirectory(async directory => {
    const bin = new MemoryRecycleBin(directory); await bin.load();
    const failing: RecoverableForgetPorts['profiles'] = {
      forgetScope: async (_scope, keep) => { await keep({ entries: [{ text: '只在画像里的一句话' }], diary: [] }); throw eio('profile'); },
      restoreScope: async () => {},
    };
    const outcome = await forgetRecoverably(CHARACTER, NAME, ['profile'], { providerScopes: () => ['p'], chat: { forgetScope: async () => 0, restoreRecords: async () => 0 }, profiles: failing, bin });
    assert.deepEqual(outcome.failed, ['profile']);
    assert.deepEqual(outcome.entries, []);
    assert.deepEqual(bin.summaries(), []);
    for (const file of await filesUnder(path.join(directory, RECYCLE_DIRECTORY))) assert.ok(!(await readFile(file, 'utf8')).includes('只在画像里的一句话'));
    // A crash between writing an entry's data and its small file, or in the middle of a write, leaves files the bin never offers.
    const folder = path.join(directory, RECYCLE_DIRECTORY, CHARACTER);
    await mkdir(folder, { recursive: true });
    const orphan = randomUUID();
    await writeFile(path.join(folder, `${orphan}.data.json`), JSON.stringify({ version: 1, id: orphan, data: { secret: '崩溃时留下的半条' } }));
    await writeFile(path.join(folder, `${randomUUID()}.json.1234.abcdef12.tmp`), '崩溃时留下的半条');
    const kept = await bin.put({ characterId: CHARACTER, characterName: NAME, part: 'chat', count: 1, label: '聊天记忆 1 段' }, { kind: 'chat', providerScope: 'p', records: [] });
    const reloaded = new MemoryRecycleBin(directory); await reloaded.load();
    assert.deepEqual(reloaded.summaries().map(entry => entry.id), [kept.id], 'a complete entry is still offered');
    assert.deepEqual((await readdir(folder)).sort(), [`${kept.id}.data.json`, `${kept.id}.json`].sort(), 'the half-written files are gone');
  });
});

// ---- 6. a note delete that could not be saved changes nothing and can be retried ----

test('6 · a note delete whose save failed is reported, changes nothing, can be retried, and the retry lasts across a restart', async () => {
  await withDirectory(async directory => {
    const scope = scopeFor('sonnet');
    const clock = { t: T0 + 10 * HOUR };
    const store = new MemoryStore(directory); await store.load();
    const id = await chat(store, scope, 'ramen', RAMEN.user, RAMEN.her, T0);
    let failNext = false;
    const disk = new MemoryNotesStore(directory, { writeFile: async (file, data) => {
      if (failNext) { failNext = false; throw eio('note'); }
      await atomicWriteFile(file, data);
    } });
    const notes = await notebook(directory, store, clock, writerFor(), () => scope, disk);
    await tickAll(notes, clock);
    assert.equal(notes.state(id).status, 'written');
    failNext = true;
    await assert.rejects(notes.deleteNote(id), /synthetic note write failure/, 'the failure is reported');
    assert.equal(notes.state(id).status, 'written', 'and nothing changed: the note is still there');
    assert.equal(store.retrieve(scope, '那家店去了吗', {}, clock.t)[0]?.title, fakeNoteBody().title, 'recall still uses it, as the panel shows');
    await notes.core.flush();
    assert.ok((await notesFile(directory)).notes.some(note => note.recordId === id), 'the file still has it');
    const retried = await notes.deleteNote(id);
    assert.equal(retried.status, 'deleted', 'a retry works once the disk is back');
    await notes.dispose();
    assert.ok(!(await notesFile(directory)).notes.some(note => note.recordId === id));
    const reopened = await notebook(directory, store, clock, writerFor(), () => scope);
    assert.equal(reopened.state(id).status, 'deleted', 'and it is still deleted after a restart');
    await tickAll(reopened, clock);
    assert.equal(reopened.state(id).status, 'deleted');
    await reopened.dispose(); await store.flush();
  });
});
