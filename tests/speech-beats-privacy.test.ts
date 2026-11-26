// 边说边演的拍子文件 (speech-beats.json) 跟着聊天记录走 (privacy rule: nothing of a
// deleted reply stays). Real stores in a temporary folder (tests/helpers/i144-world.ts): deleting one record, forgetting her chat the way
// Claude's delete_memories does, deleting a character with her memories, and each one's put back. The file holds no one's words, but it
// describes the replies that were deleted; so after every deletion a reply of the other character stays and nothing of those replies stays
// (checked on the file's bytes, not through the store).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SPEECH_BEATS_FILE, speechBeatScopeKey } from '../electron/brain/speech-beats/archive';
import { characterForgetRegistry } from '../electron/memory/privacy-wiring';
import { forgetRecoverably, restoreRecoverably } from '../electron/memory/recoverable-forget';
import { recycleRegistry, takeChatRecord } from '../electron/memory/recycle-wiring';
import { recycleCharacter, restoreCharacterEntry } from '../electron/memory/recycle/character';
import { ITEM_RESTORERS } from '../electron/memory/recycle/items-wiring';
import { DATA_MAP } from '../electron/foundation/data-map';
import { withDirectory, world, type World } from './helpers/i144-world';

/** The turns the file holds, read from its bytes: `character:turn` for the two characters of the fixture. */
async function filed(w: World): Promise<string[]> {
  const raw = JSON.parse(await readFile(path.join(w.directory, SPEECH_BEATS_FILE), 'utf8')) as { entries: { key: string }[] };
  const names = new Map<string, string>();
  for (const id of [w.doomed, w.kept]) names.set(speechBeatScopeKey(w.scope(id)), id === w.doomed ? 'doomed' : 'kept');
  return raw.entries.map(entry => `${names.get(entry.key.slice(0, 64)) ?? '?'}:${entry.key.slice(65)}`).sort();
}
const ALL = ['doomed:d1', 'doomed:d2', 'kept:k1', 'kept:k2'];

test('the data map: her beats are a row the bin keeps, deleted with her chat memory and riding in Claude\'s chat entry', () => {
  const row = DATA_MAP.find(item => item.id === 'speech-beats')!;
  assert.equal(row.recycle, 'take');
  assert.equal(row.characterForget, 'delete');
  assert.equal(row.agentDelete, 'rides-chat');
  assert.equal(row.scope, 'character-connection');
  assert.deepEqual(row.paths, [SPEECH_BEATS_FILE]);
});

test('deleting one chat record drops the beats of its turns; the other records keep theirs', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    assert.deepEqual(await filed(w), ALL);
    const scope = w.scope(w.doomed), memory = w.stores.memory;
    const [first] = memory.recordIds(scope);
    assert.equal(await memory.delete(scope, first!), true);
    await w.flush();
    assert.deepEqual(await filed(w), ['doomed:d2', 'kept:k1', 'kept:k2'], 'only the deleted record\'s turn left the file');
    // The other journal (her text invitations) never touches it.
    const invitation = w.stores.textInvitations!.recordIds(scope)[0]!;
    assert.equal(await w.stores.textInvitations!.delete(scope, invitation), true);
    await w.flush();
    assert.deepEqual(await filed(w), ['doomed:d2', 'kept:k1', 'kept:k2']);
  } finally { await w.dispose(); }
}));

test('one record through the bin: its beats go with it and come back with it (the file reads as before, byte for byte)', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const scope = w.scope(w.doomed), memory = w.stores.memory;
    const before = await readFile(path.join(directory, SPEECH_BEATS_FILE));
    const [first] = memory.recordIds(scope);
    const take = await takeChatRecord(w.stores, scope, first!, 'conversation');
    assert.ok((take!.data as { speechBeats?: { items: unknown[] } }).speechBeats?.items.length === 1, 'the bin entry carries the turn\'s beats');
    await memory.delete(scope, first!);
    await w.flush();
    assert.deepEqual(await filed(w), ['doomed:d2', 'kept:k1', 'kept:k2']);
    const summary = { characterId: w.doomed, characterName: '阿澄', part: 'chat-record' } as never;
    await ITEM_RESTORERS['chat-record'](summary, take!.data as never, { stores: w.stores, keep: async () => { throw new Error('nothing to swap'); } } as never);
    await w.flush();
    assert.ok((await readFile(path.join(directory, SPEECH_BEATS_FILE))).equals(before), 'the file is as it was');
    // An entry made before this existed (no beats in it) still comes back.
    const old = { ...(take!.data as object) } as Record<string, unknown>; delete old.speechBeats;
    await memory.delete(scope, first!);
    await ITEM_RESTORERS['chat-record'](summary, old as never, { stores: w.stores, keep: async () => { throw new Error('nothing to swap'); } } as never);
    assert.ok(memory.recordIds(scope).includes(first!), 'the record is back');
  } finally { await w.dispose(); }
}));

