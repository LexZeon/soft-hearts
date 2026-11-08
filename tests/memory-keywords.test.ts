// I-049 step 1 / I-048 keywords: validation of what the writer returns, local matching, deleting, converting old notes, and the files
// on disk. Made-up text and temporary folders only; no model, no real profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateKeywords, parseKeywordsText, type Keyword } from '../shared/memory-keywords/keyword';
import { keywordsFromNote } from '../shared/memory-keywords/from-note';
import { KeywordIndex } from '../shared/memory-keywords/keyword-index';
import { MEMORY_KEYWORDS_KNOBS } from '../shared/memory-keywords/knobs';
import { fakeNoteBody } from '../shared/memory-notes/fake';
import { KeywordIndexStore, characterKey } from '../electron/memory-keywords/store';
import { ScreenshotCache } from '../electron/watch-notes/screenshots';
import { WatchNotesStore, watchNoteKeywordId } from '../electron/watch-notes/store';

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const MIN = 60_000;
const kw = (term: string, kind: Keyword['kind'], weight: number, aliases: string[] = []): Keyword => ({ term, kind, weight, aliases });

async function temp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sh-keywords-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function tree(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tree(full, base))); else out.push(path.relative(base, full));
  }
  return out.sort();
}

// ---- validation ----
const SOURCE = '剧里那个拿信封的侦探叫林默，他在码头追查《夜航船》的案子，和《Night Ferry》是同一部。';

test('a keyword the source does not say is dropped, one it does say is kept', () => {
  const kept = validateKeywords([
    { term: '林默', kind: 'person', weight: 0.9, aliases: [] },
    { term: '周小雨', kind: 'person', weight: 0.9, aliases: [] },
    { term: '码头', kind: 'place', weight: 0.5, aliases: [] },
  ], SOURCE);
  assert.deepEqual(kept.map(item => item.term), ['林默', '码头']);
});

test('a term that is not in the text is kept only through an alias that is', () => {
  const kept = validateKeywords([
    { term: 'Night Ferry', kind: 'work', weight: 0.8, aliases: ['夜航船'] },
    { term: 'Midnight Express', kind: 'work', weight: 0.8, aliases: ['午夜特快'] },
  ], SOURCE);
  assert.deepEqual(kept.map(item => item.term), ['Night Ferry']);
});

test('wrong shapes, unknown kinds, bad weights and vague or over-long terms never get in', () => {
  const long = '林'.repeat(40);
  const kept = validateKeywords([
    null, 'text', 5, [],
    { term: '林默', kind: 'celebrity', weight: 0.5 },
    { term: '林默', kind: 'person', weight: '0.5' },
    { term: '林默', kind: 'person', weight: NaN },
    { term: '今天', kind: 'topic', weight: 0.5 },
    { term: '他', kind: 'person', weight: 0.5 },
    { term: long, kind: 'person', weight: 0.5 },
    { term: '侦探', kind: 'topic', weight: 0.4, aliases: 'not-a-list' },
  ], `${SOURCE}今天${long}`);
  assert.deepEqual(kept.map(item => item.term), ['侦探']);
  assert.deepEqual(kept[0].aliases, []);
});

test('weights are kept within 0 to 1 and duplicates under one name become one keyword with the higher weight', () => {
  const kept = validateKeywords([
    { term: '林默', kind: 'person', weight: 7, aliases: ['侦探'] },
    { term: '林默', kind: 'person', weight: 0.2, aliases: ['那个人'] },
    { term: '码头', kind: 'place', weight: -3, aliases: [] },
  ], SOURCE);
  const person = kept.find(item => item.term === '林默')!;
  assert.equal(person.weight, 1);
  assert.deepEqual([...person.aliases].sort(), ['侦探', '那个人'].sort());
  assert.equal(kept.find(item => item.term === '码头')!.weight, 0);
});

test('counts and alias lists stay within their bounds', () => {
  const words = Array.from({ length: 40 }, (_, i) => `词${String.fromCharCode(0x4e00 + i * 7)}${String.fromCharCode(0x4e01 + i * 7)}`);
  const kept = validateKeywords(words.map(term => ({ term, kind: 'topic', weight: 0.5, aliases: words.slice(0, 20) })), words.join(' '));
  assert.ok(kept.length <= MEMORY_KEYWORDS_KNOBS.write.perNote);
  assert.ok(kept.every(item => item.aliases.length <= MEMORY_KEYWORDS_KNOBS.write.aliases));
});

test('writer text: a code fence is fine, anything that is not a JSON array gives nothing', () => {
  const json = JSON.stringify([{ term: '林默', kind: 'person', weight: 0.9, aliases: [] }]);
  assert.equal(parseKeywordsText('```json\n' + json + '\n```', SOURCE).length, 1);
  assert.deepEqual(parseKeywordsText('好的，关键词是林默', SOURCE), []);
  assert.deepEqual(parseKeywordsText('{"term":"林默"}', SOURCE), []);
});

