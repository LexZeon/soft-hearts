// C3 用角色卡文件原地更新 (docs/claude/2026-11-03-card-update-in-place.md). Real stores in temporary folders; synthetic cards and Gene only (never the user's own files).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../electron/character-cards';
import { CharacterResponseService, CharacterResponseStore } from '../electron/character-response';
import { CharacterCardUpdater, backupBeforeUpdate, readCharacterCardFile, updateBackupName } from '../electron/character-card-update';
import { CharacterAvatarStore } from '../electron/character-avatars';
import { CompanionService, memoryProviderScope } from '../electron/companion';
import { RpsStore } from '../electron/rps/store';
import { UserProfileStore, type UserProfileScope } from '../electron/user-profile';
import { localDateKey } from '../electron/diary/diary-dates';
import {
  BUNDLED_CHARACTER_MODEL, CHARACTER_CARD_FORMAT, compileCharacterPersona, defaultCharacterMoodTemplate, effectiveCharacterMood,
  type CharacterDraft, type CharacterMoodTemplate,
} from '../shared/character-cards';
import { cardUpdateSummaryLines, planCharacterCardUpdate, type CharacterCardFileContent } from '../shared/character-card-update';
import { CHARACTER_RESPONSE_MOODS, defaultCharacterResponseProfile, defaultCharacterResponseRule, type CharacterResponseProfile } from '../shared/character-response';
import { DEFAULT_MOOD_PARAMETERS, validateMoodParameters } from '../shared/mood';
import { readHerNeedSaved } from '../shared/her-needs';
import { setUiLanguage, t } from '../shared/ui-language';
import type { RpsGameRecord } from '../shared/rps-memory';

const provider = { kind: 'claude' as const, baseUrl: 'https://card-update.invalid/v1', model: 'fixture' };
const providerScope = memoryProviderScope(provider);

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-card-update-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
const text = (name: string, fields: Partial<CharacterDraft> = {}) => ({
  name, description: '', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '', ...fields,
});
function moodWith(change: (parameters: typeof DEFAULT_MOOD_PARAMETERS) => void): CharacterMoodTemplate {
  const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS);
  change(parameters);
  return { version: 1, parameters: validateMoodParameters(parameters) };
}
const PLAYFUL_MOOD = moodWith(parameters => { parameters.weights.playful = 2; });
const CALM_MOOD = moodWith(parameters => { parameters.weights.playful = 0.5; parameters.weights.cautious = 1.5; });
const reactions = (scale = 1.4): CharacterResponseProfile => {
  const rule = defaultCharacterResponseRule({ mood: CHARACTER_RESPONSE_MOODS[0] });
  rule.intensityScale.expression = scale;
  return { version: 1, rules: [rule] };
};
const v1File = (card: object) => JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 1, card });
const v2File = (card: object) => JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 2, card });
const v3File = (card: object) => JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 3, card });
const tavernV2File = (data: object) => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data });

/** Every file under the profile folder, by relative path. */
async function snapshot(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.set(path.relative(directory, full).split(path.sep).join('/'), await readFile(full));
  }
  return files;
}

// ---- reading a card file: every format the import reads ----

