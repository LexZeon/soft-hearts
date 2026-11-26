/**
 * I-089 item 2 「记忆会更新，而且记得对」 (docs/claude/2026-11-12-i089-item-2.md). Synthetic chats and notes only (a temporary folder each, no real
 * profile, no model call). What it pins: a change the user stated ("我搬家了") is carried by the note of that talk (`changes`, optional, lenient);
 * recall then marks the OLDER memory it speaks about with what was said later and puts it behind; an unrelated old memory, an earlier "change"
 * and a note the user deleted never mark anything; a memory with no change anywhere recalls exactly as before; old note files and old model
 * answers (no `changes`) load; the old note and original stay as they were (nothing is rewritten).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../electron/memory/memory';
import { MemoryNotesCore } from '../electron/memory/memory-notes/core';
import { validateMemoryNotesFile } from '../electron/memory/memory-notes/store';
import type { MemoryScope } from '../shared/memory/memory';
import type { MemoryNoteBody } from '../shared/memory/memory-notes/interface';
import { MEMORY_NOTES_KNOBS, type MemoryNotesKnobs } from '../shared/memory/memory-notes/knobs';
import { MEMORY_NOTE_SYSTEM_PROMPT, parseMemoryNote } from '../shared/memory/memory-notes/note';
import { changeSpeaksAbout, updateMarker, updatesFor } from '../shared/memory/memory-notes/supersede';
import { FakeNoteWriter, fakeNoteBody } from '../shared/memory/memory-notes/fake';

const HOUR = 3_600_000, DAY = 24 * HOUR, T0 = 1_800_000_000_000;
const scope: MemoryScope = { characterId: 'test-girl', providerScope: 'claude:test-model' };
const FAST: MemoryNotesKnobs = { ...MEMORY_NOTES_KNOBS, pace: { ...MEMORY_NOTES_KNOBS.pace, startDelaySeconds: 0, spacingSeconds: 0, quietSeconds: 0 } };
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

const OLD_HOME: MemoryNoteBody = { title: '用户住在北京', summary: '用户说自己住在北京朝阳区，在那边上班。', people: [], things: ['北京', '朝阳区'], mood: '', plans: [], tags: ['住处', '北京', '朝阳区'] };
const DENTIST: MemoryNoteBody = { title: '周三约了牙医', summary: '用户约了周三下午去看牙医。', people: [], things: ['牙医'], mood: '', plans: [], tags: ['牙医', '看牙', '约诊'] };
const NEW_HOME: MemoryNoteBody = { title: '用户搬到了上海', summary: '用户说搬家了，现在住在上海浦东。', people: [], things: ['上海', '浦东'], mood: '兴奋', plans: [], tags: ['住处', '上海', '搬家'],
  changes: [{ was: '住在北京', now: '搬到了上海浦东' }] };

async function withStore(run: (store: MemoryStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-supersede-test-'));
  try { const store = new MemoryStore(directory); await store.load(); await run(store, directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function chat(store: MemoryStore, id: string, user: string, at: number): Promise<string> {
  const handle = await store.beginTurn(scope, { id, userText: user, at, conversationId: `c-${id}` });
  await store.appendAssistant(scope, id, '嗯嗯，我记下啦', at + 1_000);
  await store.finishTurn(scope, id, 'complete', at + 2_000);
  return handle.recordId;
}
/** Writes the given notes for the chats (by a word in the chat) through the real notebook, then hands it to the store as the recall hints. */
async function notebook(store: MemoryStore, notes: Record<string, MemoryNoteBody>): Promise<MemoryNotesCore> {
  const writer = new FakeNoteWriter(JSON.stringify(fakeNoteBody({ title: '别的聊天', things: [], plans: [], tags: ['别的', '杂事', '随便聊聊'] })));
  for (const [word, body] of Object.entries(notes)) writer.when(word, body);
  const clock = { t: T0 + 30 * DAY };
  const core = new MemoryNotesCore({ archive: store, write: writer.write, save: async () => {}, userBusy: () => false, modelBusy: () => false, lastActivityAt: () => null,
    currentScope: () => store.noteScope(scope), now: () => clock.t, knobs: FAST });
  for (let i = 0; i < 30; i++) { clock.t += 1_000; core.tick(); await settle(); }
  store.setRecallHints(core);
  return core;
}
const asked = '还记得我的住处吗';

