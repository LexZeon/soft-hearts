import assert from 'node:assert/strict';
import test from 'node:test';
import { composeSpeechConfig, freezeTurnSpeechStyle, ReplySpeechStyles, SPEECH_EMOTION_INSTRUCTIONS, TURN_SPEECH_INSTRUCTION_LIMIT, type SpeechMood } from '../electron/speech-emotion';
import { characterSpeechPersona, SPEECH_PERSONA_LIMIT } from '../electron/speech-persona';
import { synthesizeBailianSpeech, ttsInstruction } from '../electron/tts';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/tts';

/*
 * R02 goal 5. Codex observed byte-identical PCM for different LONG instruction
 * templates (several personas and moods side by side) and different PCM for a
 * SHORT form. That the long form is ignored is an unproven hypothesis; what
 * these tests pin is the request we send: the short form ("current voice
 * reference + current feeling + brief reading rule"), bounded, frozen for one
 * reply, and two moods give two different request bodies. They say nothing
 * about how it sounds.
 */
const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'r', apiKey: 'k', emotion: 'gentle' };
const happy: SpeechMood = { context: 'positive', primary: 'happy' };
const sad: SpeechMood = { context: 'disappointment', primary: 'sad' };
const longCard = {
  personality: '温柔、细心，偶尔有点小迷糊，对熟悉的人很依赖。'.repeat(40),
  description: '说话方式：语速偏慢，句尾常带轻轻的笑意，不喜欢大声说话。'.repeat(10),
  systemPrompt: '你是一位陪伴型桌宠。'.repeat(200),
};

async function requestBody(instructionConfig: TtsConfig): Promise<{ input: Record<string, unknown> }> {
  let body = '';
  const sse = `data: ${JSON.stringify({ output: { type: 'sentence-synthesis', audio: { data: Buffer.from([0, 0, 5, 0]).toString('base64') }, finish_reason: 'stop' } })}\r\n\r\n`;
  await synthesizeBailianSpeech(instructionConfig, '你好。', new AbortController().signal, () => {}, {
    fetch: (async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch,
  });
  return JSON.parse(body);
}

test('R02 instruction: the short form has one voice reference, one current feeling and one reading rule, within bounds', () => {
  const persona = characterSpeechPersona(longCard);
  assert.ok(persona.length <= SPEECH_PERSONA_LIMIT && SPEECH_PERSONA_LIMIT <= 420, 'persona reference ≤ 420 UTF-16 units');
  for (const mood of [happy, sad]) {
    const { instruction, emotion } = composeSpeechConfig(config, mood, persona, { phase: 'drowsy' });
    assert.equal(emotion, 'custom');
    assert.ok(instruction.length <= TURN_SPEECH_INSTRUCTION_LIMIT && TURN_SPEECH_INSTRUCTION_LIMIT === 1000, 'one input.instruction ≤ 1000');
    assert.equal(instruction.match(/本轮语气：/gu)?.length, 1, 'exactly one current feeling');
    const listed = Object.values(SPEECH_EMOTION_INSTRUCTIONS).filter(text => instruction.includes(text));
    assert.equal(listed.length, 1, 'never several moods side by side');
    assert.equal(instruction.match(/角色口吻参考：/gu)?.length, 1, 'one voice reference');
    assert.ok(!instruction.includes('你是一位陪伴型桌宠'), 'no unlabelled system prompt prose');
    assert.ok(instruction.endsWith('只朗读正文。'), 'brief reading rule last');
  }
});

test('R02 instruction: two moods give two different bounded request bodies that differ only in input.instruction', async () => {
  const persona = characterSpeechPersona(longCard);
  const a = composeSpeechConfig(config, happy, persona), b = composeSpeechConfig(config, sad, persona);
  assert.notEqual(a.instruction, b.instruction);
  const [bodyA, bodyB] = [await requestBody(a), await requestBody(b)];
  assert.equal(bodyA.input.instruction, ttsInstruction(a));
  assert.equal(bodyB.input.instruction, ttsInstruction(b));
  assert.notEqual(bodyA.input.instruction, bodyB.input.instruction);
  const { instruction: _a, ...restA } = bodyA.input, { instruction: _b, ...restB } = bodyB.input;
  assert.deepEqual(restA, restB, 'text, voice, format, rate are identical: only the instruction carries the mood');
  assert.ok(String(bodyA.input.instruction).length <= 1000 && String(bodyB.input.instruction).length <= 1000);
});

test('R02 instruction: the early voice holds until the reply\'s own appraisal, which is adopted once', () => {
  const styles = new ReplySpeechStyles();
  const persona = characterSpeechPersona(longCard);
  styles.begin(1, 'reply', 'scope');
  assert.equal(freezeTurnSpeechStyle(styles, { owner: 1, replyId: 'reply', scope: 'scope', config, persona, mood: happy }), true);
  const first = styles.resolveStyle(1, 'reply', 'scope').instruction;
  // The reply's own appraisal arrives at completion with another mood (R02 2026-11-03: later sentences use it).
  assert.equal(styles.complete(1, 'reply', 'scope', sad, composeSpeechConfig(config, sad, persona)), true);
  const own = styles.resolveStyle(1, 'reply', 'scope').instruction;
  assert.notEqual(own, first); assert.equal(own, composeSpeechConfig(config, sad, persona).instruction);
  assert.equal(styles.complete(1, 'reply', 'scope', happy, composeSpeechConfig(config, happy, persona)), false, 'adopted once only');
  assert.equal(styles.resolveStyle(1, 'reply', 'scope').instruction, own);
  styles.begin(1, 'next', 'scope');
  freezeTurnSpeechStyle(styles, { owner: 1, replyId: 'next', scope: 'scope', config, persona, mood: sad });
  assert.notEqual(styles.resolveStyle(1, 'next', 'scope').instruction, first, 'the next reply follows the new mood');
});
