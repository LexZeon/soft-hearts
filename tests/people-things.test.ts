// I-088 item 2 (docs/claude/2026-11-11-i088-people-and-things.md): her people and things gathered from the notes under every name they go
// by. All data is made up; each test that touches files uses its own temporary folder; no profile is read, no model is called.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findAddressForms } from '../electron/cards/character-convert/addresses';
import { MemoryNotes } from '../electron/memory/memory-notes/host';
import { MemoryNotesCore } from '../electron/memory/memory-notes/core';
import { emptyMemoryNotesFile, MemoryNotesStore } from '../electron/memory/memory-notes/store';
import { PeopleThings } from '../electron/memory/people-things/host';
import { PeopleThingsStore, peopleThingsFile, readPeopleThingsDecisions } from '../electron/memory/people-things/store';
import type { MemoryNote, MemoryRecallHints, RecordsRemoval } from '../shared/memory/memory-notes/interface';
import { FakeNoteArchive, FakeNoteWriter, fakeNoteBody } from '../shared/memory/memory-notes/fake';
import { MEMORY_NOTES_KNOBS } from '../shared/memory/memory-notes/knobs';
import {
  PEOPLE_THINGS_LIMITS, emptyDecisions, joinNames, keepApart, nameKey, pruneDecisions, readDecisions, removeNames, renameEntry, splitName,
  type PeopleThingsDecisions,
} from '../shared/memory/people-things/decisions';
import { KINSHIP, gatherPeopleThings, sureKey, type PeopleNoteInput } from '../shared/memory/people-things/gather';
import { aliasMatches, buildAliasIndex } from '../shared/memory/people-things/recall';
import { PEOPLE_THINGS_VIEW_ROWS, peopleThingsView, readPeopleThingsOp, type PeopleThingsView } from '../shared/memory/people-things/view';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { PeopleThingsPanel, peopleThingsDay, peopleThingsPendingWords, peopleThingsRowWords } from '../src/memory/PeopleThingsPanel';

const DAY = 86_400_000, T0 = Date.UTC(2026, 10, 1, 4);
const note = (id: string, day: number, people: string[], things: string[] = []): PeopleNoteInput => ({ recordId: id, at: T0 + day * DAY, people, things });
const keysOf = (entry: { names: readonly { key: string }[] }) => entry.names.map(name => name.key).sort();
const find = (g: ReturnType<typeof gatherPeopleThings>, name: string) => g.entries.find(entry => entry.names.some(n => n.key === nameKey(name)));
const none = emptyDecisions();
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

// ---- gathering: the sure merges ----

test('the same name after normalisation is one entry with every note that wrote it', () => {
  const g = gatherPeopleThings([note('a', 0, ['Alice']), note('b', 1, ['alice ', 'Bob']), note('c', 2, ['ＡＬＩＣＥ'])], none);
  const alice = find(g, 'alice')!;
  assert.equal(alice.names.length, 1);
  assert.deepEqual([...alice.notes].sort(), ['a', 'b', 'c']);
  assert.equal(g.entries.length, 2);
  assert.equal(alice.firstAt, T0);
  assert.equal(alice.lastAt, T0 + 2 * DAY);
  assert.equal(alice.kind, 'person');
});

test('common forms of the same relative are one entry; other relatives and "X的妈妈" stay apart', () => {
  const g = gatherPeopleThings([note('1', 0, ['我妈']), note('2', 1, ['老妈']), note('3', 2, ['妈妈']), note('4', 3, ['母亲']), note('5', 4, ['妈']),
    note('6', 5, ['my mom']), note('7', 6, ['Mother']), note('8', 7, ['我爸']), note('9', 8, ['老爸', '爸爸']), note('10', 9, ['小明的妈妈']), note('11', 10, ['我妈妈'])], none);
  const mother = find(g, '妈妈')!;
  assert.deepEqual([...mother.notes].sort(), ['1', '11', '2', '3', '4', '5', '6', '7']);
  assert.ok(mother.names.length >= 7);
  const father = find(g, '爸爸')!;
  assert.deepEqual([...father.notes].sort(), ['8', '9']);
  assert.notEqual(mother, father);
  const aunt = find(g, '小明的妈妈')!;
  assert.deepEqual(aunt.notes, ['10'], 'someone else\'s mother is not "my mother"');
  assert.equal(g.pending.some(p => [p.a.key, p.b.key].includes(nameKey('小明的妈妈'))), false, '"X的Y" forms are never suggested by containment');
});

test('"我的X" is X; the kinship list is small, closed and one relative per row', () => {
  const g = gatherPeopleThings([note('a', 0, [], ['我的吉他']), note('b', 1, [], ['吉他'])], none);
  assert.equal(g.entries.length, 1);
  assert.equal(sureKey('我的猫'), '我的猫'.slice(0), 'one remaining character is not enough to strip');
  assert.equal(sureKey('我妈'), sureKey('老妈'));
  assert.notEqual(sureKey('我妈'), sureKey('我爸'));
  assert.ok(KINSHIP.length <= 20);
  const all = KINSHIP.flat();
  assert.equal(new Set(all).size, all.length, 'no name is in two rows');
});

// ---- gathering: the unsure ones wait ----

test('unsure ones become pending suggestions and are never merged on their own', () => {
  const g = gatherPeopleThings([note('a', 0, ['小明']), note('b', 1, ['明哥']), note('c', 2, [], ['拉面店']), note('d', 3, [], ['那家拉面店']),
    note('e', 4, [], ['拉面']), note('f', 5, ['王强']), note('g', 6, ['李梅'])], none);
  const pairs = g.pending.map(p => [p.a.key, p.b.key].sort().join('/'));
  assert.ok(pairs.includes([nameKey('小明'), nameKey('明哥')].sort().join('/')), '小明 / 明哥');
  assert.ok(pairs.includes([nameKey('拉面店'), nameKey('那家拉面店')].sort().join('/')), '拉面店 / 那家拉面店');
  assert.ok(pairs.includes([nameKey('拉面'), nameKey('拉面店')].sort().join('/')), 'one name inside another');
  assert.equal(g.pending.some(p => [p.a.key, p.b.key].includes(nameKey('王强'))), false, 'unrelated names are not suggested');
  assert.equal(find(g, '小明'), g.entries.find(entry => entry.names.some(n => n.key === nameKey('小明'))));
  assert.notEqual(find(g, '小明'), find(g, '明哥'), 'not merged');
  assert.ok(g.pending.every(p => p.a.names.length && p.b.names.length && p.a.chats >= 1));
});

