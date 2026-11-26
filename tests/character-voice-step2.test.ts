// I-162 step 2 (docs/claude/2026-11-20-character-voice-step2.md): what 「她的声音」 shows and saves, saving through the card store the resolver reads,
// the card update's option for the file's voice, and the notice's English line and click destination. Real card store in a temporary folder;
// no paid call, no real profile, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../electron/cards/character-cards';
import { CharacterCardUpdater } from '../electron/cards/character-card-update';
import { CharacterResponseStore } from '../electron/cards/character-response';
import { saveCharacterVoice } from '../electron/cards/character-voice-save';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/voice/tts';
import { characterTtsConfig, type VoiceSettings } from '../shared/voice/character-voice-resolver';
import { followedVoice } from '../shared/voice/character-voice-settle';
import {
  GENDER_MARK, VOICE_PROVIDER_FORM, bailianVoiceChoices, providerNote, systemVoiceChoices, voiceFormOf, voiceFormUnchanged, voiceFromForm, voiceLabel,
} from '../shared/voice/character-voice-form';
import { planCharacterCardUpdate, cardUpdateSummaryLines } from '../shared/cards/character-card-update';
import { defaultCharacterMoodTemplate, validateCharacterDraft } from '../shared/cards/character-cards';
import { readCharacterCardFile } from '../electron/cards/character-card-update';
import { takeMeThereLeaf } from '../src/initiative';

const READY = { fishApiKey: 'placeholder-not-a-key', apiKey: 'placeholder-not-a-key', apiHost: 'https://example.invalid', region: 'x' };
const tts = (patch: Partial<TtsConfig> = {}): TtsConfig => ({ ...structuredClone(DEFAULT_TTS_CONFIG) as TtsConfig, ...patch });
const TEXT = { description: '她是一个安静的女孩。', personality: '温柔', scenario: '', greeting: '', examples: '', systemPrompt: '' };

