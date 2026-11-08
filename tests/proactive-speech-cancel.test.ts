import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechRuntime, type SpeechSynthesizer } from '../electron/speech-runtime';
import { DEFAULT_TTS_CONFIG, type SpeechRequestContext, type SpeechWireEvent, type TtsConfig, type TtsStreamEvent } from '../shared/tts';

const audio: TtsStreamEvent = { type: 'audio', data: 'AAAFAA==', format: 'pcm_s16le', sampleRate: 24000, channels: 1 };
const done: TtsStreamEvent = { type: 'done', firstAudioMs: 10, audioBytes: 4 };
interface Call { signal: AbortSignal; emit(event: TtsStreamEvent): void | Promise<void>; resolve(): void; reject(error: unknown): void }

function fixture(resolveConfig?: (owner: number, context?: SpeechRequestContext) => TtsConfig) {
  const calls: Call[] = [], events: { owner: number; event: SpeechWireEvent }[] = [];
  const synthesize: SpeechSynthesizer = (_config, _text, signal, emit) => new Promise<void>((resolve, reject) => {
    calls.push({ signal, emit, resolve, reject });
  });
  const runtime = new SpeechRuntime(resolveConfig ?? (() => structuredClone(DEFAULT_TTS_CONFIG)),
    (owner, event) => events.push({ owner, event }), synthesize);
  return { runtime, calls, events };
}

test('host reply cancellation stops the actual pending transport rather than mistaking replyId for requestId', async () => {
  const h = fixture();
  const task = h.runtime.speak(11, 'transport-random-id', '主动观察。', { replyId: 'initiative-id' });
  assert.equal(h.runtime.cancel(11, 'initiative-id'), false, 'legacy cancel still addresses only a transport request');
  assert.equal(h.runtime.cancelReply(22, 'initiative-id'), false);
  assert.equal(h.runtime.cancelReply(11, 'transport-random-id'), false);
  assert.equal(h.calls[0].signal.aborted, false);
  assert.equal(h.runtime.cancelReply(11, 'initiative-id'), true);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.deepEqual(h.events, [{ owner: 11, event: { id: 'transport-random-id', type: 'error', cancelled: true, message: '语音已停止。' } }]);
  assert.equal(h.runtime.cancelReply(11, 'initiative-id'), false);
  await h.calls[0].emit(audio); await h.calls[0].emit(done);
  assert.equal(h.events.length, 1);
  h.calls[0].resolve(); await task;
});

test('reply identity remains cancellable after network completion while the renderer drains final PCM', async () => {
  const h = fixture();
  assert.equal(h.runtime.busy, false);
  const task = h.runtime.speak(11, 'last-segment-transport', '最后一段。', { replyId: 'initiative-id' });
  assert.equal(h.runtime.busy, true);
  await h.calls[0].emit(audio); await h.calls[0].emit(done);
  h.calls[0].resolve(); await task;
  assert.equal(h.runtime.busy, true, 'network completion must not pretend final PCM has drained');
  assert.equal(h.calls[0].signal.aborted, false);
  assert.equal(h.runtime.cancelReply(22, 'initiative-id'), false);
  assert.equal(h.runtime.cancelReply(11, 'initiative-id'), true);
  assert.equal(h.runtime.busy, false);
  assert.equal(h.calls[0].signal.aborted, false, 'finished transports retain only recipient identity');
  assert.deepEqual(h.events.at(-1), { owner: 11, event: { id: 'last-segment-transport', type: 'error', cancelled: true, message: '语音已停止。' } });
  assert.equal(h.runtime.cancelReply(11, 'initiative-id'), false);
});

test('same-reply segmentation cancels its current transport while old request IDs cannot affect the next segment', async () => {
  const h = fixture();
  const first = h.runtime.speak(11, 'segment-one', '第一段。', { replyId: 'initiative-id' });
  await h.calls[0].emit(done); h.calls[0].resolve(); await first;
  const second = h.runtime.speak(11, 'segment-two', '第二段。', { replyId: 'initiative-id' });
  assert.equal(h.runtime.cancel(11, 'segment-one'), false);
  assert.equal(h.calls[1].signal.aborted, false);
  assert.equal(h.runtime.cancelReply(11, 'initiative-id'), true);
  assert.equal(h.calls[1].signal.aborted, true);
  assert.equal(h.events.at(-1)?.event.id, 'segment-two');
  h.calls[1].resolve(); await second;
});

