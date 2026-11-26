// I-071 v2 第三步, fix 4 after the third test of the user's card (every word here is synthetic): a name left for later never reaches
// the translation model (replaced before every call by a plain reference or a neutral mark), so it can come back neither romanised
// nor translated; spouse words and terms of endearment are caught where a left-out name was; only names her memories use as an
// address are offered, and names the user adds have caps of their own; the assistant shows what is carried and the exact cost
// first. A fake Claude, real stores. (The assistant's refused-tool diagnostic is tested in assistant.test.ts.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_NOTES_FILE } from '../electron/memory/memory-notes/store';
import { addressEvidence, addressReferent, findAddressForms } from '../electron/cards/character-convert/addresses';
import { LEFT_OUT_MARK, inventedPetNames, memoryPrompt, memorySystemPrompt, personaPrompt, personaSystemPrompt, plannedCalls, translationProblems, withoutLeftOutNames, type NameMap } from '../electron/cards/character-convert/translate';
import { conversionItems } from '../electron/cards/character-convert/build';
import { createConversionTools } from '../electron/cards/character-convert/tools';
import { ASSISTANT_SYSTEM_PROMPT } from '../electron/safety/assistant/prompt';
import { checkConversionExtra, conversionCostText, validateConversionRequest, type ConversionName } from '../shared/cards/character-convert';
import { readSourceSnapshot } from '../electron/cards/character-convert/snapshot';
import { ALL_KEPT, FIXTURE_TERMS, makeFixture, makeTranslator, providerScope, romanize, withDirectory, type Fixture } from './helpers/convert-fixture';

const convert = async (fixture: Fixture, names: unknown[], extra?: unknown[]) => {
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names, ...(extra ? { extra } : {}) });
  await fixture.service.idle();
  return fixture.service.view()!;
};
/** Everything the new card holds that came from a translation: card text, memory titles, tags and her recollections. */
const carried = (fixture: Fixture, id: string) => {
  const scope = { characterId: id, providerScope };
  const page = fixture.companion.memory.list(scope, { limit: 50 }, 1_900_000_000_000);
  const card = fixture.cards.publicState().cards.find(item => item.id === id)!;
  return JSON.stringify([card, page.records.map(record => [record.title, record.tags, fixture.companion.memory.read(scope, record.id, {}, 1_900_000_000_000)?.messages ?? null])]);
};
/** Her notes: the user calls her 「团子」 / 「小团子」 (her pet names), and she calls the user 「阿龙」; both used as names elsewhere too. */
async function addPetNames(fixture: Fixture) {
  const file = path.join(fixture.directory, MEMORY_NOTES_FILE);
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.notes[0].body.summary = `用户叫她「小团子」，有时叫她「团子」。${data.notes[0].body.summary}小团子很开心。`;
  data.notes[0].body.title = '小团子和书店';
  data.notes[0].body.people.push('小团子');
  data.notes[1].body.summary = `她叫用户「阿龙」。阿龙说周五面试。团子给阿龙打气。${data.notes[1].body.summary}`;
  data.notes[1].body.people.push('阿龙', '团子');
  data.notes[1].body.tags.push('团子');
  await writeFile(file, JSON.stringify(data));
}

// ---- A. the replacement before every call ----------------------------------------------------------------------------------------

