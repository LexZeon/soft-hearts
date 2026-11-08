import assert from 'node:assert/strict';
import test from 'node:test';
import { composeSpeechConfig, freezeTurnSpeechStyle, ReplySpeechStyles, SPEECH_EMOTION_INSTRUCTIONS, supportsTurnSpeechEmotion } from '../electron/speech-emotion';
import { characterSpeechPersona } from '../electron/speech-persona';
import { SpeechRuntime } from '../electron/speech-runtime';
import { synthesizeBailianSpeech } from '../electron/tts';
import { DEFAULT_TTS_CONFIG, effectiveTtsConfig, type TtsConfig } from '../shared/tts';

/**
 * R02. A fake
 * Bailian endpoint (injected fetch: no network, no real key, nothing paid)
 * records every request body the real host chain sends: ReplySpeechStyles +
 * SpeechRuntime (with the same getConfig as electron/main.ts) + the real SSE
 * adapter. The reply text carries the reply's OWN mood (its tail appraisal);
 * the voice used to stay on the mood from before the turn for every sentence.
 */
const owner = 7, scope = 'scope';
const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'r', apiKey: 'synthetic-test-key' };
const card = { personality: '温柔、细心，偶尔有点小迷糊。', description: '说话方式：语速偏慢，句尾常带轻轻的笑意。', systemPrompt: '' };

function fakeBailian() {
  const bodies: Array<{ model: string; input: Record<string, unknown> }> = [];
  const sse = `data: ${JSON.stringify({ output: { audio: { data: Buffer.from([0, 0, 5, 0]).toString('base64') }, finish_reason: 'stop' } })}\r\n\r\n`;
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof globalThis.fetch;
  return { bodies, fetch };
}

function host(styles: ReplySpeechStyles, tts: TtsConfig = config) {
  const server = fakeBailian();
  const runtime = new SpeechRuntime(
    // Same resolution as electron/main.ts: the effective config plus this reply's frozen style.
    (sender, context) => {
      const effective = effectiveTtsConfig(tts, 'card', 'model.pmx');
      return context ? { ...effective, ...styles.resolveStyle(sender, context.replyId, scope) } : effective;
    },
    () => {},
    (cfg, text, signal, emit) => synthesizeBailianSpeech(cfg, text, signal, emit, { fetch: server.fetch }),
  );
  return { runtime, bodies: server.bodies };
}

test('R02 Bailian: every reply sentence carries a per-turn mood instruction to the TTS request', async () => {
  const styles = new ReplySpeechStyles(), { runtime, bodies } = host(styles);
  styles.begin(owner, 'r', scope);
  assert.equal(freezeTurnSpeechStyle(styles, { owner, replyId: 'r', scope, config, persona: characterSpeechPersona(card), mood: { primary: 'happy', context: 'positive' } }), true);
  await runtime.speak(owner, 'p0', '好呀。', { replyId: 'r', segmentIndex: 0 });
  assert.equal(bodies.length, 1);
  const instruction = String(bodies[0]!.input.instruction);
  assert.equal(bodies[0]!.model, 'qwen-audio-3.1-tts-flash');
  assert.ok(instruction.includes(`本轮语气：${SPEECH_EMOTION_INSTRUCTIONS.happy}`), 'the mood instruction reaches the request');
  assert.ok(instruction.includes('角色口吻参考：'), 'with the character voice reference');
  assert.ok(!instruction.includes('synthetic-test-key'), 'the key never enters the instruction');
});

