import test from 'node:test';
import assert from 'node:assert/strict';
import { REPLY_BUBBLE_POLICY, paragraphEnds, planReplyPieces, replyPieces, validReplyPieces, MAX_REPLY_PIECES } from '../shared/reply-bubbles';
import { IncrementalReplySegments } from '../shared/incremental-reply-segments';

const slices = (text: string, ends: number[]) => ends.map((end, index) => text.slice(index ? ends[index - 1] : 0, end));

test('the default R27 policy follows the user-confirmed standard: one bubble per complete sentence', () => {
  assert.equal(REPLY_BUBBLE_POLICY, 'bubble-per-sentence');
  assert.equal(replyPieces('第一句。第二句。')!.mode, 'bubbles');
});

test('the same-bubble policy keeps one bubble that advances by natural paragraphs', () => {
  const text = '嗯，我在呢。今天累不累？\n\n要不要跟我说说？';
  const pieces = replyPieces(text, undefined, 'same-bubble')!;
  assert.equal(pieces.mode, 'paragraphs');
  // Two sentences in one paragraph stay together: no line break is invented.
  assert.deepEqual(slices(text, pieces.ends), ['嗯，我在呢。今天累不累？', '\n\n要不要跟我说说？']);
  const plan = planReplyPieces(text, pieces);
  assert.deepEqual(plan.map(piece => [piece.core, piece.gap]), [['嗯，我在呢。今天累不累？', false], ['要不要跟我说说？', true]]);
  assert.equal(plan.map(piece => piece.lead + piece.core + piece.trail).join(''), text);
});

test('the alternative policy gives each complete sentence its own bubble, in order', () => {
  const text = '第一句。第二句。';
  const pieces = replyPieces(text, [4], 'bubble-per-sentence')!;
  assert.equal(pieces.mode, 'bubbles');
  assert.deepEqual(slices(text, pieces.ends), ['第一句。', '第二句。']);
  // Without streaming boundaries the completed text is split the same way.
  assert.deepEqual(replyPieces(text, undefined, 'bubble-per-sentence')!.ends, [4, 8]);
  const paragraphs = '第一句。\n\n第二句。';
  const plan = planReplyPieces(paragraphs, replyPieces(paragraphs, undefined, 'bubble-per-sentence')!);
  assert.deepEqual(plan.map(piece => piece.core), ['第一句。', '第二句。'], 'a bubble never starts with the blank line');
  assert.equal(plan.map(piece => piece.lead + piece.core + piece.trail).join(''), paragraphs);
});

test('streamed growth never retracts a piece end in either policy, and ends stay inside the text', () => {
  const text = '你好呀。\n\n今天天气不错，要出去走走吗？\n```js\nconst a = 1;\n\nconst b = 2;\n```\n好的！Dr. Smith said hi. 3.14 是圆周率。';
  for (const policy of ['same-bubble', 'bubble-per-sentence'] as const) {
    const parser = new IncrementalReplySegments({ maxReplyChars: 100000, maxSegments: 100000 });
    const sentenceEnds: number[] = [];
    let previous: number[] = [];
    for (let length = 1; length <= text.length; length++) {
      const prefix = text.slice(0, length);
      sentenceEnds.push(...parser.push(text[length - 1]).map(part => part.end));
      const pieces = replyPieces(prefix, sentenceEnds, policy);
      if (!pieces) continue;
      assert.ok(validReplyPieces(pieces, prefix), `${policy} @${length}`);
      const inner = pieces.ends.slice(0, -1);
      for (const end of previous) assert.ok(inner.includes(end), `${policy}: end ${end} retracted at ${length}`);
      previous = inner;
    }
    const code = replyPieces(text, sentenceEnds, policy)!;
    const codePiece = slices(text, code.ends).find(piece => piece.includes('const a'))!;
    assert.ok(codePiece.includes('const b = 2;'), `${policy}: a blank line inside fenced code never splits it`);
  }
});

test('paragraph ends need following content and ignore fences', () => {
  assert.deepEqual(paragraphEnds('第一段\n\n'), []);
  assert.deepEqual(paragraphEnds('第一段\n\n第'), [3]);
  assert.deepEqual(paragraphEnds('```\na\n\nb'), []);
  assert.deepEqual(paragraphEnds('说明：\n```\na\n\nb\n```\n结束'), [3, 16]);
});

test('pieces are bounded, keep surrogate pairs whole and reject malformed shapes', () => {
  const many = Array.from({ length: 300 }, (_, index) => `第${index}句。`).join('\n');
  const pieces = replyPieces(many, undefined, 'bubble-per-sentence')!;
  assert.equal(pieces.ends.length, MAX_REPLY_PIECES);
  assert.ok(slices(many, pieces.ends).at(-1)!.endsWith('第299句。'));
  assert.equal(planReplyPieces(many, pieces).map(piece => piece.lead + piece.core + piece.trail).join(''), many);
  const emoji = '😀\n😀';
  assert.ok(replyPieces(emoji)!.ends.every(end => !/[\uD800-\uDBFF]/.test(emoji[end - 1]) || end === emoji.length));
  assert.equal(replyPieces('  \n '), null);
  for (const bad of [null, [], { mode: 'paragraphs' }, { mode: 'html', ends: [2] }, { mode: 'bubbles', ends: [] }, { mode: 'bubbles', ends: [1, 1, 2] },
    { mode: 'bubbles', ends: [3] }, { mode: 'bubbles', ends: [0, 2] }, { mode: 'bubbles', ends: [1.5, 2] }, { mode: 'bubbles', ends: [2], style: 'x' },
    { mode: 'bubbles', ends: Array.from({ length: 129 }, (_, i) => i + 1) }])
    assert.equal(validReplyPieces(bad, 'ab'), false, JSON.stringify(bad));
  assert.equal(validReplyPieces({ mode: 'bubbles', ends: [1, 2] }, 'ab'), true);
});