test('a name left for later is replaced before the call: longest first, by whom it names, a mark where it was given as a name', () => {
  const names: NameMap = {
    'her-name': { from: '阿澄', to: 'Cheng' }, 'her-nickname': { from: '团子', to: '' }, 'user-nickname': { from: '阿龙', to: '' },
    aliases: [{ from: '小团子', to: '', refers: 'her' }, { from: '老大', to: '' }, { from: '团子屋', to: 'Dango House', kind: 'term' }],
  };
  const mark = LEFT_OUT_MARK['zh-CN'];
  // longest first: 小团子 is replaced as itself (no stray 小 left); a kept or translated name containing a left-out one is untouched
  assert.equal(withoutLeftOutNames('小团子在团子屋等阿龙。', names, 'zh-CN'), '阿澄在团子屋等用户。');
  // where it is given or used as a name, the mark (the prompt explains it); a referent nobody knows: the mark
  assert.equal(withoutLeftOutNames('阿龙叫她「团子」，她的小名团子。老大来了。', names, 'zh-CN'), `用户叫她「${mark}」，她的小名${mark}。${mark}来了。`);
  // calling someone by it in a quoted line is an address too ("Good night, the user" would read wrong)
  assert.equal(withoutLeftOutNames('“阿龙，晚安。”她说。“晚安呀，团子！”', names, 'zh-CN'), `“${mark}，晚安。”她说。“晚安呀，${mark}！”`);
  // lists: an entry that only was such a name becomes the plain reference, or is dropped instead of becoming a mark
  assert.deepEqual(withoutLeftOutNames({ people: ['团子', '阿龙', '老大', '小王'], tags: ['老大', '书店'] }, names, 'zh-CN'), { people: ['阿澄', '用户', '小王'], tags: ['书店'] });
  // an English source: whole words only, case-insensitive, "the user" as the plain reference
  const en: NameMap = { 'her-name': { from: 'Gene', to: '阿金' }, 'user-nickname': { from: 'Bun', to: '' } };
  assert.equal(withoutLeftOutNames('Bun came by; bun was tired. A bundle of buns.', en, 'en'), 'the user came by; the user was tired. A bundle of buns.');
  // nothing left for later: the value as it was
  assert.equal(withoutLeftOutNames('团子来了', { 'her-name': { from: '阿澄', to: 'Cheng' }, 'her-nickname': { from: '团子', to: '团子' } }, 'zh-CN'), '团子来了');
});

test('the prompts never carry a name left for later, not even in the glossary or a retry note', () => {
  const names: NameMap = { 'her-name': { from: '阿澄', to: 'Cheng' }, 'her-nickname': { from: '团子', to: '' }, aliases: [{ from: '阿龙', to: '', refers: 'user' }] };
  const card = { name: '阿澄', description: '用户叫她团子。', personality: '', scenario: '', greeting: '阿龙，你来啦', examples: '', systemPrompt: '', understandingNotes: '' };
  const problems = translationProblems({ s: '团子来了' }, { s: '团子 came, sweetie' }, 'zh-CN', 'en', names);
  assert.ok(problems.deviations.length && problems.invented.length, 'the second layer still sees the slip');
  const prompts = [personaPrompt(card, 'en', names, '', problems, 'zh-CN'), memoryPrompt([{ k: 'n0', kind: 'note', v: { title: '团子', summary: '阿龙说团子很乖', people: ['团子'], things: [], mood: '', plans: [], tags: ['团子'] } }], 'en', names, problems, 'zh-CN')];
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt, /团子|阿龙/);
    assert.match(prompt, /Some pet names were taken out of the text before you got it/);
    assert.match(prompt, /"阿澄" becomes "Cheng"/);
  }
  assert.match(prompts[0]!, /用户叫她〔昵称〕。/);
  assert.match(prompts[0]!, /"greeting": "用户，你来啦"/);
  assert.match(prompts[1]!, /"summary":"用户说阿澄很乖"/);
});

test('end to end: nothing of a left-for-later name reaches the translator, and no romanised or translated form of it comes back', async () => withDirectory(async directory => {
  // A model that romanises every name it sees and turns the pet names into English words (what the third test saw).
  const seesNames: [string, string][] = [...FIXTURE_TERMS, ['小团子', 'Xiao Tuan Zi'], ['团子', 'wifey'], ['阿龙', 'A Long'], ['澄澄', 'Cheng Cheng']];
  const fixture = await makeFixture(directory, { model: makeTranslator(seesNames) });
  await addPetNames(fixture);
  const preview = await fixture.service.preview(fixture.sourceId);
  const alias = (text: string) => preview.names.find(name => name.text === text);
  assert.deepEqual([alias('小团子')?.refers, alias('阿龙')?.refers], ['her', 'user']);
  const later = preview.names.filter(name => name.id !== 'her-name').map(name => name.id === 'user-nickname' ? { id: name.id, to: 'Rainy' } : { id: name.id, to: '' });
  const done = await convert(fixture, [ALL_KEPT[0]!, ...later]);
  assert.equal(done.state, 'done', done.error);
  assert.ok(fixture.model.calls.length >= 2);
  for (const call of fixture.model.calls) assert.doesNotMatch(call.prompt + call.system, /团子|阿龙|澄澄/, 'no left-out name in any prompt');
  const text = carried(fixture, done.newCardId!);
  assert.doesNotMatch(text, /Tuan|A Long|Cheng Cheng|wifey|团子|阿龙|澄澄/i);
  for (const name of ['小团子', '团子', '阿龙', '澄澄']) assert.ok(!text.includes(romanize(name)) || romanize(name).length < 3, name);
  // her own name stands where the user's name for her was, the user where hers for the user was
  const memoryCall = fixture.model.calls.find(call => call.prompt.includes('<items>'))!.prompt;
  assert.match(memoryCall, /阿澄和书店/);
  assert.match(memoryCall, /用户说周五面试。阿澄给用户打气。/);
}));