test('every card format the import reads can update a card, with exactly the import\'s checks', () => {
  const persona = { description: '在海边长大', personality: '安静，爱笑', scenario: '书店', greeting: '你来啦', examples: '用户：嗨\n角色：嗨', systemPrompt: '' };
  const v1 = readCharacterCardFile(v1File(text('阿澄', persona)));
  assert.equal(v1.format, 'soft-hearts-v1'); assert.equal(v1.draft.personality, '安静，爱笑'); assert.equal(v1.draft.mood, undefined);
  const v2 = readCharacterCardFile(v2File({ ...text('阿澄', persona), mood: PLAYFUL_MOOD, slowWarmUp: true }));
  assert.equal(v2.format, 'soft-hearts-v2'); assert.deepEqual(v2.draft.mood, PLAYFUL_MOOD); assert.equal(v2.draft.slowWarmUp, true);
  const v3 = readCharacterCardFile(v3File({ ...text('阿澄', persona), mood: PLAYFUL_MOOD, slowWarmUp: true, responseProfile: reactions() }));
  assert.equal(v3.format, 'soft-hearts-v3'); assert.deepEqual(v3.response, reactions()); assert.equal(v3.draft.slowWarmUp, true);
  const tavern2 = readCharacterCardFile(tavernV2File({ name: '阿澄', description: '在海边长大', personality: '安静，爱笑', first_mes: '你来啦', mes_example: '例', system_prompt: '补充' }));
  assert.equal(tavern2.format, 'tavern-v2'); assert.equal(tavern2.draft.greeting, '你来啦'); assert.equal(tavern2.draft.examples, '例'); assert.equal(tavern2.draft.systemPrompt, '补充');
  const tavern = readCharacterCardFile(JSON.stringify({ name: '阿澄', personality: '安静', first_mes: '嗨' }));
  assert.equal(tavern.format, 'tavern'); assert.equal(tavern.draft.greeting, '嗨');
  // The same refusals as importing: no paths, links, permissions or private state, and no half-formed cards.
  for (const bad of ['not json', '[]', v2File(text('x')), v2File({ ...text('x'), mood: PLAYFUL_MOOD, modelPath: 'C:\\m\\x.pmx' }),
    v1File({ ...text('x'), id: '0f8fad5b-d9cb-469f-a165-70867728950e' }), v3File({ ...text('x'), mood: PLAYFUL_MOOD }),
    JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 9, card: text('x') }), tavernV2File({ name: 'x', extensions: { tools: true } }),
    v1File(text('')), 'x'.repeat(1_000_001)])
    assert.throws(() => readCharacterCardFile(bad), Error, bad.slice(0, 40));
});

// ---- the rule ----

const fileOf = (format: CharacterCardFileContent['format'], draft: CharacterDraft, response: CharacterResponseProfile | null = null): CharacterCardFileContent => ({ format, draft, response });

test('the rule: persona text comes from the file; mood, "关系慢慢升温" and reactions only when the format has them', () => {
  const current: CharacterDraft = { ...text('阿澄', { description: '旧简介', personality: '旧性格', greeting: '旧开场' }), mood: PLAYFUL_MOOD, slowWarmUp: true };
  // Version 2: text, mood and the switch from the file; a v2 file without the switch means off (the app exports it only when on).
  const v2 = planCharacterCardUpdate(current, reactions(), fileOf('soft-hearts-v2', { ...text('阿澄', { personality: '新性格' }), mood: CALM_MOOD }));
  assert.deepEqual(v2.draft, { ...text('阿澄', { personality: '新性格' }), mood: CALM_MOOD });
  assert.deepEqual(v2.summary.changedFields, ['description', 'personality', 'greeting'], 'a field missing from the file is the file\'s (empty)');
  assert.equal(v2.summary.mood, 'replaced');
  assert.deepEqual(v2.summary.slowWarmUp, { before: true, after: false, part: 'replaced' });
  assert.equal(v2.summary.response, 'kept', 'a v2 file has no reactions: hers stay');
  assert.equal(v2.response, null);
  assert.equal(v2.summary.name.changed, false);
  // A file without a mood template (v1, Tavern) keeps hers, never Gene's default; the switch stays too.
  for (const format of ['soft-hearts-v1', 'tavern-v2', 'tavern'] as const) {
    const plan = planCharacterCardUpdate(current, reactions(), fileOf(format, text('阿澄', { personality: '新性格' })));
    assert.deepEqual(plan.draft.mood, PLAYFUL_MOOD, format);
    assert.notDeepEqual(plan.draft.mood, defaultCharacterMoodTemplate(), format);
    assert.equal(plan.draft.slowWarmUp, true, format);
    assert.equal(plan.summary.mood, 'kept', format); assert.equal(plan.summary.slowWarmUp.part, 'kept', format);
  }
  // Version 3 replaces her reactions too.
  const v3 = planCharacterCardUpdate(current, reactions(), fileOf('soft-hearts-v3', { ...text('阿澄'), mood: PLAYFUL_MOOD, slowWarmUp: true }, reactions(0.6)));
  assert.equal(v3.summary.response, 'replaced'); assert.deepEqual(v3.response, reactions(0.6));
  assert.equal(v3.summary.mood, 'same'); assert.equal(v3.summary.slowWarmUp.part, 'same');
  // No reactions of her own and none in the file: nothing to mention.
  assert.equal(planCharacterCardUpdate(current, defaultCharacterResponseProfile(), fileOf('tavern', text('阿澄'))).summary.response, 'same');
  // The very same card: nothing to do.
  const same = planCharacterCardUpdate(current, reactions(), fileOf('soft-hearts-v2', { ...current }));
  assert.equal(same.summary.unchanged, true);
  // A different name is reported (the confirmation flags it).
  const renamed = planCharacterCardUpdate(current, reactions(), fileOf('soft-hearts-v2', { ...current, name: '菲菲' }));
  assert.deepEqual(renamed.summary.name, { before: '阿澄', after: '菲菲', changed: true });
  assert.deepEqual(renamed.summary.changedFields, ['name']);
  // Persona limits still hold.
  assert.throws(() => planCharacterCardUpdate(current, reactions(), fileOf('tavern', text('x', { description: 'x'.repeat(4000), personality: 'x'.repeat(4000), examples: 'x'.repeat(5000) }))), /超过/);
});

