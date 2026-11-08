import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCharacterSpeechPreview } from '../electron/speech-preview';
import { ReplySpeechStyles, SPEECH_EMOTION_INSTRUCTIONS, type SpeechMood } from '../electron/speech-emotion';
import { SpeechRuntime } from '../electron/speech-runtime';
import { DEFAULT_TTS_CONFIG, type SpeechWireEvent, type TtsConfig } from '../shared/tts';

const config = (): TtsConfig => ({ ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://fixture.example', apiKey: 'PRIVATE_FIXTURE_KEY', rate: 0.9 });
const card = () => ({ personality: '', description: '', systemPrompt: '说话方式：温柔含蓄。开心时不会高声欢呼。' });
const mood = (): SpeechMood => ({ context: 'positive', primary: 'happy', gesture: 'upbeat' });

test('explicit host preview freezes the actual legacy card and current feeling across segments without retaining the key', async () => {
  const styles = new ReplySpeechStyles(), currentCard = card(), currentMood = mood(), currentConfig = config(), requests: TtsConfig[] = [];
  let stops = 0;
  const context = prepareCharacterSpeechPreview({ owner: 11, scope: 'card-model-provider-conversation', config: currentConfig, card: currentCard, mood: currentMood, styles,
    stop: () => { stops++; }, createId: () => 'host-preview' });
  assert.deepEqual(context, { replyId: 'preview-host-preview' }); assert.equal(stops, 1);
  const frozen = styles.resolveStyle(11, context.replyId, 'card-model-provider-conversation');
  assert.ok(frozen.instruction.includes('温柔含蓄。 开心时不会高声欢呼。'));
  assert.ok(frozen.instruction.includes(SPEECH_EMOTION_INSTRUCTIONS.happy));
  assert.deepEqual(Object.keys(frozen).sort(), ['emotion', 'instruction']); assert.ok(!JSON.stringify(frozen).includes(currentConfig.apiKey!));
  currentCard.systemPrompt = '说话方式：另一角色。'; currentMood.context = 'offense'; currentConfig.instruction = '后来修改的静态风格。';
  const runtime = new SpeechRuntime((owner, requestContext) => ({ ...currentConfig, ...styles.resolveStyle(owner, requestContext!.replyId, 'card-model-provider-conversation') }), () => {}, async settings => { requests.push(settings); });
  for (let segment = 0; segment < 3; segment++) await runtime.speak(11, `segment-${segment}`, '公开试听正文。', context);
  assert.equal(requests.length, 3); assert.ok(requests.every(item => item.instruction === frozen.instruction));
  assert.ok(requests.every(item => item.voice === config().voice && item.rate === 0.9)); runtime.stop();
});

test('preparing a preview stops the previous recipient before minting its authority and ignores the previous late cancellation', async () => {
  const styles = new ReplySpeechStyles(), events: SpeechWireEvent[] = [];
  let previewMintedDuringStop = false;
  const runtime = new SpeechRuntime((owner, context) => context ? { ...config(), ...styles.resolveStyle(owner, context.replyId, 'scope') } : config(), (_owner, event) => {
    events.push(event);
    if (event.type === 'error' && event.cancelled && event.id === 'old-pcm') {
      try { styles.resolveStyle(11, 'preview-new', 'scope'); previewMintedDuringStop = true; } catch { /* It must not yet exist. */ }
      if (runtime.cancel(11, 'old-pcm')) styles.dropOwner(11);
    }
  }, async (_settings, _text, _signal, emit) => { await emit({ type: 'done', firstAudioMs: 1, audioBytes: 4 }); });
  await runtime.speak(11, 'old-pcm', '之前的公开语音。');
  const context = prepareCharacterSpeechPreview({ owner: 11, scope: 'scope', config: config(), card: card(), mood: mood(), styles, stop: () => runtime.stop(), createId: () => 'new' });
  assert.equal(previewMintedDuringStop, false);
  assert.equal(events.filter(item => item.id === 'old-pcm' && item.type === 'error' && item.cancelled).length, 1);
  assert.equal(runtime.cancel(11, 'old-pcm'), false); assert.ok(styles.resolveStyle(11, context.replyId, 'scope'));
  await runtime.speak(11, 'new-pcm', '新的公开语音。', context);
  if (runtime.cancel(11, 'old-pcm')) styles.dropOwner(11);
  assert.ok(styles.resolveStyle(11, context.replyId, 'scope')); runtime.stop();
});

test('wrong owner and stale preview context cannot replace active speech; clear or scope change revokes reuse', async () => {
  const styles = new ReplySpeechStyles(), events: SpeechWireEvent[] = [];
  const context = prepareCharacterSpeechPreview({ owner: 11, scope: 'scope', config: config(), card: card(), mood: mood(), styles, stop() {}, createId: () => 'current' });
  let end!: () => void, signal!: AbortSignal, calls = 0;
  const runtime = new SpeechRuntime((owner, requestContext) => ({ ...config(), ...styles.resolveStyle(owner, requestContext!.replyId, 'scope') }), (_owner, event) => events.push(event),
    async (_settings, _text, activeSignal) => { calls++; signal = activeSignal; await new Promise<void>(resolve => { end = resolve; }); });
  const active = runtime.speak(11, 'active', '公开测试。', context);
  await runtime.speak(22, 'wrong-owner', '公开测试。', context);
  await runtime.speak(11, 'old-context', '公开测试。', { replyId: 'preview-old' });
  assert.equal(calls, 1); assert.equal(signal.aborted, false);
  assert.ok(events.some(event => event.id === 'wrong-owner' && event.type === 'error'));
  assert.throws(() => styles.resolveStyle(11, context.replyId, 'new-model-scope'));
  styles.clear(); assert.throws(() => styles.resolveStyle(11, context.replyId, 'scope'));
  runtime.stop(); end(); await active;
});
