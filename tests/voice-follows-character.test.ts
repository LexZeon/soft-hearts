// 2026-11-19: a character's voice follows her across a model swap (the binding is per character + model path). Fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TTS_CONFIG, effectiveTtsConfig, type TtsConfig, type TtsStyleBinding } from '../shared/voice/tts';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { AppSettings } from '../shared/foundation/settings';
import { voiceStyleOf, withVoiceStyle } from '../electron/safety/agent-channel/app-tools';

const MUMI = 'mumi-id', GENE = 'gene-id', OLD = 'C:\m\gene.pmx', NEW = 'C:\m\mumi.vrm';
const bind = (characterId: string, modelPath: string, patch: Partial<TtsStyleBinding> = {}): TtsStyleBinding =>
  ({ characterId, modelPath, voice: 'longanlingxin_v3.1', instruction: '', emotion: 'custom', rate: 1, ...patch });
const config = (styleBindings: TtsStyleBinding[]): TtsConfig => ({ ...structuredClone(DEFAULT_TTS_CONFIG), apiKey: 'k', apiHost: 'https://x.example', fishApiKey: 'f', styleBindings });
const settings = (tts: TtsConfig, modelPath: string): AppSettings => ({ ...structuredClone(DEFAULT_SETTINGS), tts, model: { ...DEFAULT_SETTINGS.model, path: modelPath } } as AppSettings);

test('a character on a new model keeps her voice id, provider, acting style and the rest', () => {
  const c = config([bind(MUMI, OLD, { provider: 'fish', fishVoiceId: 'mumi-voice', fishActingStyle: 'soft', voice: 'v2', instruction: 'slow', emotion: 'gentle', rate: 1.2 })]);
  const e = effectiveTtsConfig(c, MUMI, NEW);
  assert.deepEqual([e.provider, e.fishVoiceId, e.fishActingStyle, e.voice, e.instruction, e.emotion, e.rate], ['fish', 'mumi-voice', 'soft', 'v2', 'slow', 'gentle', 1.2]);
});

test('the exact character + model binding still wins; with several others the most recently written is the base', () => {
  const c = config([bind(MUMI, 'a', { fishVoiceId: 'first' }), bind(MUMI, NEW, { fishVoiceId: 'exact' }), bind(MUMI, 'b', { fishVoiceId: 'latest' })]);
  assert.equal(effectiveTtsConfig(c, MUMI, NEW).fishVoiceId, 'exact');
  assert.equal(effectiveTtsConfig(c, MUMI, 'other').fishVoiceId, 'latest');
});

test('two characters never borrow each other; one with no binding uses the global voice', () => {
  const c = { ...config([bind(MUMI, OLD, { fishVoiceId: 'mumi-voice' })]), fishVoiceId: 'global' };
  assert.equal(effectiveTtsConfig(c, GENE, NEW).fishVoiceId, 'global');
  assert.equal(effectiveTtsConfig(c, MUMI, NEW).fishVoiceId, 'mumi-voice');
});

test('changing only the rate on a new model writes a binding based on the old one', () => {
  const c = config([bind(MUMI, OLD, { provider: 'fish', fishVoiceId: 'mumi-voice', fishActingStyle: 'soft' })]);
  const next = withVoiceStyle(settings(c, NEW), MUMI, { rate: 1.3 });
  const written = next.tts!.styleBindings!.find(b => b.modelPath === NEW)!;
  assert.deepEqual([written.fishVoiceId, written.fishActingStyle, written.provider, written.rate], ['mumi-voice', 'soft', 'fish', 1.3]);
  assert.equal(next.tts!.styleBindings!.length, 2, 'the old binding is kept');
  assert.equal(voiceStyleOf(next, MUMI).voiceId, 'mumi-voice');
});

test('the shown current value is what is spoken', () => {
  const c = config([bind(MUMI, OLD, { fishVoiceId: 'mumi-voice' })]);
  assert.equal(voiceStyleOf(settings(c, NEW), MUMI).voiceId, effectiveTtsConfig(c, MUMI, NEW).fishVoiceId);
});