test('two names written side by side in one note are two ones, so they are not suggested', () => {
  const g = gatherPeopleThings([note('a', 0, ['小明', '明哥']), note('b', 1, ['小明'])], none);
  assert.equal(g.pending.length, 0);
});

test('a person and a thing are not suggested for each other, and the list of suggestions is bounded', () => {
  const g = gatherPeopleThings([note('a', 0, ['小明']), note('b', 1, [], ['明哥'])], none);
  assert.equal(g.pending.length, 0);
  const many: PeopleNoteInput[] = [];
  for (let i = 0; i < 120; i++) many.push(note(`x${i}`, i, [`小${String.fromCharCode(0x4e00 + i)}`]), note(`y${i}`, i, [`${String.fromCharCode(0x4e00 + i)}哥`]));
  assert.ok(gatherPeopleThings(many, none).pending.length <= 50);
});

test('the same input gives the same answer, in any note order', () => {
  const notes = [note('a', 0, ['小明', '我妈']), note('b', 1, ['明哥', '老妈']), note('c', 2, ['Lily'], ['拉面店'])];
  const a = gatherPeopleThings(notes, none), b = gatherPeopleThings([...notes].reverse(), none);
  const sig = (g: typeof a) => JSON.stringify([g.entries.map(e => [e.name, keysOf(e), [...e.notes]]), g.pending.map(p => [p.a.key, p.b.key])]);
  assert.equal(sig(a), sig(b));
});

// ---- the user's decisions win ----

test('a joined pair is joined; the suggestion goes', () => {
  const notes = [note('a', 0, ['小明']), note('b', 1, ['明哥'])];
  const d = joinNames(none, nameKey('小明'), nameKey('明哥'));
  const g = gatherPeopleThings(notes, d);
  assert.equal(g.entries.length, 1);
  assert.equal(g.pending.length, 0);
  assert.deepEqual(keysOf(g.entries[0]!), [nameKey('小明'), nameKey('明哥')].sort());
});

test('a refused merge is never suggested again, whatever the notes do later', () => {
  const d = keepApart(none, nameKey('小明'), nameKey('明哥'));
  const base = [note('a', 0, ['小明']), note('b', 1, ['明哥'])];
  assert.equal(gatherPeopleThings(base, d).pending.length, 0);
  assert.equal(gatherPeopleThings([...base, note('c', 2, ['小明', '阿明']), note('d', 3, ['明哥'])], d).pending.every(p => ![p.a.key, p.b.key].includes(nameKey('明哥')) || ![p.a.key, p.b.key].includes(nameKey('小明'))), true);
  assert.equal(gatherPeopleThings([note('c', 2, ['小明'])], d).pending.length, 0, 'one of them gone');
  assert.equal(gatherPeopleThings([...base, note('z', 9, ['小明'])], d).pending.length, 0, 'both back again');
  // Without the refusal the suggestion is there (the test is about the decision, not about the names).
  assert.equal(gatherPeopleThings(base, none).pending.length, 1);
  // The refusal also covers the whole entry, not just the two spellings it was given for.
  const wider = gatherPeopleThings([...base, note('c', 2, ['小明同学'])], keepApart(none, nameKey('小明'), nameKey('明哥')));
  assert.equal(wider.pending.some(p => [p.a.key, p.b.key].includes(nameKey('明哥')) && [p.a.key, p.b.key].includes(nameKey('小明'))), false);
});

test('a name the user split off stays out of the automatic merge, new notes included', () => {
  const notes = [note('a', 0, ['我妈']), note('b', 1, ['老妈']), note('c', 2, ['妈妈'])];
  const before = gatherPeopleThings(notes, none);
  assert.equal(before.entries.length, 1);
  const d = splitName(none, nameKey('老妈'), keysOf(before.entries[0]!));
  const after = gatherPeopleThings(notes, d);
  assert.equal(after.entries.length, 2);
  assert.deepEqual(keysOf(find(after, '老妈')!), [nameKey('老妈')]);
  const later = gatherPeopleThings([...notes, note('d', 3, ['老妈', '母亲'])], d);
  assert.deepEqual(keysOf(find(later, '老妈')!), [nameKey('老妈')], 'the next notes do not bring it back');
  assert.ok(find(later, '母亲') !== find(later, '老妈'));
});

test('splitting a name that joined two others keeps those two together', () => {
  let d = joinNames(none, 'a1', 'b1');
  d = joinNames(d, 'b1', 'c1');
  const out = splitName(d, 'b1', ['a1', 'b1', 'c1']);
  assert.ok(out.joined.some(([x, y]) => [x, y].sort().join() === 'a1,c1'));
  assert.equal(out.joined.some(pair => pair.includes('b1')), false);
});

test('a deleted entry is gone, and its names stay gone when a later note writes them', () => {
  const notes = [note('a', 0, ['我妈']), note('b', 1, ['老妈']), note('c', 2, ['Lily'])];
  const g = gatherPeopleThings(notes, none);
  const d = removeNames(none, keysOf(find(g, '妈妈') ?? find(g, '我妈')!));
  const after = gatherPeopleThings([...notes, note('d', 3, ['老妈'])], d);
  assert.deepEqual(after.entries.map(e => e.name), ['Lily']);
  assert.ok(after.seen.has(nameKey('老妈')), 'still seen in the notes (so the decision is kept)');
  assert.equal(after.live.has(nameKey('老妈')), false);
});

