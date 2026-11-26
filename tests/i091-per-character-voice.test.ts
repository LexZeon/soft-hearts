// I-091 / I-070: each character can carry its own read-aloud provider (system / Bailian / Drama 3). Absent = the global one,
// exactly as before. Fakes only: nothing here calls Bailian or Fish, and no key is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_TTS_CONFIG, effectiveTtsConfig, ttsProviderReady, type TtsConfig, type TtsStyleBinding } from '../shared/voice/tts';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { AppSettings } from '../shared/foundation/settings';
import { validateTtsConfig } from '../electron/voice/tts';
import { CharacterCardStore } from '../electron/cards/character-cards';
import { CallFillerStore, callFillerVoiceKey } from '../electron/voice/voice-call/fillers';
import { ownVoiceHint } from '../src/voice/EmotionalVoice';
import { AgentToolRegistry } from '../electron/safety/agent-channel/registry';
import { createAppTools, voiceStyleArgs, voiceStyleOf } from '../electron/safety/agent-channel/app-tools';
import { createHostBridge, type IpcHandler } from '../electron/safety/agent-channel/bridge';

const AKIKO = 'akiko-id', GENE = 'gene-id', MODEL = 'C:\\m\\akiko.pmx';
const BAILIAN_KEY = 'bailian-secret-marker-111', FISH_KEY = 'fish-secret-marker-222';
const bind = (characterId: string, patch: Partial<TtsStyleBinding> = {}): TtsStyleBinding =>
  ({ characterId, modelPath: MODEL, voice: 'longanlingxin_v3.1', instruction: '', emotion: 'custom', rate: 1, ...patch });
const both = (patch: Partial<TtsConfig> = {}): TtsConfig => ({ ...structuredClone(DEFAULT_TTS_CONFIG), apiHost: 'https://dashscope.example', region: 'cn-beijing',
  apiKey: BAILIAN_KEY, fishApiKey: FISH_KEY, ...patch });

test('absent = the global provider: a config with no own provider resolves exactly as before', () => {
  for (const provider of ['system', 'bailian', 'fish'] as const) {
    const config = both({ provider, styleBindings: [bind(AKIKO, { voice: 'longanhuan_v3.1' })] });
    const effective = effectiveTtsConfig(config, AKIKO, MODEL);
    assert.equal(effective.provider, provider);
    assert.equal(effective.ownProvider, undefined);
    assert.equal(effective.voice, 'longanhuan_v3.1');
    assert.equal(effectiveTtsConfig(config, 'nobody', MODEL).provider, provider);
  }
});

test('each character is read with its own provider; the global one only decides for characters that chose nothing', () => {
  const config = both({ provider: 'system', styleBindings: [bind(AKIKO, { provider: 'bailian' }), bind(GENE, { provider: 'fish', fishVoiceId: 'gene-voice' })] });
  assert.equal(effectiveTtsConfig(config, AKIKO, MODEL).provider, 'bailian');
  assert.deepEqual([effectiveTtsConfig(config, GENE, MODEL).provider, effectiveTtsConfig(config, GENE, MODEL).fishVoiceId], ['fish', 'gene-voice']);
  assert.equal(effectiveTtsConfig(config, 'third', MODEL).provider, 'system');
  // Her own "system voice" wins over a paid global one too (she reads for free).
  assert.equal(effectiveTtsConfig({ ...config, provider: 'fish', styleBindings: [bind(AKIKO, { provider: 'system' })] }, AKIKO, MODEL).provider, 'system');
});

