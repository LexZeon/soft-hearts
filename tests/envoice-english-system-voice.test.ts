import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSystemVoice, systemVoiceLine } from '../src/voice/voice-language';
import { effectiveTtsConfig, DEFAULT_TTS_CONFIG } from '../shared/voice/tts';

const voices = [
  { voiceURI: 'zh-a', name: 'Microsoft Xiaoxiao Online (Natural)', lang: 'zh-CN' },
  { voiceURI: 'en-david', name: 'Microsoft David - English (United States)', lang: 'en-US' },
  { voiceURI: 'en-zira', name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
  { voiceURI: 'en-aria', name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' },
];
test('English card + empty voice: the natural female English voice', () => {
  assert.equal(pickSystemVoice(voices, '', 'en')?.voiceURI, 'en-aria');
});
test('English card + Chinese voice set: an English voice, never the Chinese one', () => {
  assert.equal(pickSystemVoice(voices, 'zh-a', 'en')?.voiceURI, 'en-aria');
});
test('English card + English voice set: kept, even a male one', () => {
  assert.equal(pickSystemVoice(voices, 'en-david', 'en')?.voiceURI, 'en-david');
});
test('without natural voices: a named female one, then any en-*, then the default', () => {
  assert.equal(pickSystemVoice(voices.filter(v => v.voiceURI !== 'en-aria'), '', 'en')?.voiceURI, 'en-zira');
  assert.equal(pickSystemVoice([voices[0], voices[1]], '', 'en')?.voiceURI, 'en-david');
  assert.equal(pickSystemVoice([voices[0]], '', 'en'), null, 'no English voice and none chosen: the default (the utterance is tagged en-US)');
  assert.equal(pickSystemVoice([], '', 'en'), null);
});
test('Chinese card: unchanged (chosen, else first Chinese, never an English preference)', () => {
  assert.equal(pickSystemVoice(voices, '', 'zh-CN')?.voiceURI, 'zh-a');
  assert.equal(pickSystemVoice(voices, 'en-david', 'zh-CN')?.voiceURI, 'en-david');
  assert.equal(pickSystemVoice([voices[1], voices[3]], '', 'zh-CN'), null);
});
test('the settings line names the voice an English character will use', () => {
  assert.match(systemVoiceLine(voices, '', 'en'), /英文.*Aria/);
  assert.match(systemVoiceLine([], '', 'en'), /系统默认/);
  assert.match(systemVoiceLine(voices, '', 'zh-CN'), /中文/);
});
test("a character's own provider choice is kept; the system-voice pick is never consulted for it", () => {
  const config = { ...DEFAULT_TTS_CONFIG, provider: 'system', fishVoiceId: 'v', styleBindings: [{ characterId: 'c', modelPath: 'm', voice: 'x', instruction: '', emotion: '', rate: 1, provider: 'fish' }] } as any;
  const result = effectiveTtsConfig(config, 'c', 'm');
  assert.equal(result.ownProvider, 'fish');
  // not ready here (no key), so the effective provider falls back to system: the voice pick then applies, and only then.
  assert.equal(result.provider, 'system');
});