async function withStore(run: (store: CharacterCardStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-voice2-'));
  try { const store = new CharacterCardStore(directory, 'legacy persona'); await store.load(); await run(store, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const idOf = (store: CharacterCardStore, name: string) => store.publicState().cards.find(card => card.name === name)!.id;

// --- the form --------------------------------------------------------------------------------------------------------

test('the form shows her card voice, else the default for new characters; saving keeps only what the provider can change', () => {
  const hers = { provider: 'bailian' as const, voiceId: 'longanhuan_v3.1', rate: 0.9, description: '活泼的女生' };
  assert.deepEqual(voiceFormOf(hers, { provider: 'system', voiceId: 'x' }), { provider: 'bailian', voiceId: 'longanhuan_v3.1', rate: 0.9, pitch: 1, description: '活泼的女生' });
  assert.equal(voiceFormOf(undefined, { provider: 'fish', voiceId: 'g6two' }).provider, 'fish', 'a card without a voice shows the default for new characters');
  assert.equal(voiceFormOf(undefined, undefined).provider, 'system');
  // A pitch means nothing to a cloud voice; it is dropped on save, kept for the system voice.
  assert.equal('pitch' in voiceFromForm({ provider: 'bailian', voiceId: '', rate: 1, pitch: 1.5, description: '' }), false);
  assert.equal(voiceFromForm({ provider: 'system', voiceId: '', rate: 1, pitch: 1.5, description: '' }).pitch, 1.5);
  assert.deepEqual(Object.keys(VOICE_PROVIDER_FORM).map(key => [key, VOICE_PROVIDER_FORM[key as 'system'].pitch]), [['system', true], ['bailian', false], ['fish', false]]);
  // Odd input is made safe, never thrown on: a path is not a voice id, a pace is clamped, brackets leave the description.
  const odd = voiceFromForm({ provider: 'fish', voiceId: 'C:\\voices\\her.wav', rate: 9, pitch: 1, description: '轻轻的 [笑] <b>' });
  assert.deepEqual(odd, { provider: 'fish', voiceId: '', rate: 2, description: '轻轻的 笑 b' });
  assert.equal(voiceFormUnchanged(hers, voiceFormOf(hers, undefined)), true);
  assert.equal(voiceFormUnchanged(hers, { ...voiceFormOf(hers, undefined), rate: 1 }), false);
});

test('the form has no way to hold a key: its fields and what it saves are only provider, voice id, pace, pitch and description', () => {
  const form = voiceFormOf({ provider: 'fish', voiceId: 'g6two' }, undefined);
  assert.deepEqual(Object.keys(form).sort(), ['description', 'pitch', 'provider', 'rate', 'voiceId']);
  // Even a key pasted into the description or the id never becomes a stored key field: the saved voice's keys are the closed set.
  const saved = voiceFromForm({ ...form, description: 'sk-abcdefghijklmnopqrstuvwxyz123456 她的声音' }) as unknown as Record<string, unknown>;
  assert.ok(Object.keys(saved).every(key => ['provider', 'voiceId', 'rate', 'pitch', 'description'].includes(key)));
});

test('the voice lists mark the gender where it is known; an unknown one is listed without a mark and a paid provider is flagged', () => {
  const bailian = bailianVoiceChoices(), mark = (id: string) => bailian.find(choice => choice.id === id)?.gender ?? null;
  assert.equal(mark('longanhuan_v3.1'), 'female');
  assert.equal(mark('xunanchuan_v3.1'), 'male');
  assert.equal(mark('longanfengyue_v3.1'), null, 'not listened to: no mark');
  assert.ok(bailian.some(choice => choice.id === 'longanfengyue_v3.1'));
  const system = systemVoiceChoices([{ voiceURI: 'a', name: 'Microsoft Huihui', lang: 'zh-CN' }, { voiceURI: 'b', name: 'Microsoft Kangkang', lang: 'zh-CN' }, { voiceURI: 'c', name: 'Some Voice' }]);
  assert.deepEqual(system.map(choice => choice.gender), ['female', 'male', null]);
  assert.deepEqual([GENDER_MARK.female, GENDER_MARK.male], ['女声', '男声']);
  assert.deepEqual(Object.entries(VOICE_PROVIDER_FORM).filter(([, form]) => form.paid).map(([key]) => key), ['bailian', 'fish']);
  // Choosing a paid provider says it spends nothing by itself.
  for (const provider of ['bailian', 'fish'] as const) assert.match(providerNote(provider), /不会花钱/u);
  assert.equal(voiceLabel({ provider: 'bailian', voiceId: 'longanhuan_v3.1' }), '百炼 · 龙安欢');
  assert.equal(voiceLabel(undefined), '');
});

// --- saving ----------------------------------------------------------------------------------------------------------

test('saving her voice writes her card only; the resolver then speaks with it; a card file export carries no key', async () => withStore(async (store, directory) => {
  await store.save({ name: '艾琳', ...TEXT, mood: defaultCharacterMoodTemplate() });
  const id = idOf(store, '艾琳');
  const before = store.publicState().cards.find(card => card.id === id)!;
  const state = await saveCharacterVoice(store, id, { provider: 'bailian', voiceId: 'longanhuan_v3.1', rate: 0.9, description: '二十出头的女生，声音亮' });
  const card = state.cards.find(value => value.id === id)!;
  assert.deepEqual(card.voice, { provider: 'bailian', voiceId: 'longanhuan_v3.1', rate: 0.9, description: '二十出头的女生，声音亮' });
  assert.deepEqual({ ...card, voice: undefined }, { ...before, voice: undefined }, 'nothing else on the card changed');
  assert.equal(state.cards.length, store.publicState().cards.length);
  // It reached the file the resolver's card comes from, and survives a restart.
  const reloaded = new CharacterCardStore(directory, 'legacy persona'); await reloaded.load();
  const loaded = reloaded.publicState().cards.find(value => value.id === id)!;
  assert.deepEqual(loaded.voice, card.voice);
  const settings: VoiceSettings = { tts: tts({ provider: 'system', ...READY }), model: { path: '' } };
  const config = characterTtsConfig(settings, loaded);
  assert.deepEqual([config.provider, config.voice, config.rate], ['bailian', 'longanhuan_v3.1', 0.9]);
  // Choosing a paid provider changes no setting and holds no key: the card file has none.
  const text = await readFile(path.join(directory, 'characters.json'), 'utf8');
  assert.ok(!/placeholder-not-a-key|apiKey|fishApiKey|"key"/u.test(text));
  assert.ok(!/placeholder-not-a-key|apiKey|fishApiKey|"key"/u.test(store.export(id)));
  // 恢复成新角色的默认声音: the voice goes away and the default speaks again.
  const cleared = await saveCharacterVoice(store, id, null);
  assert.equal(cleared.cards.find(value => value.id === id)!.voice, undefined);
}));

test('a card that does not exist or a voice that is not one is refused and the card keeps what it had', async () => withStore(async store => {
  await store.save({ name: '艾琳', ...TEXT, mood: defaultCharacterMoodTemplate() });
  const id = idOf(store, '艾琳');
  await saveCharacterVoice(store, id, { provider: 'system', voiceId: 'Microsoft Huihui' });
  await assert.rejects(saveCharacterVoice(store, 'no-such-card', { provider: 'system', voiceId: '' }), /不存在/u);
  await assert.rejects(saveCharacterVoice(store, id, { provider: 'evil', voiceId: 'x' }), /不能用/u);
  await assert.rejects(saveCharacterVoice(store, id, 'fish'), /不能用/u);
  assert.deepEqual(store.publicState().cards.find(card => card.id === id)!.voice, { provider: 'system', voiceId: 'Microsoft Huihui' });
  // A path or a link as a voice id is dropped, not stored.
  await saveCharacterVoice(store, id, { provider: 'fish', voiceId: 'https://example.invalid/voice' });
  assert.equal(store.publicState().cards.find(card => card.id === id)!.voice!.voiceId, '');
}));

test('the global default no longer moves any character: only her own binding and the system voice list are hers', () => {
  const base = tts({ provider: 'system', ...READY });
  const previous: VoiceSettings = { tts: base, voice: { voiceURI: 'a' }, model: { path: 'C:/m.pmx' } };
  const akiko = { id: 'akiko', voice: { provider: 'system' as const, voiceId: 'a', description: '困困的女孩' } };
  // Step 2: 新角色的默认声音 moved to Drama 3: nobody's card follows it.
  assert.equal(followedVoice(previous, { ...previous, tts: { ...base, provider: 'fish', fishVoiceId: 'g6two' } }, akiko), null);
  // Her own binding naming Drama 3 (the agent channel's set_voice_style / the old panel) is hers.
  const binding = { characterId: 'akiko', modelPath: 'C:/m.pmx', voice: 'longanlingxin_v3.1', instruction: '', emotion: 'custom' as const, rate: 1, fishVoiceId: 'g6two' };
  const own = { ...previous, tts: { ...base, styleBindings: [{ ...binding, provider: 'fish' as const }] } };
  assert.deepEqual(followedVoice(previous, own, akiko), { provider: 'fish', voiceId: 'g6two', description: '困困的女孩' });
  // The system voice list for her.
  assert.deepEqual(followedVoice(previous, { ...previous, voice: { voiceURI: 'b' } }, akiko), { provider: 'system', voiceId: 'b', description: '困困的女孩' });
});

// --- updating a card from a file -------------------------------------------------------------------------------------

async function cardFileWithVoice(store: CharacterCardStore, name: string, voice: unknown): Promise<string> {
  await store.save({ name, ...TEXT, personality: '新的性格', mood: defaultCharacterMoodTemplate() });
  const id = idOf(store, name);
  await saveCharacterVoice(store, id, voice);
  return store.export(id);
}

test('updating from a file keeps her voice unless the user ticks the file\'s; the tick is the only way it changes', async () => withStore(async (store, directory) => {
  const file = await cardFileWithVoice(store, '来源', { provider: 'bailian', voiceId: 'longanhuan_v3.1', description: '活泼的女生' });
  await store.save({ name: '艾琳', ...TEXT, mood: defaultCharacterMoodTemplate() });
  const id = idOf(store, '艾琳');
  const mine = { provider: 'system' as const, voiceId: 'Microsoft Huihui', description: '困困的' };
  await saveCharacterVoice(store, id, mine);
  const responses = new CharacterResponseStore(directory, () => store.publicState().cards.map(card => card.id)); await responses.load();
  const updater = new CharacterCardUpdater({ cards: store, responses, directory });
  const card = () => store.publicState().cards.find(value => value.id === id)!;
  // The preview offers the file's voice; the default keeps hers.
  const preview = await updater.preview(id, file);
  assert.equal(preview.summary.voice, 'offered');
  assert.deepEqual(preview.summary.fileVoice, { provider: 'bailian', voiceId: 'longanhuan_v3.1', description: '活泼的女生' });
  assert.ok(cardUpdateSummaryLines(preview.summary).some(line => /声音/u.test(line.text)));
  await updater.confirm(preview.token);
  assert.deepEqual(card().voice, mine, 'default: her current voice stays');
  assert.equal(card().personality, '新的性格', 'the persona did update');
  // With the tick, the file's voice comes in (and nothing else about the voice path changed).
  const second = await updater.preview(id, file);
  await updater.confirm(second.token, { useFileVoice: true });
  assert.deepEqual(card().voice, { provider: 'bailian', voiceId: 'longanhuan_v3.1', description: '活泼的女生' });
  // The same voice again: nothing is offered, and the agent channel's path (no option) never takes it.
  const same = await updater.plan(id, file);
  assert.equal(same.summary.voice, undefined);
  assert.equal(same.summary.unchanged, true);
  await saveCharacterVoice(store, id, mine);
  await updater.update(id, file, store.cardFingerprint(id));
  assert.deepEqual(card().voice, mine, 'update() without the option keeps hers');
}));

test('a file without a voice, or a file voice that is hers already, offers nothing; a key-like text in the file never rides along', () => {
  const current = validateCharacterDraft({ name: '她', ...TEXT, mood: defaultCharacterMoodTemplate(), voice: { provider: 'system', voiceId: 'x' } });
  const fromText = (voice: unknown) => readCharacterCardFile(JSON.stringify({ format: 'soft-hearts-character-card', version: 2, card: { name: '她', ...TEXT, mood: defaultCharacterMoodTemplate(), ...(voice ? { voice } : {}) } }));
  const plan = (voice: unknown, options = {}) => planCharacterCardUpdate(current, { rules: [] } as never, fromText(voice), options);
  assert.equal(plan(undefined).summary.voice, undefined);
  assert.equal(plan({ provider: 'system', voiceId: 'x' }).summary.voice, undefined);
  const offered = plan({ provider: 'fish', voiceId: 'g6two', description: 'sk-abcdefghijklmnopqrstuvwxyz123456 C:\\Users\\me\\a.wav 轻轻的' });
  assert.equal(offered.summary.voice, 'offered');
  assert.deepEqual(offered.draft.voice, { provider: 'system', voiceId: 'x' });
  assert.ok(!JSON.stringify(offered.summary).includes('sk-abcdef') && !JSON.stringify(offered.summary).includes('C:\\\\Users'));
  const taken = plan({ provider: 'fish', voiceId: 'g6two' }, { useFileVoice: true });
  assert.equal(taken.summary.voice, 'replaced');
  assert.deepEqual(taken.draft.voice, { provider: 'fish', voiceId: 'g6two' });
});

// --- the notice ------------------------------------------------------------------------------------------------------

test('the notice has an English line, and one click on it goes to her voice settings (a 带我去 place)', () => {
  const settings: VoiceSettings = { tts: tts({ provider: 'system', ...READY }), model: { path: '' } };
  const config = characterTtsConfig(settings, { id: 'akiko', name: '艾琳', description: '她', voice: { provider: 'fish', voiceId: '' } });
  assert.match(config.voicePlan!.notice!, /艾琳/u);
  assert.match(config.voicePlan!.notice!, /她的声音/u);
  assert.match(config.voicePlan!.noticeEn!, /"艾琳"'s Drama 3 voice has no voice id/u);
  assert.ok(!/[\u4e00-\u9fff]/u.test(config.voicePlan!.noticeEn!.replace('艾琳', '')), 'the English line is English');
  const noKey = characterTtsConfig({ tts: tts({ provider: 'system' }), model: { path: '' } }, { id: 'x', voice: { provider: 'bailian', voiceId: '' } });
  assert.match(noKey.voicePlan!.noticeEn!, /Bailian.*key is not filled in/u);
  const leaf = takeMeThereLeaf('character-voice');
  assert.equal(leaf?.page, 'characters');
  assert.equal(leaf?.target, 'character-voice-controls');
});

test('her own pace and pitch reach the window only when the system voice is really hers; a cloud voice\'s pace goes into its config', () => {
  const settings: VoiceSettings = { tts: tts({ provider: 'system', ...READY }), voice: { voiceURI: '' }, model: { path: '' } };
  const hers = characterTtsConfig(settings, { id: 'a', name: 'A', description: '她', voice: { provider: 'system', voiceId: 'huihui', rate: 0.8, pitch: 1.2 } });
  assert.deepEqual([hers.voicePlan!.rate, hers.voicePlan!.pitch], [0.8, 1.2]);
  // Her Drama 3 has no voice id: the system voice reads instead, and her pace for Drama 3 is not put on it.
  const fallback = characterTtsConfig(settings, { id: 'a', name: 'A', description: '她', voice: { provider: 'fish', voiceId: '', rate: 0.8 } });
  assert.equal(fallback.provider, 'system');
  assert.equal(fallback.voicePlan!.rate, undefined);
  // A cloud voice takes her own pace over the panel's.
  const cloud = characterTtsConfig(settings, { id: 'a', name: 'A', description: '她', voice: { provider: 'bailian', voiceId: 'longanhuan_v3.1', rate: 0.8 } });
  assert.deepEqual([cloud.provider, cloud.rate], ['bailian', 0.8]);
});