test('a later reply or owner cannot be cancelled by the preceding initiative identity', async () => {
  const h = fixture();
  const first = h.runtime.speak(11, 'old-transport', '旧主动话题。', { replyId: 'old-initiative' });
  const next = h.runtime.speak(11, 'new-transport', '新回复。', { replyId: 'new-reply' });
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.runtime.cancelReply(11, 'old-initiative'), false);
  assert.equal(h.runtime.cancelReply(22, 'new-reply'), false);
  await h.calls[0].emit(audio); h.calls[0].reject(new Error('late private error')); await first;
  assert.equal(h.calls[1].signal.aborted, false);
  assert.equal(h.runtime.cancelReply(11, 'new-reply'), true);
  h.calls[1].resolve(); await next;
});

test('no-context preview has no inherited reply identity and keeps legacy request cancellation', async () => {
  const h = fixture();
  const first = h.runtime.speak(11, 'old-transport', '旧回复。', { replyId: 'old-reply' });
  const preview = h.runtime.speak(11, 'preview-transport', '独立试听。');
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.runtime.cancelReply(11, 'old-reply'), false);
  assert.equal(h.runtime.cancelReply(11, 'preview-transport'), false);
  assert.equal(h.runtime.cancelReply(11, undefined as unknown as string), false);
  assert.equal(h.calls[1].signal.aborted, false);
  assert.equal(h.runtime.cancel(11, 'preview-transport'), true);
  h.calls[0].resolve(); h.calls[1].resolve(); await Promise.all([first, preview]);
});

test('invalid or rejected reply context cannot acquire the recipient or interrupt valid speech', async () => {
  const inherited = Object.assign(Object.create({ replyId: 'inherited-reply' }), { extra: 'unexpected' });
  const h = fixture((_owner, context) => {
    if (context?.replyId === 'rejected-reply') throw new Error('private context failure');
    return structuredClone(DEFAULT_TTS_CONFIG);
  });
  const active = h.runtime.speak(11, 'valid-transport', '有效回复。', { replyId: 'valid-reply' });
  for (const context of [null, [], {}, { replyId: '' }, { replyId: 'bad id' }, { replyId: 'x'.repeat(101) },
    { replyId: 'new', instruction: 'renderer instructions' }, inherited]) {
    await assert.rejects(h.runtime.speak(22, 'invalid-context', '无效。', context as SpeechRequestContext), /所属回合/);
  }
  await h.runtime.speak(22, 'failed-config', '拒绝上下文。', { replyId: 'rejected-reply' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, false);
  assert.equal(h.runtime.cancelReply(22, 'rejected-reply'), false);
  assert.deepEqual(h.events, [{ owner: 22, event: { id: 'failed-config', type: 'error', message: '语音合成失败，请稍后重试。' } }]);
  assert.equal(h.runtime.cancelReply(11, 'valid-reply'), true);
  h.calls[0].resolve(); await active;
});

test('validated reply identity is frozen before a resolver or caller can mutate the supplied context', async () => {
  const context = { replyId: 'frozen-initiative' };
  const seen: unknown[] = [];
  const h = fixture((_owner, accepted) => {
    seen.push(structuredClone(accepted));
    context.replyId = 'mutated-by-resolver';
    if (accepted) accepted.replyId = 'mutated-canonical-copy';
    return structuredClone(DEFAULT_TTS_CONFIG);
  });
  const task = h.runtime.speak(11, 'frozen-transport', '冻结身份。', context);
  context.replyId = 'mutated-by-caller';
  assert.deepEqual(seen, [{ replyId: 'frozen-initiative' }]);
  assert.equal(h.runtime.cancelReply(11, 'mutated-by-resolver'), false);
  assert.equal(h.runtime.cancelReply(11, 'mutated-canonical-copy'), false);
  assert.equal(h.runtime.cancelReply(11, 'mutated-by-caller'), false);
  assert.equal(h.runtime.cancelReply(11, 'frozen-initiative'), true);
  h.calls[0].resolve(); await task;
});

test('legacy request cancellation, owner teardown and stop clear the optional reply identity', async () => {
  for (const operation of ['cancel', 'dropOwner', 'stop'] as const) {
    const h = fixture();
    const task = h.runtime.speak(11, 'legacy-transport', '原契约。', { replyId: 'initiative-id' });
    if (operation === 'cancel') assert.equal(h.runtime.cancel(11, 'legacy-transport'), true);
    else if (operation === 'dropOwner') h.runtime.dropOwner(11);
    else h.runtime.stop();
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.runtime.cancelReply(11, 'initiative-id'), false);
    assert.equal(h.events.length, 1);
    h.calls[0].resolve(); await task;
  }
});