test('R02 Bailian: once the reply\'s own mood is known, sentences not yet synthesized speak in it', async () => {
  const styles = new ReplySpeechStyles(), { runtime, bodies } = host(styles);
  const persona = characterSpeechPersona(card);
  styles.begin(owner, 'r', scope);
  // Turn accepted: the companion was calm before this message.
  freezeTurnSpeechStyle(styles, { owner, replyId: 'r', scope, config, persona, mood: { primary: 'calm', context: 'neutral' } });
  await runtime.speak(owner, 'p0', '诶？', { replyId: 'r', segmentIndex: 0 });
  // The reply's tail says it was a happy, positive turn (the text sounds happy).
  const happy = { primary: 'happy', context: 'positive' } as const;
  assert.equal(styles.complete(owner, 'r', scope, happy, composeSpeechConfig(config, happy, persona)), true);
  await runtime.speak(owner, 'p1', '真的吗？太好啦！', { replyId: 'r', segmentIndex: 1 });
  await runtime.speak(owner, 'p2', '我也想去。', { replyId: 'r', segmentIndex: 2 });
  const moods = bodies.map(body => String(body.input.instruction));
  assert.ok(moods[0]!.includes(SPEECH_EMOTION_INSTRUCTIONS.calm), 'the first sentence spoke before the mood was known');
  assert.ok(moods[1]!.includes(SPEECH_EMOTION_INSTRUCTIONS.happy), 'the next sentence follows the reply\'s own mood');
  assert.ok(moods[2]!.includes(SPEECH_EMOTION_INSTRUCTIONS.happy));
  // Accepted once only: a second completion cannot change it again.
  const sad = { primary: 'sad', context: 'disappointment' } as const;
  assert.equal(styles.complete(owner, 'r', scope, sad, composeSpeechConfig(config, sad, persona)), false);
  await runtime.speak(owner, 'p3', '走吧。', { replyId: 'r', segmentIndex: 3 });
  assert.ok(String(bodies[3]!.input.instruction).includes(SPEECH_EMOTION_INSTRUCTIONS.happy));
});

test('R02 Bailian: a completion without a usable style keeps the frozen voice; other replies are untouched', async () => {
  const styles = new ReplySpeechStyles(), { runtime, bodies } = host(styles);
  styles.begin(owner, 'r', scope);
  freezeTurnSpeechStyle(styles, { owner, replyId: 'r', scope, config, persona: '', mood: { primary: 'calm', context: 'neutral' } });
  assert.equal(styles.complete(owner, 'r', scope, { primary: 'happy', context: 'positive' }), true, 'no style offered');
  await runtime.speak(owner, 'p0', '嗯。', { replyId: 'r', segmentIndex: 0 });
  assert.ok(String(bodies[0]!.input.instruction).includes(SPEECH_EMOTION_INSTRUCTIONS.calm));
  // An unbounded style is never adopted; the reply still completes (its readout must not be lost).
  styles.begin(owner, 'q', scope);
  freezeTurnSpeechStyle(styles, { owner, replyId: 'q', scope, config, persona: '', mood: { primary: 'calm', context: 'neutral' } });
  const frozen = styles.resolveStyle(owner, 'q', scope);
  assert.equal(styles.complete(owner, 'q', scope, { primary: 'happy', context: 'positive' }, { instruction: 'x'.repeat(1001), emotion: 'custom' }), true);
  assert.deepEqual(styles.resolveStyle(owner, 'q', scope), frozen);
  assert.equal(styles.complete(owner, 'other', scope, { primary: 'sad', context: 'disappointment' }, { instruction: '低落', emotion: 'custom' }), false);
});

test('R02 Bailian: models without verified per-turn emotion get only the panel instruction (documented limit)', async () => {
  assert.equal(supportsTurnSpeechEmotion('qwen-audio-3.1-tts-flash'), true);
  const other = { ...config, model: 'cosyvoice-v2', emotion: 'gentle' as const };
  const styles = new ReplySpeechStyles(), { runtime, bodies } = host(styles, other);
  styles.begin(owner, 'r', scope);
  freezeTurnSpeechStyle(styles, { owner, replyId: 'r', scope, config: other, persona: characterSpeechPersona(card), mood: { primary: 'happy', context: 'positive' } });
  await runtime.speak(owner, 'p0', '好呀。', { replyId: 'r', segmentIndex: 0 });
  assert.ok(!String(bodies[0]!.input.instruction).includes('本轮语气'), 'no per-turn mood for an unverified model');
});
