// I-071 v2 第三步, fix 3 after the retest of the user's own card (every word here is synthetic): names are found from what her
// notes already know and from the assistant's reading of the persona; an English result keeps no Chinese; a name left for later is
// neither kept nor replaced by an invented pet name; she asks once for a new nickname; "ignore" on a proper noun means "an ordinary
// word". A fake Claude, real stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_NOTES_FILE } from '../electron/memory/memory-notes/store';
import { findAddressForms, findProperNouns } from '../electron/cards/character-convert/addresses';
import { inventedPetNames, leftoverSource, translatePersona } from '../electron/cards/character-convert/translate';
import { createConversionTools } from '../electron/cards/character-convert/tools';
import type { ConversionService } from '../electron/cards/character-convert/service';
import { checkConversionExtra, validateConversionRequest, type ConversionPreview } from '../shared/cards/character-convert';
import type { CharacterCard } from '../shared/foundation/character-card';
import { ALL_KEPT, FIXTURE_TERMS, fakeEnglish as E, filesOf, makeFixture, makeTranslator, providerScope, withDirectory, type Fixture } from './helpers/convert-fixture';

const HAN = /\p{Script=Han}/u;

/** Both notes are about someone the notes call "阿福", used as a subject ("阿福说……") and listed among the note's people. */
async function addSubjectName(fixture: Fixture, name = '阿福') {
  const file = path.join(fixture.directory, MEMORY_NOTES_FILE);
  const data = JSON.parse(await readFile(file, 'utf8'));
  for (const note of data.notes) { note.body.summary = `${name}说${note.body.summary}`; note.body.people.push(name); }
  await writeFile(file, JSON.stringify(data));
}
/** Her two notes call the user "团团" (as in the earlier fixes), so a left-for-later form of address is in every note. */
async function addPetName(fixture: Fixture) {
  const file = path.join(fixture.directory, MEMORY_NOTES_FILE);
  const data = JSON.parse(await readFile(file, 'utf8'));
  for (const note of data.notes) note.body.summary = `她叫用户「团团」。${note.body.summary}团团很开心。`;
  await writeFile(file, JSON.stringify(data));
}
const convert = async (fixture: Fixture, names: unknown[], extra?: unknown[]) => {
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names, ...(extra ? { extra } : {}) });
  await fixture.service.idle();
  return fixture.service.view()!;
};
/** What the new card holds of her memories: titles, tags and her recollections (the category is an internal word). */
const carried = (fixture: Fixture, id: string) => {
  const scope = { characterId: id, providerScope };
  const page = fixture.companion.memory.list(scope, { limit: 50 }, 1_900_000_000_000);
  assert.ok(page.records.length >= 2);
  return JSON.stringify(page.records.map(record => [record.title, record.tags, JSON.stringify(fixture.companion.memory.read(scope, record.id, {}, 1_900_000_000_000)?.messages ?? null)]));
};
const outsideUnchanged = (before: Map<string, Buffer>, after: Map<string, Buffer>) => {
  const outside = (files: Map<string, Buffer>) => [...files.keys()].filter(file => !file.startsWith('character-convert/')).sort();
  assert.deepEqual(outside(after), outside(before));
  for (const file of outside(before)) assert.ok(before.get(file)!.equals(after.get(file)!), `${file} changed`);
  assert.deepEqual([...after.keys()].filter(file => file.startsWith('character-convert/')), []);
};

// ---- A. finding names ------------------------------------------------------------------------------------------------------------

test('a nickname used as a subject in her notes ("阿福说……") is offered as a form of address, from the notes\' own people lists', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  await addSubjectName(fixture);
  const preview = await fixture.service.preview(fixture.sourceId);
  assert.deepEqual(preview.names.filter(name => name.id.startsWith('alias-')).map(name => name.text), ['阿福']);
  // the pure finder: the people list is what finds it (no "叫你" anywhere)
  const texts = ['阿福说今天很累', '阿福说想吃面', '阿福']; // the people entries are part of the counted text, as in the snapshot
  assert.deepEqual(findAddressForms(texts, ['阿澄'], ['阿福']).map(item => item.text), ['阿福']);
  assert.deepEqual(findAddressForms(texts, ['阿澄']).map(item => item.text), []);
}));

