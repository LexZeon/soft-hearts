// Local recognizer back end: greedy CTC, special-token removal (electron/asr/decode.ts) and the ONNX metadata reader
// (electron/asr/onnx-metadata.ts) that finds SenseVoice's CMVN and ids without loading the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ctcGreedy, parseTokens, tokensToText } from '../electron/asr/decode';
import { readOnnxMetadata, senseVoiceMeta, type ByteSource } from '../electron/asr/onnx-metadata';
import { onnxWithMetadata, senseVoiceMetadata } from './helpers/onnx-proto';

const TOKENS = ['<unk>', '<s>', '</s>', '<|zh|>', '<|en|>', '<|NEUTRAL|>', '<|Speech|>', '<|withitn|>', '今天', '天气', '真', '好', '。', '▁hello', '▁world', '<|HAPPY|>', '<|BGM|>'];

test('tokens.txt parses in id order and refuses gaps', () => {
  assert.deepEqual(parseTokens('<unk> 0\n▁the 1\r\n今天 2\n'), ['<unk>', '▁the', '今天']);
  assert.throws(() => parseTokens('<unk> 0\n▁the 2\n'));
  assert.throws(() => parseTokens(''));
});

test('greedy CTC: best id per frame, repeats merged, blank (0) dropped, a blank separates a real repeat', () => {
  const vocab = 4;
  const rows = [3, 3, 0, 3, 2, 2, 1, 0, 0, 1];
  const logits = new Float32Array(rows.length * vocab);
  rows.forEach((best, frame) => { for (let v = 0; v < vocab; v++) logits[frame * vocab + v] = v === best ? 5 : -1; });
  assert.deepEqual(ctcGreedy(logits, rows.length, vocab), [3, 3, 2, 1, 1]);
  assert.throws(() => ctcGreedy(new Float32Array(3), 2, 4));
});

test('special tokens (<|zh|>, emotion, event, ITN) are removed; the language tag is reported; word marks become spaces', () => {
  const zh = tokensToText([3, 5, 6, 7, 8, 9, 10, 11, 12], TOKENS);
  assert.deepEqual(zh, { text: '今天天气真好。', language: 'zh' });
  const en = tokensToText([4, 15, 16, 7, 13, 14, 0, 1, 2, 999], TOKENS);
  assert.deepEqual(en, { text: 'hello world', language: 'en' });
  assert.ok(!/<\|/.test(zh.text + en.text));
  assert.deepEqual(tokensToText([3, 5, 6, 7], TOKENS), { text: '', language: 'zh' }, 'only tags: nothing was said');
});

test('ONNX metadata is read from the top-level message, the graph is skipped by its length', () => {
  const bytes = onnxWithMetadata({ a: '1', b: 'two' }, 200_000);
  let largest = 0;
  const source: ByteSource = { size: bytes.length, read: (p, l) => { largest = Math.max(largest, l); return bytes.subarray(p, p + l); } };
  const meta = readOnnxMetadata(source);
  assert.deepEqual([...meta], [['a', '1'], ['b', 'two']]);
  assert.ok(largest < 1000, 'the 200 kB graph is never read');
  assert.throws(() => readOnnxMetadata({ size: 5, read: (p, l) => bytes.subarray(p, p + l) }));
});

test('SenseVoice metadata: CMVN sizes, LFR, ids; a model without them is refused', () => {
  const meta = senseVoiceMeta(readOnnxMetadata(fromBytes(onnxWithMetadata(senseVoiceMetadata()))));
  assert.equal(meta.lfrM, 7); assert.equal(meta.lfrN, 6);
  assert.equal(meta.negMean.length, 560); assert.equal(meta.invStddev.length, 560);
  assert.deepEqual(meta.languages, { auto: 0, zh: 3, en: 4, yue: 7, ja: 11, ko: 12 });
  assert.equal(meta.withItn, 14);
  const broken = senseVoiceMetadata(); delete (broken as Record<string, string>).neg_mean;
  assert.throws(() => senseVoiceMeta(readOnnxMetadata(fromBytes(onnxWithMetadata(broken)))));
  assert.throws(() => senseVoiceMeta(readOnnxMetadata(fromBytes(onnxWithMetadata({ ...senseVoiceMetadata(), model_type: 'paraformer' })))));
});

function fromBytes(bytes: Uint8Array): ByteSource { return { size: bytes.length, read: (p, l) => bytes.subarray(p, p + l) }; }