test('the confirmation: a different name comes first and is flagged; it says what changes and that her memories stay; English has no Chinese', () => {
  const current: CharacterDraft = { ...text('阿澄', { personality: '旧' }), mood: PLAYFUL_MOOD };
  const plan = planCharacterCardUpdate(current, reactions(), fileOf('soft-hearts-v2', { ...text('菲菲', { personality: '新', scenario: '新情境' }), mood: CALM_MOOD }), { presetGene: true });
  const lines = cardUpdateSummaryLines(plan.summary);
  assert.equal(lines[0].warning, true);
  assert.match(lines[0].text, /文件里叫「菲菲」，现在叫「阿澄」/);
  assert.equal(lines.filter(line => line.warning).length, 1);
  const all = lines.map(line => line.text).join('\n');
  assert.match(all, /会换成文件里的：性格与说话方式、相处情境。/);
  assert.match(all, /心情模板：换成文件里的（当前心情不清零/);
  assert.match(all, /反应细调：文件里没有，保留她现在的。/);
  assert.match(all, /预装的 Gene 卡：更新后她仍然用预装 Gene 模型/);
  assert.match(all, /她的聊天、日记、画像、熟悉度和昵称都会保留/);
  assert.doesNotMatch(all, /旧|新情境/, 'the persona text itself is not shown, only which parts change');
  setUiLanguage('en');
  try {
    const english = cardUpdateSummaryLines(plan.summary, (source, ...values) => t(source, Object.fromEntries(values.map((value, index) => [String(index), String(value)]))));
    const fixed = english.map(line => line.text.replace(/“[^”]*”/g, '')).join('\n');
    assert.doesNotMatch(fixed, /[\u3400-\u9fff]/u, fixed);
    assert.match(english[0].text, /Different name: the file says “菲菲”, she is “阿澄” now/);
  } finally { setUiLanguage('zh-CN'); }
});

// ---- the key proof: same id, everything of hers still hers ----

const game = (at: number): RpsGameRecord => ({ at, origin: 'user', result: 'her', rounds: [{ her: 'paper', user: 'rock', outcome: 'her' }] });
function receipt(body: string, id: string) { return { requestId: id, messageId: 'message-' + id, source: 'text' as const, text: body, acceptedAt: Date.now() }; }