// ---- B. one order of the name rules ----------------------------------------------------------------------------------------------

test('the name rules no longer contradict: kept, chosen, never a left-out name in any form, then romanise the rest', () => {
  const names: NameMap = { 'her-name': { from: '阿澄', to: 'Cheng' }, 'her-nickname': { from: '团子', to: '' } };
  const prompt = memoryPrompt([{ k: 'p0', kind: 'profile', v: { text: '团子' } }], 'en', names);
  assert.match(prompt, /Never write a nickname, a term of endearment \(sweetie, honey, baby…\), a spouse word used as a name \(wife, husband…\) or any spelling of a name there/);
  for (const system of [memorySystemPrompt('zh-CN', 'en'), personaSystemPrompt('zh-CN', 'en')])
    assert.match(system, /a name the name list keeps stays exactly as it is; a name with a chosen form uses that form; a pet name that was taken out .* is never written in any form: not kept, not in pinyin or any other spelling, not translated .*Every other name .*pinyin for a Chinese personal name/);
});

// ---- C. the stronger invented-name check -----------------------------------------------------------------------------------------

test('invented pet names: spouse words and endearments are caught where a left-out name was, ordinary words are not', () => {
  const names: NameMap = { 'her-nickname': { from: '团子', to: '' } };
  const flag = (source: unknown, result: unknown) => inventedPetNames(source, result, 'zh-CN', 'en', names);
  assert.deepEqual(flag({ s: '团子很开心' }, { s: 'My "wife" was happy' }), ['wife']);
  assert.deepEqual(flag({ s: '团子很开心' }, { s: 'The husband was happy' }), ['husband']);
  assert.deepEqual(flag({ s: '团子，晚安' }, { s: 'Good night, love.' }), ['love']);
  assert.deepEqual(flag({ s: '团子很乖' }, { s: 'The little one was good' }), ['little one']);
  assert.deepEqual(flag({ s: '团子来了' }, { s: 'Honey, she came' }), ['honey']);
  // ordinary words: a diary greeting, food, a verb, and a field that never had the left-out name
  assert.deepEqual(flag({ s: '团子写日记' }, { s: 'Dear diary, Cheng wrote' }), []);
  assert.deepEqual(flag({ s: '团子吃蜂蜜吐司' }, { s: 'Cheng had honey toast; I love rainy days' }), []);
  assert.deepEqual(flag({ title: '团子', summary: '今天很冷' }, { title: 'Cheng', summary: 'Dear me, my wife said it was cold' }), []);
  // the source's own spouse word is a translation, not an invention
  assert.deepEqual(flag({ s: '团子说他的妻子来了' }, { s: 'Cheng said his wife came' }), []);
  // no name left for later at all: nothing is checked
  assert.deepEqual(inventedPetNames({ s: '团子很开心' }, { s: 'wife' }, 'zh-CN', 'en', { 'her-nickname': { from: '团子', to: 'Dumpling' } }), []);
  // the other direction
  assert.deepEqual(inventedPetNames({ s: 'Bun was happy' }, { s: '老婆很开心' }, 'en', 'zh-CN', { 'her-nickname': { from: 'Bun', to: '' } }), ['老婆']);
});