test('the name the user gave is the entry\'s name and an alias; a later, more used name does not take it back', () => {
  const notes = [note('a', 0, ['老妈']), note('b', 1, ['老妈']), note('c', 2, ['我妈'])];
  const d = renameEntry(none, nameKey('老妈'), '阿芳');
  const g = gatherPeopleThings(notes, d);
  assert.equal(g.entries.length, 1);
  assert.equal(g.entries[0]!.name, '阿芳');
  assert.ok(g.entries[0]!.names.some(name => name.key === nameKey('阿芳') && name.notes.length === 0), 'the new name is one of its names');
  const more = gatherPeopleThings([...notes, note('d', 3, ['妈妈']), note('e', 4, ['妈妈']), note('f', 5, ['妈妈']), note('g', 6, ['妈妈'])], d);
  assert.equal(more.entries[0]!.name, '阿芳');
  assert.equal(more.entries[0]!.notes.length, 7);
  // Renaming twice: the last name wins.
  assert.equal(gatherPeopleThings(notes, renameEntry(d, nameKey('老妈'), '芳姐')).entries[0]!.name, '芳姐');
  // Not a usable name: nothing changes.
  assert.equal(renameEntry(none, 'x1', '   '), none);
  assert.equal(renameEntry(none, 'x1', 'a'.repeat(25)), none);
  assert.equal(renameEntry(none, 'x1', '\n'), none);
});

test('a user-given name alone is not an entry: no note writes it', () => {
  const d = renameEntry(none, nameKey('不存在'), '阿芳');
  assert.equal(gatherPeopleThings([note('a', 0, ['Lily'])], d).entries.length, 1);
});

test('a deleted note takes its appearances away; an entry with no note left is gone', () => {
  const notes = [note('a', 0, ['小明']), note('b', 1, ['小明']), note('c', 2, ['Lily'])];
  assert.deepEqual([...find(gatherPeopleThings(notes, none), '小明')!.notes].sort(), ['a', 'b']);
  assert.deepEqual(find(gatherPeopleThings(notes.slice(1), none), '小明')!.notes, ['b']);
  assert.equal(find(gatherPeopleThings(notes.slice(2), none), '小明'), undefined);
});

test('decisions about names no note writes any more are pruned; the ones still in use are kept', () => {
  let d = joinNames(none, nameKey('小明'), nameKey('明哥'));
  d = keepApart(d, nameKey('老王'), nameKey('王哥'));
  d = removeNames(d, [nameKey('已删')]);
  const g = gatherPeopleThings([note('a', 0, ['小明']), note('b', 1, ['明哥'])], d);
  const pruned = pruneDecisions(d, g.live, g.seen);
  assert.deepEqual(pruned.joined, d.joined);
  assert.deepEqual(pruned.apart, []);
  assert.deepEqual(pruned.removed, []);
});

test('decisions are read leniently and every list is bounded', () => {
  assert.deepEqual(readDecisions('nope'), emptyDecisions());
  assert.deepEqual(readDecisions({ v: 2 }), emptyDecisions());
  const read = readDecisions({ v: 1, joined: [['a', 'b'], ['a', 'a'], 'x', ['c']], apart: [['\u0000', 'b']], removed: ['ok', 3, ''], labels: [{ key: 'k', text: '' }, { key: 'k', text: '好名' }] });
  assert.deepEqual(read.joined, [['a', 'b']]);
  assert.deepEqual(read.apart, []);
  assert.deepEqual(read.removed, ['ok']);
  assert.deepEqual(read.labels, [{ key: 'k', text: '好名' }]);
  let d: PeopleThingsDecisions = emptyDecisions();
  for (let i = 0; i < PEOPLE_THINGS_LIMITS.joined + 100; i++) d = joinNames(d, `a${i}`, `b${i}`);
  assert.equal(d.joined.length, PEOPLE_THINGS_LIMITS.joined);
  assert.ok(d.joined.some(([x]) => x === `a${PEOPLE_THINGS_LIMITS.joined + 99}`), 'the newest are kept');
  assert.equal(d.joined.some(([x]) => x === 'a0'), false, 'the oldest went');
  let r: PeopleThingsDecisions = emptyDecisions();
  for (let i = 0; i < PEOPLE_THINGS_LIMITS.removed + 10; i++) r = removeNames(r, [`n${i}`]);
  assert.equal(r.removed.length, PEOPLE_THINGS_LIMITS.removed);
});

// ---- recall by any name ----

test('a name of the entry the note itself does not write recalls it; an unrelated word does not', () => {
  const g = gatherPeopleThings([note('a', 0, ['老妈']), note('b', 1, ['妈妈']), note('c', 2, ['Lily'])], none);
  const index = buildAliasIndex(g.entries);
  const hits = aliasMatches('我老妈最近怎么样', index);
  assert.deepEqual([...hits.keys()], ['b'], 'only the note that does not write 老妈 itself (a already matches by its own name)');
  assert.deepEqual(hits.get('b'), ['老妈']);
  assert.equal(aliasMatches('今天天气不错', index).size, 0);
  assert.equal(aliasMatches('Lily来了', index).size, 0, 'an entry with one name adds nothing');
  assert.equal(aliasMatches('', index).size, 0);
});

const SCOPE = 'ch|p';
class PeopleArchive extends FakeNoteArchive {
  hints: MemoryRecallHints | null = null;
  removal: ((ids: readonly string[], how: RecordsRemoval) => void) | null = null;
  noteScope(scope: { characterId: string; providerScope: string }): string { return `${scope.characterId}|${scope.providerScope}`; }
  characterOfScope(key: string): string | null { return key.split('|')[0] || null; }
  setRecallHints(hints: MemoryRecallHints | null): void { this.hints = hints; }
  onRecordsRemoved(listener: ((ids: readonly string[], how: RecordsRemoval) => void) | null): void { this.removal = listener; }
}
const writtenNote = (recordId: string, at: number, people: string[], things: string[], extra: Partial<ReturnType<typeof fakeNoteBody>> = {}): MemoryNote =>
  ({ recordId, source: `src-${recordId}`, segmentAt: at, writtenAt: at, body: fakeNoteBody({ title: `聊了${recordId}`, summary: `摘要${recordId}`, people, things, plans: [], tags: ['杂事', '随便', `标签${recordId}`], ...extra }) });