test('in place: same id, and her chats, diary, 梗, profile, familiarity and nickname, her own life, little needs, match counts, mood state and picture stay hers byte for byte (real stores, read back)', async () => withDirectory(async directory => {
  // A character with a model and a picture.
  const cards = new CharacterCardStore(directory, 'legacy persona');
  await cards.load({ preinstalledGene: true, freshProfile: true });
  await cards.save({ ...text('阿澄', { description: '在海边长大', personality: '安静，爱笑', greeting: '你来啦' }), mood: PLAYFUL_MOOD });
  const id = cards.publicState().cards.find(card => card.name === '阿澄')!.id;
  const model = path.join(directory, 'models', '阿澄', 'acheng.pmx');
  await cards.bindModel(id, model, 'acheng.pmx');
  await cards.activate(id);
  const responses = new CharacterResponseStore(directory, () => cards.publicState().cards.map(card => card.id));
  await responses.load();
  await responses.save(id, reactions());
  const avatars = new CharacterAvatarStore(directory);
  const picture = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  await avatars.save(id, picture);

  // Her memories, all kept by her id.
  const persona = compileCharacterPersona(cards.getActive());
  const companion = new CompanionService(directory, () => {});
  await companion.load();
  await companion.context(id, provider, persona, effectiveCharacterMood(cards.getActive()));
  const turn = await companion.begin('chat-1', '我最喜欢下雨天去书店', persona, () => {}, {});
  turn.push('delta', '那我们下次下雨一起去。'); await turn.finish('complete');
  const today = localDateKey(Date.now());
  await companion.relationship.seed(id, { version: 1, metDate: localDateKey(Date.now() - 20 * 86_400_000), days: [localDateKey(Date.now() - 20 * 86_400_000), localDateKey(Date.now() - 86_400_000)],
    qualityDays: [], today: { date: today, rounds: 2, touched: false }, backfilled: [], nickname: null, herNickname: null, nicknameAsked: false, milestones: [] });
  await companion.relationship.setNickname(id, '小雨');
  const knownBefore = await companion.relationship.knownDay(id);
  companion.mood.lift({ id: 'c3-test', delta: { D: 20, O: -12 }, reason: 'test' }, id);
  const moodBefore = companion.mood.get().snapshot.values;
  assert.equal(companion.herLife.startNow(id, 'daydream', { parameters: DEFAULT_MOOD_PARAMETERS, mood: 'calm', localMinute: 600 }), 'daydream');
  const lifeBefore = companion.herLife.view(id)!;
  for (let i = 0; i < 3; i++) companion.herNeeds.interact(id, 'food', 1);
  const profiles = new UserProfileStore(path.join(directory, 'user-profiles'));
  const scope: UserProfileScope = { characterId: id, providerScope };
  await profiles.activate(scope); profiles.setEnabled(true);
  const body = '我在学钢琴。';
  const ticket = profiles.beginObservation(profiles.acceptUserMessage(receipt(body, 'fact-1')));
  assert.equal((await profiles.completeObservation(ticket!, 'fact-1', [{ kind: 'fact', quoteStart: 0, quoteEnd: body.length }])).added, 1);
  const yesterday = localDateKey(Date.now() - 86_400_000);
  assert.equal(await profiles.saveDiary(profiles.diaryTicket()!, yesterday, '今天他说起下雨天的书店。', '下雨天一起去书店'), true);
  const rps = new RpsStore({ file: () => path.join(directory, 'rps.json') });
  await rps.load(); rps.finish(id, game(Date.now() - 1000), true);
  await Promise.all([companion.flush(), companion.relationship.flush(), companion.herLife.flush(), companion.herNeeds.flush(), rps.flush()]);
  const before = await snapshot(directory);
  for (const file of ['memories.jsonl', 'mood-state.json', `relationship/${id}.json`, 'her-life.json', 'her-needs.json', 'rps.json', `character-avatars/${id}.png`])
    assert.ok(before.has(file), `fixture wrote ${file}`);
  assert.ok([...before.keys()].some(file => file.startsWith('user-profiles/')), 'fixture wrote the diary and profile');

  // The update: a newer version of her card (persona and mood template), from the 角色页's two steps.
  const updater = new CharacterCardUpdater({ cards, responses, directory });
  const newer = v2File({ ...text('阿澄', { description: '在海边长大，后来搬进城里', personality: '安静，爱笑，也会撒娇', greeting: '你来啦' }), mood: CALM_MOOD });
  const preview = await updater.preview(id, newer);
  assert.equal(preview.id, id);
  assert.deepEqual(preview.summary.changedFields, ['description', 'personality']);
  assert.equal((await snapshot(directory)).size, before.size, 'a preview writes nothing');
  const result = await updater.confirm(preview.token);
  assert.equal(result.changed, true);

  // Same id, same model and picture; only her persona and mood template are new.
  const after = await snapshot(directory);
  const updated = cards.publicState().cards.find(card => card.id === id)!;
  assert.equal(cards.publicState().cards.filter(card => card.name === '阿澄').length, 1, 'no second card');
  assert.equal(cards.publicState().cards.length, 2, 'Gene and her, nothing added');
  assert.equal(updated.personality, '安静，爱笑，也会撒娇');
  assert.deepEqual(updated.mood, CALM_MOOD);
  assert.equal(updated.modelName, 'acheng.pmx');
  assert.equal(cards.rosterCards().find(card => card.id === id)!.modelPath, model);
  assert.equal(cards.publicState().activeId, id);
  // Byte for byte: every file of hers is untouched; characters.json changed and its old bytes were copied aside first.
  const backups = [...after.keys()].filter(file => /^characters\.before-update-.*\.json$/.test(file));
  assert.equal(backups.length, 1);
  assert.deepEqual(after.get(backups[0]), before.get('characters.json'), 'the backup is the card file as it was');
  assert.notDeepEqual(after.get('characters.json'), before.get('characters.json'));
  for (const [file, bytes] of before) if (file !== 'characters.json') assert.deepEqual(after.get(file), bytes, `${file} is byte for byte the same`);
  assert.deepEqual([...after.keys()].filter(file => !before.has(file)), backups, 'nothing else was written');

  // The host's next step after any card change (syncCharacter): the same id with the new persona and mood template.
  // Her current mood is not reset; it carries on with the new parameters.
  await companion.context(id, provider, compileCharacterPersona(updated), effectiveCharacterMood(updated));
  const moodNow = companion.mood.get();
  assert.deepEqual(moodNow.parameters, CALM_MOOD.parameters);
  for (const channel of Object.keys(moodBefore) as (keyof typeof moodBefore)[])
    assert.ok(Math.abs(moodNow.snapshot.values[channel] - moodBefore[channel]) < 1, `mood ${channel} kept (${moodBefore[channel]} → ${moodNow.snapshot.values[channel]})`);
  assert.equal(companion.memory.list({ characterId: id, providerScope }).records.length, 1);
  await companion.flush();

  // Read back with fresh store instances, as after a restart.
  const reloadedCards = new CharacterCardStore(directory, 'legacy persona');
  await reloadedCards.load({ preinstalledGene: true });
  const reloaded = reloadedCards.publicState().cards.find(card => card.id === id)!;
  assert.equal(reloaded.personality, '安静，爱笑，也会撒娇');
  assert.equal(reloadedCards.rosterCards().find(card => card.id === id)!.modelPath, model);
  const restarted = new CompanionService(directory, () => {});
  try {
    await restarted.load();
    await restarted.context(id, provider, compileCharacterPersona(reloaded), effectiveCharacterMood(reloaded));
    const records = restarted.memory.list({ characterId: id, providerScope }).records;
    assert.equal(records.length, 1, 'her chat is still hers');
    assert.match(JSON.stringify(restarted.memory.read({ characterId: id, providerScope }, records[0].id)), /下雨天去书店/);
    assert.equal(restarted.memory.retrieve({ characterId: id, providerScope }, `还记得${records[0].title}吗`)[0]?.id, records[0].id, 'and she still recalls it');
    await restarted.relationship.ensure(id);
    assert.equal(restarted.relationship.nickname(id), '小雨');
    assert.equal(await restarted.relationship.knownDay(id), knownBefore);
    assert.ok((knownBefore ?? 0) >= 20);
    assert.equal(restarted.herLife.view(id)?.activity, lifeBefore.activity);
    assert.equal(restarted.herLife.view(id)?.since, lifeBefore.since);
    const needs = readHerNeedSaved(JSON.parse(after.get('her-needs.json')!.toString('utf8')).characters[id]);
    assert.ok(needs && needs.interactions >= 3, 'her little needs\' counts are still under her id');
    const moodReloaded = restarted.mood.get();
    assert.deepEqual(moodReloaded.parameters, CALM_MOOD.parameters);
    assert.ok(Math.abs(moodReloaded.snapshot.values.D - moodBefore.D) < 1, 'her mood state is still hers after a restart');
  } finally { await restarted.flush().catch(() => {}); }
  const reopened = new UserProfileStore(path.join(directory, 'user-profiles'));
  try {
    const view = (await reopened.activate(scope))!;
    assert.equal(view.entries.length, 1); assert.equal(view.entries[0].text, body);
    assert.equal(view.diary[0]?.text, '今天他说起下雨天的书店。');
    assert.equal(view.diary[0]?.meme, '下雨天一起去书店', 'the 梗 lives in that day\'s diary');
  } finally { reopened.dispose(); }
  const rpsAgain = new RpsStore({ file: () => path.join(directory, 'rps.json') });
  await rpsAgain.load();
  assert.equal(rpsAgain.games(id).length, 1);
  assert.equal(await avatars.read(id), `data:image/png;base64,${Buffer.from(picture).toString('base64')}`);
  const responsesAgain = new CharacterResponseStore(directory, () => reloadedCards.publicState().cards.map(card => card.id));
  await responsesAgain.load();
  assert.deepEqual(responsesAgain.get(id).profile, reactions(), 'a v2 file leaves her reactions as they were');
  profiles.dispose();
}));

