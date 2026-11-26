// I-071 v2 第三步「转换成英文 / 中文角色」: the conversion core with real stores and a fake Claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UserProfileStore, userProfileScopeId } from '../electron/memory/user-profile';
import { relationshipFileName } from '../electron/memory/relationship/store';
import { relationshipBackfillKey } from '../electron/memory/relationship/host';
import { MEMORY_NOTES_FILE } from '../electron/memory/memory-notes/store';
import { CONVERSION_BACKUP_FILES } from '../electron/cards/character-convert/service';
import { batches, clip, readMemoryBatch, readPersona, type MemoryItem } from '../electron/cards/character-convert/translate';
import { resolveConversionNames, conversionNames } from '../shared/cards/character-convert';
import { ALL_KEPT, DAY, fakeEnglish as E, filesOf, makeFixture, prefixTranslation, providerScope, withDirectory, type Fixture } from './helpers/convert-fixture';

const sourceFiles = (fixture: Fixture) => {
  const scopeId = userProfileScopeId({ characterId: fixture.sourceId, providerScope });
  return ['relationship/' + relationshipFileName(fixture.sourceId), `user-profiles/profile-${scopeId}.json`, MEMORY_NOTES_FILE];
};
const sourceRecords = (fixture: Fixture) => JSON.stringify(fixture.companion.memory.list({ characterId: fixture.sourceId, providerScope }, { limit: 50 }, 1_900_000_000_000));

async function convert(fixture: Fixture, names = ALL_KEPT) {
  const view = await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names });
  assert.equal(view.state, 'running');
  await fixture.service.idle();
  return fixture.service.view()!;
}

