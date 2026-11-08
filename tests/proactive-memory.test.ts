import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../electron/memory';
import type { MemoryInitiative, MemoryScope } from '../shared/memory';

const now = 1_800_000_000_000;
const scope: MemoryScope = { characterId: 'gene', providerScope: 'provider-a' };
const other: MemoryScope = { characterId: 'gene', providerScope: 'provider-b' };

function initiative(id = 'host-cue-1', text = '屏幕里像是电影《小森林》，你想聊聊这个片段吗？', at = now): MemoryInitiative {
  return { id, text, at, origin: { kind: 'proactive', id, at, sources: ['screen'], labels: ['已开启的屏幕共享'] } };
}

async function fixture(run: (store: MemoryStore, directory: string) => Promise<void>) {
  const parent = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'soft-hearts-proactive-memory-'));
  try { const store = new MemoryStore(directory); await store.load(); await run(store, directory); await store.flush(); }
  finally {
    const relative = path.relative(parent, path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('soft-hearts-proactive-memory-')) throw new Error('Unexpected test cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
}

test('completed initiative archives exactly one sealed assistant original with host source and timestamp', async () => {
  await fixture(async (store, directory) => {
    const input = initiative();
    const handle = await store.appendInitiative(scope, input);
    const page = store.read(scope, handle.recordId, {}, now)!;
    assert.equal(page.sealed, true);
    assert.equal(page.messageCount, 1);
    assert.equal(page.turnCount, 0);
    assert.equal(page.messages[0].role, 'assistant');
    assert.equal(page.messages[0].status, 'complete');
    assert.equal(page.messages[0].content, input.text);
    assert.equal(page.messages[0].createdAt, input.at);
    assert.deepEqual(page.origin, input.origin);
    assert.equal(page.weight, 0);
    assert.equal(store.list(scope, { query: '小森林' }, now).total, 1);
    const restored = new MemoryStore(directory); await restored.load();
    assert.deepEqual(restored.read(scope, handle.recordId, {}, now), page);
    const journal = await readFile(path.join(directory, 'memories.jsonl'), 'utf8');
    assert.equal(journal.includes('"type":"recall"'), false);
    assert.equal(journal.includes('"type":"mention"'), false);
    assert.equal(journal.includes('"role":"user"'), false);
    assert.equal(journal.includes('data:image'), false);
    assert.equal(journal.includes(scope.providerScope), false);
  });
});

test('initiative does not seal, move or fabricate turns in the ordinary active conversation', async () => {
  await fixture(async store => {
    const first = await store.beginTurn(scope, { id: 'user-turn-1', userText: '我们聊电影', at: now - 50 });
    await store.appendAssistant(scope, first.turnId, '好呀。', now - 40);
    await store.finishTurn(scope, first.turnId, 'complete', now - 30);
    const activeBefore = store.read(scope, first.recordId, {}, now)!;
    const separate = await store.appendInitiative(scope, initiative());
    assert.notEqual(separate.recordId, first.recordId);
    assert.deepEqual(store.read(scope, first.recordId, {}, now), activeBefore);
    const next = await store.beginTurn(scope, { id: 'user-turn-2', userText: '接着聊电影', at: now + 20 });
    assert.equal(next.recordId, first.recordId);
    assert.equal(store.read(scope, separate.recordId, {}, now + 20)?.messages.length, 1);
  });
});

test('repeated identical initiative is idempotent, conflicting identity or a user turn collision is refused', async () => {
  await fixture(async store => {
    const input = initiative();
    const first = await store.appendInitiative(scope, input);
    assert.deepEqual(await store.appendInitiative(scope, structuredClone(input)), first);
    await assert.rejects(store.appendInitiative(scope, { ...input, text: '同 ID 的不同正文' }));
    const user = await store.beginTurn(scope, { id: 'user-id', userText: '真实用户文字', at: now + 1 });
    await store.finishTurn(scope, user.turnId, 'complete', now + 2);
    await assert.rejects(store.appendInitiative(scope, initiative('user-id')));
    assert.equal(store.list(scope, {}, now + 2).total, 2);
  });
});

test('source metadata and text are snapshotted before the queued journal write', async () => {
  await fixture(async store => {
    const input = initiative();
    const expected = structuredClone(input);
    const pending = store.appendInitiative(scope, input);
    input.text = 'MUTATED'; input.origin.labels[0] = 'MUTATED'; input.origin.sources[0] = 'camera';
    const handle = await pending;
    assert.deepEqual(store.read(scope, handle.recordId, {}, now)?.origin, expected.origin);
    assert.equal(store.read(scope, handle.recordId, {}, now)?.messages[0].content, expected.text);
    const page = store.read(scope, handle.recordId, {}, now)!;
    page.origin!.labels[0] = 'UI MUTATION';
    assert.deepEqual(store.read(scope, handle.recordId, {}, now)?.origin, expected.origin);
  });
});

test('initiative reads, retrieval, editing and physical deletion stay character/provider isolated', async () => {
  await fixture(async (store, directory) => {
    const handle = await store.appendInitiative(scope, initiative());
    assert.equal(store.list(other, {}, now).total, 0);
    assert.equal(store.read(other, handle.recordId, {}, now), undefined);
    assert.deepEqual(store.retrieve(other, '电影《小森林》', {}, now), []);
    await assert.rejects(store.edit(other, handle.recordId, { title: 'wrong scope' }));
    assert.equal(await store.delete(other, handle.recordId), false);
    assert.equal(await store.delete(scope, handle.recordId), true);
    assert.equal(store.list(scope, {}, now).total, 0);
    assert.deepEqual(store.retrieve(scope, '电影《小森林》', {}, now), []);
    assert.equal((await readFile(path.join(directory, 'memories.jsonl'), 'utf8')).includes('小森林'), false);
    const restored = new MemoryStore(directory); await restored.load();
    await assert.rejects(restored.appendInitiative(scope, initiative()));
    assert.equal(restored.list(scope, {}, now).total, 0);
  });
});

test('autonomous observations remain browseable but are never automatically recalled or promoted into facts', async () => {
  await fixture(async store => {
    const handle = await store.appendInitiative(scope, initiative());
    const recalled = store.retrieve(scope, '电影《小森林》', {}, now);
    assert.deepEqual(recalled, []);
    assert.deepEqual(store.detectExplicitRecall(scope, '还记得上次我们聊的电影《小森林》吗'), []);
    assert.deepEqual(await store.noteUserRecall(scope, '还记得上次我们聊的电影《小森林》吗', {
      eventId: 'real-user-follow-up', at: now + 1, confirmedRecordId: handle.recordId,
    }), []);
    assert.equal(await store.reinforce(scope, handle.recordId, { eventId: 'direct', episodeId: 'episode', at: now + 1 }), 0);
    assert.equal(store.read(scope, handle.recordId, {}, now + 1)?.weight, 0);
    assert.equal(store.list(scope, { query: '小森林' }, now).total, 1);
    assert.deepEqual(store.read(scope, handle.recordId, {}, now)?.origin, initiative().origin);
    assert.deepEqual(store.retrieve(scope, '小森林', { maxChars: 10 }, now), []);
  });
});

test('host initiative lookup supports linked deletion while ordinary IDs and other scopes stay inaccessible', async () => {
  await fixture(async (store, directory) => {
    const input = initiative();
    const handle = await store.appendInitiative(scope, input);
    assert.deepEqual(store.findInitiative(scope, input.id), handle);
    assert.equal(store.findInitiative(other, input.id), null);
    assert.equal(store.findInitiative(scope, 'missing'), null);
    const ordinary = await store.beginTurn(scope, { id: 'ordinary-id', userText: '真实用户文字', at: now + 1 });
    assert.equal(store.findInitiative(scope, ordinary.turnId), null);
    const restored = new MemoryStore(directory); await restored.load();
    assert.deepEqual(restored.findInitiative(scope, input.id), handle);
    assert.equal(await restored.delete(scope, handle.recordId), true);
    assert.equal(restored.findInitiative(scope, input.id), null);
    await assert.rejects(restored.appendInitiative(scope, input));
  });
});

test('malformed, oversized, mismatched or media/path-bearing initiative metadata never reaches disk', async () => {
  await fixture(async (store, directory) => {
    const initial = await readFile(path.join(directory, 'memories.jsonl'), 'utf8');
    const base = initiative();
    const invalid: unknown[] = [
      null, { ...base, text: '' }, { ...base, text: 'a'.repeat(2001) },
      { ...base, text: 'a\0b' }, { ...base, image: 'data:image/jpeg;base64,AA==' },
      { ...base, at: NaN }, { ...base, origin: { ...base.origin, id: 'another' } },
      { ...base, origin: { ...base.origin, at: now + 1 } },
      { ...base, origin: { ...base.origin, kind: 'user' } },
      { ...base, origin: { ...base.origin, sources: [] } },
      { ...base, origin: { ...base.origin, sources: ['screen', 'screen'], labels: ['screen', 'screen'] } },
      { ...base, origin: { ...base.origin, sources: ['microphone'] } },
      { ...base, origin: { ...base.origin, labels: ['https://example.test/frame'] } },
      { ...base, origin: { ...base.origin, labels: ['C:\\private\\frame.png'] } },
      { ...base, origin: { ...base.origin, labels: ['/tmp/frame.png'] } },
      { ...base, origin: { ...base.origin, labels: ['data:image/jpeg;base64,AA=='] } },
      { ...base, origin: { ...base.origin, labels: ['x'.repeat(81)] } },
      { ...base, origin: { ...base.origin, labels: ['screen\nextra'] } },
      { ...base, origin: { ...base.origin, labels: [] } },
      { ...base, origin: { ...base.origin, scope: 'private-provider' } },
    ];
    for (const input of invalid) assert.throws(() => store.appendInitiative(scope, input as MemoryInitiative));
    assert.equal(store.list(scope, {}, now).total, 0);
    assert.equal(await readFile(path.join(directory, 'memories.jsonl'), 'utf8'), initial);
  });
});

test('origin supports actual dual visual sources and ambient text without carrying frames or audio', async () => {
  await fixture(async store => {
    const dual = initiative('dual');
    dual.origin.sources = ['screen', 'camera']; dual.origin.labels = ['屏幕共享', '摄像头共享'];
    const handle = await store.appendInitiative(scope, dual);
    assert.deepEqual(store.read(scope, handle.recordId, {}, now)?.origin?.sources, ['screen', 'camera']);
    const ambient = initiative('ambient', '刚才系统声音的对白有点像在讨论电影。', now + 1);
    ambient.origin.sources = ['ambient']; ambient.origin.labels = ['已开启的系统声音转写'];
    const second = await store.appendInitiative(scope, ambient);
    assert.deepEqual(store.read(scope, second.recordId, {}, now + 1)?.origin, ambient.origin);
  });
});

test('legacy ordinary records retain their old shape across a journal reload alongside initiatives', async () => {
  await fixture(async (store, directory) => {
    const ordinary = await store.beginTurn(scope, { id: 'ordinary', userText: '你好', at: now - 2 });
    await store.appendAssistant(scope, ordinary.turnId, '你好呀', now - 1);
    await store.finishTurn(scope, ordinary.turnId, 'complete', now);
    const before = store.read(scope, ordinary.recordId, {}, now)!;
    assert.equal(Object.hasOwn(before, 'origin'), false);
    await store.appendInitiative(scope, initiative());
    const restored = new MemoryStore(directory); await restored.load();
    assert.deepEqual(restored.read(scope, ordinary.recordId, {}, now), before);
  });
});

test('a persisted initiative with invalid origin or a fabricated user original is rejected without overwriting source', async () => {
  await fixture(async (store, directory) => {
    await store.appendInitiative(scope, initiative());
    const file = path.join(directory, 'memories.jsonl');
    const original = await readFile(file, 'utf8');
    const rows = original.trimEnd().split('\n').map(line => JSON.parse(line));
    rows[1].record.messages[0].role = 'user';
    const corrupted = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(file, corrupted, 'utf8');
    await assert.rejects(new MemoryStore(directory).load());
    assert.equal(await readFile(file, 'utf8'), corrupted);
  });
});