test('a later change marks the older memory, which carries it and steps behind the new one', async () => {
  await withStore(async store => {
    const old = await chat(store, 'old', '我住在北京朝阳区，在那边上班', T0);
    const fresh = await chat(store, 'new', '我搬家了，现在住在上海浦东', T0 + 20 * DAY);
    await notebook(store, { 朝阳区: OLD_HOME, 浦东: NEW_HOME });
    const got = store.retrieve(scope, asked, {}, T0 + 30 * DAY);
    const oldRecall = got.find(item => item.id === old), newRecall = got.find(item => item.id === fresh);
    assert.ok(oldRecall && newRecall, 'both still come back (the old one is history, not gone)');
    assert.match(oldRecall.excerpt, /^【后来有更新：原来是“住在北京”，后来用户说的是“搬到了上海浦东”/u);
    assert.match(oldRecall.excerpt, /住在北京朝阳区/u, 'the original words are still there');
    assert.doesNotMatch(newRecall.excerpt, /后来有更新/u, 'the newer one is current and carries no marker');
    assert.ok(got.indexOf(newRecall) < got.indexOf(oldRecall), 'the updated one steps behind');
  });
});

test('nothing changes for a memory no one changed (an unrelated old memory is not marked)', async () => {
  await withStore(async store => {
    const dentist = await chat(store, 'dentist', '我约了周三下午看牙医', T0);
    await chat(store, 'old', '我住在北京朝阳区，在那边上班', T0 + DAY);
    await chat(store, 'new', '我搬家了，现在住在上海浦东', T0 + 20 * DAY);
    await notebook(store, { 牙医: DENTIST, 朝阳区: OLD_HOME, 浦东: NEW_HOME });
    const got = store.retrieve(scope, '还记得我约的牙医吗', {}, T0 + 30 * DAY);
    const recall = got.find(item => item.id === dentist);
    assert.ok(recall);
    assert.doesNotMatch(recall.excerpt, /后来有更新/u);
    assert.match(recall.excerpt, /^用户：/u, 'the excerpt is the plain original, as before');
  });
});

test('without any change written, recall is exactly what it was (old notes behave as before)', async () => {
  await withStore(async store => {
    const old = await chat(store, 'old', '我住在北京朝阳区，在那边上班', T0);
    await chat(store, 'new', '我搬家了，现在住在上海浦东', T0 + 20 * DAY);
    const { changes: _dropped, ...plain } = NEW_HOME;
    await notebook(store, { 朝阳区: OLD_HOME, 浦东: plain });
    const got = store.retrieve(scope, asked, {}, T0 + 30 * DAY);
    assert.ok(!got.find(item => item.id === old)!.excerpt.includes('后来有更新'));
  });
});

test('an earlier talk never marks a later one, and a note the user deleted marks nothing', async () => {
  await withStore(async store => {
    const old = await chat(store, 'old', '我住在北京朝阳区，在那边上班', T0);
    const fresh = await chat(store, 'new', '我搬家了，现在住在上海浦东', T0 + 20 * DAY);
    const core = await notebook(store, { 朝阳区: OLD_HOME, 浦东: NEW_HOME });
    // the new note's change speaks about "住在北京": the NEW note itself has "上海", and even a note mentioning 北京 later than the change is not marked by an earlier one
    assert.equal(core.updates(fresh), null, 'the newer note is not updated by the older one');
    assert.equal(core.updates(old)?.length, 1);
    await core.deleteNote(fresh, store.noteScope(scope));
    assert.equal(core.updates(old), null, 'the user deleted the note that carried the change: it no longer applies');
  });
});

// Codex X-454: notes do not carry their scope; a change said to another character must never mark this character's memory.
test('a change said to another character never marks this character\'s memory (the same character\'s: first test above)', async () => {
  await withStore(async store => {
    const other: MemoryScope = { characterId: 'other-girl', providerScope: 'claude:test-model' };
    const old = await chat(store, 'old', '我住在北京朝阳区，在那边上班', T0);
    const handle = await store.beginTurn(other, { id: 'elsewhere', userText: '我搬家了，现在住在上海浦东', at: T0 + 20 * DAY, conversationId: 'c-elsewhere' });
    await store.appendAssistant(other, 'elsewhere', '好呀', T0 + 20 * DAY + 1_000);
    await store.finishTurn(other, 'elsewhere', 'complete', T0 + 20 * DAY + 2_000);
    const writer = new FakeNoteWriter(JSON.stringify(fakeNoteBody({ title: '别的聊天', things: [], plans: [], tags: ['别的', '杂事', '随便聊聊'] })));
    writer.when('朝阳区', OLD_HOME); writer.when('浦东', NEW_HOME);
    const clock = { t: T0 + 30 * DAY }, current = { scope: store.noteScope(other) };
    const core = new MemoryNotesCore({ archive: store, write: writer.write, save: async () => {}, userBusy: () => false, modelBusy: () => false, lastActivityAt: () => null,
      currentScope: () => current.scope, now: () => clock.t, knobs: FAST });
    for (let i = 0; i < 30; i++) { clock.t += 1_000; core.tick(); await settle(); }
    current.scope = store.noteScope(scope);
    for (let i = 0; i < 30; i++) { clock.t += 1_000; core.tick(); await settle(); }
    store.setRecallHints(core);
    assert.ok(core.state(handle.recordId, store.noteScope(other)).note?.changes?.length, 'the other character\'s talk has its change written');
    assert.ok(core.state(old, store.noteScope(scope)).note, 'this character\'s old talk has its note');
    assert.equal(core.updates(old), null, 'the other character\'s change does not speak about this memory');
    const got = store.retrieve(scope, asked, {}, T0 + 30 * DAY);
    assert.doesNotMatch(got.find(item => item.id === old)?.excerpt ?? '', /后来有更新/u);
  });
});