test('convert: a new English card with her memories translated under its own id; the source is untouched byte for byte', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const before = await filesOf(directory);
  const recordsBefore = sourceRecords(fixture);
  const cardBefore = JSON.stringify(fixture.cards.publicState().cards.find(card => card.id === fixture.sourceId));
  const keysBefore = { apiKey: fixture.settings.current.tts!.apiKey, fishApiKey: fixture.settings.current.tts!.fishApiKey, cap: fixture.settings.current.tts!.fishMonthlyCapUsd };

  const done = await convert(fixture);
  assert.equal(done.state, 'done', done.error);
  const newId = done.newCardId!;
  assert.notEqual(newId, fixture.sourceId);
  assert.deepEqual(done.steps.map(step => step.status), ['done', 'done', 'done', 'done', 'done', 'done']);

  // The card: English, the chosen name, translated persona, the same model, not made current, "更真实的情绪" not carried.
  const card = fixture.cards.publicState().cards.find(item => item.id === newId)!;
  assert.equal(card.language, 'en');
  assert.equal(card.name, 'Cheng');
  assert.equal(card.description, E('在海边长大的女孩'));
  assert.equal(card.systemPrompt, E('她叫用户小雨。')); // "EN " + four romanized letters + "Rainy." (fix 8: an English card has ASCII punctuation)
  assert.match(card.systemPrompt, /^EN [a-z]{4}Rainy\.$/u);
  assert.doesNotMatch(card.systemPrompt, /\p{Script=Han}/u);
  assert.equal(fixture.cards.rosterCards().find(item => item.id === newId)!.modelPath, fixture.modelPath);
  assert.equal(fixture.cards.publicState().activeId, fixture.sourceId);
  assert.equal(card.realerEmotions, undefined);

  // Her notes became her memories under the new scope only: recalled by a translated tag, her recollection as her line,
  // and none of them shows in the chat window (empty user line).
  const scope = { characterId: newId, providerScope };
  const recalled = fixture.companion.memory.retrieve(scope, `remember the ${E('书店').toLowerCase()}?`, {}, Date.now());
  assert.equal(recalled.length >= 1, true);
  assert.match(recalled[0]!.excerpt, /Remembered from before, not our exact words/);
  assert.ok(recalled[0]!.excerpt.includes(E('用户说最喜欢下雨天去老城区的书店。')));
  const newRecords = fixture.companion.memory.list(scope, { limit: 50 }, 1_900_000_000_000);
  assert.equal(JSON.stringify(newRecords).includes(E('下雨天的书店')), true);
  assert.deepEqual(fixture.companion.memory.recentConversation(scope, 'converted-' + newId + '-0'), []);
  assert.equal(fixture.companion.memory.noteSegments(Date.now()).filter(segment => segment.scope === fixture.companion.memory.noteScope(scope)).every(segment => segment.userChars === 0), true);

  // Profile and diary under the new scope, translated; the diary does not backfill from carried memories.
  const profiles = new UserProfileStore(path.join(directory, 'user-profiles'));
  await profiles.activate(scope); profiles.setEnabled(true);
  const view = profiles.view();
  assert.deepEqual(view.entries.map(entry => entry.text), [E('我在学钢琴。')]);
  assert.equal(view.diary.length, 3);
  assert.equal(view.diary.every(entry => entry.text.startsWith('EN ')), true);
  assert.equal(view.diary.find(entry => entry.meme)?.meme, E('抢不到的布丁'));

  // Familiarity as it was, the nicknames as the user chose, the new scope counted as scanned.
  const relationship = await fixture.companion.relationship.snapshot(newId);
  const sourceRelationship = await fixture.companion.relationship.snapshot(fixture.sourceId);
  assert.deepEqual(relationship.days, sourceRelationship.days);
  assert.deepEqual(relationship.qualityDays, sourceRelationship.qualityDays);
  assert.equal(relationship.metDate, sourceRelationship.metDate);
  assert.equal(relationship.nickname, 'Rainy');
  assert.equal(relationship.herNickname, '澄澄');
  assert.deepEqual(relationship.backfilled, [relationshipBackfillKey(scope)]);

  // Voice: same model, the style texts adapted, the private Drama 3 voice id not carried, keys and the monthly cap untouched.
  const tts = fixture.settings.current.tts!;
  const binding = tts.styleBindings!.find(item => item.characterId === newId)!;
  assert.equal(binding.modelPath, fixture.modelPath);
  assert.equal(binding.instruction, E('温柔，有点困，句尾拖一点'));
  assert.equal(binding.fishActingStyle, E('平时一直有点困的语气'));
  assert.equal(binding.fishVoiceId, undefined);
  assert.equal(tts.styleBindings!.find(item => item.characterId === fixture.sourceId)!.fishVoiceId, 'privatevoice123');
  assert.deepEqual({ apiKey: tts.apiKey, fishApiKey: tts.fishApiKey, cap: tts.fishMonthlyCapUsd }, keysBefore);

  // The source: her card, her records, her relationship, profile and notes files are exactly what they were.
  assert.equal(JSON.stringify(fixture.cards.publicState().cards.find(item => item.id === fixture.sourceId)), cardBefore);
  assert.equal(sourceRecords(fixture), recordsBefore);
  const after = await filesOf(directory);
  for (const file of sourceFiles(fixture)) assert.ok(before.get(file)?.equals(after.get(file)!), `${file} changed`);
  // Staging is gone; the backup of the shared files is there.
  assert.deepEqual(await readdir(path.join(directory, 'character-convert', 'staging')).catch(() => []), []);
  const [backup] = await readdir(path.join(directory, 'character-convert', 'backups'));
  const backedUp = await readdir(path.join(directory, 'character-convert', 'backups', backup!));
  for (const name of CONVERSION_BACKUP_FILES) if (before.has(name)) assert.ok(backedUp.includes(name), name);
  assert.ok((await readFile(path.join(directory, 'character-convert', 'backups', backup!, 'characters.json'))).equals(before.get('characters.json')!));
  // One persona call and one memory batch, with the Claude 助手's model.
  assert.equal(fixture.model.calls.length, 2);
  assert.match(fixture.model.calls[0]!.system, /Do not add, quote or invent lines from any game/);
}));

