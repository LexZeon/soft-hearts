// I-144 回收站：完整复原. Two characters with something
// in every store the bin keeps (electron/foundation/data-map.ts recycle: 'take'), real stores in a temporary folder. Deleting one with
// "同时删除她的记忆" ticked takes all of hers into one entry and leaves the other untouched; finding her back makes every file of every
// kept row read exactly as before (byte for byte, pictures too). The two chat journals are rewritten whole by their own compaction, and
// the card files carry a revision counter, so those four are compared by content (and the journals byte for byte across two rounds).
// Mutation in the suite itself: a registry whose restore of any one row does nothing must fail the comparison.
// Every conversation here is made up; no profile directory is read, no real Claude is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recycleIds } from '../electron/foundation/data-map';
import { characterKey } from '../electron/memory/memory-keywords/store';
import { recycleRegistry } from '../electron/memory/recycle-wiring';
import { recycleCharacter, restoreCharacterEntry, restoreOrder, CARD_ROWS } from '../electron/memory/recycle/character';
import type { RecycleRegistry } from '../electron/memory/recycle/ports';
import { differences, roundTrip, rowOf, snapshot, withDirectory, world } from './helpers/i144-world';

test('I-144 · every row the bin keeps has something of hers in the fixture (so the round trip below covers all of them)', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const registry = recycleRegistry(w.stores);
    const ports = w.ports(registry);
    const missing: string[] = [];
    for (const id of recycleIds()) {
      const port = registry[id];
      if (!port) { missing.push(`${id} (no port)`); continue; }
      const value = port.per === 'character' ? await port.capture(w.doomed)
        : (await Promise.all(ports.providerScopes(w.doomed).map(providerScope => port.capture({ characterId: w.doomed, providerScope })))).find(item => item != null);
      if (value === null || value === undefined) missing.push(id);
    }
    // Recall by meaning is not running in a test (no model): its files are copied as they are.
    assert.deepEqual(missing, []);
  } finally { await w.dispose(); }
}));

test('I-144 · delete her with her memories → one entry, nothing of hers left, the other untouched → find her back: every kept file reads as before', async () => withDirectory(async directory => {
  const { world: w, before, afterDelete, after, journalsBefore, journalsAfter, failed, binAfterDelete } = await roundTrip(directory);
  try {
    assert.deepEqual(failed, []);
    // After the deletion: no file of the kept rows mentions her outside her bin folder, and one entry holds everything.
    const leftovers = [...afterDelete].filter(([rel, bytes]) => rowOf(rel) && !rel.startsWith(`recycle-bin/${w.doomed}`) && (rel.includes(w.doomed) || rel.includes(characterKey(w.doomed))
      || bytes.toString('utf8').includes(w.doomed) || bytes.toString('utf8').includes('科幻电影') || bytes.toString('utf8').includes('星砂书店'))).map(([rel]) => rel);
    assert.deepEqual(leftovers, [], 'nothing of hers is left in place');
    assert.deepEqual(binAfterDelete, [['character', '角色卡和她的全部记忆', true]],
      'her earlier entry rode into the one for the character');
    // The other character's files did not change at all (her own files, and the shared ones only lost her part).
    const keptFiles = [...before.keys()].filter(rel => rowOf(rel) && (rel.includes(w.kept) || rel.includes(characterKey(w.kept))));
    assert.ok(keptFiles.length >= 10, `fixture: ${keptFiles.length} files of the other character`);
    for (const rel of keptFiles) assert.ok(afterDelete.get(rel)?.equals(before.get(rel)!), `${rel} of the other character is untouched`);
    // Found back: every file of every kept row reads as before.
    assert.deepEqual(differences(before, after), []);
    assert.deepEqual(journalsAfter, journalsBefore, 'both chat journals hold the same records at the same places, open conversation and recall episode too');
    assert.deepEqual(w.stores.bin.summaries(w.doomed).map(entry => entry.part), ['chat'], 'her earlier entry is back in the bin, under its own id');
    assert.equal(w.stores.cards!.publicState().activeId, w.kept, 'finding her back does not make her the current character');
    // A second round leaves the journals byte for byte as the first one did (each compaction writes the same lines).
    const first = await snapshot(directory);
    const entry = (await recycleCharacter(w.doomed, w.doomedName, true, w.ports())).entry;
    await w.flush();
    assert.deepEqual((await restoreCharacterEntry(entry.id, w.ports())).failed, []);
    await w.flush();
    const second = await snapshot(directory);
    for (const rel of ['memories.jsonl', 'text-invitations.jsonl']) assert.ok(second.get(rel)?.equals(first.get(rel)!), `${rel} byte for byte across two rounds`);
    assert.deepEqual(differences(first, second), []);
  } finally { await w.dispose(); }
}));

