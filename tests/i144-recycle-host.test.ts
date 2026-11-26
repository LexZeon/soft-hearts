// I-144 回收站 (docs/claude/2026-11-16-i144-recycle-bin.md): the host side around the round trip of tests/i144-recycle-bin.test.ts.
//  - the three single deletions (a memory note, the moving memory, a listening note) go into the bin and come back where they were;
//    「永久删除」 of the moving memory finishes the deletion in its own list;
//  - what the windows and the agent channel get is names, kinds, counts and times only;
//  - the agent channel can list and find back every kind, never delete for good; its profile part carries her plans, look-backs, note
//    and moving memory and brings them back;
//  - entries written by the earlier version (version 1) are still listed and found back.
// Made-up data in temporary folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryRecycleBin, recycleCharacterFolder } from '../electron/memory/memory-recycle-bin';
import { createRecycleHost, recycleRegistry, registerRecycleIpc, type RecycleHost } from '../electron/memory/recycle-wiring';
import { forgetRecoverably, restoreRecoverably, PROFILE_EXTRA_ROWS } from '../electron/memory/recoverable-forget';
import { createMemoryBridge } from '../electron/safety/agent-channel/memory-bridge';
import { userProfileScopeId } from '../electron/memory/user-profile';
import type { RecycleEntryKind } from '../shared/foundation/recycle-bin';
import { snapshot, withDirectory, world, type World } from './helpers/i144-world';

function hostFor(w: World): RecycleHost {
  return createRecycleHost({ bin: w.stores.bin, stores: () => w.stores, currentScope: () => w.scope(w.kept),
    characterName: id => id === w.doomed ? '阿澄' : '小桃', providerScopes: id => w.ports().providerScopes(id), cardExists: id => w.ports().cardExists(id),
    restoreMemoryPart: () => Promise.reject(new Error('not in this test')),
    change: (_kind: RecycleEntryKind | 'delete-character', _id: string, run: () => Promise<never>) => run() });
}
const CONTENT = ['科幻电影', '星砂书店', '拉面店', ' 的日记', ' 的笔记', ' 的那件事', '听到的一句歌词', '安静的钢琴', '饼干', '要不要把今天这句留下来'];
const SUMMARY_KEYS = new Set(['id', 'characterId', 'characterName', 'part', 'count', 'label', 'deletedAt', 'expiresAt', 'memories']);

test('I-144 · one memory note: into the bin, then back where it was (the notebook file byte for byte, its keywords too)', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const host = hostFor(w), notes = w.stores.notes!;
    const recordId = w.stores.memory.recordIds(w.scope(w.kept))[0]!;
    assert.equal(notes.state(recordId).status, 'written', 'fixture');
    const keywordsBefore = await w.stores.keywords!.entry(w.kept, recordId);
    const before = await readFile(path.join(directory, 'memory-notes.json'));
    assert.equal((await host.deleteMemoryNote(recordId)).status, 'deleted');
    const [entry] = w.stores.bin.summaries(w.kept).filter(item => item.part === 'memory-note');
    assert.ok(entry, 'the note waits in the bin');
    assert.match(entry.label, /^\d+月\d+日那段聊天的笔记$/, 'a date, never the note itself');
    await host.restore(entry.id);
    await w.flush();
    assert.equal(notes.state(recordId).status, 'written');
    assert.ok((await readFile(path.join(directory, 'memory-notes.json'))).equals(before), 'the notebook reads as before');
    assert.deepEqual(await w.stores.keywords!.entry(w.kept, recordId), keywordsBefore, 'its keywords are back');
    assert.equal(w.stores.bin.summaries(w.kept).some(item => item.id === entry.id), false);
  } finally { await w.dispose(); }
}));