test('convert: memories are copied under the new scope only (no cross-talk with the source)', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const done = await convert(fixture);
  const source = { characterId: fixture.sourceId, providerScope }, target = { characterId: done.newCardId!, providerScope };
  // The source does not recall the carried copies, and the new card does not recall the source's chats.
  assert.equal(fixture.companion.memory.retrieve(source, E('书店').toLowerCase(), {}, Date.now()).length, 0);
  assert.equal(fixture.companion.memory.retrieve(target, '我最喜欢下雨天去书店 书店', {}, Date.now()).every(item => item.excerpt.includes('Remembered from before')), true);
  const sourceKey = fixture.companion.memory.noteScope(source), targetKey = fixture.companion.memory.noteScope(target);
  const segments = fixture.companion.memory.noteSegments(Date.now());
  assert.equal(segments.filter(segment => segment.scope === sourceKey).length, 3);
  assert.equal(segments.filter(segment => segment.scope === targetKey).length, 2);
}));

test('names: each one must be the user\'s choice; a bad nickname is refused; nothing starts', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const listed = conversionNames({ name: '阿澄' }, { nickname: '小雨', herNickname: '澄澄' });
  assert.deepEqual(listed.map(name => name.id), ['her-name', 'her-nickname', 'user-nickname']);
  await assert.rejects(fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT.slice(0, 2) }), /她叫你的昵称.*还没选/);
  await assert.rejects(fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: [ALL_KEPT[0]!, ALL_KEPT[1]!, { id: 'user-nickname', to: 'A very long nickname' }] }), /最多 8 个字/);
  await assert.rejects(fixture.service.start({ characterId: fixture.sourceId, language: 'zh-CN', names: ALL_KEPT }), /已经是这种语言/);
  assert.equal(fixture.service.view(), null);
  assert.throws(() => resolveConversionNames(listed, ALL_KEPT.slice(1)), /她在新卡上的名字/);
}));

/** Cancel or fail while translating: nothing outside the conversion folder changed, and no staging or backup is left. */
async function assertNothingChanged(directory: string, before: Map<string, Buffer>) {
  const after = await filesOf(directory);
  const outside = (files: Map<string, Buffer>) => [...files.keys()].filter(file => !file.startsWith('character-convert/')).sort();
  assert.deepEqual(outside(after), outside(before));
  for (const file of outside(before)) assert.ok(before.get(file)!.equals(after.get(file)!), `${file} changed`);
  assert.deepEqual([...after.keys()].filter(file => file.startsWith('character-convert/')), []);
}

test('cancel while translating: stops, leaves nothing behind, the profile folder is byte for byte what it was', async () => withDirectory(async directory => {
  let release!: () => void;
  const fixture = await makeFixture(directory);
  fixture.model.current = async (prompt, system, signal) => {
    if (system.includes('character card')) return prefixTranslation(prompt, system, signal);
    await new Promise<void>((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    return prefixTranslation(prompt, system, signal);
  };
  const before = await filesOf(directory);
  const cardsBefore = fixture.cards.publicState().cards.length;
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT });
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(release, 'the memory call started');
  assert.equal(fixture.service.cancel(), true);
  await fixture.service.idle();
  assert.equal(fixture.service.view()!.state, 'cancelled');
  assert.equal(fixture.cards.publicState().cards.length, cardsBefore);
  await assertNothingChanged(directory, before);
}));

for (const [label, broken] of [['two malformed answers', async () => 'not json at all'], ['a failing call', async (): Promise<string> => { throw new Error('Claude Code 运行失败（退出码 1）。'); }]] as const)
  test(`failure while translating (${label}): nothing is left, the source unchanged`, async () => withDirectory(async directory => {
    const fixture = await makeFixture(directory);
    fixture.model.current = async (prompt, system, signal) => system.includes('character card') ? prefixTranslation(prompt, system, signal) : broken();
    const before = await filesOf(directory);
    await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT });
    await fixture.service.idle();
    const view = fixture.service.view()!;
    assert.equal(view.state, 'failed');
    assert.match(view.error!, /原角色没有任何改动|运行失败/);
    await assertNothingChanged(directory, before);
  }));

test('failure in the persona call: asked twice, then nothing is left', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  fixture.model.current = async () => '{"name": 5}';
  const before = await filesOf(directory);
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT });
  await fixture.service.idle();
  assert.equal(fixture.service.view()!.state, 'failed');
  assert.match(fixture.service.view()!.error!, /人设翻译两次都没能用上/);
  assert.equal(fixture.model.calls.length, 2);
  await assertNothingChanged(directory, before);
}));