test('I-144 · mutation: a restore that does nothing for any one row is caught by the comparison', async () => {
  const caught: string[] = [], missed: string[] = [];
  for (const id of recycleIds()) {
    await withDirectory(async directory => {
      const { world: w, before, after, journalsBefore, journalsAfter } = await roundTrip(directory, id);
      try {
        let journalsDiffer = false;
        try { assert.deepEqual(journalsAfter, journalsBefore); } catch { journalsDiffer = true; }
        const cardMissing = CARD_ROWS.includes(id) && !w.stores.cards!.publicState().cards.some(card => card.id === w.doomed);
        (differences(before, after).length || journalsDiffer || cardMissing ? caught : missed).push(id);
      } finally { await w.dispose(); }
    });
  }
  assert.deepEqual(missed, [], 'each of these rows could lose its restore without any test noticing');
  assert.equal(caught.length, recycleIds().length);
});

test('I-144 · unticked: only the card, its reaction settings and its picture go in; her memories stay where they are', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const before = await snapshot(directory);
    const { entry } = await recycleCharacter(w.doomed, w.doomedName, false, w.ports());
    await w.flush();
    assert.equal(entry.label, '角色卡和模型关联');
    const after = await snapshot(directory);
    const changed = differences(before, after).filter(rel => !rel.startsWith('recycle-bin/'));
    assert.deepEqual(changed, [`character-avatars/${w.doomed}.png missing after`, 'character-response-settings.json', 'characters.json']);
    const back = await restoreCharacterEntry(entry.id, w.ports());
    await w.flush();
    assert.deepEqual(back.failed, []);
    assert.deepEqual(differences(before, await snapshot(directory)), []);
  } finally { await w.dispose(); }
}));

test('I-144 · nothing is removed when a part cannot be captured, or the card cannot go (the last card)', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const before = await snapshot(directory);
    const registry = recycleRegistry(w.stores);
    const broken = { ...registry, hands: { ...registry.hands!, capture: async () => { throw new Error('disk'); } } } as RecycleRegistry;
    await assert.rejects(recycleCharacter(w.doomed, w.doomedName, true, w.ports(broken)), /牵手、拉钩的小账.*什么都没删/);
    await assert.rejects(recycleCharacter(w.doomed, w.doomedName, true, { ...w.ports(), removeCard: async () => { throw new Error('至少保留一张角色卡。'); } }), /至少保留一张角色卡/);
    await w.flush();
    assert.deepEqual(differences(before, await snapshot(directory)), [], 'every file as it was');
    assert.deepEqual(w.stores.bin.summaries(w.doomed).map(entry => entry.part), ['chat'], 'no entry was left behind');
  } finally { await w.dispose(); }
}));

test('I-144 · restore order: the card first, the index of her connections next, what is worked out from the rest last', () => {
  const order = restoreOrder();
  assert.deepEqual(order.slice(0, 4), ['character-cards', 'character-response', 'character-avatars', 'memory-scopes']);
  assert.deepEqual(order.slice(-3), ['memory-keywords', 'memory-vectors', 'recycle-bin']);
  assert.ok(order.indexOf('chat-memory') < order.indexOf('memory-notes') && order.indexOf('user-profile') < order.indexOf('upcoming-plans'));
  assert.equal(new Set(order).size, recycleIds().length);
});