test('a translation that turns a left-out place into a spouse word is asked again; the mark itself may not be copied', async () => withDirectory(async directory => {
  let memoryCalls = 0;
  const plain = makeTranslator(FIXTURE_TERMS);
  const spouse = makeTranslator(FIXTURE_TERMS, value => JSON.parse(JSON.stringify(value).split('them').join('wife')));
  const fixture = await makeFixture(directory, { model: async (prompt, system, signal) => system.includes('character card') ? plain(prompt, system, signal) : (++memoryCalls === 1 ? spouse : plain)(prompt, system, signal) });
  await addPetNames(fixture);
  const preview = await fixture.service.preview(fixture.sourceId);
  const done = await convert(fixture, [ALL_KEPT[0]!, ...preview.names.filter(name => name.id !== 'her-name').map(name => ({ id: name.id, to: '' }))]);
  assert.equal(done.state, 'done', done.error);
  const retry = fixture.model.calls.at(-1)!.prompt;
  assert.match(retry, /used "wife" where the original had a pet name the user will choose again later/);
  assert.doesNotMatch(retry, /团子|阿龙|澄澄/);
  assert.doesNotMatch(carried(fixture, done.newCardId!), /wife/);
  // copying the mark is a leftover too (both directions)
  const names: NameMap = { 'her-nickname': { from: '团子', to: '' } };
  assert.ok(translationProblems({ s: '团子来了' }, { s: '〔昵称〕 came' }, 'zh-CN', 'en', names).leftover.includes('〔昵称〕'));
  assert.ok(translationProblems({ s: 'Bun came' }, { s: '〔pet name〕来了' }, 'en', 'zh-CN', { 'her-nickname': { from: 'Bun', to: '' } }).leftover.includes('〔pet name〕'));
}));

// ---- D. forms of address ---------------------------------------------------------------------------------------------------------

test('addresses: a name the notes only mention (a film character) is not offered; one they use to address or name someone is', () => {
  const texts = ['电影里的灭霸打了个响指', '灭霸说要消灭一半的人', '灭霸（漫威角色）很强', '周哥说今天加班', '周哥又熬夜了', '她叫用户「阿龙」。阿龙笑了', '她叫用户「阿龙」', '灭霸', '周哥'];
  const found = findAddressForms(texts, ['阿澄'], ['灭霸', '周哥', '灭霸', '阿龙']).map(item => item.text);
  assert.ok(!found.includes('灭霸'), found.join());
  assert.ok(found.includes('周哥') && found.includes('阿龙'), found.join());
  assert.equal(addressEvidence('灭霸', texts), false);
  assert.equal(addressEvidence('周哥', texts), true); // a subject in two separate notes
  assert.equal(addressEvidence('周哥', ['周哥说今天加班']), false); // once is not "repeatedly"
  assert.equal(addressEvidence('小乐', ['用户给她起了个小名小乐']), true); // a naming context, once is enough
  assert.equal(addressEvidence('Moss', ['She calls me Moss.']), true);
  assert.equal(addressEvidence('周哥', ['“周哥，晚安”']), true); // called by it in a quoted line
  // who it names
  assert.equal(addressReferent('团子', ['用户叫她「团子」']), 'her');
  assert.equal(addressReferent('团子', ['我的小名是团子']), 'her');
  assert.equal(addressReferent('阿龙', ['她叫用户「阿龙」', '他的外号是阿龙']), 'user');
  assert.equal(addressReferent('阿龙', ['她叫用户阿龙', '用户叫她阿龙']), null); // both: unclear
  assert.equal(addressReferent('周哥', ['周哥说今天加班']), null);
  assert.equal(addressReferent('Moss', ['He calls me "Moss"']), 'her');
});