test('failure while saving: every part of the new card is rolled back; the source is untouched', async () => withDirectory(async directory => {
  let newId = '';
  const fixture = await makeFixture(directory, { wiring: wiring => ({ ...wiring, addCard: async id => { newId = id; throw new Error('磁盘写不进去。'); } }) });
  const before = await filesOf(directory);
  const recordsBefore = sourceRecords(fixture);
  const done = await convert(fixture);
  assert.equal(done.state, 'failed');
  assert.match(done.error!, /磁盘写不进去/);
  assert.ok(newId);
  const scope = { characterId: newId, providerScope };
  assert.equal(fixture.cards.publicState().cards.some(card => card.id === newId), false);
  await assert.rejects(stat(path.join(directory, 'relationship', relationshipFileName(newId))));
  await assert.rejects(stat(path.join(directory, 'user-profiles', `profile-${userProfileScopeId(scope)}.json`)));
  assert.equal(fixture.companion.memory.noteSegments(Date.now()).filter(segment => segment.scope === fixture.companion.memory.noteScope(scope)).length, 0);
  assert.equal(fixture.settings.current.tts!.styleBindings!.some(item => item.characterId === newId), false);
  assert.equal(sourceRecords(fixture), recordsBefore);
  const after = await filesOf(directory);
  for (const file of sourceFiles(fixture)) assert.ok(before.get(file)!.equals(after.get(file)!), `${file} changed`);
  assert.equal((await readdir(path.join(directory, 'character-convert', 'backups'))).length, 1, 'the backup made before saving stays');
}));

test('an interrupted save (the app quit or crashed) is rolled back at the next start', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const newId = '00000000-1111-4222-8333-444444444444', scope = { characterId: newId, providerScope };
  // Parts of a new card that got saved before the crash: her familiarity and one carried memory; no card yet.
  await fixture.companion.relationship.adopt(newId, { ...(await fixture.companion.relationship.snapshot(fixture.sourceId)), backfilled: [] });
  const key = fixture.companion.memory.noteScope(scope);
  await fixture.companion.memory.restoreRecords([{ id: 'r-1', scopeKey: key, conversationId: 'c', title: 't', tags: ['x'], category: '日常', manual: { title: true, tags: true, category: false },
    createdAt: 1, updatedAt: 1, lastFinishedAt: 1, weight: 20, weightAt: 1, mentions: [], sealed: true,
    messages: [{ id: 'm1', turnId: 't1', role: 'user', content: '', createdAt: 1, updatedAt: 1, status: 'complete' }, { id: 'm2', turnId: 't1', role: 'assistant', content: 'carried', createdAt: 1, updatedAt: 1, status: 'complete' }] }], scope);
  const staging = path.join(directory, 'character-convert', 'staging', 'job-1');
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, 'commit.json'), JSON.stringify({ newId, providerScope }));
  await mkdir(path.join(directory, 'character-convert', 'staging', 'job-2'), { recursive: true }); // never began saving
  assert.equal(await fixture.service.ensureRecovered(), 1);
  await assert.rejects(stat(path.join(directory, 'relationship', relationshipFileName(newId))));
  assert.equal(fixture.companion.memory.noteSegments(Date.now()).some(segment => segment.scope === key), false);
  assert.deepEqual(await readdir(path.join(directory, 'character-convert', 'staging')).catch(() => []), []); // fix 8: the empty staging folder goes too
}));

test('the card button only asks the Claude 助手 (no conversion starts without the popup); the cancel IPC cancels', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  await fixture.registered.get('assistantConvertCharacter')!(fixture.sourceId);
  assert.deepEqual(fixture.sent, ['把角色「阿澄」转成英文版。']);
  assert.equal(fixture.service.view(), null);
  await assert.rejects(Promise.resolve(fixture.registered.get('assistantConvertCharacter')!('nope')), /角色卡不存在/);
  assert.equal(fixture.registered.get('assistantCancelConversion')!('nope'), false);
}));