// ---- converting old notes ----
test('old chat notes become keywords locally: people high, things middle, tags low; the note itself is not changed', () => {
  const note = Object.freeze({ ...fakeNoteBody(), people: ['小林'], things: ['拉面店'], tags: ['拉面店', '周末', '面馆'] });
  const before = JSON.stringify(note);
  const list = keywordsFromNote(note);
  assert.equal(JSON.stringify(note), before);
  const byTerm = Object.fromEntries(list.map(item => [item.term, item]));
  assert.equal(byTerm['小林'].weight, MEMORY_KEYWORDS_KNOBS.write.fromPerson);
  assert.equal(byTerm['小林'].kind, 'person');
  assert.equal(byTerm['拉面店'].weight, MEMORY_KEYWORDS_KNOBS.write.fromThing, 'a thing that is also a tag keeps the higher weight');
  assert.equal(byTerm['面馆'].weight, MEMORY_KEYWORDS_KNOBS.write.fromTag);
  assert.equal(list.filter(item => item.term === '拉面店').length, 1);
  assert.ok(list[0].weight >= list[list.length - 1].weight);
});

test('vague tags in an old note are not turned into keywords', () => {
  assert.deepEqual(keywordsFromNote({ people: [], things: [], tags: ['日常', '聊天', '今天'] }), []);
});

// ---- matching ----
function sample(): KeywordIndex {
  const index = new KeywordIndex();
  index.set('chat:ramen', 'chat', T0 - 3 * DAY, [kw('一兰', 'place', 0.9, ['那家拉面店']), kw('拉面', 'topic', 0.3)]);
  index.set('watch:letter', 'watch', T0 - DAY, [kw('夜航船', 'work', 0.9, ['Night Ferry']), kw('林默', 'person', 0.8), kw('信封', 'object', 0.5)]);
  index.set('chat:exam', 'chat', T0 - 10 * DAY, [kw('期末考试', 'event', 0.9), kw('复习', 'topic', 0.3)]);
  return index;
}

test('the user\'s words find a note by its term or by an alias, without any model', () => {
  const index = sample();
  assert.deepEqual(index.match(['上次说的那家拉面店后来去了吗'], T0).map(item => item.noteId), ['chat:ramen']);
  assert.deepEqual(index.match(['还记得 night ferry 里拿信封的人吗'], T0).map(item => item.noteId), ['watch:letter']);
});

test('the two lines before can supply the thing a short message points at, at a lower weight', () => {
  const index = sample();
  assert.deepEqual(index.match(['那后来呢'], T0), []);
  const hit = index.match(['那后来呢', '我们昨天聊的林默', '嗯'], T0);
  assert.deepEqual(hit.map(item => item.noteId), ['watch:letter']);
  const now = index.match(['林默后来呢'], T0)[0];
  assert.ok(now.score > hit[0].score, 'the same name said just now counts for more than one said earlier');
  assert.equal(index.match(['那后来呢', 'x', 'y', '林默'], T0).length, 0, 'only the previous two lines are looked at');
});

test('a person or a work beats a loose topic; one vague tag alone is not enough but two together are', () => {
  const index = new KeywordIndex();
  index.set('a', 'chat', T0, [kw('小林', 'person', 0.9)]);
  index.set('b', 'chat', T0, [kw('周末', 'topic', 0.3)]);
  index.set('c', 'chat', T0, [kw('周末', 'topic', 0.3), kw('电影', 'topic', 0.3)]);
  assert.deepEqual(index.match(['小林在吗'], T0).map(item => item.noteId), ['a']);
  assert.deepEqual(index.match(['周末'], T0), []);
  assert.deepEqual(index.match(['周末看电影'], T0).map(item => item.noteId), ['c']);
});

test('newer notes win over older ones, and very old ones are not buried completely', () => {
  const index = new KeywordIndex();
  index.set('old', 'chat', T0 - 400 * DAY, [kw('小林', 'person', 0.9)]);
  index.set('new', 'chat', T0 - DAY, [kw('小林', 'person', 0.9)]);
  const hits = index.match(['小林最近怎么样'], T0);
  assert.deepEqual(hits.map(item => item.noteId), ['new', 'old']);
  assert.ok(hits[1].score >= MEMORY_KEYWORDS_KNOBS.match.minScore);
});

test('at most the chat memory\'s own limit of notes come back, best first', () => {
  const index = new KeywordIndex();
  for (let i = 0; i < 10; i++) index.set(`n${i}`, 'chat', T0 - i * DAY, [kw('小林', 'person', 0.9 - i * 0.01)]);
  const hits = index.match(['小林'], T0, 99);
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map(item => item.noteId), ['n0', 'n1', 'n2']);
});