async function withProfile(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-people-things-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
async function notebook(directory: string, notes: readonly MemoryNote[], segments: string[] = notes.map(n => n.recordId), character = 'ch'): Promise<{ book: MemoryNotes; archive: PeopleArchive }> {
  const archive = new PeopleArchive();
  for (const id of segments) archive.add(id, SCOPE, T0, [{ role: 'user', content: `用户在聊${id}的事情，说了不少话。` }, { role: 'assistant', content: '嗯嗯，我在听。' }]);
  const store = new MemoryNotesStore(directory);
  await store.save({ ...emptyMemoryNotesFile(), notes: [...notes] });
  const book = new MemoryNotes({ directory, archive, write: new FakeNoteWriter('{}').write, userBusy: () => false, modelBusy: () => false, lastActivityAt: () => null,
    scope: () => ({ characterId: character, providerScope: 'p' }), tickMs: 3_600_000 });
  await book.start();
  await book.people.warm();
  return { book, archive };
}

test('through the notebook: a note is recalled by another name of the same person, but not by an unrelated word', async () => {
  await withProfile(async directory => {
    const { book } = await notebook(directory, [writtenNote('n1', T0, ['我妈'], []), writtenNote('n2', T0 + DAY, ['老妈'], [])]);
    const recall = book.core.prepare('我老妈最近怎么样');
    assert.ok(recall('n1'), 'n1 never wrote 老妈; the entry says it is the same person');
    assert.equal(recall('n1')!.score, MEMORY_NOTES_KNOBS.recall.person, 'counts like a person name');
    assert.equal(recall('n1')!.explicit, false, 'no "talking about before" cue is made up');
    assert.ok(recall('n2'), 'n2 writes 老妈 itself: matched by its own name as before');
    assert.equal(recall('n2')!.score, MEMORY_NOTES_KNOBS.recall.person);
    assert.equal(book.core.prepare('今天天气不错')('n1'), null);
    // Without the entries (before they are gathered) nothing changes: the old behaviour.
    const plain = new MemoryNotesCore({ archive: new FakeNoteArchive(), write: new FakeNoteWriter('{}').write, save: async () => {}, userBusy: () => false, modelBusy: () => false, lastActivityAt: () => null, currentScope: () => null });
    plain.load({ ...emptyMemoryNotesFile(), notes: [writtenNote('n1', T0, ['我妈'], [])] });
    assert.equal(plain.prepare('我老妈最近怎么样')('n1'), null);
    await book.dispose();
  });
});

test('the entry of a user merge recalls through the new names, and a deleted note is never recalled', async () => {
  await withProfile(async directory => {
    const { book } = await notebook(directory, [writtenNote('n1', T0, ['小明'], []), writtenNote('n2', T0 + DAY, ['明哥'], [])]);
    assert.equal(book.core.prepare('明哥最近怎么样')('n1'), null, 'a suggestion alone recalls nothing');
    const view = await book.people.view();
    assert.equal(view.pending.length, 1);
    await book.people.apply({ kind: 'confirm', key: view.pending[0]!.a.key, other: view.pending[0]!.b.key });
    assert.ok(book.core.prepare('明哥最近怎么样')('n1'), 'after the user said yes');
    await book.core.deleteNote('n1', SCOPE);
    await settle();
    assert.equal(book.core.prepare('明哥最近怎么样')('n1'), null, 'a deleted note is not recalled by any name');
    const after = await book.people.view();
    assert.ok(after.rows.every(row => row.chats <= 1), 'its appearances went');
    await book.dispose();
  });
});

test('the own-tag rule of I-083 still works with entries present, and a shared tag alone still brings nothing', async () => {
  await withProfile(async directory => {
    const sleepwalk = writtenNote('walk', T0, ['我妈'], ['纸条'], { title: '梦游写纸条', tags: ['梦游', '纸条', '可爱'] });
    const others = ['o1', 'o2', 'o3'].map((id, i) => writtenNote(id, T0 + (i + 1) * DAY, ['老妈'], [], { title: '夸她可爱', tags: ['可爱'] }));
    const { book } = await notebook(directory, [sleepwalk, ...others]);
    const hint = book.core.prepare('感觉不如我的梦游冷笑话')('walk');
    assert.ok(hint, 'found by the note\'s own rare tag');
    assert.equal(hint!.score, MEMORY_NOTES_KNOBS.recall.ownTag, 'no alias score was added: the message names nobody');
    assert.equal(book.core.prepare('你好可爱')('walk'), null, 'a tag many notes share is a passing word');
    await book.dispose();
  });
});

test('one character\'s names never make entries from another character\'s notes', async () => {
  await withProfile(async directory => {
    const archive = new PeopleArchive();
    archive.add('mine', 'ch|p', T0, [{ role: 'user', content: '用户在聊mine的事情，说了不少话。' }, { role: 'assistant', content: '嗯嗯。' }]);
    archive.add('theirs', 'other|p', T0, [{ role: 'user', content: '用户在聊theirs的事情，说了不少话。' }, { role: 'assistant', content: '嗯嗯。' }]);
    await new MemoryNotesStore(directory).save({ ...emptyMemoryNotesFile(), notes: [writtenNote('mine', T0, ['我妈'], []), writtenNote('theirs', T0, ['老妈'], [])] });
    const book = new MemoryNotes({ directory, archive, write: new FakeNoteWriter('{}').write, userBusy: () => false, modelBusy: () => false, lastActivityAt: () => null,
      scope: () => ({ characterId: 'ch', providerScope: 'p' }), tickMs: 3_600_000 });
    await book.start(); await book.people.warm();
    assert.equal((await book.people.view()).total, 1, 'only this character\'s notes make entries');
    assert.equal(book.core.prepare('我老妈')('mine'), null, 'the other character\'s 老妈 is another entry set');
    await book.dispose();
  });
});

// ---- the page's operations and the store ----

test('the page can rename, merge, split, delete, confirm and refuse; the decisions are saved per character and win after a restart', async () => {
  await withProfile(async directory => {
    const notes = [writtenNote('n1', T0, ['我妈'], []), writtenNote('n2', T0 + DAY, ['老妈'], []), writtenNote('n3', T0 + 2 * DAY, ['小明'], []), writtenNote('n4', T0 + 3 * DAY, ['明哥'], []), writtenNote('n5', T0 + 4 * DAY, ['Lily'], [])];
    const { book } = await notebook(directory, notes);
    let view = await book.people.view();
    assert.equal(view.rows.length, 4);
    assert.equal(view.pending.length, 1);
    const mom = view.rows.find(row => row.names.length === 2)!;
    // rename
    view = await book.people.apply({ kind: 'rename', key: mom.key, text: '阿芳' });
    assert.ok(view.rows.some(row => row.name === '阿芳' && row.names.length === 3));
    // split the new name off again: only the user-given name goes
    view = await book.people.apply({ kind: 'split', key: nameKey('阿芳') });
    const back = view.rows.find(row => row.names.some(name => name.key === nameKey('老妈')))!;
    assert.equal(back.names.length, 2, 'the user-given name is gone again');
    assert.notEqual(back.name, '阿芳');
    // refuse the suggestion
    view = await book.people.apply({ kind: 'refuse', key: view.pending[0]!.a.key, other: view.pending[0]!.b.key });
    assert.equal(view.pending.length, 0);
    // delete Lily
    view = await book.people.apply({ kind: 'delete', key: nameKey('Lily') });
    assert.equal(view.rows.some(row => row.names.some(name => name.key === nameKey('lily'))), false);
    // merge
    view = await book.people.apply({ kind: 'merge', key: nameKey('小明'), other: nameKey('明哥') });
    assert.ok(view.rows.some(row => row.names.length === 2 && row.names.some(name => name.key === nameKey('小明'))));
    await book.dispose();
    const saved = JSON.parse(await readFile(peopleThingsFile(directory, 'ch'), 'utf8'));
    assert.equal(saved.v, 1);
    assert.ok(!JSON.stringify(saved).includes('用户在聊'), 'no chat text in the file');
    assert.ok(!JSON.stringify(saved).includes('n1'), 'no note ids in the file');
    // After a restart the same decisions apply.
    const again = await notebook(directory, notes);
    const after = await again.book.people.view();
    assert.equal(after.rows.some(row => row.names.some(name => name.key === nameKey('lily'))), false, 'deleted stays deleted');
    assert.equal(after.pending.length, 0, 'refused stays refused');
    assert.ok(after.rows.some(row => row.names.some(name => name.key === nameKey('小明')) && row.names.some(name => name.key === nameKey('明哥'))), 'merged stays merged');
    await again.book.dispose();
  });
});

test('operations that name something that is gone or are malformed change nothing and say why', async () => {
  await withProfile(async directory => {
    const { book } = await notebook(directory, [writtenNote('n1', T0, ['Lily'], [])]);
    const before = JSON.stringify(await book.people.view());
    await assert.rejects(book.people.apply({ kind: 'delete', key: 'nobody' }), /已经不在/u);
    await assert.rejects(book.people.apply({ kind: 'merge', key: nameKey('lily'), other: nameKey('lily') }), /已经不在/u);
    await assert.rejects(book.people.apply({ kind: 'split', key: nameKey('lily') }), /只有一个叫法/u);
    await assert.rejects(book.people.apply({ kind: 'rename', key: nameKey('lily'), text: ' ' }), /名字/u);
    await assert.rejects(book.people.apply({ kind: 'rename', key: nameKey('lily'), text: 'x'.repeat(40) }), /名字/u);
    await assert.rejects(book.people.apply({ kind: 'drop', key: 'x' }), /不对/u);
    await assert.rejects(book.people.apply({ kind: 'delete', key: nameKey('lily'), extra: 1 }), /不对/u);
    await assert.rejects(book.people.apply('delete'), /不对/u);
    assert.equal(JSON.stringify(await book.people.view()), before);
    assert.deepEqual(await readdir(directory).then(list => list.filter(name => name === 'people-things')), [], 'nothing was written');
    await book.dispose();
  });
});

test('the request is checked field by field', () => {
  assert.deepEqual(readPeopleThingsOp({ kind: 'rename', key: 'a', text: 'b' }), { kind: 'rename', key: 'a', text: 'b' });
  assert.deepEqual(readPeopleThingsOp({ kind: 'confirm', key: 'a', other: 'b' }), { kind: 'confirm', key: 'a', other: 'b' });
  assert.equal(readPeopleThingsOp({ kind: 'confirm', key: 'a' }), null);
  assert.equal(readPeopleThingsOp({ kind: 'delete', key: 'a', other: 'b' }), null);
  assert.equal(readPeopleThingsOp({ kind: 'delete', key: '' }), null);
  assert.equal(readPeopleThingsOp({ kind: 'delete', key: 'x'.repeat(201) }), null);
  assert.equal(readPeopleThingsOp(null), null);
  assert.equal(readPeopleThingsOp([]), null);
});

test('deleting memories prunes the decisions that named nothing any more (and forgetting a character removes the file)', async () => {
  await withProfile(async directory => {
    const notes = [writtenNote('n1', T0, ['小明'], []), writtenNote('n2', T0 + DAY, ['明哥'], []), writtenNote('n3', T0 + 2 * DAY, ['Lily'], [])];
    const { book, archive } = await notebook(directory, notes);
    await book.people.apply({ kind: 'confirm', key: nameKey('小明'), other: nameKey('明哥') });
    await book.people.apply({ kind: 'delete', key: nameKey('lily') });
    assert.ok(readDecisions(JSON.parse(await readFile(peopleThingsFile(directory, 'ch'), 'utf8'))).removed.includes(nameKey('lily')));
    archive.remove('n3'); book.core.removed(['n3'], { recoverable: false });
    await settle(); await book.people.prune(); await book.people.dispose();
    const left = readDecisions(JSON.parse(await readFile(peopleThingsFile(directory, 'ch'), 'utf8')));
    assert.deepEqual(left.removed, [], 'the deleted name has no note any more');
    assert.equal(left.joined.length, 1, 'the merge of names still in use stays');
    archive.remove('n1'); archive.remove('n2'); book.core.removed(['n1', 'n2'], { recoverable: false });
    await settle(); await book.people.prune(); await book.people.dispose();
    await assert.rejects(readFile(peopleThingsFile(directory, 'ch'), 'utf8'), /ENOENT/u, 'no names left, no file left');
    await book.dispose();
  });
});

test('the store: one file per character, atomic, never overwrites an unreadable file, bounded on read', async () => {
  await withProfile(async directory => {
    const writes: string[] = [];
    const store = new PeopleThingsStore({ directory: () => directory, write: async (file, data) => { writes.push(file); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data); } });
    await store.save('gene', joinNames(none, 'a1', 'b1'));
    await store.save('momo', joinNames(none, 'c1', 'd1'));
    assert.deepEqual(writes.map(file => path.basename(file)), ['gene.json', 'momo.json']);
    assert.deepEqual((await readPeopleThingsDecisions(directory, 'gene')).joined, [['a1', 'b1']]);
    assert.deepEqual((await readPeopleThingsDecisions(directory, 'momo')).joined, [['c1', 'd1']]);
    assert.deepEqual((await readPeopleThingsDecisions(directory, 'nobody')).joined, []);
    await writeFile(path.join(directory, 'escape.json'), JSON.stringify(joinNames(none, 'p1', 'q1')));
    assert.deepEqual((await readPeopleThingsDecisions(directory, '../escape')).joined, [], 'a character id with a path in it is refused');
    assert.deepEqual((await new PeopleThingsStore({ directory: () => directory }).load('../escape')).joined, []);
    // A write that fails leaves the old file and the in-memory decisions as they were.
    const failing = new PeopleThingsStore({ directory: () => directory, write: async () => { throw new Error('disk full'); } });
    await failing.load('gene');
    await assert.rejects(failing.save('gene', joinNames(none, 'x1', 'y1')), /disk full/u);
    assert.deepEqual(failing.current('gene').joined, [['a1', 'b1']]);
    assert.deepEqual((await readPeopleThingsDecisions(directory, 'gene')).joined, [['a1', 'b1']]);
    // An unreadable file is kept as it is.
    await writeFile(peopleThingsFile(directory, 'broken'), '{not json');
    const guard = new PeopleThingsStore({ directory: () => directory });
    assert.deepEqual((await guard.load('broken')).joined, []);
    await assert.rejects(guard.save('broken', joinNames(none, 'a', 'b')), /读不出来/u);
    assert.equal(await readFile(peopleThingsFile(directory, 'broken'), 'utf8'), '{not json');
    // A huge file is not read.
    await writeFile(peopleThingsFile(directory, 'huge'), JSON.stringify({ v: 1, joined: [], apart: [], removed: ['x'.repeat(2 * 1024 * 1024)], labels: [] }));
    assert.deepEqual((await readPeopleThingsDecisions(directory, 'huge')).removed, []);
    // Nothing before the app is ready.
    await assert.rejects(new PeopleThingsStore({ directory: () => null }).save('gene', joinNames(none, 'a', 'b')), /还不能/u);
  });
});