test('one conversion at a time; the preview tells counts, names and cost before anything starts', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const preview = await fixture.service.preview(fixture.sourceId);
  assert.equal(preview.target, 'en');
  assert.deepEqual({ notes: preview.counts.notesCarried, profile: preview.counts.profileEntries, diary: preview.counts.diaryDays, memes: preview.counts.memes, days: preview.counts.knownDays },
    { notes: 2, profile: 1, diary: 3, memes: 1, days: 2 });
  assert.deepEqual(preview.names.map(name => name.text), ['阿澄', '澄澄', '小雨']);
  assert.match(preview.cost, /你自己的 Claude Code（sonnet，思考强度低）.*不另外花钱/);
  assert.equal(preview.calls, 2);
  assert.ok(preview.notCopied.some(line => line.includes('原始聊天记录')));
  let release!: () => void;
  fixture.model.current = async (prompt, system, signal) => { await new Promise<void>(resolve => { release = resolve; }); return prefixTranslation(prompt, system, signal); };
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT });
  await assert.rejects(fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT }), /已经有一个转换/);
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10));
  fixture.model.current = prefixTranslation; release();
  await fixture.service.idle();
}));

test('translation reading: strict shapes, limits clipped, malformed items asked again, batches bounded', () => {
  assert.throws(() => readPersona('{"name":"A","description":' + JSON.stringify('x'.repeat(4001)) + '}'), /太长/);
  assert.equal(readPersona('sure: {"name":"Gene","description":"d"} done').description, 'd');
  const items: MemoryItem[] = [
    { k: 'n0', kind: 'note', v: { title: '标题', summary: '摘要', people: [], things: [], mood: '', plans: [], tags: ['a', 'b', 'c'] } },
    { k: 'd1', kind: 'diary', v: { text: '日记', meme: '梗' } },
    { k: 'p0', kind: 'profile', v: { text: '画像' } },
  ];
  const read = readMemoryBatch(JSON.stringify({ items: [
    { k: 'n0', v: { title: 'Title', summary: 'Sum', people: [], things: [], mood: '', plans: [], tags: ['Rain', 'rain', 'Books'] } },
    { k: 'd1', v: { text: 'Diary' } }, // the meme is missing: asked again
    { k: 'p0', v: { text: 'x'.repeat(400) } },
    { k: 'zz', v: { text: 'unknown key' } },
  ] }), items);
  assert.deepEqual([...read.keys()], ['n0', 'p0']);
  assert.deepEqual((read.get('n0') as { tags: string[] }).tags, ['rain', 'books']);
  assert.equal(Array.from((read.get('p0') as { text: string }).text).length <= 270, true);
  assert.equal(clip('one two three four', 10), 'one two…');
  assert.equal(batches(Array.from({ length: 30 }, (_, i) => ({ k: `p${i}`, kind: 'profile' as const, v: { text: 'x'.repeat(1000) } }))).length > 3, true);
});

test('the source\'s diary window is the last 30 days', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const ticket = fixture.profiles.diaryTicket()!;
  await fixture.profiles.saveDiary(ticket, new Date(Date.now() - 40 * DAY).toISOString().slice(0, 10), '很久以前的一天。');
  await fixture.profiles.settled();
  assert.equal((await fixture.service.preview(fixture.sourceId)).counts.diaryDays, 3);
}));

test('the calls use the Claude 助手\'s model and effort (--effort is only added when given)', async () => {
  const { claudeArguments } = await import('../electron/brain/claude');
  const { conversionModel } = await import('../electron/cards/character-convert/model');
  const args = claudeArguments({ model: 'sonnet', effort: 'low', systemPrompt: 'p' });
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.equal(claudeArguments({ model: 'sonnet', systemPrompt: 'p' }).includes('--effort'), false);
  assert.throws(() => claudeArguments({ model: 'sonnet', effort: 'max' as never, systemPrompt: 'p' }));
  const tasks: unknown[] = [];
  const call = conversionModel(() => ({ model: 'haiku', effort: 'high' }), async (task, _signal, emit) => { tasks.push(task); emit('delta', '{"ok":'); emit('delta', '1}'); return null; });
  assert.equal(await call('prompt', 'system', new AbortController().signal), '{"ok":1}');
  assert.deepEqual((tasks[0] as { model: string; effort: string; writable: boolean; systemPrompt: string }), { ...(tasks[0] as object), model: 'haiku', effort: 'high', writable: false, systemPrompt: 'system' });
});