test('I-144 · the moving memory: into the bin and back; 「永久删除」 then takes it out of her list for good', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const host = hostFor(w), store = w.stores.movingMemory!.store, scope = w.scope(w.kept);
    const file = path.join(directory, 'user-profiles', `moving-memory-${userProfileScopeId(scope)}.json`);
    const before = await readFile(file);
    const chosenAt = store.current(scope)!.chosenAt;
    await host.deleteMovingMemory(scope, chosenAt);
    assert.equal(store.current(scope), null);
    let [entry] = w.stores.bin.summaries(w.kept).filter(item => item.part === 'moving-memory');
    assert.equal(entry?.label, '最打动她的那一件（2026-11-14）');
    await host.restore(entry!.id);
    assert.equal(store.current(scope)?.text, `${w.kept} 的那件事`);
    assert.ok((await readFile(file)).equals(before), 'her list reads as before');
    // Deleted again, then deleted for good: it leaves her list (its words stay remembered as deleted, so the same quote is not picked again).
    await host.deleteMovingMemory(scope, chosenAt);
    [entry] = w.stores.bin.summaries(w.kept).filter(item => item.part === 'moving-memory');
    await host.deleteForGood(entry!.id);
    assert.equal(w.stores.bin.summaries(w.kept).some(item => item.id === entry!.id), false);
    const after = JSON.parse(await readFile(file, 'utf8')) as { versions: { text: string }[]; deleted: string[] };
    assert.deepEqual(after.versions, [], 'gone from her list');
    assert.deepEqual(after.deleted, [`${w.kept} 的那件事`]);
  } finally { await w.dispose(); }
}));

test('I-144 · one listening note: into the bin, then back at its place (the file byte for byte)', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const host = hostFor(w), file = path.join(directory, 'listen-together.json');
    const before = await readFile(file);
    await host.deleteListenNote('ln-s1');
    await w.stores.listen!.core.flush();
    assert.doesNotMatch(await readFile(file, 'utf8'), /"id":"ln-s1"/);
    const [entry] = w.stores.bin.summaries(w.kept).filter(item => item.part === 'listen-note');
    assert.ok(entry);
    await host.restore(entry.id);
    assert.ok((await readFile(file)).equals(before));
  } finally { await w.dispose(); }
}));

test('I-144 · the windows and the agent channel get names, kinds, counts and times only (never what was deleted)', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const host = hostFor(w);
    await host.deleteCharacter(w.doomed, true, async () => { await w.ports().removeCard(w.doomed); });
    await host.deleteMemoryNote(w.stores.memory.recordIds(w.scope(w.kept))[0]);
    await host.deleteListenNote('ln-s1');
    await host.deleteMovingMemory(w.scope(w.kept), w.stores.movingMemory!.store.current(w.scope(w.kept))!.chosenAt);
    const view = host.view();
    assert.deepEqual(view.entries.map(entry => entry.part).sort(), ['character', 'chat', 'listen-note', 'memory-note', 'moving-memory']);
    for (const entry of view.entries) assert.deepEqual(Object.keys(entry).filter(key => !SUMMARY_KEYS.has(key)), [], 'summary fields only');
    const shown = JSON.stringify(view);
    for (const words of CONTENT) assert.ok(!shown.includes(words), `the view does not carry "${words}"`);
    // The agent channel's list is the same summaries.
    const bridge = createMemoryBridge(w.stores.bin, { providerScopes: () => [], chat: () => w.stores.memory as never, profiles: () => null,
      change: (_c, _p, _m, _g, run) => run() });
    const listed = JSON.stringify(bridge.list());
    for (const words of CONTENT) assert.ok(!listed.includes(words));
  } finally { await w.dispose(); }
}));

