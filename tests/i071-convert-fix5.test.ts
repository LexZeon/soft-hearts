// I-071 v2 第三步, fix 5 after the fourth test of the user's card (every word here is synthetic): the source field's own spouse or
// endearment word allows its translation (a quoted "爱妻X" next to a left-out 老婆 is not an invention); one memory item that still
// fails after its re-ask is left out and named instead of voiding all of them (the conversion stops only above a tenth); a name
// being called out ("连叫多声“X”", "逗她叫X") becomes the neutral mark, not whom it names; and the small things: who added an
// extra name, no redundant nickname line, the voice line when there is nothing to rewrite, no empty folders after a failure.
// A fake Claude, real stores. (The intro the Claude 助手 shows itself: assistant.test.ts; the result's list: assistant-panel.test.ts.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_NOTES_FILE } from '../electron/memory/memory-notes/store';
import { localDateKey } from '../electron/memory/diary/diary-dates';
import { userProfileScopeId } from '../electron/memory/user-profile';
import { inNamingContext } from '../electron/cards/character-convert/addresses';
import { LEFT_OUT_MARK, inventedPetNames, translatePersona, withoutLeftOutNames, type NameMap } from '../electron/cards/character-convert/translate';
import { conversionSummary, createConversionTools } from '../electron/cards/character-convert/tools';
import type { ConversionService } from '../electron/cards/character-convert/service';
import { ASSISTANT_SYSTEM_PROMPT } from '../electron/safety/assistant/prompt';
import { conversionLine } from '../shared/safety/assistant';
import { conversionCopiedLines, validateConversionRequest, type ConversionPreview } from '../shared/cards/character-convert';
import type { CharacterCard } from '../shared/foundation/character-card';
import { ALL_KEPT, DAY, FIXTURE_TERMS, daysAgoKey, filesOf, makeFixture, makeTranslator, providerScope, withDirectory, type Fixture } from './helpers/convert-fixture';

const convert = async (fixture: Fixture, names: unknown[], extra?: unknown[]) => {
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names, ...(extra ? { extra } : {}) });
  await fixture.service.idle();
  return fixture.service.view()!;
};
/** The nicknames left for later (her name kept as Cheng). */
const LEFT_OUT = [ALL_KEPT[0]!, { id: 'her-nickname', to: '' }, { id: 'user-nickname', to: '' }];
const memoryTitles = (fixture: Fixture, id: string) => fixture.companion.memory.list({ characterId: id, providerScope }, { limit: 50 }, 1_900_000_000_000).records.map(record => record.title);
const newProfile = async (directory: string, id: string) => JSON.parse(await readFile(path.join(directory, 'user-profiles', `profile-${userProfileScopeId({ characterId: id, providerScope })}.json`), 'utf8'));
/** More diary days (4…3+n days back), so one or two bad items are under a tenth of everything carried. */
async function addDiaryDays(fixture: Fixture, n: number) {
  for (let back = 4; back < 4 + n; back++) await fixture.profiles.saveDiary(fixture.profiles.diaryTicket()!, daysAgoKey(back), `第${back}天：天气不错，小雨去散步了。`);
  await fixture.profiles.settled?.();
}
const exists = async (file: string) => stat(file).then(() => true, () => false);

// ---- A. the source field's own words ---------------------------------------------------------------------------------------------