test('a call switching character changes the voice on the next utterance: each utterance resolves the active character afresh', () => {
  const config = both({ provider: 'system', styleBindings: [bind(AKIKO, { provider: 'bailian' }), bind(GENE, { provider: 'fish' })] });
  let active = AKIKO;
  const utterance = () => effectiveTtsConfig(config, active, MODEL); // what electron/main.ts does per sentence (voice() and ttsConfig())
  const first = utterance();
  active = GENE;
  const inFlight = first; // a sentence already handed to the synthesizer keeps its own config
  const next = utterance();
  assert.deepEqual([inFlight.provider, next.provider], ['bailian', 'fish']);
  // The call's filler clips follow: different provider means a different voice key (so the window fetches the other character's clips).
  assert.notEqual(callFillerVoiceKey(inFlight), callFillerVoiceKey(next));
  const store = new CallFillerStore({ directory: () => null, synthesize: async () => { throw new Error('no paid call in a test'); } } as any);
  assert.deepEqual([store.status(AKIKO, inFlight).provider, store.status(GENE, next).provider], ['bailian', 'fish']);
});

test('a provider with no key is not used: the global one keeps speaking, and the choice is still known to the window', () => {
  const noFish = both({ provider: 'system', fishApiKey: '', styleBindings: [bind(GENE, { provider: 'fish' })] });
  const noBailian = both({ provider: 'system', apiKey: '', styleBindings: [bind(AKIKO, { provider: 'bailian' })] });
  const noHost = both({ provider: 'fish', apiHost: '', styleBindings: [bind(AKIKO, { provider: 'bailian' })] });
  assert.equal(effectiveTtsConfig(noFish, GENE, MODEL).provider, 'system');
  assert.equal(effectiveTtsConfig(noFish, GENE, MODEL).ownProvider, 'fish');
  assert.equal(effectiveTtsConfig(noBailian, AKIKO, MODEL).provider, 'system');
  assert.equal(effectiveTtsConfig(noHost, AKIKO, MODEL).provider, 'fish', 'Bailian also needs its host: fall back to the global Drama 3');
  assert.deepEqual([ttsProviderReady(noFish, 'fish'), ttsProviderReady(noFish, 'bailian'), ttsProviderReady(noFish, 'system')], [false, true, true]);
  // The note next to the choice, in Chinese, only while it cannot speak.
  assert.match(ownVoiceHint(effectiveTtsConfig(noFish, GENE, MODEL)), /Drama 3.*Key.*全局/u);
  assert.match(ownVoiceHint(effectiveTtsConfig(noBailian, AKIKO, MODEL)), /百炼.*全局/u);
  assert.equal(ownVoiceHint(effectiveTtsConfig(both({ styleBindings: [bind(GENE, { provider: 'fish' })] }), GENE, MODEL)), '');
  assert.equal(ownVoiceHint(effectiveTtsConfig(both(), GENE, MODEL)), '');
});

test('saved settings keep the choice and nothing else about it; unknown values and a stray ownProvider are dropped', () => {
  const kept = validateTtsConfig({ ...both({ provider: 'system' }), ownProvider: 'fish',
    styleBindings: [bind(AKIKO, { provider: 'bailian' }), bind(GENE, { provider: 'evil' as any }), bind('third')] });
  assert.deepEqual(kept.styleBindings!.map(item => item.provider), ['bailian', undefined, undefined]);
  assert.equal(kept.ownProvider, undefined);
  assert.equal(Object.hasOwn(kept.styleBindings![1], 'provider'), false);
  // Validating the effective config of a call keeps the provider that will really be used.
  assert.equal(validateTtsConfig(effectiveTtsConfig(both({ styleBindings: [bind(GENE, { provider: 'fish' })] }), GENE, MODEL)).provider, 'fish');
});