test('the store does not keep an empty decision as a file', async () => {
  await withProfile(async directory => {
    const store = new PeopleThingsStore({ directory: () => directory });
    await store.save('gene', joinNames(none, 'a1', 'b1'));
    await store.save('gene', emptyDecisions());
    await assert.rejects(readFile(peopleThingsFile(directory, 'gene'), 'utf8'), /ENOENT/u);
  });
});

test('the view shows the newest rows only and is names, counts and times', () => {
  const notes = Array.from({ length: PEOPLE_THINGS_VIEW_ROWS + 20 }, (_, i) => note(`n${i}`, i, [`人${String.fromCharCode(0x4e00 + i)}${String.fromCharCode(0x5000 + i)}`]));
  const g = gatherPeopleThings(notes, none);
  const view = peopleThingsView(g.entries, g.pending);
  assert.equal(view.rows.length, PEOPLE_THINGS_VIEW_ROWS);
  assert.equal(view.total, PEOPLE_THINGS_VIEW_ROWS + 20);
  assert.equal(view.rows[0]!.lastAt, T0 + (PEOPLE_THINGS_VIEW_ROWS + 19) * DAY, 'newest first');
  assert.doesNotMatch(JSON.stringify(view), /"n\d+"/u, 'no note ids');
});

// ---- the conversion's address finding ----

