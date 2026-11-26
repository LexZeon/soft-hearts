// I-162 step 1: each character's voice on her card. The migration keeps the voice she has now (and the old global setting becomes the
// default for new characters), a voice saved for the active character moves her card along, and an exported card carries provider, voice id
// and description only: never a key, a path or a link. Real card store in a temporary folder; no paid call, no real profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore, parseCharacterCardText } from '../electron/cards/character-cards';
import { inspectGeneProfile } from '../electron/cards/gene-preinstalled-card';
import { atomicWriteFile } from '../electron/foundation/atomic-file';
import { DEFAULT_TTS_CONFIG, effectiveTtsConfig, type TtsConfig } from '../shared/voice/tts';
import { characterTtsConfig, type VoiceSettings } from '../shared/voice/character-voice-resolver';
import { followedVoice, voicesToSettle } from '../shared/voice/character-voice-settle';
import { normalizeCharacterVoice, portableCharacterVoice } from '../shared/foundation/character-voice';
import { validateCharacterDraft } from '../shared/cards/character-cards';

const GENE = 'bundled:gene', MUMI_MODEL = 'C:/models/mumi.pmx';
function tts(patch: Partial<TtsConfig> = {}): TtsConfig { return { ...structuredClone(DEFAULT_TTS_CONFIG) as TtsConfig, ...patch }; }
const READY = { fishApiKey: 'placeholder-not-a-key', apiKey: 'placeholder-not-a-key', apiHost: 'https://example.invalid', region: 'x' };