test('more room for forms of address, and the user\'s own additions are never refused because the found ones filled theirs', () => {
  const listed: ConversionName[] = [{ id: 'her-name', label: '', text: '阿澄' },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `alias-${index + 1}` as ConversionName['id'], label: '', text: `称呼${index + 1}` })),
    ...Array.from({ length: 6 }, (_, index) => ({ id: `term-${index + 1}` as ConversionName['id'], label: '', text: `名词${index + 1}` }))];
  const corpus = '老公 小家伙 星火 月影 甲 乙';
  const added = [{ kind: 'alias' as const, from: '老公', to: '' }, { kind: 'alias' as const, from: '小家伙', to: '' }, { kind: 'term' as const, from: '星火', to: 'Ember' }];
  assert.deepEqual(checkConversionExtra(listed, added, corpus).map(item => item.from), ['老公', '小家伙', '星火']);
  const fiveAliases = ['老公', '小家伙', '月影', '甲', '乙'].map(from => ({ kind: 'alias' as const, from, to: '' }));
  assert.throws(() => checkConversionExtra(listed, fiveAliases, corpus), /另外加的称呼最多 4 个/);
  assert.equal(validateConversionRequest({ characterId: 'a', language: 'en', names: [{ id: 'alias-6', to: '' }] }).names.length, 1);
  assert.throws(() => validateConversionRequest({ characterId: 'a', language: 'en', names: [{ id: 'alias-7', to: '' }] }), /alias-1…alias-6/);
  assert.equal(validateConversionRequest({ characterId: 'a', language: 'en', names: [], extra: added.concat(added.map(item => ({ ...item, from: `${item.from}2` })), [{ kind: 'term', from: 'x', to: 'X' }, { kind: 'term', from: 'y', to: 'Y' }]) }).extra!.length, 8);
});

test('end to end: a user-added form of address left for later is replaced too, with the referent read from her memories', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { model: makeTranslator([...FIXTURE_TERMS, ['老公', 'husband']]) });
  const file = path.join(directory, MEMORY_NOTES_FILE);
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.notes[0].body.summary = `她叫用户「老公」。${data.notes[0].body.summary}`;
  await writeFile(file, JSON.stringify(data));
  const done = await convert(fixture, ALL_KEPT, [{ kind: 'alias', from: '老公', to: '' }]);
  assert.equal(done.state, 'done', done.error);
  for (const call of fixture.model.calls) assert.doesNotMatch(call.prompt, /老公/);
  assert.doesNotMatch(carried(fixture, done.newCardId!), /husband|老公/);
}));

// ---- F. what the assistant shows first, and the exact count ----------------------------------------------------------------------

test('prepare gives the plain intro the assistant shows first, with the exact number of calls; a clean run makes exactly that many', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const preview = await fixture.service.preview(fixture.sourceId);
  const snapshot = await readSourceSnapshot(fixture.sourceId, (fixture.service as any).options.source);
  assert.equal(preview.calls, plannedCalls(conversionItems(snapshot)));
  assert.match(preview.cost, new RegExp(`一共 ${preview.calls} 次调用（人设 1 次、记忆 ${preview.calls - 1} 次）；哪一次翻得不合格会重问一次，每次多 1 次，最多一共 ${preview.calls * 2} 次`));
  assert.doesNotMatch(preview.cost, /大约 \d+ 次/);
  assert.match(conversionCostText(1, 'sonnet', 'low'), /一共 1 次调用（人设 1 次）；/);
  const [prepareTool] = createConversionTools(() => fixture.service);
  const result = await prepareTool!.run(prepareTool!.validate({ characterId: fixture.sourceId }), {} as never) as { intro: string; next: string; introNext: string };
  assert.match(result.intro, /^会新建一个英文版角色，原来的「阿澄」一个字都不动，之后两边记忆不同步。\n带过去（翻译后复制一次）：.*\n不带：.*\n额度：会用你自己的 Claude Code/u);
  assert.ok(result.intro.includes(preview.cost));
  // Fix 5: the external channel's Claude Code still gets the duty to show it first; the Claude 助手 shows it itself (assistant.test.ts)
  assert.match(result.introNext, /^这一轮先把 intro 原样发给用户（在问任何名字之前/);
  assert.match(ASSISTANT_SYSTEM_PROMPT, /soft hearts 会自己把会新建什么、带什么、不带什么、准确的调用次数作为软件的一段话显示给用户；你不要重复它/);
  const done = await convert(fixture, ALL_KEPT);
  assert.equal(done.state, 'done', done.error);
  assert.equal(fixture.model.calls.length, preview.calls, 'the planned number is the real number when nothing is asked again');
}));