test('ordinary words are not offered: roles in the people lists, and pattern matches in the persona that her notes never name', async () => withDirectory(async directory => {
  const persona = ['她常说「早上好」和「晚安」，在普通学校读书，是班里的小队长。'];
  // without the notes' confirmation every pattern match is dropped
  assert.deepEqual(findProperNouns(persona, ['阿澄'], persona, () => false), []);
  // with it, only what the notes name stays
  const named = ['晚安'];
  assert.deepEqual(findProperNouns(persona, ['阿澄'], persona, text => named.some(entry => entry.includes(text))).map(item => item.text), ['晚安']);
  assert.deepEqual(findAddressForms(['妈妈说今天下雨', '用户的妈妈说', '妈妈很好'], [], ['妈妈', '妈妈', '用户', '用户的妈妈', 'the user']), []);
  // end to end: a card whose persona has quoted greetings and a school; the notes name none of them
  const fixture = await makeFixture(directory, { description: '她常说「早上好」和「晚安」，在普通学校读书，是班里的小队长。' });
  const preview = await fixture.service.preview(fixture.sourceId);
  assert.deepEqual(preview.names.filter(name => name.id.startsWith('term-')), []);
  // the assistant gets the persona to read instead (bounded)
  assert.match(preview.persona, /\[description\]\n她常说「早上好」/);
  assert.ok(Array.from(preview.persona).length <= 6000);
}));

test('a pattern match her notes name too is still offered (the fallback stays)', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { description: '她是「晨星社」的成员。' });
  const file = path.join(directory, MEMORY_NOTES_FILE);
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.notes[0].body.things.push('晨星社的活动');
  await writeFile(file, JSON.stringify(data));
  const preview = await fixture.service.preview(fixture.sourceId);
  assert.deepEqual(preview.names.filter(name => name.id.startsWith('term-')).map(name => name.text), ['晨星社']);
}));

test('an organization with no known suffix, proposed by the assistant from the persona, is decided, checked and translated one way everywhere', async () => withDirectory(async directory => {
  const description = '她是星火的一员，星火的人都很照顾她。';
  const fixture = await makeFixture(directory, { description, model: makeTranslator([...FIXTURE_TERMS, ['星火', 'Ember']]) });
  const preview = await fixture.service.preview(fixture.sourceId);
  assert.deepEqual(preview.names.filter(name => name.id.startsWith('term-')), []); // "星火" ends in no organization word
  const extra = [{ kind: 'term', from: '星火', to: 'Ember' }];
  // the input is plain text, bounded, and must occur in the card or her memories
  await assert.rejects(fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT, extra: [{ kind: 'term', from: '月影会', to: 'Moon' }] }), /都没有出现/);
  assert.throws(() => validateConversionRequest({ characterId: 'a', language: 'en', names: [], extra: [{ kind: 'term', from: 'C:\\Users\\x', to: 'X' }] }), /路径/);
  assert.throws(() => validateConversionRequest({ characterId: 'a', language: 'en', names: [], extra: [{ kind: 'term', from: 'x', to: 'X', path: 'y' }] }), /只有 kind、from、to 和 by/); // fix 5: by (who added it)
  assert.throws(() => validateConversionRequest({ characterId: 'a', language: 'en', names: [], extra: Array.from({ length: 9 }, (_, i) => ({ kind: 'term', from: `t${i}`, to: 'X' })) }), /最多 8 个/); // fix 4: 8, with caps of their own
  assert.throws(() => validateConversionRequest({ characterId: 'a', language: 'en', names: [], extra: [{ kind: 'alias', from: '阿福', to: 'Muffin the Great' }] }), /最多 8 个字/);
  assert.throws(() => checkConversionExtra(preview.names, [{ kind: 'term', from: '阿澄', to: 'Cheng' }], '阿澄'), /已经在 names 里了/);
  assert.equal(fixture.service.view(), null);
  const done = await convert(fixture, ALL_KEPT, extra);
  assert.equal(done.state, 'done', done.error);
  for (const call of fixture.model.calls) assert.match(call.prompt, /"星火" becomes "Ember" everywhere/);
  const card = fixture.cards.publicState().cards.find(item => item.id === done.newCardId)!;
  assert.match(card.description, /Ember/);
  assert.doesNotMatch(card.description, HAN);
}));