// ---- the rest on real stores ----

async function storeFixture(directory: string, options: { gene?: boolean } = {}) {
  const cards = new CharacterCardStore(directory, 'legacy persona');
  await cards.load(options.gene ? { preinstalledGene: true, freshProfile: true } : {});
  await cards.save({ ...text('阿澄', { personality: '安静' }), mood: PLAYFUL_MOOD, slowWarmUp: true });
  const id = cards.publicState().cards.find(card => card.name === '阿澄')!.id;
  const responses = new CharacterResponseStore(directory, () => cards.publicState().cards.map(card => card.id));
  await responses.load();
  return { cards, responses, id, service: new CharacterResponseService(cards, responses) };
}

test('a file without a mood template keeps hers; a version 3 file also brings its reactions (backed up first); others keep them', async () => withDirectory(async directory => {
  const { cards, responses, id } = await storeFixture(directory);
  await responses.save(id, reactions());
  const updater = new CharacterCardUpdater({ cards, responses, directory });
  const card = () => cards.publicState().cards.find(value => value.id === id)!;
  // Tavern: persona only.
  const tavern = tavernV2File({ name: '阿澄', personality: '安静，爱看书', first_mes: '嗨' });
  await updater.update(id, tavern, cards.cardFingerprint(id));
  assert.equal(card().personality, '安静，爱看书');
  assert.deepEqual(card().mood, PLAYFUL_MOOD, 'not Gene\'s default');
  assert.equal(card().slowWarmUp, true);
  assert.deepEqual(responses.get(id).profile, reactions());
  // Version 3: her reactions are replaced, and the reactions file is copied aside too.
  const sidecar = await readFile(path.join(directory, 'character-response-settings.json'));
  const result = await updater.update(id, v3File({ ...text('阿澄', { personality: '安静，爱看书' }), mood: CALM_MOOD, responseProfile: reactions(0.5) }), cards.cardFingerprint(id));
  assert.deepEqual(responses.get(id).profile, reactions(0.5));
  assert.ok(result.response);
  assert.deepEqual(card().mood, CALM_MOOD);
  assert.equal(card().slowWarmUp, undefined, 'a v3 file without the switch turns it off');
  const files = await readdir(directory);
  const sidecarBackup = files.find(file => file.startsWith('character-response-settings.before-update-'))!;
  assert.ok(sidecarBackup);
  assert.deepEqual(await readFile(path.join(directory, sidecarBackup)), sidecar);
  assert.equal(files.filter(file => file.startsWith('characters.before-update-')).length, 2, 'one card backup per update, none overwritten');
}));