test('I-144 · the agent channel finds back every kind (a character through the recycle host) and has no way to delete for good', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const host = hostFor(w);
    const { entry } = await host.deleteCharacter(w.doomed, false, async () => { await w.ports().removeCard(w.doomed); });
    const bridge = createMemoryBridge(w.stores.bin, { providerScopes: () => [], chat: () => w.stores.memory as never, profiles: () => null,
      change: (_c, _p, _m, _g, run) => run(), restoreOther: id => host.restore(id) });
    assert.deepEqual(Object.keys(bridge).sort(), ['days', 'forget', 'list', 'restore', 'setDays'], 'list, find back, the retention: nothing that deletes for good');
    assert.ok(bridge.list().some(item => item.id === entry.id && item.part === 'character'));
    const outcome = await bridge.restore(entry.id, () => {});
    assert.equal(outcome.restored.part, 'character');
    assert.ok(w.ports().cardExists(w.doomed), 'she is back');
    // The control window's IPC: exactly these four, 「永久删除」 among them (the host registers them control-window only).
    const methods: string[] = [];
    registerRecycleIpc(method => { methods.push(method); }, () => host);
    assert.deepEqual(methods.sort(), ['deleteRecycleEntryForGood', 'getRecycleBin', 'restoreRecycleEntry', 'setRecycleBinDays']);
  } finally { await w.dispose(); }
}));

test('I-144 · Claude deleting 「画像和日记」 takes her plans, look-backs, note and moving memory into the same entry and brings them back', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const scope = w.scope(w.kept), sid = userProfileScopeId(scope);
    const extras = ['upcoming', 'review', 'her-note', 'moving-memory'].map(prefix => `user-profiles/${prefix}-${sid}.json`);
    const before = await snapshot(directory);
    const registry = recycleRegistry(w.stores);
    w.stores.profiles!.closeScope(scope);
    const ports = { providerScopes: () => [scope.providerScope], chat: w.stores.memory as never, profiles: w.stores.profiles!, bin: w.stores.bin,
      profileExtras: Object.fromEntries(PROFILE_EXTRA_ROWS.map(row => [row, registry[row]])) as never };
    const forgot = await forgetRecoverably(w.kept, '小桃', ['profile'], ports);
    assert.deepEqual(forgot.entries.map(entry => entry.label), ['画像 0 条、日记 1 天，连同计划、回顾和她的笔记']);
    const gone = await snapshot(directory);
    for (const rel of [...extras, `user-profiles/profile-${sid}.json`]) assert.equal(gone.has(rel), false, `${rel} left with the profile`);
    await restoreRecoverably(forgot.entries[0]!.id, ports);
    await w.flush();
    const after = await snapshot(directory);
    for (const rel of extras) assert.ok(after.get(rel)?.equals(before.get(rel)!), `${rel} is back byte for byte`);
    await w.stores.profiles!.activate(scope);
    assert.equal(w.stores.profiles!.view().diary.length, 1, 'her diary is back');
  } finally { await w.dispose(); }
}));

test('I-144 · an entry written by the earlier version (version 1) is still listed and found back', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const id = randomUUID(), folder = path.join(directory, 'recycle-bin', recycleCharacterFolder(w.kept));
    const scope = w.scope(w.kept);
    const records = (await w.stores.memory.recycleCopy(scope))!.records.items.map(item => item.value);
    // The very format I-014 wrote (no "memories", version 1, the chat data shape of electron/memory/recoverable-forget.ts).
    await w.stores.memory.forgetScope(scope);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `${id}.data.json`), JSON.stringify({ version: 1, id, data: { kind: 'chat', providerScope: scope.providerScope, records } }));
    await writeFile(path.join(folder, `${id}.json`), JSON.stringify({ version: 1, id, characterId: w.kept, characterName: '小桃', part: 'chat', count: records.length,
      label: `聊天记忆 ${records.length} 段`, deletedAt: Date.now() }));
    const bin = new MemoryRecycleBin(directory); await bin.load();
    assert.deepEqual(bin.summaries(w.kept).filter(item => item.id === id).map(item => [item.part, item.count]), [['chat', records.length]]);
    await restoreRecoverably(id, { providerScopes: () => [scope.providerScope], chat: w.stores.memory as never, profiles: null, bin });
    assert.equal(w.stores.memory.recordIds(scope).length, records.length, 'her chat memory is back');
  } finally { await w.dispose(); }
}));