// ---- B. no source-language text left ---------------------------------------------------------------------------------------------

test('no Chinese is left in an English result: a leftover is asked again with the reason, and the second answer is used', async () => withDirectory(async directory => {
  // The first memory answer leaves a place name in Chinese in one note's title (as the real card's food and place names were).
  const model = makeTranslator(FIXTURE_TERMS, (value, kind, key, call) => call === 2 && kind === 'note' && key === 'n0' ? { ...value, title: `${value.title} 老街` } : value);
  const fixture = await makeFixture(directory, { model });
  const done = await convert(fixture, ALL_KEPT);
  assert.equal(done.state, 'done', done.error);
  assert.equal(fixture.model.calls.length, 3); // persona + batch + the one item asked again
  assert.match(fixture.model.calls[2]!.prompt, /still had 简体中文 text in it: "老街"\. The result must contain no Chinese characters at all/);
  assert.match(fixture.model.calls[2]!.prompt, /"k":"n0"/);
  assert.doesNotMatch(fixture.model.calls[2]!.prompt, /"k":"n1"/);
  assert.doesNotMatch(carried(fixture, done.newCardId!), HAN);
  assert.match(carried(fixture, done.newCardId!), /Remembered from before/); // her recollections are part of what was checked
  // the prompts say how to write a name that is not in the list
  assert.match(fixture.model.calls[1]!.system, /pinyin for a Chinese personal name.*must contain no Chinese characters at all/);
}));

test('Chinese left twice stops the whole conversion and leaves nothing behind', async () => withDirectory(async directory => {
  const model = makeTranslator(FIXTURE_TERMS, (value, kind) => kind === 'profile' ? { ...value, text: `${value.text} 钢琴` } : value);
  const fixture = await makeFixture(directory, { model });
  const before = await filesOf(directory);
  const done = await convert(fixture, ALL_KEPT);
  assert.equal(done.state, 'failed');
  assert.match(done.error!, /还留着原来语言的字/);
  assert.doesNotMatch(done.error!, /钢琴/); // the message never carries memory text
  outsideUnchanged(before, await filesOf(directory));
}));

test('the persona call is checked for leftovers too (one retry with the reason, then the conversion stops)', async () => {
  const card = { name: '阿澄', description: '在海边长大的女孩', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '', understandingNotes: '' } as unknown as CharacterCard;
  const answer = (description: string) => JSON.stringify({ name: 'Cheng', description, personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '', understandingNotes: '' });
  const names = { 'her-name': { from: '阿澄', to: 'Cheng' } };
  const prompts: string[] = [];
  const answers = [answer('A girl who grew up by the 海边'), answer('A girl who grew up by the sea')];
  const persona = await translatePersona(card, 'zh-CN', 'en', names, async prompt => { prompts.push(prompt); return answers.shift()!; }, new AbortController().signal);
  assert.equal(persona.description, 'A girl who grew up by the sea');
  assert.match(prompts[1]!, /still had 简体中文 text in it: "海边"/);
  await assert.rejects(translatePersona(card, 'zh-CN', 'en', names, async () => answer('by the 海边'), new AbortController().signal), /还留着原来语言的字/);
});