async function withStore(run: (store: CharacterCardStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-card-voice-'));
  try {
    const store = new CharacterCardStore(directory, 'legacy persona');
    await store.load();
    await run(store, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('migration keeps everyone\'s current voice: Mumi her Drama 3 voice, Akiko the global one, a system-voice card its voiceURI', () => {
  // Global: Drama 3 without a voice id (Akiko follows it); Mumi has her own Drama 3 id and acting style on her own model.
  const config = tts({ provider: 'fish', fishVoiceId: '', ...READY, styleBindings: [
    { characterId: 'mumi', modelPath: MUMI_MODEL, voice: 'longanlingxin_v3.1', instruction: '', emotion: 'custom', rate: 0.9, fishVoiceId: 'mumivoice', fishActingStyle: 'cute' },
    { characterId: 'gene', modelPath: GENE, voice: 'longanlingxin_v3.1', instruction: '', emotion: 'custom', rate: 1, provider: 'system' },
  ] });
  const settings: VoiceSettings = { tts: config, voice: { voiceURI: 'Microsoft Huihui' }, model: { path: MUMI_MODEL } };
  const cards = [{ id: 'mumi', modelPath: MUMI_MODEL }, { id: 'akiko', modelPath: 'C:/models/akiko.pmx' }, { id: 'gene', modelPath: GENE },
    { id: 'kept', voice: { provider: 'bailian' as const, voiceId: 'longanhuan_v3.1' } }];
  const settled = voicesToSettle(settings, cards, { id: 'mumi', modelPath: MUMI_MODEL });
  assert.deepEqual(settled.get('mumi'), { provider: 'fish', voiceId: 'mumivoice', rate: 0.9 });
  assert.deepEqual(settled.get('akiko'), { provider: 'fish', voiceId: '' });
  assert.deepEqual(settled.get('gene'), { provider: 'system', voiceId: 'Microsoft Huihui' });
  assert.equal(settled.has('kept'), false, 'a card with a voice of her own is never touched');
  // Nothing changes for Mumi: the same provider, voice id and acting style as before the migration.
  const mumi = { id: 'mumi', name: 'Mumi', description: '她', voice: settled.get('mumi') };
  const before = effectiveTtsConfig(config, 'mumi', MUMI_MODEL), after = characterTtsConfig(settings, mumi);
  assert.deepEqual([after.provider, after.fishVoiceId, after.fishActingStyle, after.rate], [before.provider, before.fishVoiceId, before.fishActingStyle, before.rate]);
  // Gene (system) keeps her voiceURI; the only change for Akiko is no Drama 3 built-in voice (resolver test).
  assert.equal(characterTtsConfig(settings, { id: 'gene', voice: settled.get('gene') }, GENE).voicePlan?.systemVoiceURI, 'Microsoft Huihui');
  // The global becomes the default for new characters: changing it later does not move Mumi.
  const later: VoiceSettings = { ...settings, tts: { ...config, provider: 'bailian' } };
  assert.equal(characterTtsConfig(later, mumi).provider, 'fish');
});

test('a voice saved for the active character moves her card; the others keep theirs; a model change is not a voice choice', () => {
  const base = tts({ provider: 'system', ...READY });
  const previous: VoiceSettings = { tts: base, voice: { voiceURI: 'a' }, model: { path: MUMI_MODEL } };
  const akiko = { id: 'akiko', voice: { provider: 'system' as const, voiceId: 'a', description: '困困的女孩' } };
  // Step 2: the panel's choice is now 「新角色的默认声音」: moving it to Drama 3 moves nobody's card (tests/character-voice-step2.test.ts). Her own
  // binding naming Drama 3 (the agent channel's set_voice_style) is hers: her card follows (description kept).
  const toFish: VoiceSettings = { ...previous, tts: { ...base, provider: 'fish', fishVoiceId: 'g6two',
    styleBindings: [{ characterId: 'akiko', modelPath: MUMI_MODEL, voice: 'longanlingxin_v3.1', instruction: '', emotion: 'custom', rate: 1, fishVoiceId: 'g6two', provider: 'fish' }] } };
  assert.deepEqual(followedVoice(previous, toFish, akiko), { provider: 'fish', voiceId: 'g6two', description: '困困的女孩' });
  assert.equal(followedVoice(previous, { ...previous, tts: { ...base, provider: 'fish', fishVoiceId: 'g6two' } }, akiko), null, 'the default alone moves nobody');
  // The system voice list picks another voice for her.
  assert.deepEqual(followedVoice(previous, { ...previous, voice: { voiceURI: 'b' } }, akiko), { provider: 'system', voiceId: 'b', description: '困困的女孩' });
  // Nothing about her voice changed: nothing to write.
  assert.equal(followedVoice(previous, { ...previous, tts: { ...base, fishMonthlyCapUsd: 3 } }, akiko), null);
  // The same save with another model: not a voice choice.
  assert.equal(followedVoice(previous, { ...toFish, model: { path: 'C:/other.pmx' } }, akiko), null);
});

test('the card store keeps her voice through save, export and import, and exports no key, path or link', async () => withStore(async (store, directory) => {
  const id = store.publicState().activeId;
  const secretish = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  await store.setVoices(new Map([[id, { provider: 'fish', voiceId: 'g6two', rate: 0.9,
    description: `二十出头的女生，声音轻 ${secretish} C:\\Users\\me\\voices\\her.wav https://example.invalid/x 偏甜`,
    apiKey: 'should-never-be-kept', path: 'C:/secret' } as never]]));
  const stored = JSON.parse(await readFile(path.join(directory, 'characters.json'), 'utf8'));
  const own = stored.cards.find((card: { id: string }) => card.id === id).voice;
  assert.deepEqual(Object.keys(own).sort(), ['description', 'provider', 'rate', 'voiceId'], 'only the known fields are stored');
  // An editor save without a voice keeps hers.
  const card = store.getActive();
  await store.save({ name: card.name, description: card.description, personality: card.personality, scenario: card.scenario, greeting: card.greeting, examples: card.examples, systemPrompt: card.systemPrompt }, id);
  assert.equal(store.getActive().voice?.voiceId, 'g6two');
  const text = store.export(id);
  const exported = JSON.parse(text).card.voice;
  assert.deepEqual(Object.keys(exported).sort(), ['description', 'provider', 'rate', 'voiceId']);
  assert.equal(exported.provider, 'fish');
  assert.equal(exported.voiceId, 'g6two');
  assert.match(exported.description, /二十出头的女生，声音轻/u);
  for (const leak of [secretish, 'Users', '.wav', 'https://', 'example.invalid', 'should-never-be-kept', 'C:/secret']) assert.ok(!text.includes(leak), `export has no ${leak}`);
  assert.ok(!/api[_-]?key|fishApiKey|apiHost|token|secret/i.test(text), 'no key word in the export');
  // The importer takes the voice back (a new card with the same voice).
  const imported = parseCharacterCardText(text).draft.voice;
  assert.deepEqual(imported, exported);
}));

test('a voice on the preinstalled Gene does not make her a "changed" preset (her first model setup still resumes)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-card-voice-gene-'));
  try {
    const open = async () => {
      const profile = await inspectGeneProfile(directory);
      const cards = new CharacterCardStore(directory, profile.legacySystemPrompt ?? 'legacy', atomicWriteFile);
      await cards.load({ preinstalledGene: true, freshProfile: profile.fresh });
      return cards;
    };
    const first = await open(), geneId = first.publicState().activeId;
    // I-172: a fresh Gene now carries the Drama 3 voice the user picked (the migration has nothing to settle for her).
    assert.deepEqual(first.getActive().voice, { provider: 'fish', voiceId: '395e6370541e49948220a7af1a60bfae' });
    await first.setVoices(voicesToSettle({}, first.publicState().cards, { id: geneId, modelPath: 'bundled:gene' }));
    // Her voice is local (like the model link): the user choosing another one for her does not make the preset "changed".
    await first.setVoices(new Map([[geneId, { provider: 'system' as const, voiceId: '' }]]));
    assert.deepEqual(first.getActive().voice, { provider: 'system', voiceId: '' });
    const restarted = await open();
    assert.equal(await restarted.needsInitialGeneModel(false), true, 'still the unchanged preset: the bundled model setup resumes');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an imported card cannot bring a key, a path or an unknown field in its voice', () => {
  const draft = validateCharacterDraft({ name: 'X', voice: { provider: 'system', voiceId: 'C:\\Windows\\evil.exe', apiKey: 'k', description: 'ok' } });
  assert.deepEqual(draft.voice, { provider: 'system', voiceId: '', description: 'ok' });
  assert.equal(normalizeCharacterVoice({ provider: 'openai', voiceId: 'x' }), undefined, 'an unknown provider is no voice');
  assert.equal(normalizeCharacterVoice({ provider: 'fish', voiceId: '../../etc/passwd' })?.voiceId, '');
  assert.equal(normalizeCharacterVoice({ provider: 'bailian', voiceId: 'https://x/y' })?.voiceId, '');
  assert.equal(portableCharacterVoice({ provider: 'system', voiceId: 'sk-abcdefghijklmnopqrstuv' })?.voiceId, '', 'a key-looking system voice name is dropped');
  assert.equal(portableCharacterVoice({ provider: 'fish', voiceId: '8ef4a238714b45718ce04243307c57a7' })?.voiceId, '8ef4a238714b45718ce04243307c57a7', 'a Drama 3 id is its own shape and stays');
});
