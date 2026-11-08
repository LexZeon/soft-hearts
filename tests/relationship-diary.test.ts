import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserProfileStore, type UserProfileScope } from '../electron/user-profile';
import { UserProfileContext } from '../electron/user-profile-context';
import { MemoryStore } from '../electron/memory';
import { DiaryWriter } from '../electron/diary/diary-writer';
import { DIARY_LIMITS, diaryMemes, memeContextSection, validateDiaryFields, withWrittenEntry, diaryState } from '../electron/diary/diary-data';
import { localDayRange, shiftDate } from '../electron/diary/diary-dates';
import { DIARY_MEME_RULE, DIARY_WRITING_RULES, buildDiaryPrompt, parseDiaryOutput, parseDiaryResult } from '../electron/diary/diary-prompt';
import { MEME_CONTEXT_NOTE } from '../shared/relationship';
import type { ChatMessage } from '../shared/contracts';

const scope: UserProfileScope = { characterId: 'character-a', providerScope: 'provider-a' };
const at = (day: string, hour = 12) => localDayRange(day).start + hour * 3_600_000;
const TODAY = '2026-11-02';
const back = (days: number) => shiftDate(TODAY, -days);
const opening: ChatMessage[] = [{ role: 'user', content: '早' }];

async function fixture(run: (f: { store: UserProfileStore; memory: MemoryStore; clock: { now: number }; profiles: string; chat(day: string, user: string, reply: string): Promise<void> }) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-meme-'));
  const profiles = path.join(directory, 'user-profiles');
  const clock = { now: at(TODAY, 9) };
  const store = new UserProfileStore(profiles, { now: () => clock.now });
  const memory = new MemoryStore(directory); await memory.load();
  let turn = 0;
  try {
    await store.activate(scope); store.setEnabled(true);
    await run({ store, memory, clock, profiles, chat: async (day, user, reply) => {
      const id = `turn-${++turn}`;
      await memory.beginTurn(scope, { id, userText: user, at: at(day, 20), newTopic: true });
      await memory.appendAssistant(scope, id, reply, at(day, 20) + 1000);
      await memory.finishTurn(scope, id, 'complete', at(day, 20) + 1000);
    } });
  } finally { store.dispose(); await memory.flush(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
const open = (store: UserProfileStore, memes: boolean) => {
  const context = new UserProfileContext(store);
  const handle = context.begin('早', () => true, opening, { memes });
  return { text: handle ? context.read(handle) ?? '' : '', context, handle };
};

test('the diary call may also name one small thing that belongs only to the two of them; no second call, same JSON', () => {
  assert.ok(buildDiaryPrompt({ persona: '角色名称：小测', language: '', date: '2026-11-01', relative: '昨天', material: '20:00 用户：布丁被抢了' }).includes(DIARY_MEME_RULE));
  const prompt = buildDiaryPrompt({ persona: '角色名称：小测', language: '', date: '2026-11-01', relative: '昨天', material: '20:00 用户：布丁被抢了' });
  assert.ok(prompt.includes('{"entry":"日记正文"}') && prompt.includes('"meme"'));
  assert.match(DIARY_MEME_RULE, /没有就不要写这个字段，不要硬凑/);
  assert.match(DIARY_MEME_RULE, new RegExp(`不超过${DIARY_LIMITS.memeChars}个字`));
  assert.doesNotMatch(DIARY_MEME_RULE, /[他她]/u);
  assert.equal(DIARY_WRITING_RULES.length, 8, 'the existing writing rules are untouched');
  const ok = parseDiaryResult('{"entry":"今天你抢布丁没抢到。","meme":"最后一个布丁"}');
  assert.deepEqual(ok, { entry: '今天你抢布丁没抢到。', meme: '最后一个布丁' });
  assert.deepEqual(parseDiaryResult('{"entry":"今天聊了很多。"}'), { entry: '今天聊了很多。', meme: null });
  assert.equal(parseDiaryOutput('{"entry":"今天聊了很多。","meme":"小事"}'), '今天聊了很多。', 'the old entry-only reader still works');
  // A bad meme only loses the meme.
  for (const meme of ['', '   ', 5, null, ['x'], '字'.repeat(DIARY_LIMITS.memeChars + 1), '见 <sh-state-ab>', '密码是 password=abc123', '见 C:\\\\Users\\\\me', '<b>']) {
    const result = parseDiaryResult(JSON.stringify({ entry: '今天聊了很多。', meme }));
    assert.deepEqual(result, { entry: '今天聊了很多。', meme: null }, JSON.stringify(meme));
  }
  // The rest is as strict as before.
  for (const bad of ['{"entry":"x","mood":"b"}', '{"meme":"x"}', '{"entry":"","meme":"x"}', '```json\n{"entry":"x"}\n```', '{"entry":"a","meme":"b","c":1}'])
    assert.equal(parseDiaryResult(bad), null, bad);
});

test('a written day keeps its meme with it; an old file without memes reads normally and a bad stored meme is refused', async () => fixture(async ({ store, profiles }) => {
  const ticket = store.diaryTicket()!;
  assert.equal(await store.saveDiary(ticket, back(1), '昨天抢布丁没抢到。', '最后一个布丁'), true);
  assert.equal(await store.saveDiary(ticket, back(2), '前天没什么特别的。'), true);
  assert.equal(await store.saveDiary(ticket, back(3), '大前天的日记。', '字'.repeat(DIARY_LIMITS.memeChars + 5)), true, 'a bad meme only loses the meme');
  const view = store.view().diary;
  assert.equal(view.find(entry => entry.date === back(1))?.meme, '最后一个布丁');
  assert.equal(Object.hasOwn(view.find(entry => entry.date === back(2))!, 'meme'), false);
  assert.equal(Object.hasOwn(view.find(entry => entry.date === back(3))!, 'meme'), false);
  const file = JSON.parse(await readFile(path.join(profiles, (await readdir(profiles))[0]), 'utf8'));
  assert.equal(file.diary.find((entry: { date: string }) => entry.date === back(1)).meme, '最后一个布丁');
  assert.equal(Object.hasOwn(file.diary.find((entry: { date: string }) => entry.date === back(2)), 'meme'), false, 'a day without one keeps the old shape');
  assert.throws(() => validateDiaryFields({ diary: [{ date: back(1), text: '好', writtenAt: 1, meme: 5 }] }));
  assert.throws(() => validateDiaryFields({ diary: [{ date: back(1), text: '好', writtenAt: 1, meme: 'password=abc123' }] }));
  validateDiaryFields({ diary: [{ date: back(1), text: '好', writtenAt: 1, meme: '最后一个布丁' }] });
  assert.equal(withWrittenEntry(diaryState({}), back(1), '好', 1, '')!.diary[0].meme, undefined);
}));

test('the opening block carries at most two memes of the last 30 days, newest first, never older ones; none unless the relationship allows', async () => fixture(async ({ store }) => {
  const ticket = store.diaryTicket()!;
  await store.saveDiary(ticket, back(1), '昨天。', '最后一个布丁');
  await store.saveDiary(ticket, back(5), '五天前。', '雨天的伞');
  await store.saveDiary(ticket, back(12), '十二天前。', '猫的名字');
  await store.saveDiary(ticket, back(31), '三十一天前。', '太久以前的事');
  const allowed = open(store, true);
  assert.ok(allowed.text.includes(MEME_CONTEXT_NOTE));
  assert.ok(allowed.text.includes('至多自然提起一件，不要背诵'));
  const lines = allowed.text.slice(allowed.text.indexOf(MEME_CONTEXT_NOTE) + MEME_CONTEXT_NOTE.length).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].endsWith('最后一个布丁') && lines[1].endsWith('雨天的伞'), 'newest first, at most two');
  assert.equal(allowed.text.includes('太久以前的事'), false);
  assert.equal(allowed.text.includes('猫的名字'), false, 'the third one is left out');
  // Not allowed (a slowly warming card before 熟悉): the diary points still ride along, the memes do not.
  const held = open(store, false);
  assert.ok(held.text.includes('昨天。'));
  assert.equal(held.text.includes('最后一个布丁') && held.text.includes(MEME_CONTEXT_NOTE), false);
  assert.equal(held.text.includes(MEME_CONTEXT_NOTE), false);
  assert.deepEqual(diaryMemes(store.view().diary, TODAY, 30, 2), [`${back(1).slice(5)}：最后一个布丁`, `${back(5).slice(5)}：雨天的伞`]);
  assert.equal(memeContextSection([]), '');
  // Later turns of the conversation carry nothing.
  const context = new UserProfileContext(store);
  assert.equal(context.begin('在吗', () => true, [...opening, { role: 'assistant', content: '在呀' }, { role: 'user', content: '在吗' }], { memes: true }), null);
  allowed.context.release(allowed.handle);
}));

test('recording off, a deleted day or a cleared diary: the meme goes with the day', async () => fixture(async ({ store }) => {
  const ticket = store.diaryTicket()!;
  await store.saveDiary(ticket, back(1), '昨天。', '最后一个布丁');
  await store.saveDiary(ticket, back(2), '前天。', '雨天的伞');
  const first = open(store, true);
  assert.ok(first.text.includes('最后一个布丁'));
  await store.deleteDiary(back(1), store.view().revision);
  assert.equal(first.context.read(first.handle), null, 'deleting revokes an already prepared context');
  const second = open(store, true);
  assert.equal(second.text.includes('最后一个布丁'), false, 'the deleted day\'s meme is gone');
  assert.ok(second.text.includes('雨天的伞'));
  assert.equal(JSON.stringify(store.view()).includes('最后一个布丁'), false, 'and from the stored view too');
  // Editing the text of a day keeps its meme (it is hers to find, yours to delete with the day).
  await store.editDiary(back(2), '改过的前天。', store.view().revision);
  assert.equal(store.view().diary[0].meme, '雨天的伞');
  store.setEnabled(false);
  assert.equal(open(store, true).text, '', 'recording off: no memes in chat');
  store.setEnabled(true);
  await store.clearDiary(store.view().revision);
  assert.equal(open(store, true).text, '');
  assert.deepEqual(diaryMemes(store.view().diary, TODAY), []);
}));

test('the writer stores the meme from the same single call, and a model that omits or garbles it still gets its day written', async () => fixture(async ({ store, memory, clock, chat }) => {
  await chat(back(1), '布丁被前面的人拿走了！', '怎么这样，最后一个都不留给你。');
  await chat(back(2), '今天加班。', '辛苦了。');
  await chat(back(3), '早上好。', '早呀。');
  const calls: string[] = [];
  const answers = [
    '{"entry":"昨天你没抢到布丁。","meme":"最后一个布丁"}',
    '{"entry":"前天你加班了。","meme":"password=abc123"}',
    '{"entry":"大前天问了早安。"}',
  ];
  const writer = new DiaryWriter({ profiles: store, scope: () => scope, messages: (target, start, end) => memory.conversationMessages(target, start, end),
    character: () => ({ persona: '角色名称：小测', language: '' }), model: () => 'sonnet',
    generate: async request => { calls.push(request.prompt); return answers[calls.length - 1]; }, written: () => {}, now: () => clock.now });
  try {
    writer.tick();
    const until = Date.now() + 10_000;
    while (writer.busy && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(calls.length, 3, 'one call per day, nothing extra for the meme');
    const entries = store.view().diary;
    assert.equal(entries.length, 3);
    assert.equal(entries.find(entry => entry.date === back(1))?.meme, '最后一个布丁');
    assert.equal(entries.find(entry => entry.date === back(2))?.meme, undefined);
    assert.equal(entries.find(entry => entry.date === back(3))?.meme, undefined);
    assert.ok(calls.every(prompt => prompt.includes(DIARY_MEME_RULE)));
  } finally { writer.dispose(); }
}));