test('a bad file changes nothing; a failed backup writes nothing; a backup never overwrites an older one', async () => withDirectory(async directory => {
  const { cards, responses, id } = await storeFixture(directory);
  const original = await readFile(path.join(directory, 'characters.json'));
  const updater = new CharacterCardUpdater({ cards, responses, directory });
  for (const bad of ['{', v2File(text('阿澄')), v1File({ ...text('阿澄'), modelPath: 'C:\\x.pmx' }), JSON.stringify({ name: '' })])
    await assert.rejects(updater.preview(id, bad));
  await assert.rejects(updater.update(id, '{"name":', cards.cardFingerprint(id)));
  assert.deepEqual(await readFile(path.join(directory, 'characters.json')), original);
  // The copy fails (full disk, locked folder): the card stays as it was, in memory and on disk.
  const failing = new CharacterCardUpdater({ cards, responses, directory, backup: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  await assert.rejects(failing.update(id, v2File({ ...text('阿澄', { personality: '新' }), mood: PLAYFUL_MOOD }), cards.cardFingerprint(id)), /disk full/);
  assert.deepEqual(await readFile(path.join(directory, 'characters.json')), original);
  assert.equal(cards.publicState().cards.find(card => card.id === id)!.personality, '安静');
  assert.deepEqual((await readdir(directory)).filter(file => file.includes('before-update')), []);
  // Same second twice: numbered, the first one is kept.
  const at = new Date('2026-11-03T06:25:30.123Z');
  assert.equal(updateBackupName('characters.json', at, 1), 'characters.before-update-2026-11-03T06-25-30Z.json');
  const first = await backupBeforeUpdate(directory, 'characters.json', at);
  const second = await backupBeforeUpdate(directory, 'characters.json', at);
  assert.equal(path.basename(first!), 'characters.before-update-2026-11-03T06-25-30Z.json');
  assert.equal(path.basename(second!), 'characters.before-update-2026-11-03T06-25-30Z-2.json');
  assert.equal(await backupBeforeUpdate(directory, 'missing.json', at), null);
  // An unknown card is refused before anything else.
  await assert.rejects(updater.preview('0f8fad5b-d9cb-469f-a165-70867728950e', v1File(text('x'))), /角色卡不存在/);
}));

test('only what was shown is applied: a card edited after the preview is refused; a token works once, and only the latest', async () => withDirectory(async directory => {
  const { cards, responses, id } = await storeFixture(directory);
  let now = 1_000_000;
  const updater = new CharacterCardUpdater({ cards, responses, directory, now: () => now });
  const file = v2File({ ...text('阿澄', { personality: '新' }), mood: PLAYFUL_MOOD });
  const preview = await updater.preview(id, file);
  await cards.save({ ...text('阿澄', { personality: '用户刚改的' }), mood: PLAYFUL_MOOD }, id);
  await assert.rejects(updater.confirm(preview.token), /确认之后又改过了/);
  assert.equal(cards.publicState().cards.find(card => card.id === id)!.personality, '用户刚改的');
  await assert.rejects(updater.confirm(preview.token), /过期/, 'a token is used once');
  const older = await updater.preview(id, file), latest = await updater.preview(id, file);
  await assert.rejects(updater.confirm(older.token), /过期/, 'a newer preview replaces an older one');
  now += 11 * 60_000;
  await assert.rejects(updater.confirm(latest.token), /过期/);
  const fresh = await updater.preview(id, file);
  updater.discard(fresh.token);
  await assert.rejects(updater.confirm(fresh.token), /过期/);
  const ok = await updater.preview(id, file);
  assert.equal((await updater.confirm(ok.token)).changed, true);
  // The same file again: nothing to do, nothing written, no backup.
  const backups = (await readdir(directory)).filter(file => file.includes('before-update')).length;
  const again = await updater.preview(id, file);
  assert.equal(again.summary.unchanged, true);
  assert.equal((await updater.confirm(again.token)).changed, false);
  assert.equal((await readdir(directory)).filter(file => file.includes('before-update')).length, backups);
}));

test('the preinstalled Gene card: its persona can be updated in place, and it still goes with the preinstalled Gene model', async () => withDirectory(async directory => {
  const { cards, responses } = await storeFixture(directory, { gene: true });
  const geneId = (await cards.presetGeneId())!;
  assert.ok(geneId);
  const updater = new CharacterCardUpdater({ cards, responses, directory });
  const gene = cards.publicState().cards.find(card => card.id === geneId)!;
  const plan = await updater.plan(geneId, v2File({ ...text(gene.name, { description: gene.description, personality: `${gene.personality}\n更爱笑一点。`,
    scenario: gene.scenario, greeting: gene.greeting, examples: gene.examples, systemPrompt: gene.systemPrompt }), mood: gene.mood }));
  assert.equal(plan.summary.presetGene, true);
  assert.deepEqual(plan.summary.changedFields, ['personality']);
  const result = await updater.update(geneId, v2File({ ...text(gene.name, { description: gene.description, personality: `${gene.personality}\n更爱笑一点。`,
    scenario: gene.scenario, greeting: gene.greeting, examples: gene.examples, systemPrompt: gene.systemPrompt }), mood: gene.mood }), plan.expected);
  assert.equal(result.changed, true);
  assert.equal(await cards.presetGeneId(), geneId, 'still the preinstalled Gene card');
  assert.equal(cards.rosterCards().find(card => card.id === geneId)!.modelPath, BUNDLED_CHARACTER_MODEL);
  assert.match(cards.publicState().cards.find(card => card.id === geneId)!.personality, /更爱笑一点/);
  // C1 still holds: it never goes with another model.
  await assert.rejects(cards.bindModel(geneId, path.join(directory, 'other.pmx'), 'other.pmx'), /预装的 Gene 卡只跟预装 Gene 模型走/);
}));

test('after an update the export carries no id, model path, picture or private data; a card with "关系慢慢升温" on exports again', async () => withDirectory(async directory => {
  const { cards, responses, id, service } = await storeFixture(directory);
  await cards.bindModel(id, path.join(directory, 'models', 'acheng.pmx'), 'acheng.pmx');
  await new CharacterAvatarStore(directory).save(id, Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')));
  await responses.save(id, reactions());
  const updater = new CharacterCardUpdater({ cards, responses, directory });
  await updater.update(id, v2File({ ...text('阿澄', { personality: '更新后的性格' }), mood: CALM_MOOD, slowWarmUp: true }), cards.cardFingerprint(id));
  // Before C3 this export threw: the v3 wrapper did not know "关系慢慢升温" (shared/character-response-portable.ts).
  const exported = service.export(id);
  const parsed = JSON.parse(exported);
  assert.equal(parsed.version, 3);
  assert.equal(parsed.card.slowWarmUp, true);
  assert.equal(parsed.card.personality, '更新后的性格');
  assert.doesNotMatch(exported, new RegExp(id));
  assert.doesNotMatch(exported, /modelPath|modelName|acheng\.pmx|avatar|data:image|before-update/);
  assert.doesNotMatch(exported, new RegExp(path.basename(directory)));
  // And the exported file updates (or imports) cleanly: exporting, then updating from it, changes nothing.
  assert.equal((await updater.plan(id, exported)).summary.unchanged, true);
  const imported = await service.import(exported);
  assert.equal(imported.state.cards.find(card => card.id === imported.characterId)!.slowWarmUp, true);
}));