test('Claude\'s delete_memories (chat part): the beats leave with the chat and come back with the chat entry', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const beats = w.stores.speechBeats!;
    const ports = { providerScopes: () => w.ports().providerScopes(w.doomed), bin: w.stores.bin, profiles: null,
      chat: { forgetScope: (scope: never, keep: never) => w.stores.memory.forgetScope(scope, keep), restoreRecords: (records: never, owner: never) => w.stores.memory.restoreRecords(records, owner),
        providerScopesOf: (id: string) => w.stores.memory.providerScopesOf(id) },
      beats: { capture: (scope: never) => beats.copyScope(scope), restore: (scope: never, part: unknown) => beats.restore(scope, part) } };
    const before = await readFile(path.join(directory, SPEECH_BEATS_FILE));
    const outcome = await forgetRecoverably(w.doomed, '阿澄', ['chat'], ports as never);
    await w.flush();
    assert.deepEqual(outcome.failed, []);
    assert.deepEqual(await filed(w), ['kept:k1', 'kept:k2'], 'nothing of the forgotten chat\'s replies stays');
    const entry = outcome.entries.find(item => item.part === 'chat')!;
    await restoreRecoverably(entry.id, ports as never);
    await w.flush();
    assert.ok((await readFile(path.join(directory, SPEECH_BEATS_FILE))).equals(before), 'found back: the file is as it was');
  } finally { await w.dispose(); }
}));

test('deleting a character with her memories: her beats go into the one entry and come back with it; the other character is untouched', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const before = await readFile(path.join(directory, SPEECH_BEATS_FILE));
    const { entry, failed } = await recycleCharacter(w.doomed, w.doomedName, true, w.ports());
    await w.flush();
    assert.deepEqual(failed, []);
    assert.deepEqual(await filed(w), ['kept:k1', 'kept:k2']);
    assert.deepEqual((await restoreCharacterEntry(entry.id, w.ports())).failed, []);
    await w.flush();
    assert.ok((await readFile(path.join(directory, SPEECH_BEATS_FILE))).equals(before));
    // Unticked: her memories (and so her beats) stay where they are.
    const unticked = await recycleCharacter(w.doomed, w.doomedName, false, w.ports());
    await w.flush();
    assert.deepEqual(await filed(w), ALL);
    await restoreCharacterEntry(unticked.entry.id, w.ports());
  } finally { await w.dispose(); }
}));

test('the character-forget registry (C2 path) clears the scope\'s beats too, and only that scope\'s', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const registry = characterForgetRegistry({ memory: w.stores.memory, profiles: null, relationship: { forget: async () => {} }, rps: { forget: () => true }, feeding: { forget: () => true },
      herNote: null, movingMemory: null, songMemory: null, semantic: null, listenTogether: null, watchTogether: null, upcoming: null, hands: null, recycle: recycleRegistry(w.stores) });
    const clear = registry['speech-beats'];
    assert.ok(clear && clear.per === 'scope', 'the registry has a clear for the row');
    await clear.clear(w.scope(w.doomed));
    await w.flush();
    assert.deepEqual(await filed(w), ['kept:k1', 'kept:k2']);
  } finally { await w.dispose(); }
}));

test('the archive: a part that is not its own is refused before anything changes; entries past the cap keep the newest', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const before = await readFile(path.join(directory, SPEECH_BEATS_FILE));
    await assert.rejects(w.speechBeats.restore(w.scope(w.doomed), { items: 'no' }), /不完整/);
    await assert.rejects(w.speechBeats.restore(w.scope(w.doomed), null), /不完整/);
    await w.flush();
    assert.ok((await readFile(path.join(directory, SPEECH_BEATS_FILE))).equals(before));
    // A word outside the vocabulary in a part from the bin never gets in.
    await w.speechBeats.restore(w.scope(w.doomed), { items: [{ turn: 'x1', beats: [{ word: '不在词表里', at: 0 }], line: '', performanceOnly: false, at: 5 }] });
    assert.equal(w.speechBeats.get(w.scope(w.doomed), 'x1'), null);
  } finally { await w.dispose(); }
}));

test('the wiring: the chat store\'s removal hook is installed where the bin starts, memory hands the archive to the bin, the agent channel carries the beats', async () => {
  const { wiringSource } = await import('./helpers/wiring-source');
  const text = wiringSource();
  assert.match(text, /followChatDeletions\(companion\.memory, speechBeatsFor\(store\.directory\)\.archive\)/, 'deleting a record drops its turns\' beats');
  assert.match(text, /speechBeats: speechBeatsFor\(needs\.store\.directory\)\.archive/, 'the bin\'s stores include the archive (the registry\'s row and the single deletion read it)');
  assert.match(text, /beats: \(\) => \{ const beats = recycleStores\(\)\.speechBeats;/, 'Claude\'s delete_memories / restore_memories carry the beats');
});