test('a changed-again fact shows the latest word first, and only a couple of updates are shown', () => {
  const at = (n: number) => T0 + n * DAY;
  const source = (recordId: string, n: number, now: string): { recordId: string; at: number; body: MemoryNoteBody } =>
    ({ recordId, at: at(n), body: { ...NEW_HOME, changes: [{ was: '住在北京', now }] } });
  const target = { recordId: 'old', at: at(0), body: OLD_HOME };
  const found = updatesFor(target, [source('a', 5, '搬到了上海'), source('b', 9, '搬到了深圳'), source('c', 12, '搬到了杭州'), source('d', 13, '搬到了杭州')]);
  assert.deepEqual(found.map(item => item.now), ['搬到了杭州', '搬到了深圳'], 'newest first, the same word once, at most maxShown');
});

test('matching the "was" phrase is local and careful', () => {
  assert.ok(changeSpeaksAbout({ was: '约了周三看牙医', now: '改到周四' }, DENTIST), 'a looser wording of the same thing still matches');
  assert.ok(!changeSpeaksAbout({ was: '住在北京', now: '搬了' }, DENTIST));
  assert.ok(!changeSpeaksAbout({ was: '周', now: '搬了' }, DENTIST), 'a one-character phrase says nothing');
});

test('the marker is only text the user said, in a fixed frame, with no brackets that could close a block', () => {
  const marker = updateMarker([{ was: '住在<北京>', now: '搬到了\n上海' }]);
  assert.ok(!/[<>]/u.test(marker.replace(/<private-memory-data>/gu, '')) && !marker.includes('\n'));
  assert.match(marker, /以后来的为准/u);
});

test('the note call asks for changes in the same answer; old answers and old files still load; bad entries are dropped, not the note', () => {
  assert.match(MEMORY_NOTE_SYSTEM_PROMPT, /changes/u);
  const base = { title: '标题', summary: '概要', people: [], things: [], mood: '', plans: [], tags: ['甲乙', '丙丁', '戊己'] };
  assert.equal(parseMemoryNote(JSON.stringify(base))?.changes, undefined, 'old shape: no changes, still a note');
  const good = parseMemoryNote(JSON.stringify({ ...base, changes: [{ was: '住在北京', now: '搬到上海' }, { was: 3, now: 'x' }, 'bad', { was: '同样', now: '同样' }] }));
  assert.deepEqual(good?.changes, [{ was: '住在北京', now: '搬到上海' }]);
  assert.ok(parseMemoryNote(JSON.stringify({ ...base, changes: 'not a list' })), 'a wrong type is just no changes');
  assert.equal(parseMemoryNote(JSON.stringify({ ...base, surprise: 1 })), null, 'other extra fields still void the note');
  const file = validateMemoryNotesFile({ version: 1, deleted: [], failed: [], notes: [
    { recordId: 'r1', source: 's', segmentAt: 1, writtenAt: 2, body: { ...NEW_HOME } },
    { recordId: 'r2', source: 's', segmentAt: 1, writtenAt: 2, body: { ...OLD_HOME } },
    { recordId: 'r3', source: 's', segmentAt: 1, writtenAt: 2, body: { ...OLD_HOME, changes: [{ was: 5 }] } }] });
  assert.deepEqual(file?.notes[0].body.changes, NEW_HOME.changes, 'saved and read back');
  assert.equal(file?.notes[1].body.changes, undefined);
  assert.equal(file?.notes.length, 3);
  assert.equal(file?.notes[2].body.changes, undefined);
});
