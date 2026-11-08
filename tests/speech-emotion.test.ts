import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService, type CompanionTurn } from '../electron/companion';
import { composeSpeechConfig, ReplySpeechStyles, selectSpeechEmotion, SPEECH_EMOTION_INSTRUCTIONS, type SpeechMood } from '../electron/speech-emotion';
import { SpeechRuntime } from '../electron/speech-runtime';
import { synthesizeBailianSpeech, ttsInstruction } from '../electron/tts';
import { DEFAULT_TTS_CONFIG, type SpeechWireEvent, type TtsConfig } from '../shared/tts';

const calm: SpeechMood = { context: 'neutral', primary: 'calm', gesture: 'none' };
const happy: SpeechMood = { context: 'positive', primary: 'happy', gesture: 'upbeat' };
const comfort: SpeechMood = { context: 'concern', primary: 'concerned', gesture: 'consider' };
const config = (): TtsConfig => ({ ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://tts.example', apiKey: 'fixture-key', instruction: '固定角色习惯。', rate: 0.9 });

test('turn semantics override lingering happiness without manufacturing an emotion field or changing the user voice', () => {
  assert.equal(selectSpeechEmotion({ ...happy, context: 'concern' }), 'comfort');
  assert.equal(selectSpeechEmotion({ ...happy, context: 'disappointment' }), 'sad');
  assert.equal(selectSpeechEmotion({ ...calm, gesture: 'upbeat' }), 'happy');
  assert.equal(selectSpeechEmotion({ ...calm, gesture: 'explain' }), 'focused');
  assert.throws(() => selectSpeechEmotion({ ...calm, context: 'arbitrary instruction' } as unknown as SpeechMood));
  const original = config(); const before = structuredClone(original);
  for (const mood of [calm, happy, comfort]) {
    const result = composeSpeechConfig(original, mood);
    assert.equal(result.voice, original.voice); assert.equal(result.model, original.model);
    assert.equal(result.apiKey, original.apiKey); assert.equal(result.apiHost, original.apiHost);
    assert.equal(result.rate, original.rate); assert.equal(result.emotion, 'custom');
    assert.ok(result.instruction.includes(original.instruction));
    assert.ok(result.instruction.includes(SPEECH_EMOTION_INSTRUCTIONS[selectSpeechEmotion(mood)]));
  }
  assert.deepEqual(original, before);
  const preset = { ...original, emotion: 'gentle' as const, instruction: 'unused-custom-draft' };
  const combined = composeSpeechConfig(preset, happy);
  assert.ok(combined.instruction.includes(ttsInstruction(preset)));
  assert.equal(ttsInstruction(combined), combined.instruction, 'a saved preset must not replace the transient emotion at dispatch');
  assert.ok(composeSpeechConfig({ ...original, instruction: '长'.repeat(1000) }, happy).instruction.length < 1000);
  const unsupported = { ...original, model: 'unverified-tts-model' };
  assert.deepEqual(composeSpeechConfig(unsupported, happy), unsupported);
});

test('only the original completed turn and owner can resolve a frozen style across segments', () => {
  const styles = new ReplySpeechStyles();
  styles.begin(11, 'reply', 'scope');
  assert.throws(() => styles.resolve(11, 'reply', 'scope'));
  assert.equal(styles.complete(22, 'reply', 'scope', happy), false);
  assert.equal(styles.complete(11, 'reply', 'other-scope', happy), false);
  const source = { ...happy }; assert.equal(styles.complete(11, 'reply', 'scope', source), true);
  source.context = 'offense';
  assert.deepEqual(styles.resolve(11, 'reply', 'scope'), happy);
  assert.equal(styles.complete(11, 'reply', 'scope', comfort), false);
  assert.throws(() => styles.resolve(22, 'reply', 'scope'));
  assert.throws(() => styles.resolve(11, 'reply', 'new-model-scope'));
  const returned = styles.resolve(11, 'reply', 'scope'); returned.context = 'offense';
  assert.deepEqual(styles.resolve(11, 'reply', 'scope'), happy);
});

test('new turns, cancellation, teardown and expiry cannot replay a previous emotion', () => {
  let clock = 0; const styles = new ReplySpeechStyles(() => clock);
  styles.begin(11, 'old', 'scope'); styles.complete(11, 'old', 'scope', happy);
  styles.begin(11, 'new', 'scope');
  assert.equal(styles.complete(11, 'old', 'scope', comfort), false);
  assert.equal(styles.cancel('old'), false);
  styles.complete(11, 'new', 'scope', comfort); styles.dropOwner(22);
  assert.deepEqual(styles.resolve(11, 'new', 'scope'), comfort);
  styles.dropOwner(11); assert.throws(() => styles.resolve(11, 'new', 'scope'));
  styles.begin(11, 'expiry', 'scope'); styles.complete(11, 'expiry', 'scope', calm);
  clock = 15 * 60_000; assert.throws(() => styles.resolve(11, 'expiry', 'scope'));
  styles.begin(11, 'cancel', 'scope'); assert.equal(styles.cancel('cancel'), true);
  assert.equal(styles.complete(11, 'cancel', 'scope', happy), false);
});

test('untrusted or stale reply contexts cannot interrupt a current transport', async () => {
  const styles = new ReplySpeechStyles(); styles.begin(11, 'valid', 'scope'); styles.complete(11, 'valid', 'scope', happy);
  let signal!: AbortSignal, end!: () => void; const events: SpeechWireEvent[] = [];
  const runtime = new SpeechRuntime((owner, context) => context ? composeSpeechConfig(config(), styles.resolve(owner, context.replyId, 'scope')) : config(),
    (_owner, event) => events.push(event), async (_config, _text, currentSignal) => { signal = currentSignal; await new Promise<void>(resolve => { end = resolve; }); });
  const active = runtime.speak(11, 'active', '正文', { replyId: 'valid' });
  await runtime.speak(22, 'wrong-owner', '正文', { replyId: 'valid' });
  assert.equal(signal.aborted, false);
  assert.ok(events.some(event => event.type === 'error' && event.id === 'wrong-owner'));
  for (const context of [null, {}, [], { replyId: '../bad' }, { replyId: 'valid', instruction: 'injected' }])
    await assert.rejects(runtime.speak(11, 'invalid-context', '正文', context as never), /回合/);
  assert.equal(signal.aborted, false);
  runtime.stop(); end(); await active;
});

function protocol(turn: CompanionTurn, context: SpeechMood['context'], body: string) {
  const start = turn.persona.match(/<sh-state-[a-f0-9]+>/)![0];
  return `${body}\n${start}${JSON.stringify({ context, delta: {}, reason: '合成语音专项', confidence: 0.9, gesture: 'none' })}${start.replace('<', '</')}`;
}
async function serviceTest(run: (service: CompanionService) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-speech-test-'));
  const service = new CompanionService(directory, () => {});
  try {
    await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://chat.example/v1', model: 'fixture' }, 'Gene');
    await run(service);
  } finally {
    await service.flush().catch(() => {});
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('soft-hearts-speech-test-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('only successfully completed current chat summaries authorize voice, without archiving protocol or replaying rewards', async () => {
  await serviceTest(async service => {
    const turn = await service.begin('complete', '公开测试', 'Gene', () => {});
    assert.equal(turn.speechMood(), null);
    turn.push('delta', protocol(turn, 'concern', '公开回复。')); await turn.finish('complete');
    assert.equal(turn.speechMood()?.context, 'concern');
    const before = structuredClone(service.mood.get().snapshot.values);
    turn.speechMood(); turn.speechMood(); assert.deepEqual(service.mood.get().snapshot.values, before);
    const scope = service.currentSpeechScope(); await service.newConversation();
    assert.notEqual(service.currentSpeechScope(), scope); assert.equal(turn.speechMood(), null);
    for (const status of ['stopped', 'error'] as const) {
      const stopped = await service.begin(status, '公开测试', 'Gene', () => {});
      stopped.push('delta', protocol(stopped, 'positive', '不朗读。')); await stopped.finish(status);
      assert.equal(stopped.speechMood(), null);
    }
    const failed = await service.begin('failed-delivery', '公开测试', 'Gene', () => { throw new Error('fixture destroyed window'); });
    failed.push('delta', protocol(failed, 'positive', '未交付。'));
    await assert.rejects(failed.finish('complete'), /界面/); assert.equal(failed.speechMood(), null);
  });
});

test('validated chat semantics reach the actual HTTP instruction with identical text, voice and rate for three emotions', async () => {
  await serviceTest(async service => {
    const styles = new ReplySpeechStyles(); const payloads: Record<string, any>[] = [];
    const body = '今天我们有一件事要一起完成。我会在这里陪着你。';
    const runtime = new SpeechRuntime((owner, context) => composeSpeechConfig(config(), styles.resolve(owner, context!.replyId, service.currentSpeechScope())),
      () => {}, (settings, text, signal, emit) => synthesizeBailianSpeech(settings, text, signal, emit, { fetch: async (_url, init) => {
        payloads.push(JSON.parse(String(init?.body)));
        const data = `data: ${JSON.stringify({ output: { audio: { data: 'AAAFAA==' }, finish_reason: 'stop' } })}\n\n`;
        return new Response(data, { headers: { 'content-type': 'text/event-stream' } });
      } }));
    for (const [index, context] of (['neutral', 'positive', 'concern'] as const).entries()) {
      const id = `reply-${index}`, turn = await service.begin(id, '公开测试', 'Gene', () => {}), scope = service.currentSpeechScope();
      styles.begin(11, id, scope); turn.push('delta', protocol(turn, context, body)); await turn.finish('complete');
      assert.ok(styles.complete(11, id, scope, turn.speechMood()!));
      await runtime.speak(11, `pcm-${index}`, body, { replyId: id });
    }
    assert.equal(payloads.length, 3); assert.equal(new Set(payloads.map(value => value.input.instruction)).size, 3);
    for (const payload of payloads) {
      assert.equal(payload.input.text, body); assert.equal(payload.model, config().model);
      assert.equal(payload.input.voice, config().voice); assert.equal(payload.input.rate, 0.9);
      assert.equal(payload.input.emotion, undefined); assert.equal(payload.input.optimize_instructions, undefined);
      assert.doesNotMatch(payload.input.text, /sh-state|合成语音专项/);
    }
    assert.ok(payloads[0].input.instruction.includes(SPEECH_EMOTION_INSTRUCTIONS.calm));
    assert.ok(payloads[1].input.instruction.includes(SPEECH_EMOTION_INSTRUCTIONS.happy));
    assert.ok(payloads[2].input.instruction.includes(SPEECH_EMOTION_INSTRUCTIONS.comfort));
  });
});