const PET = '阿福';
test('conversion: the names of one person add up as evidence, but the evidence rules of fix 4 and 5 still decide', () => {
  const texts = [`她叫他「${PET}」，他很开心。`, '福哥说今天要来。', '福哥又带了零食。', '福哥也在。', `${PET}说要去吃饭。`];
  const people = [PET, '福哥'];
  const without = findAddressForms(texts, ['小夏'], people);
  const withGroup = findAddressForms(texts, ['小夏'], people, [[PET, '福哥']]);
  assert.ok(without.some(form => form.text === PET));
  assert.ok(withGroup.some(form => form.text === PET));
  assert.ok(withGroup.some(form => form.text === '福哥'), 'the other name of the same person is offered with it');
  // Used three times under two spellings (two and one): neither passes alone, together they do.
  const alone = ['福哥说今天要来。', '福哥又来了。', '福哥也在。', '阿福说要去吃饭。', '阿福又来了。', '阿福也在。'];
  assert.equal(findAddressForms(alone, ['小夏'], ['福哥', '阿福']).length, 2, 'three uses and subject clauses each: both pass alone');
  const thin = ['福哥说今天要来。', '阿福说要去吃饭。', '福哥又来了。'];
  assert.equal(findAddressForms(thin, ['小夏'], ['福哥', '阿福']).length, 0, 'two uses and one use: neither passes alone');
  assert.equal(findAddressForms(thin, ['小夏'], ['福哥', '阿福'], [['福哥', '阿福']]).length, 2, 'the group has three uses and subject clauses in three texts');
  assert.equal(findAddressForms(thin.slice(0, 2), ['小夏'], ['福哥', '阿福'], [['福哥', '阿福']]).length, 0, 'two uses in all are still too few');
  // A group with a name marked as a character of a work is left out (fix 4), and so are role words.
  const film = ['电影里的福哥说今天要来。', '阿福说要去吃饭。', '阿福又来了。'];
  assert.deepEqual(findAddressForms(film, ['小夏'], [], [['福哥', '阿福']]), [], 'one of them is a character of a film: the group adds nothing (the veto stays)');
  assert.ok(findAddressForms(film.slice(1), ['小夏'], [], [['福哥', '阿福']]).length === 0, 'and without the film line the group has only one name used');
  assert.deepEqual(findAddressForms(['妈妈说回来。', '老妈又说了。', '妈妈在。'], ['小夏'], [], [['妈妈', '老妈']]).map(form => form.text), [], 'a role word is not a name');
  // No evidence in the group: nothing is added.
  assert.deepEqual(findAddressForms(['福哥的帽子很好看。', '阿福的鞋也是。', '福哥的包。'], ['小夏'], [], [['福哥', '阿福']]), [], 'three uses but nobody is addressed or does anything');
});