test('export: a card file carries no provider, key or voice binding; the binding itself holds a name only', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i091-'));
  try {
    const store = new CharacterCardStore(directory, 'persona');
    await store.load();
    await store.save({ name: '小桃', description: '', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '' });
    const text = store.export(store.publicState().cards.at(-1)!.id);
    for (const word of ['provider', 'ownProvider', 'fishApiKey', 'apiKey', 'styleBindings', 'bailian', 'fish']) assert.ok(!text.includes(word), word);
  } finally { await rm(directory, { recursive: true, force: true }); }
  const binding = JSON.stringify(effectiveTtsConfig(both({ styleBindings: [bind(AKIKO, { provider: 'fish' })] }), AKIKO, MODEL).styleBindings![0]);
  assert.ok(!binding.includes(BAILIAN_KEY) && !binding.includes(FISH_KEY) && !/[A-Za-z]:\\\\/u.test(binding.replace(/"modelPath":"[^"]*"/u, '')));
});

// --- Internal channel -------------------------------------------------------------------------------------------------------

function channel(tts: Partial<TtsConfig>) {
  let settings: AppSettings = { ...structuredClone(DEFAULT_SETTINGS), model: { path: MODEL, url: 'local://akiko', name: 'akiko.pmx' } as any,
    tts: { ...structuredClone(DEFAULT_TTS_CONFIG), ...tts } as any };
  const cards = { activeId: AKIKO, cards: [{ id: AKIKO, name: '艾琳', modelName: 'akiko.pmx' } as any] };
  const handlers: Record<string, (...args: any[]) => unknown> = {
    getSettings: () => structuredClone(settings), saveSettings: next => { settings = structuredClone(next); return settings; },
    getCharacterCards: () => structuredClone(cards), openControls: () => {},
  };
  const operations = new Map<string, IpcHandler>(Object.entries(handlers).map(([name, run]) => [name, (_event: any, ...args: unknown[]) => run(...args)]));
  const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send() {} } });
  const bridge = createHostBridge({ version: () => '0', controls: () => window(11), pet: () => window(12), operations,
    admit: (guard, run) => { guard(); return run(); }, importCharacterCard: async () => { throw new Error('x'); },
    loadModel: async () => { throw new Error('x'); }, commitPetBoolean: async () => { throw new Error('x'); },
    commitReadoutVolume: async () => { throw new Error('x'); }, commitBreath: async () => { throw new Error('x'); },
    replyLatency: () => [], broadcast: () => {}, interconnected: () => true });
  const registry = new AgentToolRegistry(createAppTools(bridge), { enabled: () => true, interconnect: () => true,
    confirm: async () => true, notice: () => {}, called: () => {} });
  return { call: (name: string, args: unknown): Promise<any> => registry.call(name, args), settings: () => settings };
}

test('channel: set_voice_style can set follow-global or the free system voice for this character, never a paid provider', async () => {
  assert.deepEqual(voiceStyleArgs({ provider: 'system' }), { provider: 'system' });
  assert.deepEqual(voiceStyleArgs({ provider: 'follow' }), { provider: '' });
  for (const paid of ['bailian', 'fish']) assert.throws(() => voiceStyleArgs({ provider: paid }), /会花钱|控制窗口/u);
  assert.throws(() => voiceStyleArgs({ provider: 'other' }));
  const h = channel({ provider: 'fish', fishApiKey: FISH_KEY });
  assert.equal(voiceStyleOf(h.settings(), AKIKO).provider, '');
  assert.ok((await h.call('set_voice_style', { provider: 'system' })).ok);
  assert.equal(voiceStyleOf(h.settings(), AKIKO).provider, 'system');
  assert.equal(effectiveTtsConfig(h.settings().tts as TtsConfig, AKIKO, MODEL).provider, 'system');
  assert.equal((h.settings().tts as TtsConfig).provider, 'fish', 'the global provider is not touched');
  const refused = await h.call('set_voice_style', { provider: 'bailian' });
  assert.equal(refused.ok, false);
  assert.equal(voiceStyleOf(h.settings(), AKIKO).provider, 'system', 'a refused call saves nothing');
  // Another change keeps her own choice; "follow" removes it.
  assert.ok((await h.call('set_voice_style', { rate: 1.2 })).ok);
  assert.equal(voiceStyleOf(h.settings(), AKIKO).provider, 'system');
  assert.ok((await h.call('set_voice_style', { provider: 'follow' })).ok);
  assert.equal(Object.hasOwn((h.settings().tts as TtsConfig).styleBindings![0], 'provider'), false);
});