test('deleting a note removes its keywords: nothing finds it any more, and the file no longer holds it', () => {
  const index = sample();
  assert.equal(index.remove('watch:letter'), true);
  assert.deepEqual(index.match(['夜航船里的林默'], T0), []);
  assert.equal(JSON.stringify(index.toFile()).includes('夜航船'), false);
  assert.equal(index.removeSource('chat'), 2);
  assert.equal(index.size, 0);
});

test('matching is fast: a thousand notes in a few milliseconds', () => {
  const index = new KeywordIndex();
  for (let i = 0; i < 1000; i++) index.set(`n${i}`, 'chat', T0 - i * DAY / 10, [kw(`词语${i}号`, 'topic', 0.5), kw(`人物${i}`, 'person', 0.9), kw(`地方${i}处`, 'place', 0.6)]);
  const started = performance.now();
  for (let i = 0; i < 20; i++) index.match(['还记得人物77和地方88处吗', '昨天', '好的'], T0);
  assert.ok((performance.now() - started) / 20 < 25, 'under 25 ms per message even on a slow machine');
});

test('the index file round-trips, and a damaged or foreign file is just an empty index', () => {
  const index = sample();
  const again = KeywordIndex.fromFile(JSON.parse(JSON.stringify(index.toFile())));
  assert.deepEqual(again.match(['夜航船'], T0).map(item => item.noteId), ['watch:letter']);
  assert.equal(KeywordIndex.fromFile(null).size, 0);
  assert.equal(KeywordIndex.fromFile({ version: 99, records: [] }).size, 0);
  assert.equal(KeywordIndex.fromFile({ version: 1, records: [{ noteId: 'x', source: 'chat', at: T0, keywords: [{ term: '今天', kind: 'topic', weight: 1 }] }, 7, null] }).size, 0);
});

// ---- files ----
test('keyword index store: saved per character, changed one note at a time, forgotten with the character', async () => {
  await temp(async dir => {
    const store = new KeywordIndexStore(dir);
    await store.update('char-a', index => index.set('chat:1', 'chat', T0, [kw('小林', 'person', 0.9)]));
    await store.update('char-b', index => index.set('chat:2', 'chat', T0, [kw('老王', 'person', 0.9)]));
    assert.deepEqual((await new KeywordIndexStore(dir).load('char-a')).match(['小林'], T0).map(item => item.noteId), ['chat:1']);
    assert.equal((await store.load('char-a')).match(['老王'], T0).length, 0, 'another character\'s keywords are not here');
    assert.equal(await store.removeNote('char-a', 'chat:1'), true);
    assert.equal((await new KeywordIndexStore(dir).load('char-a')).size, 0);
    await store.forgetCharacter('char-b');
    assert.equal((await store.load('char-b')).size, 0);
    assert.ok((await tree(dir)).every(file => !file.endsWith('.tmp')), 'no half-written files are left');
  });
});

test('two updates at once are both kept', async () => {
  await temp(async dir => {
    const store = new KeywordIndexStore(dir);
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.update('c', index => index.set(`n${i}`, 'chat', T0, [kw(`人物${i}号`, 'person', 0.9)]))));
    assert.equal((await store.load('c')).size, 8);
  });
});

test('character names cannot point outside the folder, and different names never share a file', () => {
  const a = characterKey('../../evil'), b = characterKey('..\\..\\evil');
  assert.doesNotMatch(a, /[\\/.]/);
  assert.notEqual(a, b);
  assert.throws(() => characterKey('  '));
});

// ---- watch notes and screenshots ----
function stores(dir: string, clock: { now: number }) {
  const keywords = new KeywordIndexStore(dir);
  const screenshots = new ScreenshotCache(dir, () => clock.now);
  const notes = new WatchNotesStore(dir, { keywords, screenshots });
  return { keywords, screenshots, notes };
}
const note = (id: string, at: number, text: string, keywords: Keyword[] = []) => ({ id, kind: 'frame' as const, at, text, keywords });
const FRAME = 'data:image/jpeg;base64,/9j/AAAA';

test('watch notes are saved with their keywords and found again by the user\'s words', async () => {
  await temp(async dir => {
    const { keywords, notes } = stores(dir, { now: T0 });
    assert.equal(await notes.add('char-a', note('f1', T0, '昏暗的走廊，一个人拿着信封。', [kw('信封', 'object', 0.9)])), true);
    assert.equal((await notes.list('char-a'))[0].text, '昏暗的走廊，一个人拿着信封。');
    const hits = (await keywords.load('char-a')).match(['那个信封是怎么回事'], T0);
    assert.deepEqual(hits.map(item => [item.noteId, item.source]), [[watchNoteKeywordId('f1'), 'watch']]);
    assert.equal((await new WatchNotesStore(dir).list('somebody-else')).length, 0);
  });
});