test('conversion: the snapshot reads the user\'s decisions and the same gathering (read only)', async () => {
  await withProfile(async directory => {
    await mkdir(path.join(directory, 'people-things'), { recursive: true });
    const d = joinNames(none, nameKey('福哥'), nameKey('阿福'));
    await writeFile(peopleThingsFile(directory, 'ch'), JSON.stringify(d));
    const read = await readPeopleThingsDecisions(directory, 'ch');
    const notes = [note('a', 0, ['福哥']), note('b', 1, ['阿福'])];
    const g = gatherPeopleThings(notes, read);
    const groups = g.entries.filter(entry => entry.kind === 'person' && entry.names.length > 1).map(entry => entry.names.map(name => name.text));
    assert.deepEqual(groups.map(group => [...group].sort()), [['福哥', '阿福'].sort()]);
    const texts = ['福哥说今天要来。', '阿福说要去吃饭。', '福哥又来了。'];
    const forms = findAddressForms(texts, ['小夏'], ['福哥', '阿福'], groups).map(form => form.text).sort();
    assert.deepEqual(forms, ['福哥', '阿福'].sort());
    assert.equal(await readFile(peopleThingsFile(directory, 'ch'), 'utf8'), JSON.stringify(d), 'unchanged');
  });
});

// ---- the page ----

class El {
  children: El[] = []; className = ''; textContent: string | null = ''; type = ''; value = ''; title = ''; placeholder = ''; maxLength = 0;
  dataset: Record<string, string> = {}; onclick: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...children: El[]) { this.children.push(...children); }
  replaceChildren(...children: El[]) { this.children = [...children]; }
  get innerHTML(): string { throw new Error('the panel never reads or writes markup'); }
  set innerHTML(_value: string) { throw new Error('the panel never reads or writes markup'); }
}
const walk = (root: El): El[] => [root, ...root.children.flatMap(walk)];
const parts = (root: El, name: string) => walk(root).filter(node => node.dataset.peopleThings === name);
(globalThis as any).document = { createElement: (tag: string) => new El(tag) };

const sampleView = (): PeopleThingsView => {
  const g = gatherPeopleThings([note('a', 0, ['我妈']), note('b', 1, ['老妈']), note('c', 2, ['小明']), note('d', 3, ['明哥']), note('e', 4, [], ['拉面店'])], none);
  return peopleThingsView(g.entries, g.pending);
};
function panelFor(view: () => PeopleThingsView) {
  setUiLanguage('zh-CN');
  const root = new El('div'), sent: unknown[] = [], errors: string[] = [];
  let notify: () => void = () => {};
  const panel = new PeopleThingsPanel(root as unknown as HTMLElement, { get: async () => view(), change: async op => { sent.push(op); return view(); },
    changed: callback => { notify = callback; return () => {}; }, error: message => errors.push(message) });
  return { root, sent, errors, panel, notify: () => notify() };
}

test('the page: one row per entry with names, chats and last day; the suggestions have two buttons; text only', async () => {
  const { root } = panelFor(sampleView);
  await settle();
  const rows = parts(root, 'row');
  assert.equal(rows.length, 4);
  const mom = rows.find(row => parts(row, 'aliases').length)!;
  assert.deepEqual(parts(mom, 'alias').map(node => node.textContent).sort(), ['我妈', '老妈'].sort());
  assert.match(parts(mom, 'meta')[0]!.textContent!, /^2 次聊天 · 最近 2026-11-0\d$/u);
  assert.equal(parts(mom, 'split').length, 2, 'each name of a merged entry can be split off');
  assert.equal(parts(rows.find(row => !parts(row, 'aliases').length)!, 'split').length, 0);
  assert.equal(parts(root, 'pending').length, 1, '小明 / 明哥');
  assert.ok(parts(root, 'question').some(node => /小明/u.test(node.textContent!) && /明哥/u.test(node.textContent!) && /是同一个吗/u.test(node.textContent!)));
  assert.equal(parts(root, 'confirm').length, 1);
  assert.equal(parts(root, 'refuse').length, 1);
  assert.equal(walk(root).some(node => /<|>/u.test(node.textContent ?? '')), false);
  assert.ok(walk(root).some(node => /共 4 个/u.test(node.textContent ?? '')));
});

test('the page: the buttons send exactly the operation, and a markup-looking name is shown as text', async () => {
  const hostile: PeopleThingsView = { rows: [{ kind: 'person', name: '<img src=x onerror=alert(1)>', key: 'k1', names: [{ key: 'k1', text: '<img src=x onerror=alert(1)>' }, { key: 'k2', text: '<b>x</b>' }], chats: 1, firstAt: T0, lastAt: T0 },
    { kind: 'thing', name: '店', key: 'k3', names: [{ key: 'k3', text: '店' }], chats: 3, firstAt: T0, lastAt: T0 }],
  total: 2, pending: [{ a: { key: 'k4', name: '甲', names: ['甲'], chats: 1 }, b: { key: 'k5', name: '乙', names: ['乙'], chats: 1 } }] };
  const { root, sent, errors } = panelFor(() => hostile);
  await settle();
  assert.equal(parts(root, 'name')[0]!.textContent, '<img src=x onerror=alert(1)>', 'kept as text');
  assert.equal(root.children.length > 0, true);
  // suggestion
  parts(root, 'confirm')[0]!.onclick!(); await settle();
  parts(root, 'refuse')[0]!.onclick!(); await settle();
  assert.deepEqual(sent, [{ kind: 'confirm', key: 'k4', other: 'k5' }, { kind: 'refuse', key: 'k4', other: 'k5' }]);
  // split
  sent.length = 0;
  parts(root, 'split')[1]!.onclick!(); await settle();
  assert.deepEqual(sent, [{ kind: 'split', key: 'k2' }]);
  // rename: the button opens a box, 确定 sends it
  sent.length = 0;
  parts(root, 'rename')[0]!.onclick!(); await settle();
  assert.equal(parts(root, 'rename-input').length, 1);
  assert.equal(parts(root, 'rename-input')[0]!.maxLength, 24);
  parts(root, 'rename-input')[0]!.value = '新名字';
  parts(root, 'rename-ok')[0]!.onclick!(); await settle();
  assert.deepEqual(sent, [{ kind: 'rename', key: 'k1', text: '新名字' }]);
  assert.equal(parts(root, 'rename-input').length, 0, 'closed after sending');
  // delete takes two clicks
  sent.length = 0;
  parts(root, 'delete')[0]!.onclick!(); await settle();
  assert.deepEqual(sent, []);
  assert.equal(parts(root, 'delete-confirm').length, 1);
  parts(root, 'delete-confirm')[0]!.onclick!(); await settle();
  assert.deepEqual(sent, [{ kind: 'delete', key: 'k1' }]);
  // merge: pick the first, then "合并到这个" on the other
  sent.length = 0;
  parts(root, 'merge')[0]!.onclick!(); await settle();
  assert.equal(parts(root, 'merge-bar').length, 1);
  assert.equal(parts(root, 'merge-into').length, 1, 'only the other row offers it');
  assert.equal(parts(root, 'delete').length, 0, 'while picking, nothing else can be pressed');
  parts(root, 'merge-into')[0]!.onclick!(); await settle();
  assert.deepEqual(sent, [{ kind: 'merge', key: 'k1', other: 'k3' }]);
  assert.deepEqual(errors, []);
});

