// I-162 step 1: the one resolver every speech path goes through
// (shared/voice/character-voice-resolver.ts) and the system voice picker (src/voice/voice-language.ts). No real voice, no paid call:
// the configs are plain objects and the "keys" are placeholders that only make a provider count as ready.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TTS_CONFIG, effectiveTtsConfig, type TtsConfig } from '../shared/voice/tts';
import { characterTtsConfig, type VoiceSettings } from '../shared/voice/character-voice-resolver';
import { systemVoiceGender, voiceTraits } from '../shared/voice/voice-traits';
import { pickSystemVoice } from '../src/voice/voice-language';
import type { CharacterVoice } from '../shared/foundation/character-voice';

const AKIKO_TEXT = { name: '艾琳', description: '她是一个总是有点困的女孩，说话拖着尾音。', personality: '她温柔、懒洋洋，暗地里有点坏。' };
const MODEL = 'C:/models/akiko.pmx';
function tts(patch: Partial<TtsConfig> = {}): TtsConfig {
  return { ...structuredClone(DEFAULT_TTS_CONFIG) as TtsConfig, ...patch };
}
const settingsWith = (config: TtsConfig, voiceURI = ''): VoiceSettings => ({ tts: config, voice: { voiceURI }, model: { path: MODEL } });
const akiko = (voice?: CharacterVoice) => ({ id: 'akiko', ...AKIKO_TEXT, ...(voice ? { voice } : {}) });
const FISH_READY = { fishApiKey: 'placeholder-not-a-key' };
const BAILIAN_READY = { apiKey: 'placeholder-not-a-key', apiHost: 'https://example.invalid' };

test('the bug as it was: a global Drama 3 without her own voice id read her with Drama 3 built-in voice (no reference_id)', () => {
  const config = tts({ provider: 'fish', fishVoiceId: '', ...FISH_READY });
  const before = effectiveTtsConfig(config, 'akiko', MODEL); // what every speech path used before I-162
  assert.equal(before.provider, 'fish');
  assert.equal(before.fishVoiceId, '', 'no voice id: Fish answers with its own default speaker, not chosen for her');
});

