import test from 'node:test';
import assert from 'node:assert/strict';
import { composeSpeechConfig, ReplySpeechStyles } from '../electron/speech-emotion';
import { TtsError } from '../electron/tts';
import { DEFAULT_TTS_CONFIG } from '../shared/tts';
import type { FatiguePhase } from '../shared/fatigue';

const config = () => ({ ...DEFAULT_TTS_CONFIG, instruction: '保持轻缓。', emotion: 'custom' as const });
const mood = () => ({ context: 'neutral' as const, primary: 'calm' as const });
const compose = composeSpeechConfig as typeof composeSpeechConfig & ((...args: any[]) => ReturnType<typeof composeSpeechConfig>);
const phases: FatiguePhase[] = ['light-drowsy', 'drowsy', 'falling-asleep', 'asleep', 'micro-awake'];

test('omitted/undefined/awake fatigue preserves the exact prior composer output and input', () => {
  const input = config(), before = structuredClone(input), persona = '清楚温柔，回答简短。';
  const expected = '角色口吻参考：\n清楚温柔，回答简短。\n面板常态声音习惯：保持轻缓。\n本轮语气：平静自然，语调稳定放松，表达清楚。\n按此角色口吻表达当前感受，心情不覆盖人格；只朗读正文。';
  const legacy = compose(input, mood(), persona);
  assert.equal(legacy.instruction, expected);
  assert.deepEqual(compose(input, mood(), persona, undefined), legacy);
  assert.deepEqual(compose(input, mood(), persona, { phase: 'awake' }), legacy);
  assert.deepEqual(input, before);
});

test('each nonawake fixed phase keeps persona/mood, bounded feeling and total/static budgets', () => {
  const persona = 'P'.repeat(420), snippets = new Set<string>();
  for (const phase of phases) {
    const input = { ...config(), instruction: '保留静态习惯。'.repeat(200) };
    const before = structuredClone(input);
    const result = compose(input, { context: 'support', primary: 'concerned' }, persona, { phase });
    assert.ok(result.instruction.includes(persona), phase);
    assert.ok(result.instruction.includes('本轮语气：关心、支持或安慰，语气柔和，认真共情。'));
    const line = result.instruction.split('\n').find(value => value.startsWith('当前困倦感受：'));
    assert.ok(line, phase); const snippet = line.slice('当前困倦感受：'.length);
    assert.ok(snippet.length > 0 && snippet.length <= 120, phase); snippets.add(snippet);
    assert.ok(result.instruction.length <= 1000, phase);
    const preference = result.instruction.split('\n').find(value => value.startsWith('面板常态声音习惯：'));
    assert.ok(!preference || preference.slice('面板常态声音习惯：'.length).length <= 180);
    assert.deepEqual(input, before); assert.equal(result.voice, input.voice); assert.equal(result.rate, input.rate);
  }
  assert.equal(snippets.size, phases.length, 'the host phases have fixed distinct feeling excerpts');
});

test('fatigue accepts only a closed single phase and exposes no arbitrary instruction input', () => {
  for (const value of [null, [], {}, 'drowsy', { phase: 'unknown' }, { phase: 1 },
    { phase: 'drowsy', instruction: 'arbitrary renderer words' }, { phase: 'asleep', F: 0.8 },
    Object.defineProperty({ phase: 'drowsy' }, 'F', { value: 0.8 }),
    { phase: 'drowsy', [Symbol('extra')]: true },
    Object.create({ phase: 'drowsy' })]) {
    assert.throws(() => compose(config(), mood(), '', value), error => error instanceof TtsError && error.publicMessage === '本轮疲倦语气无效。');
  }
});

test('one actual completed ReplySpeechStyles freezes fatigue with persona/mood for every later segment', () => {
  const input = config(), feeling = { phase: 'drowsy' as FatiguePhase };
  const state = { context: 'support' as const, primary: 'concerned' as const };
  const frozen = compose(input, state, '角色保持自己的温柔和幽默。', feeling);
  assert.ok(frozen.instruction.includes('当前困倦感受：'));
  const styles = new ReplySpeechStyles();
  styles.begin(17, 'completed-reply', 'fixed-scope');
  assert.equal(styles.complete(17, 'completed-reply', 'fixed-scope', state, frozen), true);
  feeling.phase = 'awake'; input.instruction = 'new live preference';
  Object.assign(state, { context: 'positive', primary: 'happy' });
  for (let segment = 0; segment < 3; segment++) assert.deepEqual(styles.resolveStyle(17, 'completed-reply', 'fixed-scope'), { instruction: frozen.instruction, emotion: frozen.emotion });
  assert.notEqual(compose(input, state, 'other live persona', feeling).instruction, frozen.instruction);
  assert.equal(styles.complete(17, 'completed-reply', 'fixed-scope', mood(), config()), false);
  assert.equal(styles.cancel('completed-reply'), true);
  assert.throws(() => styles.resolveStyle(17, 'completed-reply', 'fixed-scope'), /结束|就绪/);
});

test('an unsupported user model remains unchanged rather than selecting a new model or voice', () => {
  const input = { ...config(), model: 'user-selected-other-model', voice: 'user-selected-voice', rate: 0.9 };
  assert.deepEqual(compose(input, mood(), 'persona', { phase: 'asleep' }), input);
  assert.throws(() => compose(input, mood(), '', { phase: 'not-allowed' }), /疲倦/);
});
