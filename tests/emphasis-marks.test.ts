import assert from 'node:assert/strict';
import test from 'node:test';
import { EmphasisStream, stripEmphasis } from '../shared/voice/emphasis-marks';
import { formatReplySegments } from '../shared/voice/reply-segments';
import { speakableText } from '../shared/voice/speakable-text';

function streamed(pieces: readonly string[]): string {
  let out = '';
  const stream = new EmphasisStream(text => { out += text; });
  for (const piece of pieces) stream.push(piece);
  stream.flush();
  return out;
}

test('bold and underscore emphasis lose the markers and keep the words', () => {
  assert.equal(stripEmphasis('今天的月亮好**晶莹**呀'), '今天的月亮好晶莹呀');
  assert.equal(stripEmphasis('__晶莹__的夜'), '晶莹的夜');
  assert.equal(stripEmphasis('**一**和**二**'), '一和二');
});

test('a lone star, math, spaced stars, word-internal marks and single-star actions are kept', () => {
  for (const kept of ['2*3=6', '2**3**4', 'a ** b ** c', 'foo__bar__baz', '好*', '价格 * 数量', '*揉了揉眼睛*', '** 单独', '末尾**'])
    assert.equal(stripEmphasis(kept), kept, kept);
});

test('an unclosed marker or one across a line break stays as written', () => {
  assert.equal(stripEmphasis('**没有结尾'), '**没有结尾');
  assert.equal(stripEmphasis('**第一行\n第二行**'), '**第一行\n第二行**');
});

test('a stream cut anywhere gives the same text as the whole', () => {
  const whole = '你看**晶莹**的露珠，还有__轻轻__的风。2*3 也行。';
  const want = stripEmphasis(whole);
  assert.equal(want, '你看晶莹的露珠，还有轻轻的风。2*3 也行。');
  for (let cut = 1; cut < whole.length; cut++) assert.equal(streamed([whole.slice(0, cut), whole.slice(cut)]), want, `cut ${cut}`);
  assert.equal(streamed([...whole]), want, 'one character at a time');
});

test('a stream holds only a marker that may still close; plain text goes out at once', () => {
  const seen: string[] = [];
  const stream = new EmphasisStream(text => seen.push(text));
  stream.push('你好');
  assert.deepEqual(seen, ['你好']);
  stream.push('**晶');
  assert.deepEqual(seen, ['你好']);
  stream.push('莹**呀');
  assert.equal(seen.join(''), '你好晶莹呀');
  stream.push('**悬着');
  stream.flush();
  assert.equal(seen.join(''), '你好晶莹呀**悬着');
});

test('display of a finished reply and the read-aloud text carry no emphasis marks', () => {
  assert.equal(formatReplySegments('好**晶莹**。'), '好晶莹。');
  assert.equal(speakableText('好**晶莹**。'), '好晶莹。');
  assert.equal(speakableText('*揉了揉眼睛* 好**晶莹**。'), '好晶莹。');
});