test('a field that says 爱妻 itself may say "wife", even next to a left-out 老婆 and 老公; a left-out name rendered as wife still fails', () => {
  const names: NameMap = { 'her-name': { from: '阿澄', to: 'Cheng' }, 'her-nickname': { from: '老婆', to: '' }, aliases: [{ from: '老公', to: '', refers: 'user' }] };
  const flag = (source: unknown, result: unknown) => inventedPetNames(source, result, 'zh-CN', 'en', names);
  // the exact shape of the fourth test: her own quoted words with 爱妻, in the same sentence as the two names left for later
  const source = { summary: '她梦游时写了张纸条“爱妻阿澄”，后半句是让用户叫她老婆、她叫用户老公。' };
  assert.deepEqual(flag(source, { summary: 'Sleepwalking, she wrote a note: "my beloved wife Cheng"; the rest asked the user to call her by a pet name, and she would call him one too.' }), []);
  // without 爱妻 in the source, "wife" where 老婆 was is an invention
  assert.deepEqual(flag({ summary: '后半句是让用户叫她老婆。' }, { summary: 'The rest asked the user to call her his wife.' }), ['wife']);
  // only the same concept: 爱妻 allows a spouse word, not a term of endearment
  assert.deepEqual(flag(source, { summary: 'She wrote "my beloved wife Cheng", and called the user sweetie.' }), ['sweetie']);
  // per field: 爱妻 in the title does not allow "wife" in the summary
  assert.deepEqual(flag({ title: '爱妻纸条', summary: '用户叫她老婆。' }, { title: 'The beloved wife note', summary: 'The user called her wife.' }), ['wife']);
  // decided after the replacement: the left-out 老婆 / 老公 themselves never count as the source's own words
  assert.deepEqual(flag({ s: '老婆和老公' }, { s: 'wife and husband' }), ['wife', 'husband']);
  // other common forms count too; 夫 inside 功夫 does not
  for (const own of ['妻', '夫君', '娘子', '内人', '相公', '媳妇', '丈夫']) assert.deepEqual(flag({ s: `${own}说老婆来了` }, { s: 'her husband said his wife came' }), [], own);
  assert.deepEqual(flag({ s: '一起练功夫，老婆来了' }, { s: 'Practising kung fu, then his husband came' }), ['husband']);
  assert.deepEqual(flag({ s: '亲爱的，老婆来了' }, { s: 'Darling, she came' }), [], 'an endearment of its own allows an endearment');
  // the other direction: the English source's own "wife" allows 老婆
  const en: NameMap = { 'her-nickname': { from: 'Bun', to: '' } };
  assert.deepEqual(inventedPetNames({ s: 'A note: "my beloved wife Gene". Bun laughed.' }, { s: '纸条：“我的老婆阿金”。阿金笑了。' }, 'en', 'zh-CN', en), []);
  assert.deepEqual(inventedPetNames({ s: 'Bun laughed.' }, { s: '老婆笑了。' }, 'en', 'zh-CN', en), ['老婆']);
});

test('end to end: the quoted "爱妻" note converts (it stopped the whole conversion in the fourth test)', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { model: makeTranslator([...FIXTURE_TERMS, ['爱妻', 'beloved wife ']]) });
  const file = path.join(directory, MEMORY_NOTES_FILE);
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.notes[0].body.summary = '她写了纸条“爱妻阿澄”，又让小雨叫她澄澄。';
  await writeFile(file, JSON.stringify(data));
  const done = await convert(fixture, LEFT_OUT);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.leftOut, undefined);
  assert.equal(done.carried?.notes, 2);
}));

// ---- B. one failing item is left out, named, the rest carried ----------------------------------------------------------------------

test('an item still wrong after its re-ask is left out and named with its own reason; the rest is carried', async () => withDirectory(async directory => {
  const bad = daysAgoKey(1);
  // n0's title keeps a Chinese word every time; one diary day gets an invented pet name where the left-out 小雨 was, every time
  const model = makeTranslator(FIXTURE_TERMS, (value, kind, key) => key === 'n0' ? { ...value, title: `${value.title} 老街` }
    : key === `d${bad}` ? { ...value, text: `${value.text} Good night, sweetie.` } : value);
  const fixture = await makeFixture(directory, { model });
  await addDiaryDays(fixture, 13); // 2 notes + 16 days + 1 profile line + 1 voice = 20 items; 2 left out = a tenth
  const done = await convert(fixture, LEFT_OUT);
  assert.equal(done.state, 'done', done.error);
  assert.deepEqual(done.leftOut, [
    { title: '周五面试', kind: 'note', reasons: ['leftover'] }, // n0 is the newest note
    { title: `${bad} 的日记`, kind: 'diary', reasons: ['invented'] },
  ]);
  assert.equal(done.leftOutCount, 2);
  // the rest is carried, the two are not
  assert.equal(done.carried?.notes, 1);
  assert.equal(done.carried?.diaryDays, 15);
  assert.equal(memoryTitles(fixture, done.newCardId!).length, 1);
  const profile = await newProfile(directory, done.newCardId!);
  assert.equal(profile.diary.some((entry: { date: string }) => entry.date === bad), false);
  assert.doesNotMatch(JSON.stringify(profile), /sweetie|老街/);
  // the user is told plainly: titles and reasons where the user looks (the conversion line, the channel's notCarried) ...
  assert.deepEqual(conversionSummary(done).notCarried, ['「周五面试」：还留着原来语言的字', `「${bad} 的日记」：像是自己编了一个昵称或爱称`]);
  assert.match(String(conversionSummary(done).note), /有 2 条记忆重问一次还是翻得不合格，没有带过去（1 条还留着原来语言的字；1 条像是自己编了一个昵称或爱称）/);
  // ... while the line the assistant's model reads next turn has the counts, not the titles
  assert.match(conversionLine(done), /有 2 条记忆重问一次还是翻得不合格/);
  assert.doesNotMatch(conversionLine(done), /周五面试/);
}));

