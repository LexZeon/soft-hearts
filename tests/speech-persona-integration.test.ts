import test from 'node:test';
import assert from 'node:assert/strict';
import { characterSpeechPersona } from '../electron/speech-persona';
import { composeSpeechConfig, ReplySpeechStyles, SPEECH_EMOTION_INSTRUCTIONS, selectSpeechEmotion, TURN_SPEECH_INSTRUCTION_LIMIT, type SpeechMood } from '../electron/speech-emotion';
import { SpeechRuntime } from '../electron/speech-runtime';
import { synthesizeBailianSpeech, validateTtsConfig } from '../electron/tts';
import { DEFAULT_TTS_CONFIG, effectiveTtsConfig, type TtsConfig } from '../shared/tts';

const quiet = { personality: '性格内敛含蓄，不大声欢呼。', description: '', systemPrompt: '说话方式：措辞简洁，喜悦也轻声表达。' };
const lively = { personality: '性格外向开朗，表达热情自然。', description: '', systemPrompt: '说话方式：乐于表达喜悦，语调富有变化。' };
const moods: SpeechMood[] = [
  { context: 'neutral', primary: 'calm' },
  { context: 'positive', primary: 'happy' },
  { context: 'concern', primary: 'concerned' },
];
const config = (): TtsConfig => ({ ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://tts.example', apiKey: 'fixture-key', voice: 'longanlingxin_v3.1', instruction: '句间停顿紧凑。', rate: 0.9 });

test('short composition leads with only the active persona and current feeling without alternative role or emotion examples', () => {
  for (const [card, other] of [[quiet, lively], [lively, quiet]]) {
    const reference = characterSpeechPersona(card);
    const happy = composeSpeechConfig({ ...config(), instruction: '' }, moods[1], reference).instruction;
    assert.ok(happy.startsWith('角色口吻参考：\n' + reference));
    assert.ok(happy.indexOf(reference) < happy.indexOf('本轮语气：'));
    assert.ok(happy.includes(SPEECH_EMOTION_INSTRUCTIONS.happy));
    assert.ok(!happy.includes(other.personality));
    assert.doesNotMatch(happy, /含蓄或外放|内敛的角色|外向的角色|开心或安慰|庆祝|雀跃/);
    assert.ok(happy.length < 200, 'short public fixtures remain direct without the previous shared meta-template');
    const comfort = composeSpeechConfig({ ...config(), instruction: '' }, moods[2], reference).instruction;
    assert.ok(comfort.includes(SPEECH_EMOTION_INSTRUCTIONS.comfort));
    assert.ok(!comfort.includes(SPEECH_EMOTION_INSTRUCTIONS.happy));
  }
});

test('two card personalities cross three feelings reach native HTTP without changing text, voice or rate', async () => {
  const requests: any[] = [], styles = new ReplySpeechStyles();
  const runtime = new SpeechRuntime((owner, context) => ({ ...config(), ...styles.resolveStyle(owner, context!.replyId, 'scope') }),
    () => {}, (settings, text, signal, emit) => synthesizeBailianSpeech(settings, text, signal, emit, { fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(`data: ${JSON.stringify({ output: { audio: { data: 'AAAFAA==', }, finish_reason: 'stop' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } }));
  const text = '今天我们有一件事要一起完成。我会在这里陪着你。';
  for (const [cardIndex, card] of [quiet, lively].entries()) for (const [moodIndex, mood] of moods.entries()) {
    const replyId = `card-${cardIndex}-mood-${moodIndex}`;
    styles.begin(1, replyId, 'scope');
    const style = composeSpeechConfig(config(), mood, characterSpeechPersona(card));
    assert.ok(styles.complete(1, replyId, 'scope', mood, style));
    await runtime.speak(1, `pcm-${replyId}`, text, { replyId });
    const input = requests.at(-1).input;
    assert.equal(input.text, text); assert.equal(input.voice, config().voice); assert.equal(input.rate, 0.9);
    assert.ok(input.instruction.includes(card.personality));
    assert.ok(input.instruction.includes(card.systemPrompt));
    assert.ok(input.instruction.includes(SPEECH_EMOTION_INSTRUCTIONS[selectSpeechEmotion(mood)]));
    assert.ok(input.instruction.includes('心情不覆盖人格'));
    assert.ok(input.instruction.includes(config().instruction));
    assert.doesNotMatch(input.instruction, /以本轮情绪为准/);
    assert.equal(input.emotion, undefined); assert.equal(input.instructions, undefined);
    assert.ok(input.instruction.length <= TURN_SPEECH_INSTRUCTION_LIMIT);
  }
  assert.equal(requests.length, 6);
  assert.equal(new Set(requests.map(value => value.input.instruction)).size, 6);
  for (let i = 0; i < 3; i++) {
    assert.ok(!requests[i].input.instruction.includes(lively.personality));
    assert.ok(!requests[i + 3].input.instruction.includes(quiet.personality));
  }
});

test('completion freezes final instruction for every segment without retaining source card or credentials', () => {
  const card = { ...quiet }, saved = config(), mood = { ...moods[1] };
  const style = composeSpeechConfig(saved, mood, characterSpeechPersona(card)), original = structuredClone(style);
  const styles = new ReplySpeechStyles(); styles.begin(1, 'reply', 'scope');
  assert.throws(() => styles.resolveStyle(1, 'reply', 'scope'));
  assert.ok(styles.complete(1, 'reply', 'scope', mood, style));
  card.personality = lively.personality; mood.context = 'offense'; style.instruction = 'changed after completion'; saved.instruction = 'later static setting';
  for (let segment = 0; segment < 3; segment++) {
    const frozen = styles.resolveStyle(1, 'reply', 'scope');
    assert.deepEqual(frozen, { instruction: original.instruction, emotion: original.emotion });
    assert.deepEqual(Object.keys(frozen).sort(), ['emotion', 'instruction']);
    assert.ok(!JSON.stringify(frozen).includes(config().apiKey!));
    frozen.instruction = 'caller mutation';
  }
  assert.equal(styles.complete(1, 'reply', 'scope', moods[2], config()), false);
  assert.throws(() => styles.resolveStyle(2, 'reply', 'scope'));
  assert.throws(() => styles.resolveStyle(1, 'reply', 'new-card-scope'));
  styles.clear();
  assert.equal(styles.complete(1, 'reply', 'scope', moods[1], original), false);
  assert.throws(() => styles.resolveStyle(1, 'reply', 'scope'));
});

test('legacy systemPrompt and unbound model use the effective active card without inferring personality from appearance', () => {
  const legacy = { personality: '', description: '', systemPrompt: '说话方式：严谨克制，先想清楚再简洁作答。' };
  const saved = { ...config(), styleBindings: [{ characterId: 'other-card', modelPath: '/other.pmx', voice: 'other-voice', instruction: 'other-card-static', emotion: 'custom' as const, rate: 1.8 }] };
  const effective = effectiveTtsConfig(saved, 'active-card', '/gene.pmx');
  const result = composeSpeechConfig(effective, moods[1], characterSpeechPersona(legacy));
  assert.ok(result.instruction.includes(legacy.systemPrompt));
  assert.ok(!result.instruction.includes('other-card-static'));
  assert.equal(result.voice, saved.voice); assert.equal(result.rate, saved.rate);
  assert.deepEqual(saved.styleBindings, [{ characterId: 'other-card', modelPath: '/other.pmx', voice: 'other-voice', instruction: 'other-card-static', emotion: 'custom', rate: 1.8 }]);
});

test('composition remains below the host limit and validation never truncates persona or mood', () => {
  const saved = { ...config(), instruction: '常态。'.repeat(400) }, persona = '性格内敛，喜悦含蓄。'.repeat(60);
  const style = composeSpeechConfig(saved, moods[1], persona);
  assert.ok(style.instruction.length <= TURN_SPEECH_INSTRUCTION_LIMIT);
  assert.ok(style.instruction.includes(SPEECH_EMOTION_INSTRUCTIONS.happy));
  assert.equal(validateTtsConfig(style).instruction, style.instruction);
  const longPreference = composeSpeechConfig({ ...config(), instruction: '自然简洁。' + '保持平稳'.repeat(80) + '，不要大声欢呼。' }, moods[1], characterSpeechPersona(quiet));
  assert.ok(longPreference.instruction.includes('面板常态声音习惯：自然简洁。'));
  assert.ok(!longPreference.instruction.includes('保持平稳'), 'a long preference is omitted after its last complete sentence, without cutting a negation');
  const unsupported = { ...saved, model: 'unverified-model' };
  assert.deepEqual(composeSpeechConfig(unsupported, moods[1], characterSpeechPersona(quiet)), unsupported);
  const styles = new ReplySpeechStyles(); styles.begin(1, 'reply', 'scope');
  assert.throws(() => styles.complete(1, 'reply', 'scope', moods[1], { instruction: 'x'.repeat(1001), emotion: 'custom' }));
  assert.throws(() => styles.resolveStyle(1, 'reply', 'scope'));
});

test('static preview remains separate while late old contexts cannot interrupt current playback', async () => {
  const styles = new ReplySpeechStyles(), requests: TtsConfig[] = [];
  let finish!: () => void, signal!: AbortSignal;
  const runtime = new SpeechRuntime((owner, context) => context ? { ...config(), ...styles.resolveStyle(owner, context.replyId, 'new-scope') } : config(),
    () => {}, async (settings, _text, activeSignal) => { requests.push(settings); signal = activeSignal; await new Promise<void>(resolve => { finish = resolve; }); });
  styles.begin(1, 'new', 'new-scope'); styles.complete(1, 'new', 'new-scope', moods[1], composeSpeechConfig(config(), moods[1], characterSpeechPersona(lively)));
  const playing = runtime.speak(1, 'pcm', '公开测试', { replyId: 'new' });
  await runtime.speak(1, 'stale', '公开测试', { replyId: 'old' });
  assert.equal(signal.aborted, false); assert.equal(requests.length, 1);
  runtime.stop(); finish(); await playing;
  const preview = runtime.speak(1, 'preview', '公开测试');
  assert.equal(requests.at(-1)!.instruction, config().instruction);
  assert.equal(requests.at(-1)!.emotion, config().emotion);
  assert.ok(!requests.at(-1)!.instruction.includes(lively.personality));
  runtime.stop(); finish(); await preview;
});