test('leftover rules: names the user kept may stay; en→zh only flags an untranslated English phrase (lenient)', () => {
  const kept = { 'her-nickname': { from: '澄澄', to: '澄澄' } };
  assert.deepEqual(leftoverSource({ s: 'Hi, 澄澄 is here' }, 'en', kept), []);
  assert.deepEqual(leftoverSource({ s: 'Hi, 澄澄 is at 老街' }, 'en', kept), ['老街']);
  assert.deepEqual(leftoverSource({ s: '{{user}} came by' }, 'en', {}), []);
  assert.deepEqual(leftoverSource({ s: '她今天去了 Steam 上买游戏，听了 Fly Me to the Moon。' }, 'zh-CN', {}), []);
  assert.deepEqual(leftoverSource({ s: '用户说 I went to the store yesterday。' }, 'zh-CN', {}), ['I went to the store yesterday']);
  assert.deepEqual(leftoverSource({ s: 'Moss 说 Moss is here。' }, 'zh-CN', { aliases: [{ from: 'Moss', to: 'Moss' }] }), []);
});

test('a nickname left for later is neither kept nor replaced by an invented pet name: an invented one is asked again', async () => withDirectory(async directory => {
  // Fix 4: the name never reaches the model, so the invented pet name is put into the first memory answer directly.
  let memoryCalls = 0;
  const base: [string, string][] = [['阿澄', 'Cheng'], ['小雨', 'the user'], ['澄澄', 'Cheng']];
  const invents = makeTranslator(base, (value, kind) => kind === 'note' ? { ...value, summary: `${value.summary} sweetie` } : value), plain = makeTranslator(base);
  const fixture = await makeFixture(directory, { model: async (prompt, system, signal) => system.includes('character card') ? plain(prompt, system, signal) : (++memoryCalls === 1 ? invents : plain)(prompt, system, signal) });
  await addPetName(fixture);
  const done = await convert(fixture, [ALL_KEPT[0]!, { id: 'her-nickname', to: '' }, { id: 'user-nickname', to: '' }, { id: 'alias-1', to: '' }]);
  assert.equal(done.state, 'done', done.error);
  assert.equal(fixture.model.calls.length, 3);
  assert.match(fixture.model.calls[2]!.prompt, /used "sweetie" where the original had a pet name the user will choose again later/);
  for (const call of fixture.model.calls) {
    assert.doesNotMatch(call.prompt, /团团|小雨|澄澄/); // fix 4: taken out before every call
    assert.match(call.prompt, /Refer to that person plainly there \(the user as "you" where she speaks to the user, otherwise "the user"/);
  }
  const text = carried(fixture, done.newCardId!);
  assert.doesNotMatch(text, /sweetie|团团/);
  assert.match(text, /Remembered from before/);
  // the pure check: a companion word of the source's own is a translation, not an invention
  const names = { aliases: [{ from: '团团', to: '' }] };
  assert.deepEqual(inventedPetNames({ s: '团团很开心' }, { s: 'Sweetie was happy' }, 'zh-CN', 'en', names), ['sweetie']);
  assert.deepEqual(inventedPetNames({ s: '团团很开心，宝贝' }, { s: 'The user was happy, sweetie' }, 'zh-CN', 'en', names), []);
  assert.deepEqual(inventedPetNames({ s: '今天很开心' }, { s: 'Sweetie was happy' }, 'zh-CN', 'en', names), []);
}));

// ---- D. she asks once for the new nickname ---------------------------------------------------------------------------------------

test('"already asked" starts over on the new card when the nickname for the user was left for later; it is kept when carried', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  assert.equal((await fixture.companion.relationship.snapshot(fixture.sourceId)).nicknameAsked, true);
  const later = await convert(fixture, [ALL_KEPT[0]!, ALL_KEPT[1]!, { id: 'user-nickname', to: '' }]);
  assert.equal(later.state, 'done', later.error);
  const fresh = await fixture.companion.relationship.snapshot(later.newCardId!);
  assert.equal(fresh.nickname, null);
  assert.equal(fresh.nicknameAsked, false);
  const kept = await convert(fixture, ALL_KEPT);
  assert.equal((await fixture.companion.relationship.snapshot(kept.newCardId!)).nicknameAsked, true);
  assert.equal((await fixture.companion.relationship.snapshot(fixture.sourceId)).nicknameAsked, true); // the source is as it was
}));