test('more than a tenth left out stops the whole conversion, each reason counted on its own, nothing left behind', async () => withDirectory(async directory => {
  const bad = daysAgoKey(1);
  const model = makeTranslator(FIXTURE_TERMS, (value, kind, key) => key === 'n0' || key === 'p0' ? JSON.parse(JSON.stringify(value).replace(/"(title|text)":"/u, '"$1":"老街 '))
    : key === `d${bad}` ? { ...value, text: `${value.text} Good night, sweetie.` } : value);
  const fixture = await makeFixture(directory, { model });
  await addDiaryDays(fixture, 13); // 20 items, 3 left out = more than a tenth
  const before = await filesOf(directory);
  const done = await convert(fixture, LEFT_OUT);
  assert.equal(done.state, 'failed');
  assert.match(done.error!, /^有 3 条记忆（共 20 条）重问一次还是翻得不合格，超过一成，转换没有继续（原角色没有任何改动）：2 条还留着原来语言的字；1 条像是自己编了一个昵称或爱称。$/);
  assert.doesNotMatch(done.error!, /不一致|面试|老街/);
  const after = await filesOf(directory);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [file, bytes] of before) assert.ok(bytes.equals(after.get(file)!), file);
  assert.equal(await exists(path.join(directory, 'character-convert')), false, 'no empty folder left either');
}));

test('the persona call says which problem it had (an invented pet name is not "names inconsistent")', async () => {
  const card = { name: '阿澄', description: '用户叫她团子。', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '', understandingNotes: '' } as unknown as CharacterCard;
  const answer = JSON.stringify({ name: 'Cheng', description: 'The user calls her sweetie.', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '', understandingNotes: '' });
  const names: NameMap = { 'her-name': { from: '阿澄', to: 'Cheng' }, 'her-nickname': { from: '团子', to: '' } };
  await assert.rejects(translatePersona(card, 'zh-CN', 'en', names, async () => answer, new AbortController().signal), (error: Error) => {
    assert.match(error.message, /人设翻译两次都没能用上：人设翻译里像是自己编了一个昵称或爱称。/);
    assert.doesNotMatch(error.message, /不一致/);
    return true;
  });
});

// ---- D. a name being called out --------------------------------------------------------------------------------------------------

test('a left-out name being called out becomes the neutral mark, not whom it names; other uses keep the plain reference', () => {
  const names: NameMap = { 'her-name': { from: '阿澄', to: 'Cheng' }, 'her-nickname': { from: '团子', to: '' } };
  const mark = LEFT_OUT_MARK['zh-CN'];
  const scrub = (text: string) => withoutLeftOutNames(text, names, 'zh-CN');
  assert.equal(scrub('用户连叫多声“团子”，她笑了。'), `用户连叫多声“${mark}”，她笑了。`);
  assert.equal(scrub('用户逗她叫团子，她不肯。'), `用户逗她叫${mark}，她不肯。`);
  assert.equal(scrub('让我叫团子就叫吧'), `让我叫${mark}就叫吧`);
  assert.equal(scrub('用户喊了几遍团子'), `用户喊了几遍${mark}`);
  assert.equal(scrub('他一直念叨“团子”'), `他一直念叨“${mark}”`); // the name alone in quotes: the word itself
  // not a call: the plain reference stays (the meaning holds)
  assert.equal(scrub('答案是团子。团子很开心。'), '答案是阿澄。阿澄很开心。');
  // the English mirror
  const en: NameMap = { 'her-name': { from: 'Gene', to: '阿金' }, 'her-nickname': { from: 'Bun', to: '' } };
  assert.equal(withoutLeftOutNames('He called out Bun twice. He kept calling "Bun" all night. Bun was happy.', en, 'en'),
    `He called out ${LEFT_OUT_MARK.en} twice. He kept calling "${LEFT_OUT_MARK.en}" all night. Gene was happy.`);
  // a called-out name is not more evidence that a people-list name is a form of address (that rule stays narrow)
  assert.equal(inNamingContext('团子', '连叫多声“', '”'), true);
});

// ---- E. small things -------------------------------------------------------------------------------------------------------------

test('the popup says who added an extra name; "by" is checked; the redundant nickname line is gone', async () => {
  const preview = { source: { id: 'card-1', name: '阿澄', language: 'zh-CN' }, target: 'en', names: [{ id: 'her-name', label: '她在新卡上的名字', text: '阿澄' }],
    counts: {}, copied: [], notCopied: [], voice: '', settings: { carried: [], off: [] }, calls: 2, cost: '', persona: '' } as unknown as ConversionPreview;
  const service = { running: false, preview: async () => structuredClone(preview), checkExtra: async (_id: string, extra: unknown[]) => extra } as unknown as ConversionService;
  const [, convertTool] = createConversionTools(() => service);
  const request = convertTool!.validate({ characterId: 'card-1', language: 'en', names: [{ id: 'her-name', to: 'Cheng' }],
    extra: [{ kind: 'alias', from: '老公', to: '', by: 'user' }, { kind: 'term', from: '星火', to: 'Ember', by: 'assistant' }, { kind: 'term', from: '月影', to: 'Moonshade' }] });
  const detail = convertTool!.confirmation!(await convertTool!.prepare!(request)).detail;
  assert.match(detail, /她的记忆里常出现的称呼或名字（你补的）：「老公」先不带/);
  assert.match(detail, /（Claude 在人设里找到的）：「星火」换成「Ember」/);
  assert.match(detail, /（另外补的）：「月影」换成「Moonshade」/);
  assert.throws(() => validateConversionRequest({ characterId: 'a', language: 'en', names: [], extra: [{ kind: 'term', from: 'x', to: 'X', by: 'someone' }] }), /by 只能是 user/);
  const lines = conversionCopiedLines({ notes: 1, notesCarried: 1, profileEntries: 0, diaryDays: 0, memes: 0, knownDays: 1, qualityDays: 0, metDate: null }, 'en');
  assert.ok(!lines.some(line => line.startsWith('昵称')), lines.join('|'));
  // the assistant marks who added each, and is told to answer in the language the user wrote in
  assert.match(ASSISTANT_SYSTEM_PROMPT, /一律 "by":"assistant"（包括从 candidates 里挑的），只有用户自己在对话里打出来的才写 "by":"user"/); // fix 6: the wording moved
  assert.match(ASSISTANT_SYSTEM_PROMPT, /用户这次用什么语言写，就用什么语言回答.*例：用户问 "How do I describe a voice I want for her\?"，整段用英文回答/);
});

test('the voice line says there is nothing to rewrite when her style texts are empty', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const full = await fixture.service.preview(fixture.sourceId);
  assert.match(full.voice, /百炼的风格文字、Drama 3 的表演提示按新语言改写/);
  const binding = fixture.settings.current.tts!.styleBindings![0]!;
  binding.instruction = '';
  delete binding.fishActingStyle;
  const empty = await fixture.service.preview(fixture.sourceId);
  assert.match(empty.voice, /她没有风格文字或表演提示，没有要改写的/);
  assert.doesNotMatch(empty.voice, /改写；/);
  const done = await convert(fixture, ALL_KEPT);
  assert.equal(done.state, 'done', done.error);
  assert.doesNotMatch(done.carried!.voice, /改写/);
}));

test('a failed or cancelled conversion leaves no empty folder it made; folders that were there before stay', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  fixture.model.current = async () => '{"name": 5}'; // the persona call fails twice
  assert.equal((await convert(fixture, ALL_KEPT)).state, 'failed');
  assert.equal(await exists(path.join(directory, 'character-convert')), false, 'the whole folder it made is gone');
  // a folder that existed before is kept (its own content untouched); only the backups folder this run made goes
  await mkdir(path.join(directory, 'character-convert', 'keep'), { recursive: true });
  await writeFile(path.join(directory, 'character-convert', 'keep', 'note.txt'), 'x');
  assert.equal((await convert(fixture, ALL_KEPT)).state, 'failed');
  assert.deepEqual(await readdir(path.join(directory, 'character-convert')), ['keep']);
  // an older backup stays, and so does its folder
  await mkdir(path.join(directory, 'character-convert', 'backups', '20260101T000000Z-old'), { recursive: true });
  assert.equal((await convert(fixture, ALL_KEPT)).state, 'failed');
  assert.deepEqual(await readdir(path.join(directory, 'character-convert', 'backups')), ['20260101T000000Z-old']);
}));
