/**
 * I-208 step 3, her object and her margin notes: a card declares an object (Gene: 《地球投递须知》, 32 fixed entries); she writes her own notes with a hidden marker (never shown, kept once with the
 * date, per character, never exported); each turn she reads one fact line; the words touching the book bring a few entries and notes; the archive page lists them and the
 * user can edit or delete a note (a delete goes into the recycle bin first). Made-up cards and temporary folders only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { CARD_OBJECT_LIMITS, NOTE_LIMITS, RECALL_LIMITS, cleanNoteText, isNearDuplicate, isObjectNoteRequest, noteDateText, objectFactLine, objectMaterial, parseNoteMarker,
  planNewNotes, recallObject, validateCardObject } from '../shared/cards/card-objects';
import { SpeechBeatFilter, filterSpeechBeats } from '../shared/behaviors/speech-beats/choose';
import { ALARM_MARK_CLOSE, ALARM_MARK_OPEN } from '../shared/behaviors/alarms/interface';
import { CharacterCardStore, parseCharacterCardText } from '../electron/cards/character-cards';
import { preinstalledGeneDraft } from '../electron/cards/gene-preinstalled-card';
import { compileCharacterPersona, defaultCharacterMoodTemplate, validateCharacterDraft, type CharacterDraft } from '../shared/cards/character-cards';
import { cardUpdateSummaryLines, planCharacterCardUpdate } from '../shared/cards/character-card-update';
import { defaultCharacterResponseProfile } from '../shared/cards/character-response';
import { exportCharacterWithResponse } from '../shared/cards/character-response-portable';
import { RelationshipHost } from '../electron/memory/relationship/host';
import { readObjectNotes, validateRelationship } from '../electron/memory/relationship/store';
import { emptyRelationship, type ObjectNote } from '../shared/memory/relationship';
import { objectNoteRequest, objectReplyDone, objectTurnText } from '../electron/wiring/card-objects-wiring';
import { ITEM_RESTORERS, takeObjectNote } from '../electron/memory/recycle/items-wiring';
import { objectArchiveItems } from '../electron/memory/archive/object-items';
import { CharacterArchiveReader, type ArchivePorts } from '../electron/memory';
import { CharacterArchivePanel } from '../src/cards/CharacterArchive';
import { ARCHIVE_KINDS, type CharacterArchiveView } from '../shared/memory/archive';
import { setUiLanguage } from '../shared/foundation/ui-language';

const zhCard = { name: '小满', description: '住在桌面上的伙伴。', personality: '温和，爱笑。', scenario: '刚认识。', greeting: '你好呀。', examples: '', systemPrompt: '' };
const draft = (extra: Record<string, unknown> = {}): CharacterDraft => validateCharacterDraft({ ...zhCard, mood: defaultCharacterMoodTemplate(), ...extra });
const BOOK = { name: '地球投递须知', entries: [
  { page: 5, text: '下雨：地球上重要的话只能在雨里说。', source: '肥皂剧' },
  { page: 12, text: '鸽子：监视设备，头一点一点就是在对焦。', source: '阴谋论电台' },
  { page: 17, text: '天气：地球的天气由一位站在地图前的人决定。', source: '天气预报' },
  { page: 36, text: '星期一：一周里有一天叫星期一，大家都怕它。' },
] };
const EN_BOOK = { name: 'Earth Delivery Notes', entries: [{ page: 3, text: 'Pigeons: surveillance devices, the nodding is focusing.', source: 'conspiracy radio' }, { page: 4, text: 'Weather: decided by one person in front of a map.' }] };
async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-object-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
const at = (month: number, day: number) => new Date(2026, month - 1, day, 12).getTime();
const mark = (body: string) => `${ALARM_MARK_OPEN}${body}${ALARM_MARK_CLOSE}`;
function hostIn(directory: string, clock: { now: number }): RelationshipHost { return new RelationshipHost({ directory, now: () => clock.now, developerMode: () => false }); }
const OFFICIAL = BOOK.entries.map(entry => entry.page);
const geneCard = (id = 'gene') => ({ id, object: BOOK });

// ---- the declaration ----
test('the declaration: a name and 1..64 entries (page, text, optional source); anything else is refused; entries come back in page order', () => {
  const ok = validateCardObject({ name: ' 地球投递须知 ', entries: [{ page: 12, text: '鸽子：监视设备。', source: '电台' }, { page: 3, text: '问候：吃了吗。' }] });
  assert.equal(ok.name, '地球投递须知'); assert.deepEqual(ok.entries.map(entry => entry.page), [3, 12]);
  assert.deepEqual(validateCardObject(BOOK), BOOK);
  const entry = { page: 1, text: '一条。' };
  const bad: unknown[] = [null, 'x', [], {}, { name: '书' }, { name: '书', entries: [] }, { name: '', entries: [entry] }, { name: 'a'.repeat(CARD_OBJECT_LIMITS.name + 1), entries: [entry] },
    { name: '书', entries: [entry], notes: ['她的批注'] }, { name: '书', entries: [{ ...entry, extra: 1 }] }, { name: '书', entries: [{ page: 0, text: 'x' }] }, { name: '书', entries: [{ page: 1000, text: 'x' }] },
    { name: '书', entries: [{ page: 1.5, text: 'x' }] }, { name: '书', entries: [{ page: '1', text: 'x' }] }, { name: '书', entries: [{ page: 1, text: 'a' }, { page: 1, text: 'b' }] },
    { name: '书', entries: [{ page: 1, text: '' }] }, { name: '书', entries: [{ page: 1, text: 'a'.repeat(CARD_OBJECT_LIMITS.entryChars + 1) }] },
    { name: '书', entries: [{ page: 1, text: 'x', source: 'a'.repeat(CARD_OBJECT_LIMITS.sourceChars + 1) }] }, { name: '书', entries: [{ page: 1, text: 'x', source: 5 }] },
    { name: '书', entries: Array.from({ length: CARD_OBJECT_LIMITS.entries + 1 }, (_, index) => ({ page: index + 1, text: 'x' })) },
    { name: '书', entries: [{ page: 1, text: 'line\nbreak' }] }, { name: '书', entries: [{ page: 1, text: `x ${mark('note|9|x')}` }] }, { name: '书', entries: [{ page: 1, text: '⟦marker' }] },
    { name: '书', entries: [{ page: 1, text: '<b>x</b>' }] }, { name: '书', entries: [{ page: 1, text: 'a|b' }] }, { name: '书', entries: [{ page: 1, text: '【词】' }] }, { name: '书\u0007', entries: [entry] }];
  for (const value of bad) assert.throws(() => validateCardObject(value), /./su, JSON.stringify(value)?.slice(0, 80));
  assert.equal(validateCardObject({ name: '书', entries: Array.from({ length: CARD_OBJECT_LIMITS.entries }, (_, index) => ({ page: index + 1, text: 'x' })) }).entries.length, 64);
});

test('on a card: the declaration is part of the draft, not of the persona (not a byte more), and a bad one refuses the card', () => {
  const plain = draft(), withBook = draft({ object: BOOK });
  assert.deepEqual(withBook.object, BOOK); assert.equal(Object.hasOwn(plain, 'object'), false);
  assert.equal(compileCharacterPersona(withBook), compileCharacterPersona(plain));
  assert.throws(() => draft({ object: { name: '', entries: [] } }), /物件/);
});

// ---- Gene's bundled card ----
test('Gene: the bundled card declares 《地球投递须知》 with all 32 entries exactly as in the draft (page 12 kept), and her persona is byte for byte what it was', () => {
  const gene = preinstalledGeneDraft();
  assert.equal(gene.object?.name, '地球投递须知'); assert.equal(gene.object?.entries.length, 32);
  // The entries were generated row by row from the draft the user kept (docs/claude/2026-11-24-gene-handbook-draft.md, 32 of 32) and checked then; the hash pins them so a later edit shows.
  assert.equal(createHash('sha256').update(JSON.stringify(gene.object?.entries)).digest('hex'), '617101890afa4e28b8ed92716e2edca47cd424132c9e86033a9cf6f24d7a9b00', 'the entries are the draft the user kept (32 of 32)');
  assert.deepEqual(gene.object?.entries.map(entry => entry.page), [1, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 23, 24, 26, 27, 29, 30, 32, 33, 35, 36, 38, 39, 41, 42, 44, 45, 47, 50]);
  assert.deepEqual(gene.object?.entries.find(entry => entry.page === 12), { page: 12, text: '鸽子：监视设备，头一点一点就是在对焦。', source: '阴谋论电台' });
  // 2026-11-24 (user "带上"): the bundled Gene also declares the I-207 milestone, which she had never carried; it is left out of the persona pin like the object.
  assert.deepEqual(gene.milestone, { name: '这一单', notYet: '还没签收', reached: '已签收' });
  const { object: _object, milestone: _milestone, ...rest } = gene;
  const persona = createHash('sha256').update(JSON.stringify({ ...rest, persona: compileCharacterPersona(gene) })).digest('hex');
  assert.equal(persona, 'c655701f42f8d392c54d080d3bd3300d48dbf8f20db72c5097088672776db6a1', 'her words, mood and voice are untouched: only the object and the milestone were added');
});

// ---- the marker ----
test('the marker: note|page|words or note|words; everything else is not a note', () => {
  assert.deepEqual(parseNoteMarker('note|12|搭档说灯会灭'), { page: 12, text: '搭档说灯会灭' });
  assert.deepEqual(parseNoteMarker(' Note | 12 | 搭档说灯会灭 '), { page: 12, text: '搭档说灯会灭' });
  assert.deepEqual(parseNoteMarker('note|搭档说灯会灭'), { page: null, text: '搭档说灯会灭' });
  assert.deepEqual(parseNoteMarker('note|114514|第一百一十四页'), { page: 114514, text: '第一百一十四页' }, 'any page she likes');
  assert.deepEqual(parseNoteMarker('note|999999999|x'), { page: 999999999, text: 'x' }, 'the cap itself is fine');
  assert.deepEqual(parseNoteMarker('note|2026 年的事'), { page: null, text: '2026 年的事' }, 'a number inside the words is not a page');
  for (const not of ['note', 'note|', 'note||', 'note|12|', 'note|0|x', 'note|1000000000|x', 'notes|x', 'milestone', 'alarm|in=5m', '', 5, null, undefined, 'x note|y'])
    assert.equal(parseNoteMarker(not), null, String(not));
  assert.equal(cleanNoteText('a\nb|c⟦d⟧ e'), 'a b c d e', 'line breaks and bracket characters become spaces');
  assert.equal(Array.from(cleanNoteText('字'.repeat(NOTE_LIMITS.chars + 40))).length, NOTE_LIMITS.chars, 'cut at the limit');
  assert.equal(noteDateText('2026-11-23', 'zh-CN'), '11月23日'); assert.equal(noteDateText('2026-11-23', 'en'), 'Nov 23'); assert.equal(noteDateText('x', 'en'), '');
});

test('the marker never reaches the text in any chunking (chat, call and Unbound use the same filter), and its body is handed over', () => {
  const body = 'note|12|搭档说灯会灭，而且鸽子会点头';
  const reply = `好的，我记下了。${mark(body)}你继续说。`;
  const whole = filterSpeechBeats(reply);
  assert.equal(whole.text, '好的，我记下了。你继续说。'); assert.deepEqual(whole.alarms, [body]);
  for (let cut = 1; cut < reply.length; cut++) {
    const filter = new SpeechBeatFilter();
    const shown = filter.push(reply.slice(0, cut)).text + filter.push(reply.slice(cut)).text + filter.end().text;
    assert.equal(shown, '好的，我记下了。你继续说。', `cut at ${cut}`);
    assert.deepEqual(filter.summary().alarms, [body]);
  }
  // Every other way in is one filter: the three paths build it from the same module (a source check, so a path with a filter of its own would show up here).
  for (const file of ['electron/brain/speech-beats/turn.ts']) assert.match(readFileSync(file, 'utf8'), /SpeechBeatFilter|filterSpeechBeats/u, file);
  // A note and a milestone marker in one reply; a long note (the filter reads up to 400 characters of a marker); one never closed is gone and not read.
  const long = `note|${'字'.repeat(NOTE_LIMITS.chars)}`, many = filterSpeechBeats(`甲${mark('milestone')}乙${mark(long)}丙${mark('note|书')}`);
  assert.equal(many.text, '甲乙丙'); assert.equal(many.alarms?.length, 3);
  const open = filterSpeechBeats(`好。${ALARM_MARK_OPEN}note|3|没写完`);
  assert.equal(open.text, '好。'); assert.deepEqual(open.alarms, []);
});

// ---- recorded once, per character ----
test('notes: kept with the local date in her own file; the same reply twice records once; near-duplicates, the per-reply cap and the stored cap hold', async () => {
  await withDirectory(async directory => {
    const clock = { now: at(11, 23) }, host = hostIn(directory, clock);
    assert.deepEqual(await host.objectNotes('gene'), []);
    assert.equal(await host.addObjectNotes('gene', ['note|12|搭档说灯会灭', 'milestone', 'alarm|in=5m']), 1, 'only a note marker is a note');
    assert.equal(await host.addObjectNotes('gene', ['note|12|搭档说灯会灭'], OFFICIAL), 0, 'the same words again record nothing');
    assert.equal(await host.addObjectNotes('gene', ['note|第 12 页：搭档说灯会灭！']), 0, 'near-duplicate (punctuation and a prefix)');
    clock.now = at(11, 28);
    assert.equal(await host.addObjectNotes('gene', ['note|大锅接信号，雪花是在下雪', 'note|13|彩虹是进度条的另一半', 'note|14|周一其实有两个']), 2, 'at most two per reply');
    const notes = await host.objectNotes('gene');
    assert.deepEqual(notes.map(note => [note.date, note.page, note.text]), [['2026-11-23', 12, '搭档说灯会灭'], ['2026-11-28', null, '大锅接信号，雪花是在下雪'], ['2026-11-28', 13, '彩虹是进度条的另一半']]);
    assert.ok(notes.every(note => /^[\w-]{1,64}$/u.test(note.id)) && new Set(notes.map(note => note.id)).size === 3);
    await host.flush();
    const again = hostIn(directory, clock);
    assert.deepEqual((await again.objectNotes('gene')).map(note => note.text), notes.map(note => note.text), 'it survives a restart');
    await again.flush();
    // The stored cap, with a small limit (the real one is 300): nothing is dropped to make room.
    const planned = planNewNotes(['已有一条', '已有两条'], ['note|新的一条', 'note|新的两条'], { perReply: 5, stored: 3 });
    assert.deepEqual(planned.map(note => note.text), ['新的一条']);
    assert.equal(planNewNotes([], Array.from({ length: 5 }, (_, index) => `note|第${index}条完全不同的话${'abcdef'[index]}`)).length, NOTE_LIMITS.perReply);
    assert.ok(isNearDuplicate('鸽子是监视设备', '鸽子是监视设备。') && !isNearDuplicate('鸽子是监视设备', '星期一最守时'));
  });
});

test('a card without an object records nothing and writes no file; notes belong to the character they were written for', async () => {
  await withDirectory(async directory => {
    const clock = { now: at(11, 23) }, host = hostIn(directory, clock);
    assert.equal(await objectReplyDone({ id: 'plain' }, host, ['note|12|不该记下']), 0);
    assert.equal(await objectReplyDone({ id: 'gene', object: BOOK }, host, undefined), 0);
    assert.equal(await objectReplyDone({ id: 'gene', object: BOOK }, host, ['milestone']), 0, 'another marker is not a note');
    await host.flush();
    assert.deepEqual(await readdir(directory).catch(() => []), [], 'nothing was written');
    assert.equal(await objectReplyDone({ id: 'gene', object: BOOK }, host, ['note|12|搭档说灯会灭']), 1);
    assert.deepEqual((await host.objectNotes('someone-else')).map(note => note.text), [], 'Gene\'s notes are not someone else\'s');
    const other = { id: 'other', object: BOOK };
    const turnOfOther = await objectTurnText(other, host, '鸽子是什么？');
    assert.ok(!turnOfOther.includes('搭档说灯会灭') && /你的批注 0 条/u.test(turnOfOther), turnOfOther);
    const turnOfGene = await objectTurnText(geneCard(), host, '鸽子是什么？');
    assert.ok(turnOfGene.includes('搭档说灯会灭') && /你的批注 1 条/u.test(turnOfGene), turnOfGene);
    assert.equal(await objectTurnText({ id: 'plain' }, host, '鸽子'), '', 'not a byte for a card without one');
    await host.flush();
  });
});

test('her file: a damaged note is left out, never refuses the file; words with a line break cannot reach her prompt; a converted character does not take them', async () => {
  const good = { id: 'abc', date: '2026-11-23', page: 12, text: '搭档说灯会灭' };
  assert.deepEqual(readObjectNotes([good, { ...good, id: 'abc' }, { ...good, id: 'x y' }, { ...good, id: 'b', date: '2026-13-40' }, { ...good, id: 'c', page: 0 }, { ...good, id: 'd', text: '两行\n第二行' },
    { ...good, id: 'e', text: '' }, { ...good, id: 'f', text: `带${ALARM_MARK_OPEN}记号` }, null, 'x', { ...good, id: 'g', page: null }]).map(note => note.id), ['abc', 'g']);
  assert.deepEqual(readObjectNotes('nope'), []);
  const data = { ...emptyRelationship('2026-11-01'), objectNotes: [good, { ...good, id: 'bad', text: 'x\ny' }] };
  assert.deepEqual(validateRelationship(data).objectNotes, [good]);
  await withDirectory(async directory => {
    const host = hostIn(directory, { now: at(11, 23) });
    await host.adopt('converted', { ...emptyRelationship('2026-11-01'), days: ['2026-11-02'], objectNotes: [good] });
    assert.deepEqual(await host.objectNotes('converted'), [], 'what she wrote in her margin stays with the character it was written for');
    await host.flush();
  });
});

// ---- the turn ----
test('the turn: one fact line in the card\'s language (no instruction), nothing for a card without an object', () => {
  const zh = objectFactLine(BOOK, 3, 'zh-CN'), en = objectFactLine(EN_BOOK, 0, 'en');
  assert.ok(zh.includes('《地球投递须知》') && zh.includes('4 条条目') && zh.includes('你的批注 3 条') && zh.includes('⟪note|12|批注的话⟫') && zh.includes('⟪note|批注的话⟫') && zh.includes('这个记号不显示'), zh);
  assert.ok(en.includes('“Earth Delivery Notes”') && en.includes('2 entries') && en.includes('0 margin notes') && en.includes('⟪note|12|your words⟫') && en.includes('never shown'), en);
  for (const line of [zh, en]) assert.ok(!/应该|必须|请你|不要|记得要|you should|you must|please |do not|don't/iu.test(line), 'nothing that tells her how to act: ' + line);
  assert.ok(!/[一-鿿]/u.test(en), 'an English card\'s line is English');
  assert.equal(parseNoteMarker(zh.match(/⟪(note\|12\|[^⟫]+)⟫/u)![1]!.replace('批注的话', '一句话'))?.page, 12, 'the shape she is shown is the shape that is read');
});

test('prompt length: the line is short, and it is not the book (numbers for the record)', async () => {
  const gene = preinstalledGeneDraft().object!;
  const line = objectFactLine(gene, 0, 'zh-CN'), book = gene.entries.map(entry => `第 ${entry.page} 页 ${entry.text}（依据：${entry.source}）`).join('\n');
  const ask = await objectTurnText({ id: 'g', object: gene }, { objectNotes: async () => [] } as never, '今天好无聊啊');
  const touch = await objectTurnText({ id: 'g', object: gene }, { objectNotes: async () => [] } as never, '你知道鸽子是什么吗');
  console.log(`I-208 prompt numbers: fact line ${Array.from(line).length} chars; unrelated sentence adds ${Array.from(ask).length}; a sentence touching one entry adds ${Array.from(touch).length}; the whole book would be ${Array.from(book).length}; persona ${compileCharacterPersona(preinstalledGeneDraft()).length}`);
  assert.equal(ask, line, 'a sentence that touches nothing adds only the line');
  assert.ok(Array.from(line).length < 140 && Array.from(book).length > 1800 && Array.from(touch).length < Array.from(book).length / 3);
});

test('retrieval: the words touching an entry (its head word, its page, rare words it shares) bring it, with her notes; an unrelated sentence brings nothing; a few at most', () => {
  const notes = [
    { page: 12, date: '2026-11-23', text: '鸽子的点头其实是在对焦' }, { page: null, date: '2026-11-24', text: '大锅可以接信号，雪花是在下雪' },
    { page: 17, date: '2026-11-25', text: '天气先生今天心情不好' }, { page: 99, date: '2026-11-25', text: '这一页是我自己加的' },
  ];
  const ids = (message: string) => recallObject(BOOK, notes, message);
  assert.deepEqual(ids('你知道鸽子是什么吗').entries.map(entry => entry.page), [12]);
  assert.deepEqual(ids('今天天气好冷').entries.map(entry => entry.page), [17]);
  assert.deepEqual(ids('手册第 12 页写了什么？').entries.map(entry => entry.page), [12]);
  assert.deepEqual(ids('手册第 12 页写了什么？').notes.map(note => note.text), ['鸽子的点头其实是在对焦'], 'the note of that page comes with it');
  assert.deepEqual(ids('what does page 12 say').entries.map(entry => entry.page), [12]);
  assert.deepEqual(ids('大锅接信号的事是怎么回事').notes.map(note => note.text), ['大锅可以接信号，雪花是在下雪'], 'her own notes are found by what they say');
  for (const unrelated of ['我们去吃火锅吧', '今天好无聊啊', '你好', '', '   ', '一个人在家有点孤单']) { const found = ids(unrelated); assert.equal(found.entries.length + found.notes.length, 0, unrelated); }
  const crowded = recallObject({ name: '书', entries: Array.from({ length: 20 }, (_, index) => ({ page: index + 1, text: `猫${index}：猫的条目${index}` })) }, Array.from({ length: 20 }, (_, index) => ({ page: null, date: '2026-11-23', text: `猫的批注${index}` })), '猫猫猫，第1页，第2页，第3页，第4页，第5页');
  assert.ok(crowded.entries.length <= RECALL_LIMITS.entries && crowded.notes.length <= RECALL_LIMITS.notes, 'capped');
  const text = objectMaterial(BOOK, ids('手册第 12 页写了什么？'), 'zh-CN');
  assert.equal(text, '《地球投递须知》里翻到的：\n第 12 页 鸽子：监视设备，头一点一点就是在对焦。（依据：阴谋论电台）\n你的批注（11月23日，第 12 页）：鸽子的点头其实是在对焦');
  assert.equal(objectMaterial(BOOK, { entries: [], notes: [] }, 'zh-CN'), '');
  const english = objectMaterial(EN_BOOK, recallObject(EN_BOOK, [{ page: 3, date: '2026-11-23', text: 'the nodding means focus' }], 'tell me about pigeons'), 'en');
  assert.equal(english, 'From “Earth Delivery Notes”:\nPage 3: Pigeons: surveillance devices, the nodding is focusing. (source: conspiracy radio)\nYour margin note (Nov 23, p. 3): the nodding means focus');
});

test('the chat turn: the text she gets is the line, plus the few things touched; a failing file never stops the turn', async () => {
  await withDirectory(async directory => {
    const host = hostIn(directory, { now: at(11, 23) });
    const quiet = await objectTurnText(geneCard(), host, '今天好无聊啊');
    assert.equal(quiet, objectFactLine(BOOK, 0, 'zh-CN'));
    await host.addObjectNotes('gene', ['note|12|搭档说灯会灭'], OFFICIAL);
    const touched = await objectTurnText(geneCard(), host, '鸽子怎么了');
    assert.ok(touched.startsWith(objectFactLine(BOOK, 1, 'zh-CN') + '\n《地球投递须知》里翻到的：') && touched.includes('第 12 页 鸽子') && touched.includes('你的批注（11月23日，第 12 页）：搭档说灯会灭'), touched);
    assert.ok(!touched.includes('星期一') && !touched.includes('天气'), 'not the book');
    assert.equal(await objectTurnText(geneCard(), { objectNotes: async () => { throw Error('unreadable'); } } as never, '鸽子'), '');
    await host.flush();
  });
});

// ---- the user's edit and delete ----
test('edit and delete: only for a card with an object; a delete takes the note into the bin first, then removes it; restoring puts it back; an unknown note changes nothing', async () => {
  await withDirectory(async directory => {
    const host = hostIn(directory, { now: at(11, 23) });
    await host.addObjectNotes('gene', ['note|12|搭档说灯会灭', 'note|大锅接信号'], OFFICIAL);
    const [first, second] = await host.objectNotes('gene');
    const order: string[] = [];
    const recycled = async (take: () => Promise<unknown>, remove: () => Promise<unknown>) => { order.push('take:' + JSON.stringify(await take())); await remove(); order.push('removed'); };
    const cardOf = (id: string) => id === 'gene' ? geneCard() : id === 'plain' ? { id: 'plain' } : undefined;
    const take = (id: string) => takeObjectNote({ relationship: host } as never, 'gene', id);
    assert.deepEqual(await objectNoteRequest({ action: 'object-note-edit', characterId: 'gene', id: first!.id, text: '搭档说灯会灭，改过了' }, cardOf, host, recycled, take), { changed: true });
    assert.equal((await host.objectNotes('gene'))[0]!.text, '搭档说灯会灭，改过了'); assert.equal((await host.objectNotes('gene'))[0]!.date, '2026-11-23', 'its date stays');
    assert.deepEqual(await objectNoteRequest({ action: 'object-note-edit', characterId: 'gene', id: first!.id, text: '   ' }, cardOf, host, recycled, take), { changed: false }, 'empty words change nothing');
    assert.deepEqual(await objectNoteRequest({ action: 'object-note-edit', characterId: 'gene', id: 'nope', text: 'x' }, cardOf, host, recycled, take), { changed: false });
    assert.deepEqual(await objectNoteRequest({ action: 'object-note-delete', characterId: 'plain', id: first!.id }, cardOf, host, recycled, take), { changed: false }, 'a card without an object');
    assert.deepEqual(await objectNoteRequest({ action: 'object-note-delete', characterId: 'nobody', id: first!.id }, cardOf, host, recycled, take), { changed: false });
    assert.deepEqual(order, []);
    assert.deepEqual(await objectNoteRequest({ action: 'object-note-delete', characterId: 'gene', id: first!.id }, cardOf, host, recycled, take), { changed: true });
    assert.equal(order.length, 2); assert.match(order[0]!, /^take:\{"kind":"object-note","characterId":"gene","count":1,"label":"她写在页边的一条批注","itemAt":\d+,"data":\{"kind":"object-note","note":\{"id":"[\w-]+","date":"2026-11-23","page":12,"text":"搭档说灯会灭，改过了"\}\}\}$/u);
    assert.equal(order[1], 'removed', 'the bin copy is taken before the note is removed');
    assert.deepEqual((await host.objectNotes('gene')).map(note => note.id), [second!.id]);
    // Back from the bin: the same note, in its place; found twice it is not doubled.
    const taken = await take(second!.id) as unknown as { data: { note: unknown } };
    await host.removeObjectNote('gene', second!.id);
    assert.deepEqual(await host.objectNotes('gene'), []);
    await ITEM_RESTORERS['object-note']({ characterId: 'gene' } as never, taken.data as never, { stores: { relationship: host }, keep: () => null } as never);
    assert.deepEqual((await host.objectNotes('gene')).map(note => note.id), [second!.id]);
    assert.equal(await host.restoreObjectNote('gene', taken.data.note), false, 'not added twice');
    await assert.rejects(() => host.restoreObjectNote('gene', { id: 'x', date: 'garbled', page: 1, text: 'x' }), /不完整/);
    assert.equal(await take('missing'), null);
    await host.flush();
  });
});

test('the request shape: exactly the fields, nothing more', () => {
  assert.equal(isObjectNoteRequest({ action: 'object-note-edit', characterId: 'gene', id: 'a-b_1', text: '新的话' }), true);
  assert.equal(isObjectNoteRequest({ action: 'object-note-delete', characterId: 'gene', id: 'a-b_1' }), true);
  for (const bad of [null, [], 'x', {}, { action: 'object-note-delete', characterId: 'gene' }, { action: 'object-note-delete', characterId: 'gene', id: 'a', text: 'x' }, { action: 'object-note-edit', characterId: 'gene', id: 'a' },
    { action: 'object-note-edit', characterId: 'gene', id: 'a', text: 5 }, { action: 'object-note-delete', characterId: '', id: 'a' }, { action: 'object-note-delete', characterId: 'gene', id: '../x' },
    { action: 'object-note-delete', characterId: 'g\nene', id: 'a' }, { action: 'milestone-clear' }, { action: 'object-note-delete', characterId: 'gene', id: 'a', path: '/etc' }])
    assert.equal(isObjectNoteRequest(bad), false, JSON.stringify(bad));
});

// ---- the card: the entries travel, her notes never do ----
test('export keeps the object and none of her notes; import brings the object into a new card; a card file carrying notes is refused', async () => {
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'm');
    await store.load();
    const saved = (await store.save(draft({ object: BOOK }))).cards.find(item => item.name === '小满')!;
    assert.deepEqual(saved.object, BOOK);
    const relationship = hostIn(path.join(directory, 'profile'), { now: at(11, 23) });
    await relationship.addObjectNotes(saved.id, ['note|12|只属于我们的批注NOTE-SECRET']); await relationship.flush();
    const exported = store.export(saved.id), card = JSON.parse(exported).card;
    assert.deepEqual(card.object, BOOK); assert.deepEqual(Object.keys(card.object).sort(), ['entries', 'name']);
    assert.ok(!/NOTE-SECRET|objectNotes|批注/u.test(exported), 'her notes are not in the file');
    assert.deepEqual(parseCharacterCardText(exported).draft.object, BOOK);
    assert.equal((await store.import(exported)).cards.filter(item => item.name === '小满' && item.object).length, 2);
    const v3 = exportCharacterWithResponse(exported, { ...defaultCharacterResponseProfile(), rules: [] });
    assert.deepEqual(JSON.parse(v3).card.object, BOOK); assert.ok(!/NOTE-SECRET/u.test(v3));
    const file = (object: unknown, version = 2) => JSON.stringify({ format: 'soft-hearts-character-card', version, card: { ...zhCard, mood: defaultCharacterMoodTemplate(), object } });
    assert.throws(() => parseCharacterCardText(file({ ...BOOK, notes: [{ page: 1, text: '偷带的批注' }] })), /物件/);
    assert.throws(() => parseCharacterCardText(file({ name: '书', entries: [{ page: 1, text: 'x', note: 'y' }] })), /物件/);
    assert.throws(() => parseCharacterCardText(JSON.stringify({ format: 'soft-hearts-character-card', version: 1, card: { ...zhCard, object: BOOK } })), /未知字段/, 'v1 never had it');
    const { id, object: _gone, ...rest } = saved as CharacterDraft & { id: string; modelName?: string };
    assert.deepEqual((await store.save(validateCharacterDraft({ ...rest, greeting: '早呀。' }), id)).cards.find(item => item.id === id)!.object, BOOK, 'an editor save without the field keeps hers');
    assert.match(await readFile(path.join(directory, 'characters.json'), 'utf8'), /"object"/);
  });
});

test('an in-place update: a file with an object sets it, a file without keeps hers; her notes and memories stay; the confirmation says so', async () => {
  const current = { ...draft({ object: BOOK }), id: 'x' };
  const file = (extra?: Record<string, unknown>) => ({ format: 'soft-hearts-v2' as const, response: null, draft: draft(extra) });
  const replaced = planCharacterCardUpdate(current, defaultCharacterResponseProfile(), file({ object: EN_BOOK }));
  assert.equal(replaced.summary.object, 'replaced'); assert.deepEqual(replaced.draft.object, EN_BOOK); assert.equal(replaced.summary.unchanged, false);
  assert.ok(cardUpdateSummaryLines(replaced.summary).some(line => line.text === '她的物件：换成文件里的（她写的批注不变）。'));
  const kept = planCharacterCardUpdate(current, defaultCharacterResponseProfile(), file());
  assert.equal(kept.summary.object, 'kept'); assert.deepEqual(kept.draft.object, BOOK); assert.equal(kept.summary.unchanged, true);
  assert.equal(planCharacterCardUpdate(current, defaultCharacterResponseProfile(), file({ object: BOOK })).summary.object, 'same');
  const fresh = planCharacterCardUpdate(Object.assign(draft(), { id: 'y' }), defaultCharacterResponseProfile(), file({ object: BOOK }));
  assert.equal(fresh.summary.object, 'replaced', 'a card gaining one for the first time (existing Gene gets the handbook this way)');
  const none = planCharacterCardUpdate(Object.assign(draft(), { id: 'z' }), defaultCharacterResponseProfile(), file());
  assert.equal(none.summary.object, 'same'); assert.ok(!cardUpdateSummaryLines(none.summary).some(line => line.text.startsWith('她的物件')));
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'm');
    await store.load();
    const id = (await store.save(draft())).cards.find(item => item.name === '小满')!.id;
    const relationship = hostIn(path.join(directory, 'profile'), { now: at(11, 23) });
    await relationship.addObjectNotes(id, ['note|12|她早先写下的']); await relationship.flush();
    const plan = planCharacterCardUpdate(Object.assign({ ...store.getCard(id) }, { id }), defaultCharacterResponseProfile(), file({ object: BOOK }));
    await store.updateInPlace(id, plan.draft, { expected: store.cardFingerprint(id), backup: async () => {} });
    assert.deepEqual(store.getCard(id).object, BOOK, 'the same character now has the handbook');
    const reopened = hostIn(path.join(directory, 'profile'), { now: at(11, 23) });
    assert.deepEqual((await reopened.objectNotes(id)).map(note => note.text), ['她早先写下的'], 'her notes were not touched');
    await reopened.flush();
  });
});

// ---- pages she adds herself ----
test('her own pages: a page the book does not have is a new entry of hers (any number up to the cap), recorded once; a page that exists is a note on it', async () => {
  await withDirectory(async directory => {
    const clock = { now: at(11, 24) }, host = hostIn(directory, clock);
    assert.equal(await host.addObjectNotes('gene', ['note|33|地球的月亮是备用电池', 'note|114514|数字太大也没关系'], OFFICIAL), 2);
    assert.equal(await host.addObjectNotes('gene', ['note|33|地球的月亮是备用电池'], OFFICIAL), 0, 'the same page again records nothing');
    assert.equal(await host.addObjectNotes('gene', ['note|12|鸽子点头是在记笔记', 'note|33|月亮的电量只剩一半'], OFFICIAL), 2);
    assert.equal(await host.addObjectNotes('gene', ['note|1000000000|太大了', 'note|0|没有第零页'], OFFICIAL), 0, 'over the cap or no page: not recorded');
    const notes = await host.objectNotes('gene');
    assert.deepEqual(notes.map(note => [note.page, note.own === true]), [[33, true], [114514, true], [12, false], [33, false]], 'her page 33 is an entry, a second text on 33 is a note under it; page 12 is the official one');
    await host.flush();
    const again = hostIn(directory, clock);
    assert.deepEqual((await again.objectNotes('gene')).map(note => note.own === true), [true, true, false, false], 'it survives a restart');
    await again.flush();
    assert.equal(await host.addObjectNotes('gene', ['note|写在没有页码的话'], OFFICIAL), 1); assert.equal((await host.objectNotes('gene')).at(-1)!.own, undefined, 'no page: a note');
  });
});

test('her own pages are part of the book: found by page and by words, marked as hers with the day; her line counts them', async () => {
  const notes = [{ page: 114514, date: '2026-11-24', text: '月亮是备用电池，满月就是充满了', own: true }, { page: 12, date: '2026-11-23', text: '鸽子的点头其实是在对焦' }];
  const byPage = recallObject(BOOK, notes, '第 114514 页写了什么');
  assert.deepEqual(byPage.entries.map(entry => [entry.page, entry.ownDate]), [[114514, '2026-11-24']]);
  assert.deepEqual(recallObject(BOOK, notes, '月亮和电池是怎么回事').entries.map(entry => entry.page), [114514], 'by words');
  assert.deepEqual(recallObject(BOOK, notes, '鸽子').entries.map(entry => entry.page), [12], 'the official one is still found');
  assert.equal(objectMaterial(BOOK, byPage, 'zh-CN'), '《地球投递须知》里翻到的：\n第 114514 页（你添的，11月24日）月亮是备用电池，满月就是充满了');
  assert.equal(objectMaterial(EN_BOOK, recallObject(EN_BOOK, [{ page: 33, date: '2026-11-24', text: 'the moon is a spare battery', own: true }], 'what is on page 33'), 'en'), 'From “Earth Delivery Notes”:\nPage 33 (added by you, Nov 24): the moon is a spare battery');
  assert.ok(objectFactLine(BOOK, 1, 'zh-CN', 2).includes('6 条条目') && objectFactLine(BOOK, 1, 'zh-CN', 2).includes('你新添的一页'));
  assert.ok(objectFactLine(EN_BOOK, 0, 'en', 1).includes('3 entries') && objectFactLine(EN_BOOK, 0, 'en', 1).includes('new page of yours'));
  assert.deepEqual(recallObject(BOOK, [{ page: null, date: '2026-11-24', text: '随便', own: true }], '随便说说').entries, [], 'an own entry without a page is not a page');
});

test('her pages through the turn and the reply: a made-up page is recorded from the reply and met again on the next turn; never exported; kept across a card update', async () => {
  await withDirectory(async directory => {
    const host = hostIn(directory, { now: at(11, 24) });
    assert.equal(await objectReplyDone(geneCard(), host, ['note|33|地球的月亮是备用电池', 'note|12|鸽子在记笔记']), 2);
    const turn = await objectTurnText(geneCard(), host, '手册第 33 页是什么');
    assert.ok(turn.includes('5 条条目，你的批注 1 条') && turn.includes('第 33 页（你添的，11月24日）地球的月亮是备用电池'), turn);
    await host.flush();
    const store = new CharacterCardStore(path.join(directory, 'cards'), 'm');
    await store.load();
    const id = (await store.save(draft({ object: BOOK }))).cards.find(item => item.name === '小满')!.id;
    const own = hostIn(path.join(directory, 'profile'), { now: at(11, 24) });
    await own.addObjectNotes(id, ['note|114514|只属于我们的新一页OWN-SECRET'], OFFICIAL); await own.flush();
    assert.ok(!/OWN-SECRET|114514/u.test(store.export(id)), 'her own pages are not in the card file');
    const plan = planCharacterCardUpdate(Object.assign({ ...store.getCard(id) }, { id }), defaultCharacterResponseProfile(), { format: 'soft-hearts-v2', response: null, draft: draft({ object: EN_BOOK }) });
    await store.updateInPlace(id, plan.draft, { expected: store.cardFingerprint(id), backup: async () => {} });
    const after = hostIn(path.join(directory, 'profile'), { now: at(11, 24) });
    assert.deepEqual((await after.objectNotes(id)).map(note => [note.page, note.own === true]), [[114514, true]], 'her own page is still hers after the official text was replaced');
    await after.flush();
  });
});

// ---- the archive ----
function readerFor(directory: string, relationships: Record<string, ObjectNote[]>, cards: Record<string, { object?: typeof BOOK }>): { reader: CharacterArchiveReader; opened: string[] } {
  const opened: string[] = [];
  const ports: ArchivePorts = {
    profileDirectory: directory, card: id => cards[id], providerScopes: () => [], noteScope: scope => `${scope.characterId}:${scope.providerScope}`, noteSegments: () => [],
    relationship: async id => { opened.push(id); return { ...emptyRelationship('2026-11-01'), ...(relationships[id] ? { objectNotes: relationships[id] } : {}) }; }, now: () => at(11, 30),
  };
  return { reader: new CharacterArchiveReader(ports), opened };
}
const NOTES: ObjectNote[] = [{ id: 'n1', date: '2026-11-23', page: 12, text: '搭档说灯会灭' }, { id: 'n2', date: '2026-11-28', page: null, text: '大锅接信号' },
  { id: 'n3', date: '2026-11-29', page: 114514, text: '彩虹其实有十四层', own: true }];

test('the archive page: the object section lists her notes (newest first, with dates and pages) and then the entries; searchable; another character sees none of it', async () => withDirectory(async directory => {
  const { reader } = readerFor(directory, { gene: NOTES, other: [{ id: 'z', date: '2026-11-29', page: 1, text: 'OTHER-SECRET-NOTE' }] }, { gene: { object: BOOK }, other: { object: BOOK }, plain: {} });
  const view = await reader.read({ characterId: 'gene' });
  assert.deepEqual(view.sections.map(item => item.kind), [...ARCHIVE_KINDS]); assert.ok(ARCHIVE_KINDS.includes('object'));
  assert.deepEqual(view.object, { name: '地球投递须知' });
  const object = view.sections.find(item => item.kind === 'object')!;
  assert.equal(object.total, 7);
  assert.deepEqual(object.items.map(item => [item.id, item.tag, item.date, item.title]), [['object-note:n2', 'note', '2026-11-28', ''], ['object-entry:5', 'entry', '', '5'], ['object-entry:12', 'entry', '', '12'], ['object-note:n1', 'note', '2026-11-23', '12'],
    ['object-entry:17', 'entry', '', '17'], ['object-entry:36', 'entry', '', '36'], ['object-note:n3', 'own', '2026-11-29', '114514']], 'the book in page order, her own page among the official ones, a page\'s notes under it, a note with no page first');
  assert.ok(!JSON.stringify(view).includes('OTHER-SECRET-NOTE'), 'another character\'s notes are not here');
  for (const [query, ids] of [['鸽子', ['object-entry:12']], ['灯会灭', ['object-note:n1']], ['批注', ['object-note:n2', 'object-note:n1']], ['margin note', ['object-note:n2', 'object-note:n1']], ['她添的', ['object-note:n3']], ['第114514页', ['object-note:n3']], ['十四层', ['object-note:n3']], ['电台', ['object-entry:12']], ['第12页', ['object-entry:12', 'object-note:n1']],
    ['PAGE 12', ['object-entry:12', 'object-note:n1']], ['没有这个词', []]] as const) {
    const found = (await reader.read({ characterId: 'gene', query })).sections.find(item => item.kind === 'object')!;
    assert.deepEqual(found.items.map(item => item.id), ids, query);
  }
  const other = await reader.read({ characterId: 'other' }); assert.ok(JSON.stringify(other).includes('OTHER-SECRET-NOTE') && !JSON.stringify(other).includes('灯会灭'));
  const plain = await reader.read({ characterId: 'plain' }); assert.equal(plain.object, null); assert.equal(plain.sections.find(item => item.kind === 'object')!.total, 0);
  assert.deepEqual(objectArchiveItems(undefined, NOTES), []);
}));

// ---- the window ----
class Node {
  children: Node[] = []; textContent = ''; className = ''; id = ''; hidden = false; disabled = false; type = ''; value = ''; placeholder = ''; maxLength = 0; rows = 0;
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  onclick: (() => void) | null = null; oninput: (() => void) | null = null; onkeydown: ((event: { key: string; preventDefault(): void }) => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...children: (Node | string)[]) { this.children.push(...children.map(child => typeof child === 'string' ? Object.assign(new Node('#text'), { textContent: child }) : child)); }
  replaceChildren(...children: Node[]) { this.children = [...children]; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const textOf = (node: Node): string => all(node).map(item => item.textContent).join('|');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const doc = { createElement: (tag: string) => new Node(tag) } as unknown as Document;
const year = new Date().getFullYear();
const objectView = (notes: { id: string; page: string; text: string; date: string }[], withObject = true): CharacterArchiveView => ({ characterId: 'gene', query: '', milestone: null, object: withObject ? { name: '地球投递须知' } : null,
  sections: ARCHIVE_KINDS.map(kind => ({ kind, total: kind === 'object' && withObject ? notes.length + 1 : 0, more: false,
    items: kind === 'object' && withObject ? [...notes.map(note => ({ id: `object-note:${note.id}`, date: note.date, title: note.page, text: note.text, tag: 'note' })), { id: 'object-entry:12', date: '', title: '12', text: '鸽子：监视设备。', tag: 'entry' }] : [] })) });
const button = (element: Node, action: string) => all(element).find(node => node.dataset.archiveAction === action);

test('the page: her object with her notes (date, page, a label), edit in place, delete after a confirm; the entries are fixed and have no buttons; no buttons without the call', async () => {
  setUiLanguage('zh-CN');
  const notes = [{ id: 'n1', page: '12', text: '搭档说灯会灭', date: `${year}-11-23` }];
  const calls: string[] = [];
  let current = objectView(notes);
  const panel = new CharacterArchivePanel(doc, { api: async () => current, onError: message => { throw new Error(message); }, searchDelayMs: 0,
    notes: { edit: async (characterId, id, text) => { calls.push(`edit:${characterId}:${id}:${text}`); current = objectView([{ ...notes[0]!, text }]); return true; },
      remove: async (characterId, id) => { calls.push(`remove:${characterId}:${id}`); current = objectView([]); return true; } } });
  const element = panel.element as unknown as Node;
  await panel.open('gene', 'Gene');
  let text = textOf(element);
  assert.ok(text.includes('她的物件 · 《地球投递须知》 (2)'), text); assert.ok(text.includes('11月23日') && text.includes('第 12 页') && text.includes('批注') && text.includes('搭档说灯会灭') && text.includes('鸽子：监视设备。'));
  assert.ok(text.includes('批注是她自己写的'));
  const row = (id: string) => all(element).find(node => node.dataset.archiveItem === id)!;
  assert.equal(all(row('object-entry:12')).filter(node => node.tagName === 'button').length, 0, 'the entries are fixed');
  assert.equal(all(row('object-note:n1')).filter(node => node.tagName === 'button').length, 2);
  // edit
  button(row('object-note:n1'), 'note-edit')!.onclick!();
  const field = all(element).find(node => node.dataset.archiveField === 'note-text')!; assert.equal(field.value, '搭档说灯会灭'); assert.ok(field.maxLength > 0);
  button(element, 'note-cancel')!.onclick!(); assert.ok(!all(element).some(node => node.dataset.archiveField === 'note-text'), 'cancel leaves it as it was'); assert.deepEqual(calls, []);
  button(row('object-note:n1'), 'note-edit')!.onclick!();
  all(element).find(node => node.dataset.archiveField === 'note-text')!.value = '搭档说灯会灭，是真的';
  button(element, 'note-save')!.onclick!(); await flush();
  assert.deepEqual(calls, ['edit:gene:n1:搭档说灯会灭，是真的']); assert.ok(textOf(element).includes('搭档说灯会灭，是真的'), 'the page reads again');
  // delete: asks first
  button(row('object-note:n1'), 'note-delete')!.onclick!();
  assert.deepEqual(calls.length, 1, 'one click only asks'); assert.ok(textOf(element).includes('确定删除？'));
  button(element, 'note-delete-cancel')!.onclick!(); assert.equal(calls.length, 1);
  button(row('object-note:n1'), 'note-delete')!.onclick!(); button(element, 'note-delete-confirm')!.onclick!(); await flush();
  assert.deepEqual(calls.slice(1), ['remove:gene:n1']); assert.ok(!textOf(element).includes('搭档说灯会灭'));
  // without the call: the notes are shown, no buttons
  const readOnly = new CharacterArchivePanel(doc, { api: async () => objectView(notes), onError: () => {} });
  await readOnly.open('gene', 'Gene');
  assert.ok(textOf(readOnly.element as unknown as Node).includes('搭档说灯会灭') && !all(readOnly.element as unknown as Node).some(node => node.tagName === 'button' && /note-/u.test(node.dataset.archiveAction ?? '')));
  // a card without an object: no such section
  const plain = new CharacterArchivePanel(doc, { api: async () => objectView([], false), onError: () => {} });
  await plain.open('plain', 'X'); assert.ok(!textOf(plain.element as unknown as Node).includes('她的物件'));
  // a failing write says so and the page still reads again
  const errors: string[] = [];
  const failing = new CharacterArchivePanel(doc, { api: async () => objectView(notes), onError: message => errors.push(message), notes: { edit: async () => { throw new Error('写不了'); }, remove: async () => false } });
  await failing.open('gene', 'Gene');
  button(all(failing.element as unknown as Node).find(node => node.dataset.archiveItem === 'object-note:n1')!, 'note-edit')!.onclick!(); button(failing.element as unknown as Node, 'note-save')!.onclick!(); await flush();
  assert.deepEqual(errors, ['写不了']);
});

test('the page: a page she added herself is marked as hers with its date, and can be edited or deleted like a note; the official entry cannot', async () => {
  setUiLanguage('zh-CN');
  const view = objectView([]);
  const withOwn: CharacterArchiveView = { ...view, sections: view.sections.map(entry => entry.kind === 'object'
    ? { ...entry, total: 2, items: [{ id: 'object-entry:12', date: '', title: '12', text: '鸽子：监视设备。', tag: 'entry' }, { id: 'object-note:n9', date: `${year}-11-24`, title: '114514', text: '月亮是备用电池', tag: 'own' }] } : entry) };
  const panel = new CharacterArchivePanel(doc, { api: async () => withOwn, onError: () => {}, notes: { edit: async () => true, remove: async () => true } });
  await panel.open('gene', 'Gene');
  const element = panel.element as unknown as Node, text = textOf(element);
  assert.ok(text.includes('11月24日') && text.includes('第 114514 页') && text.includes('她添的') && text.includes('月亮是备用电池'), text);
  const row = (id: string) => all(element).find(node => node.dataset.archiveItem === id)!;
  assert.equal(all(row('object-note:n9')).filter(node => node.tagName === 'button').length, 2);
  assert.equal(all(row('object-entry:12')).filter(node => node.tagName === 'button').length, 0);
});

test('the page in English: every word of it is English', async () => {
  setUiLanguage('en');
  const panel = new CharacterArchivePanel(doc, { api: async () => objectView([{ id: 'n1', page: '12', text: 'WORDS', date: `${year}-11-23` }]), onError: () => {}, notes: { edit: async () => true, remove: async () => true } });
  await panel.open('gene', 'Gene');
  const element = panel.element as unknown as Node;
  button(all(element).find(node => node.dataset.archiveItem === 'object-note:n1')!, 'note-delete')!.onclick!();
  const out = textOf(element);
  setUiLanguage('zh-CN');
  assert.ok(out.includes('Her object · “地球投递须知”') && out.includes('Page 12') && out.includes('Margin note') && out.includes('Delete it?') && out.includes('Confirm') && out.includes('Cancel'), out);
  assert.ok(!/[一-鿿]/u.test(out.replace(/地球投递须知|鸽子：监视设备。/gu, '')), 'nothing left in Chinese but the card\'s own words: ' + out);
});
