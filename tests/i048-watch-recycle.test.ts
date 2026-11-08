/**
 * I-048: her watch notes follow her chat memory through the existing recycle bin (electron/recoverable-forget.ts). Forget: they ride in
 * the chat entry and are no longer recalled, the cached screenshots go; restore: they and their keywords are back and recalled; purge
 * (expiry): the entry's files are gone, and with them the notes; another character is untouched. Real stores in temporary folders,
 * synthetic text, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../electron/memory';
import { MemoryRecycleBin } from '../electron/memory-recycle-bin';
import { forgetRecoverably, restoreRecoverably } from '../electron/recoverable-forget';
import { WatchTogether } from '../electron/watch-notes/wiring';

const T0 = 2_000_000_000_000, DAY = 86_400_000;
const A = 'card-a', B = 'card-b', providerScope = 'claude-scope';
const note = (id: string, term: string) => ({ id, kind: 'frame' as const, at: T0, text: `画面里有一个${term}在桌上`, keywords: [{ term, kind: 'object' as const, weight: 0.9, aliases: [] }] });

async function rig(run: (r: { dir: string; clock: { t: number }; memory: MemoryStore; bin: MemoryRecycleBin; together: WatchTogether; ports: Parameters<typeof forgetRecoverably>[3] }) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-watch-recycle-test-'));
  try {
    const clock = { t: T0 };
    const memory = new MemoryStore(dir); await memory.load();
    const bin = new MemoryRecycleBin(dir, () => clock.t); await bin.load();
    const together = new WatchTogether({ directory: dir, now: () => clock.t, characterId: () => A, conditions: () => ({ watch: false, screen: false }), capture: async () => null,
      prepare: () => null, readListenNote: () => null });
    const ports = { providerScopes: () => [providerScope], chat: memory, profiles: null, bin, watch: together.recyclePort() };
    await run({ dir, clock, memory, bin, together, ports });
    await together.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function chat(memory: MemoryStore, characterId: string, id: string, text: string, at: number) {
  const scope = { characterId, providerScope };
  await memory.beginTurn(scope, { id, userText: text, at }); await memory.appendAssistant(scope, id, `嗯，${text}`, at + 1); await memory.finishTurn(scope, id, 'complete', at + 2);
}
const recalled = (together: WatchTogether, character: string, line: string) => together.keywords.block(character, [line], together.texts);

test('forget moves her watch notes into the chat entry: not recalled, files gone, screenshots gone; restore brings them and their keywords back', async () => {
  await rig(async ({ dir, memory, bin, together, ports }) => {
    await chat(memory, A, 't1', '下雨天去书店', 1_000);
    for (const [who, term] of [[A, '红伞'], [B, '蓝杯']] as const) {
      await together.notes.add(who, note(`n-${who}`, term));
      await together.screenshots.put(who, `s-${who}`, 'data:image/jpeg;base64,AAAA', T0);
      together.texts.added(who, note(`n-${who}`, term));
    }
    await together.keywords.ensure(A);
    assert.match(recalled(together, A, '那把红伞呢'), /红伞/u, 'recalled before');

    const forgot = await forgetRecoverably(A, '小桃', ['chat'], ports);
    assert.deepEqual(forgot.failed, []);
    assert.equal(forgot.entries.length, 1, 'the same bin entry as her chat memory, not a second bin');
    assert.match(forgot.entries[0].label, /聊天记忆 1 段、看剧笔记 1 条/u);
    assert.deepEqual(await together.notes.list(A), [], 'the live notes are gone');
    assert.equal((await together.keywordStore.load(A)).size, 0, 'and their keywords');
    assert.equal(recalled(together, A, '那把红伞呢'), '', 'no longer recalled');
    assert.equal(await together.screenshots.get(A, `s-${A}`), null, 'the ephemeral screenshot cache goes right away');
    // The data is in the bin entry's file, and only there.
    const files = await readdir(path.join(dir, 'recycle-bin', A));
    assert.equal(files.length, 2);
    assert.match(await readFile(path.join(dir, 'recycle-bin', A, files.find(name => name.endsWith('.data.json'))!), 'utf8'), /红伞/u);
    // Another character is untouched.
    assert.equal((await together.notes.list(B)).length, 1);
    assert.match(recalled(together, B, '那个蓝杯呢'), /蓝杯/u);
    assert.ok(await together.screenshots.get(B, `s-${B}`));

    const restored = await restoreRecoverably(forgot.entries[0].id, ports);
    assert.equal(restored.count, 1);
    assert.equal((await together.notes.list(A)).length, 1, 'the notes are back');
    assert.deepEqual((await together.notes.list(A))[0].keywords.map(k => k.term), ['红伞']);
    assert.match(recalled(together, A, '那把红伞呢'), /红伞/u, 'recalled again, through their keywords');
    assert.equal((await together.keywordStore.load(A)).size, 1, 'and in the index file');
    assert.deepEqual(bin.summaries(), [], 'the entry left the bin');
  });
});

test('purge: when the entry expires its files, and the watch notes inside them, are deleted for good', async () => {
  await rig(async ({ dir, clock, bin, memory, together, ports }) => {
    await chat(memory, A, 't1', '下雨天去书店', 1_000);
    await together.notes.add(A, note('n-a', '红伞'));
    together.texts.added(A, note('n-a', '红伞'));
    const forgot = await forgetRecoverably(A, '小桃', ['chat'], ports);
    assert.equal((await readdir(path.join(dir, 'recycle-bin', A))).length, 2);
    clock.t += (bin.retentionDays + 1) * DAY;
    assert.equal(await bin.purge(), 1);
    assert.deepEqual(await readdir(path.join(dir, 'recycle-bin', A)), [], 'no copy left');
    await assert.rejects(restoreRecoverably(forgot.entries[0].id, ports), /没有这一项/);
    assert.deepEqual(await together.notes.list(A), []);
    assert.equal(recalled(together, A, '那把红伞呢'), '');
  });
});

test('watch notes with no chat memory get an entry of their own and come back the same way; a failed move keeps them', async () => {
  await rig(async ({ together, bin, ports }) => {
    await together.notes.add(A, note('n-a', '红伞'));
    together.texts.added(A, note('n-a', '红伞'));
    const forgot = await forgetRecoverably(A, '小桃', ['chat'], ports);
    assert.deepEqual(forgot.failed, []);
    assert.equal(forgot.entries.length, 1);
    assert.deepEqual(await together.notes.list(A), []);
    await restoreRecoverably(forgot.entries[0].id, ports);
    assert.equal((await together.notes.list(A)).length, 1);
    assert.deepEqual(bin.summaries(), []);
  });
  await rig(async ({ together, memory, ports }) => {
    await chat(memory, A, 't1', '下雨天去书店', 1_000);
    await together.notes.add(A, note('n-a', '红伞'));
    const broken = { ...ports, bin: { put: async () => { throw new Error('disk full'); }, discard: async () => {} } as unknown as MemoryRecycleBin };
    const forgot = await forgetRecoverably(A, '小桃', ['chat'], broken);
    assert.deepEqual(forgot.failed, ['chat']);
    assert.equal((await together.notes.list(A)).length, 1, 'a bin that cannot write keeps her watch notes too');
  });
});