test('watch notes that are not acceptable are refused, and over the cap the oldest go with their keywords', async () => {
  await temp(async dir => {
    const { keywords } = stores(dir, { now: T0 });
    const notes = new WatchNotesStore(dir, { keywords }, { screenshotMinutes: 30, keptNotes: 2 });
    assert.equal(await notes.add('c', note('../x', T0, '路径')), false);
    assert.equal(await notes.add('c', note('ok', T0, '   ')), false);
    await notes.add('c', note('n1', T0 + 1, '第一条', [kw('第一个人', 'person', 0.9)]));
    await notes.add('c', note('n2', T0 + 2, '第二条', [kw('第二个人', 'person', 0.9)]));
    await notes.add('c', note('n3', T0 + 3, '第三条', [kw('第三个人', 'person', 0.9)]));
    assert.deepEqual((await notes.list('c')).map(item => item.id), ['n2', 'n3']);
    const index = await keywords.load('c');
    assert.equal(index.has(watchNoteKeywordId('n1')), false);
    assert.equal(index.has(watchNoteKeywordId('n3')), true);
  });
});

test('forgetting removes the notes, their keywords and the screenshots, and leaves other kinds of memory alone', async () => {
  await temp(async dir => {
    const clock = { now: T0 };
    const { keywords, screenshots, notes } = stores(dir, clock);
    await keywords.update('char-a', index => index.set('chat:1', 'chat', T0, [kw('小林', 'person', 0.9)]));
    await notes.add('char-a', note('f1', T0, '走廊', [kw('信封', 'object', 0.9)]));
    await notes.add('other', note('o1', T0, '别的角色的', [kw('雨伞', 'object', 0.9)]));
    await screenshots.put('char-a', 'f1', FRAME, T0);
    await screenshots.put('other', 'o1', FRAME, T0);
    await notes.forget('char-a');
    assert.deepEqual(await notes.list('char-a'), []);
    assert.equal(await screenshots.get('char-a', 'f1'), null);
    const index = await keywords.load('char-a');
    assert.deepEqual([index.size, index.has('chat:1')], [1, true]);
    assert.equal((await notes.list('other')).length, 1);
    assert.equal(await screenshots.get('other', 'o1'), FRAME);
    const files = (await tree(dir)).filter(file => file.includes(characterKey('char-a')));
    assert.deepEqual(files, [path.join('memory-keywords', `${characterKey('char-a')}.json`)]);
  });
});

test('screenshots live for the configured time and not a minute longer', async () => {
  await temp(async dir => {
    const clock = { now: T0 };
    const { screenshots } = stores(dir, clock);
    assert.equal(await screenshots.put('c', 's1', FRAME, T0), true);
    clock.now = T0 + 29 * MIN;
    assert.equal(await screenshots.get('c', 's1'), FRAME);
    clock.now = T0 + 30 * MIN;
    assert.equal(await screenshots.get('c', 's1'), null);
    assert.deepEqual(await tree(dir), [], 'an expired frame is deleted when it is asked for');
  });
});

test('sweeping deletes expired frames in every character\'s folder and keeps the young ones', async () => {
  await temp(async dir => {
    const clock = { now: T0 };
    const { screenshots } = stores(dir, clock);
    await screenshots.put('a', 'old', FRAME, T0);
    await screenshots.put('b', 'old2', FRAME, T0 + MIN);
    clock.now = T0 + 20 * MIN;
    await screenshots.put('a', 'young', FRAME, clock.now);
    clock.now = T0 + 40 * MIN;
    assert.equal(await screenshots.sweep(), 2);
    assert.equal(await screenshots.get('a', 'young'), FRAME);
    assert.equal((await tree(dir)).length, 1, 'the empty folder of the other character is gone too');
  });
});

test('screenshots refuse unsafe ids, things that are not images and frames already expired; nothing is written outside the folder', async () => {
  await temp(async dir => {
    const clock = { now: T0 + 60 * MIN };
    const { screenshots } = stores(dir, clock);
    assert.equal(await screenshots.put('c', '../escape', FRAME, clock.now), false);
    assert.equal(await screenshots.put('c', 'a/b', FRAME, clock.now), false);
    assert.equal(await screenshots.put('c', 'text', 'hello', clock.now), false);
    assert.equal(await screenshots.put('c', 'late', FRAME, T0), false);
    assert.deepEqual(await tree(dir), []);
    await screenshots.put('c', 'fine', FRAME, clock.now);
    for (const file of await tree(dir)) assert.ok(file.startsWith('watch-screens'), file);
    assert.ok((await stat(path.dirname(dir))).isDirectory());
    assert.match(await readFile(path.join(dir, (await tree(dir))[0]), 'utf8'), /^data:image\/jpeg/);
  });
});