test('the page: cancel closes merge and rename; a refused operation shows its message; a change elsewhere refreshes it', async () => {
  let view = sampleView();
  const failing = panelFor(() => view);
  await settle();
  parts(failing.root, 'merge')[0]!.onclick!(); await settle();
  parts(failing.root, 'merge-cancel')[0]!.onclick!(); await settle();
  assert.equal(parts(failing.root, 'merge-bar').length, 0);
  assert.equal(parts(failing.root, 'merge').length, 4);
  parts(failing.root, 'rename')[0]!.onclick!(); await settle();
  parts(failing.root, 'rename-cancel')[0]!.onclick!(); await settle();
  assert.equal(parts(failing.root, 'rename-input').length, 0);
  const rows = parts(failing.root, 'row').length;
  view = { ...view, rows: view.rows.slice(1), total: view.total - 1 };
  failing.notify(); await settle();
  assert.equal(parts(failing.root, 'row').length, rows - 1);
  const root = new El('div'), errors: string[] = [];
  new PeopleThingsPanel(root as unknown as HTMLElement, { get: async () => sampleView(), change: async () => { throw new Error('这一项已经不在了，请刷新看看。'); }, changed: () => () => {}, error: m => errors.push(m) });
  await settle();
  parts(root, 'confirm')[0]!.onclick!(); await settle();
  assert.deepEqual(errors, ['这一项已经不在了，请刷新看看。']);
});

test('the page: empty, and the words in both languages', async () => {
  const { root } = panelFor(() => ({ rows: [], total: 0, pending: [] }));
  await settle();
  assert.ok(walk(root).some(node => /还没有记下人和事/u.test(node.textContent ?? '')));
  assert.equal(parts(root, 'row').length, 0);
  assert.equal(peopleThingsDay(new Date(2026, 10, 9, 12).getTime()), '2026-11-09');
  const tr = (source: string, ...values: readonly unknown[]) => source.replace(/\{(\d+)\}/gu, (_m, i) => String(values[Number(i)]));
  const row = sampleView().rows.find(r => r.names.length === 2)!;
  const words = peopleThingsRowWords(row, tr);
  assert.equal(words.kind, '人');
  assert.match(words.meta, /^2 次聊天 · 最近 /u);
  assert.equal(peopleThingsPendingWords({ a: { key: 'a', name: '小明', names: [], chats: 1 }, b: { key: 'b', name: '明哥', names: [], chats: 1 } }, tr), '「小明」和「明哥」是同一个吗？');
  setUiLanguage('en');
  try {
    assert.equal(peopleThingsPendingWords({ a: { key: 'a', name: 'A', names: [], chats: 1 }, b: { key: 'b', name: 'B', names: [], chats: 1 } }), 'Are “A” and “B” the same one?');
    assert.match(peopleThingsRowWords(row).meta, /^in 2 chats · last /u);
    assert.equal(peopleThingsRowWords(row).kind, 'person');
  } finally { setUiLanguage('zh-CN'); }
});

test('conversion: the real snapshot offers every name of a merged person, and only reads the decisions file', async () => {
  const { makeFixture, withDirectory } = await import('./helpers/convert-fixture');
  const { readSourceSnapshot } = await import('../electron/cards/character-convert/snapshot');
  const { MEMORY_NOTES_FILE } = await import('../electron/memory/memory-notes/store');
  await withDirectory(async directory => {
    const fixture = await makeFixture(directory);
    const file = path.join(directory, MEMORY_NOTES_FILE);
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.notes[0].body.people = ['福哥']; data.notes[0].body.summary = '福哥说周五来。';
    data.notes[1].body.people = ['阿福']; data.notes[1].body.summary = '阿福说要去吃饭。';
    await writeFile(file, JSON.stringify(data));
    const ports = (fixture.service as any).options.source;
    const names = async () => (await readSourceSnapshot(fixture.sourceId, ports)).names.map(name => name.text);
    assert.ok(!(await names()).includes('福哥'), 'two names used twice each, not merged: neither is offered');
    await mkdir(path.join(directory, 'people-things'), { recursive: true });
    const decisions = JSON.stringify(joinNames(none, nameKey('福哥'), nameKey('阿福')));
    await writeFile(peopleThingsFile(directory, fixture.sourceId), decisions);
    const merged = await names();
    assert.ok(merged.includes('福哥') && merged.includes('阿福'), 'the user said they are one person: the evidence adds up');
    assert.equal(await readFile(peopleThingsFile(directory, fixture.sourceId), 'utf8'), decisions, 'read only');
    assert.deepEqual(await readdir(path.join(directory, 'people-things')), [`${fixture.sourceId}.json`]);
  });
});