test('Akiko after the migration (Drama 3, no voice id): a female system voice and one notice, never Drama 3 built-in voice', () => {
  const config = tts({ provider: 'fish', fishVoiceId: '', ...FISH_READY });
  const resolved = characterTtsConfig(settingsWith(config), akiko({ provider: 'fish', voiceId: '' }));
  assert.equal(resolved.provider, 'system');
  assert.equal(resolved.voicePlan?.gender, 'female');
  assert.equal(resolved.voicePlan?.fallback, 'no-voice-id');
  assert.match(resolved.voicePlan?.notice ?? '', /艾琳.*Drama 3.*声音编号.*系统女声/u);
  // The system picker then never takes a male voice for her.
  const voices = [{ voiceURI: 'kk', name: 'Microsoft Kangkang - Chinese (Simplified, PRC)', lang: 'zh-CN' }, { voiceURI: 'hh', name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN' }];
  assert.equal(pickSystemVoice(voices, '', 'zh-CN', { gender: 'female', voiceURI: resolved.voicePlan!.systemVoiceURI })?.voiceURI, 'hh');
});

test('her own default voice speaks when its provider is usable (per provider)', () => {
  const ready = tts({ ...FISH_READY, ...BAILIAN_READY });
  const fish = characterTtsConfig(settingsWith(ready), akiko({ provider: 'fish', voiceId: 'g6two' }));
  assert.deepEqual([fish.provider, fish.fishVoiceId, fish.voicePlan?.fallback], ['fish', 'g6two', null]);
  const bailian = characterTtsConfig(settingsWith(ready), akiko({ provider: 'bailian', voiceId: 'longanhuan_v3.1' }));
  assert.deepEqual([bailian.provider, bailian.voice, bailian.voicePlan?.fallback], ['bailian', 'longanhuan_v3.1', null]);
  const system = characterTtsConfig(settingsWith(ready, 'global-uri'), akiko({ provider: 'system', voiceId: 'her-uri' }));
  assert.deepEqual([system.provider, system.voicePlan?.systemVoiceURI], ['system', 'her-uri']);
  // A custom Bailian voice (not in the known list) of her own is trusted.
  assert.equal(characterTtsConfig(settingsWith(ready), akiko({ provider: 'bailian', voiceId: 'cosyvoice-her-own' })).voice, 'cosyvoice-her-own');
});

test('Drama 3 never reads her 声音描述: it is not her acting style (Drama 3 speaks a long inline direction aloud); her own acting style still is', () => {
  // One's description sat in Drama 3's [direction] and was partly spoken.
  const description = '成年女声，清冷。口癖都短而低：“切”是鼻子里一声干干的出气。';
  const ready = tts({ provider: 'fish', ...FISH_READY });
  const plain = characterTtsConfig(settingsWith(ready), akiko({ provider: 'fish', voiceId: 'g6two', description }));
  assert.equal(plain.provider, 'fish');
  assert.equal(plain.fishActingStyle, undefined, 'no acting style from the description');
  // An acting style written for Drama 3 on her binding is kept.
  const styled = tts({ provider: 'fish', ...FISH_READY, styleBindings: [{ characterId: 'akiko', modelPath: MODEL, voice: 'longanlingxin_v3.1', instruction: '', emotion: 'custom', rate: 1, fishActingStyle: 'cool, calm' }] });
  const withOwn = characterTtsConfig(settingsWith(styled), akiko({ provider: 'fish', voiceId: 'g6two', description }));
  assert.equal(withOwn.fishActingStyle, 'cool, calm');
});

test('a provider that cannot speak (no key) passes to the default provider, then the system voice; paid ones are never added', () => {
  // Drama 3 has no key, Bailian is the global (default) provider and ready: Bailian, with her closest known voice.
  const bailianDefault = tts({ provider: 'bailian', ...BAILIAN_READY });
  const viaBailian = characterTtsConfig(settingsWith(bailianDefault), akiko({ provider: 'fish', voiceId: 'g6two', description: '二十出头的女生，活泼，声音亮' }));
  assert.equal(viaBailian.provider, 'bailian');
  assert.equal(viaBailian.voicePlan?.fallback, 'no-key');
  assert.equal(viaBailian.voice, 'longanhuan_v3.1', 'the closest known female voice to "活泼、亮"');
  assert.equal(viaBailian.instruction, '二十出头的女生，活泼，声音亮', 'Bailian takes her description as its instruction');
  assert.equal(viaBailian.emotion, 'custom');
  // Nothing ready but the system voice: the system voice. A Bailian key alone never makes a system-voice character paid.
  const free = characterTtsConfig(settingsWith(tts({ ...BAILIAN_READY })), akiko({ provider: 'fish', voiceId: 'g6two' }));
  assert.equal(free.provider, 'system');
  const systemOwn = characterTtsConfig(settingsWith(tts({ provider: 'bailian', ...BAILIAN_READY })), akiko({ provider: 'system', voiceId: '' }));
  assert.equal(systemOwn.provider, 'system', 'her own free voice is never upgraded to a paid default');
});

test('never the wrong gender: a known male Bailian voice is replaced for her; a male character keeps a male voice', () => {
  const ready = tts({ ...BAILIAN_READY });
  const replaced = characterTtsConfig(settingsWith(ready), akiko({ provider: 'bailian', voiceId: 'xunanchuan_v3.1' }));
  assert.equal(replaced.provider, 'bailian');
  assert.notEqual(replaced.voice, 'xunanchuan_v3.1');
  assert.equal(replaced.voicePlan?.fallback, 'wrong-gender');
  // The description decides gender first: "男声" makes the man's voice right (and a female preset wrong).
  const man = { id: 'kai', name: '凯', description: '一个温和的大学生。', voice: { provider: 'bailian' as const, voiceId: 'longanlingxin_v3.1', description: '二十多岁的男生，声音低沉' } };
  const forMan = characterTtsConfig(settingsWith(ready), man);
  assert.equal(forMan.voice, 'xunanchuan_v3.1');
  assert.equal(forMan.voicePlan?.gender, 'male');
  // A character without a voice of her own reads with the default for new characters, but never a known voice of the other gender.
  const maleDefault = tts({ provider: 'bailian', voice: 'xunanchuan_v3.1', ...BAILIAN_READY });
  assert.notEqual(characterTtsConfig(settingsWith(maleDefault), { id: 'new', ...AKIKO_TEXT }).voice, 'xunanchuan_v3.1');
  // An unknown custom voice that is only the default (not hers) is not trusted either: her closest known voice.
  const customDefault = tts({ provider: 'bailian', voice: 'somebody-else', ...BAILIAN_READY });
  assert.equal(characterTtsConfig(settingsWith(customDefault), { id: 'new', ...AKIKO_TEXT }).voice, 'longanlingxin_v3.1');
});

test('gender and age come from her description, else her card (biased to female), else female', () => {
  assert.equal(voiceTraits('', '她是一个女孩').gender, 'female');
  assert.equal(voiceTraits('', '').genderFrom, 'default');
  assert.equal(voiceTraits('', '').gender, 'female');
  assert.equal(voiceTraits('不要男声，轻一点', '').gender, 'female', 'a negated mention says nothing; default female');
  assert.equal(voiceTraits('', '她喜欢用户，把他当男朋友').gender, 'female', 'the user called "他" never makes her male');
  assert.equal(voiceTraits('', '性别：男。他是一个少年。').gender, 'male');
  assert.equal(voiceTraits('成熟的男声，低沉', '她').gender, 'male', 'the description wins over the card');
  assert.equal(voiceTraits('二十出头的女生', '').age, 'young');
  assert.deepEqual(voiceTraits('声音轻、偏甜，语速慢', '').timbre, ['sweet', 'soft', 'calm']);
});

const WINDOWS_VOICES = [
  { voiceURI: 'Microsoft David - English (United States)', name: 'Microsoft David - English (United States)', lang: 'en-US' },
  { voiceURI: 'Microsoft Mark - English (United States)', name: 'Microsoft Mark - English (United States)', lang: 'en-US' },
  { voiceURI: 'Microsoft Zira - English (United States)', name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
  { voiceURI: 'Microsoft Kangkang - Chinese (Simplified, PRC)', name: 'Microsoft Kangkang - Chinese (Simplified, PRC)', lang: 'zh-CN' },
  { voiceURI: 'Microsoft Huihui - Chinese (Simplified, PRC)', name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN' },
  { voiceURI: 'Microsoft Yaoyao - Chinese (Simplified, PRC)', name: 'Microsoft Yaoyao - Chinese (Simplified, PRC)', lang: 'zh-CN' },
];

test('the system picker never returns a known voice of the other gender, whatever was chosen and in any order', () => {
  const orders = [WINDOWS_VOICES, [...WINDOWS_VOICES].reverse(), [WINDOWS_VOICES[3], WINDOWS_VOICES[0], WINDOWS_VOICES[1], WINDOWS_VOICES[5], WINDOWS_VOICES[2], WINDOWS_VOICES[4]]];
  for (const voices of orders) for (const gender of ['female', 'male'] as const) for (const language of ['zh-CN', 'en'] as const)
    for (const chosen of ['', ...voices.map(voice => voice.voiceURI)]) for (const own of ['', ...voices.map(voice => voice.voiceURI)]) {
      const picked = pickSystemVoice(voices, chosen, language, { gender, voiceURI: own });
      if (picked) assert.notEqual(systemVoiceGender(picked), gender === 'female' ? 'male' : 'female', `${gender} ${language} chosen=${chosen} own=${own} → ${picked.name}`);
    }
  // Her own voice wins when it fits; Kangkang (the first Chinese voice in some orders) is never hers.
  assert.equal(pickSystemVoice(WINDOWS_VOICES, '', 'zh-CN', { gender: 'female', voiceURI: WINDOWS_VOICES[5].voiceURI })?.name, WINDOWS_VOICES[5].name);
  assert.equal(pickSystemVoice([WINDOWS_VOICES[3], WINDOWS_VOICES[4]], '', 'zh-CN', { gender: 'female', voiceURI: '' })?.name, WINDOWS_VOICES[4].name);
  assert.equal(pickSystemVoice([WINDOWS_VOICES[0], WINDOWS_VOICES[1], WINDOWS_VOICES[2]], '', 'en', { gender: 'female', voiceURI: '' })?.name, WINDOWS_VOICES[2].name);
  assert.equal(pickSystemVoice([WINDOWS_VOICES[0], WINDOWS_VOICES[1]], '', 'en', { gender: 'female', voiceURI: '' }), null, 'only male voices: none, not a man');
  assert.equal(pickSystemVoice(WINDOWS_VOICES, '', 'zh-CN', { gender: 'male', voiceURI: '' })?.name, WINDOWS_VOICES[3].name);
  // Without a wish (no character) the picker is what it was.
  assert.equal(pickSystemVoice(WINDOWS_VOICES, '', 'zh-CN', null)?.name, WINDOWS_VOICES[3].name);
});