test('"already asked" is kept when nothing was left for later (the user may have said no before)', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const data = await fixture.companion.relationship.snapshot(fixture.sourceId);
  await fixture.companion.relationship.seed(fixture.sourceId, { ...data, nickname: null, nicknameAsked: true });
  const done = await convert(fixture, [ALL_KEPT[0]!, ALL_KEPT[1]!]);
  assert.equal(done.state, 'done', done.error);
  assert.equal((await fixture.companion.relationship.snapshot(done.newCardId!)).nicknameAsked, true);
}));

// ---- C. "ignore" on a proper noun ------------------------------------------------------------------------------------------------

test('"ignore" on a proper noun is explained as "an ordinary word" and the popup says so', async () => {
  const preview: ConversionPreview = {
    source: { id: 'card-1', name: '阿澄', language: 'zh-CN' }, target: 'en',
    names: [{ id: 'her-name', label: '她在新卡上的名字', text: '阿澄' }, { id: 'alias-1', label: '她的记忆里常出现的称呼或名字', text: '阿福' }, { id: 'term-1', label: '角色设定里的专有名词（组织、头衔、地名）', text: '小队长' }],
    counts: { notes: 0, notesCarried: 0, profileEntries: 0, diaryDays: 0, memes: 0, knownDays: 0, qualityDays: 0, metDate: null },
    copied: [], settings: { carried: [], off: [] }, notCopied: [], voice: '', calls: 1, cost: '', persona: '[description]\n她是星火的一员',
  };
  const service = { running: false, preview: async () => structuredClone(preview), checkExtra: async (_id: string, extra: unknown[]) => extra } as unknown as ConversionService;
  const [prepareTool, convertTool] = createConversionTools(() => service);
  const prepared = await prepareTool!.run(prepareTool!.validate({ characterId: 'card-1' }), {} as never) as { next: string; persona: string };
  assert.match(prepared.next, /term-N 是角色设定里的专有名词，「忽略」= 它其实是普通词，按普通词翻译（不是保留原样/);
  assert.match(prepared.next, /读 persona/);
  assert.equal(prepared.persona, preview.persona);
  const request = convertTool!.validate({ characterId: 'card-1', language: 'en', names: [{ id: 'her-name', to: 'Cheng' }, { id: 'alias-1', to: '', ignore: true }, { id: 'term-1', to: '', ignore: true }],
    extra: [{ kind: 'term', from: '星火', to: 'Ember', by: 'assistant' }] }); // fix 5: the popup says who added it
  const detail = convertTool!.confirmation!(await convertTool!.prepare!(request)).detail;
  assert.match(detail, /「小队长」不是专有名词，按普通词翻译/);
  assert.doesNotMatch(detail, /「小队长」不是称呼/);
  assert.match(detail, /「阿福」不是称呼，忽略/);
  assert.match(detail, /（Claude 在人设里找到的）：「星火」换成「Ember」/);
});

test('the tool catalog lets the model send alias, term, ignore and extra (the schema used to allow only the three nicknames)', () => {
  const catalog = JSON.parse(readFileSync(path.join(process.cwd(), 'shared/safety/agent-channel-catalog.json'), 'utf8'));
  const tool = catalog.tools.find((item: any) => item.name === 'convert_character_language');
  const ids = tool.inputSchema.properties.names.items.properties.id.enum;
  for (const id of ['alias-1', 'alias-6', 'term-1', 'term-6']) assert.ok(ids.includes(id), id);
  assert.ok(tool.inputSchema.properties.names.items.properties.ignore);
  assert.equal(tool.inputSchema.properties.extra.maxItems, 8); // fix 4
  assert.deepEqual(Object.keys(tool.inputSchema.properties.extra.items.properties).sort(), ['by', 'from', 'kind', 'to']); // fix 5: who added it
});

test('the fake translator used by these tests leaves no Chinese except kept names', () => {
  assert.doesNotMatch(E('她叫用户小雨。'), HAN);
  assert.equal(E('澄澄来了', FIXTURE_TERMS, ['澄澄']).includes('澄澄'), true);
});
