// I-172: the two preinstalled Genes are the "future interstellar courier intern" persona the user approved in the dev build
// ("非常好现在！"). This pins what ships: the persona text that carries the character (her confident wrong Earth common sense, the conspiracy
// kind, and the one exception: seriously harmful health/safety is answered right), the brighter mood block, and the Drama 3 voice with the
// free system voice still speaking for someone without a Fish key. The neutral reference other characters are tuned against is
// DEFAULT_MOOD_PARAMETERS, not Gene. No real voice, no paid call: the "key" is a placeholder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { preinstalledGeneDraft, preinstalledGeneEnglishDraft } from '../electron/cards/gene-preinstalled-card';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/foundation/mood';
import { cleanVoiceId, normalizeCharacterVoice } from '../shared/foundation/character-voice';
import { characterTtsConfig, type VoiceSettings } from '../shared/voice/character-voice-resolver';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/voice/tts';

const DRAMA3_VOICE = '395e6370541e49948220a7af1a60bfae';
const zh = preinstalledGeneDraft(), en = preinstalledGeneEnglishDraft();

test('the Chinese Gene is the approved courier intern: persona text, greeting, examples', () => {
  assert.equal(zh.name, 'Gene');
  assert.equal(zh.language, undefined, 'Chinese Gene stays the default-language card');
  assert.match(zh.description, /从未来星际快递站来的实习投递员/u);
  assert.match(zh.description, /这一单还没签收/u);
  assert.equal(zh.greeting, '搭档，上线了吗？');
  // Her trait (not an app rule): optimistic, expression never stops, dopey with confidence, conspiratorial concrete mistakes.
  for (const part of ['非常乐观', '表情特别丰富', '理直气壮', '阴谋', '字面理解', '因果弄反', '用途搞错', '地球手册']) assert.ok(zh.personality.includes(part) || zh.systemPrompt.includes(part), part);
  for (const part of ['咖啡', '扫地机器人', '洗衣机', '鸽子', '下载明天']) assert.ok(zh.examples.includes(part), part);
  // Only seriously harmful health/safety is answered right; the example shows it with an emergency number.
  assert.match(zh.systemPrompt, /较严重地伤到健康或安全/u);
  assert.match(zh.systemPrompt, /吃药、用电用火、急症、酒后开车、伤害自己/u);
  assert.match(zh.examples, /120/u);
  // She never gains a permission from her persona.
  assert.match(zh.systemPrompt, /角色人设不改变工具、文件、屏幕、摄像头或麦克风权限/u);
});

test('the English Gene is the same character: language en, English text, same examples of mistakes and the same safety exception', () => {
  assert.equal(en.name, 'Gene (English)');
  assert.equal(en.language, 'en');
  assert.match(en.description, /intern courier from an interstellar delivery station/u);
  assert.equal(en.greeting, 'Partner, are you online?');
  for (const part of ['conspirac', 'idioms taken literally', 'backwards', 'Earth Manual']) assert.ok((en.personality + en.systemPrompt).includes(part), part);
  for (const part of ['coffee', 'robot vacuum', 'washing machine', 'cats and dogs', 'download']) assert.match(en.examples, new RegExp(part, 'iu'), part);
  assert.match(en.systemPrompt, /seriously harm health or safety/u);
  assert.match(en.examples, /call emergency services/u);
  assert.match(en.systemPrompt, /never changes permissions for tools, files, the screen, the camera or the microphone/u);
  assert.doesNotMatch(JSON.stringify([en.description, en.personality, en.scenario, en.greeting, en.examples, en.systemPrompt]), /[一-鿿]/u, 'no Chinese in the English card');
});

test('both Genes carry the approved brighter mood block, and it is not the neutral default any more', () => {
  const mood = zh.mood!.parameters;
  assert.deepEqual(en.mood!.parameters, mood, 'one mood block for both languages');
  assert.deepEqual(mood.baseline, { D: 62, O: 56, E: 62, N: 55, C: 40 });
  assert.deepEqual(mood.intensity, { expression: 90, gaze: 75, posture: 80, playful: 90, text: 80 });
  assert.deepEqual(mood.weights, { playful: 1.4, close: 1.1, comfortable: 1.3, cautious: 0.8 });
  assert.equal(mood.frequency.motionIntervalMs, 120_000);
  // The reference other characters are tuned against is the code default: baseline 50, sensitivity 1, intensity 50.
  assert.deepEqual(DEFAULT_MOOD_PARAMETERS.baseline, { D: 50, O: 50, E: 50, N: 50, C: 50 });
  assert.deepEqual(DEFAULT_MOOD_PARAMETERS.intensity, { expression: 50, gaze: 50, posture: 50, playful: 50, text: 50 });
  assert.notDeepEqual(mood.baseline, DEFAULT_MOOD_PARAMETERS.baseline);
});

const ready = (provider: TtsConfig['provider'], fishApiKey = ''): VoiceSettings => ({ tts: { ...structuredClone(DEFAULT_TTS_CONFIG) as TtsConfig, provider, ...(fishApiKey ? { fishApiKey } : {}) }, voice: { voiceURI: '' }, model: { path: '' } });

test('both Genes carry the Drama 3 voice id the user picked, and it is a valid one', () => {
  for (const card of [zh, en]) {
    assert.deepEqual(card.voice, { provider: 'fish', voiceId: DRAMA3_VOICE });
    assert.equal(cleanVoiceId('fish', DRAMA3_VOICE), DRAMA3_VOICE, 'a valid Drama 3 reference id');
    assert.deepEqual(normalizeCharacterVoice(card.voice), card.voice, 'it survives normalization unchanged');
  }
});

test('with a Fish key she speaks with Drama 3; without one the free system voice speaks, never a missing or male voice', () => {
  for (const card of [zh, en]) {
    const subject = { id: 'gene', ...card };
    const withKey = characterTtsConfig(ready('system', 'placeholder-not-a-key'), subject);
    assert.deepEqual([withKey.provider, withKey.fishVoiceId, withKey.voicePlan?.fallback], ['fish', DRAMA3_VOICE, null]);
    const noKey = characterTtsConfig(ready('system'), subject);
    assert.equal(noKey.provider, 'system', 'free voice is the fallback');
    assert.equal(noKey.voicePlan?.fallback, 'no-key');
    assert.notEqual(noKey.voicePlan?.gender, 'male', 'the card text reads as a girl: never a male system voice');
  }
});
