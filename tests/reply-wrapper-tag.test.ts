// A reply wrapper on its own (seen in the stable build, 2026-11-11): the model wrote "答<reply>\n…\n</reply>" once, then the next
// replies of the same conversation ended in "\n</reply>". The tags and the "答" label in front of them are never her speech; the
// words between them are. Generic shapes only; no card or chat text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyDraftGuard, loneWrapperAt } from '../electron/brain/reply-draft-guard';

function run(chunks: string[], chinese = true) {
  const guard = new ReplyDraftGuard([], { chinese });
  const pushes = chunks.map(chunk => guard.push(chunk));
  const end = guard.finish();
  return { pushes, text: pushes.join('') + end, guard };
}
const REPLY = '晚上好呀。今天过得怎么样？';

test('the stream as it came: "答" alone, then the opening tag, the reply, and the closing tag on its own line', () => {
  const { text, guard } = run(['答', '<reply>\n晚上', '好', '呀。今天过得怎么样？', '\n</reply>']);
  assert.equal(text.trim(), REPLY);
  assert.ok(!/[<>]/u.test(text));
  assert.deepEqual(guard.dropped.map(drop => drop.kind), ['protocol-talk', 'wrapper-tag', 'wrapper-tag']);
});

test('a closing tag alone at the end (the later replies of that conversation)', () => {
  assert.equal(run(['哼，又来了。', '\n</reply>']).text, '哼，又来了。\n');
  assert.equal(run(['哼，又来了。\n</reply>']).text, '哼，又来了。\n');
  assert.equal(run(['哼，又来了。\n</re', 'ply>']).text, '哼，又来了。\n', 'a closing tag split across chunks is held until it settles');
  assert.equal(run(['哼，又来了。</Reply>']).text, '哼，又来了。', 'any case');
});

test('the same reply whole, in pieces, or char by char comes out the same', () => {
  const raw = '答<reply>\n' + REPLY + '\n</reply>';
  const whole = run([raw]).text;
  assert.equal(whole.trim(), REPLY);
  const pieces = [...raw].reduce<string[]>((out, c) => (out.length && out[out.length - 1] === '<' ? (out[out.length - 1] += c, out) : (out.push(c), out)), []);
  assert.equal(run(pieces).text, whole);
  assert.equal(run(['答：<reply>' + REPLY + '</reply>']).text, REPLY, 'with a colon');
  assert.equal(run(['<response>' + REPLY + '</response>']).text, REPLY, 'the other wrapper names');
  assert.equal(run(['<answer>\n' + REPLY + '\n</answer>']).text.trim(), REPLY);
});

test('ordinary replies are untouched: "答应……", hearts and other tags', () => {
  const agree = run(['答', '应你啦，下次一起看。']);
  assert.equal(agree.text, '答应你啦，下次一起看。');
  assert.equal(agree.guard.dropped.length, 0);
  assert.equal(agree.pushes[0], '', 'only a lone "答" waits for the next piece');
  assert.equal(run(['答应你啦。']).pushes[0], '答应你啦。', 'when it comes with what follows it, it goes out at once');
  assert.equal(run(['答']).text, '答', 'a reply that is only "答" still goes out at the end');
  for (const plain of ['爱你 <3', '<b>好</b>', '这是 <replay> 按钮', '回复我嘛。'])
    assert.equal(run([plain]).text, plain, plain);
  assert.equal(run(['<reply>Hi there.</reply>'], false).text, 'Hi there.', 'an English chat drops them too');
});

test('loneWrapperAt: the tag, a start of it, or nothing', () => {
  assert.equal(loneWrapperAt('</reply>…'), 8);
  assert.equal(loneWrapperAt('<reply>'), 7);
  assert.equal(loneWrapperAt('</re'), 'wait');
  assert.equal(loneWrapperAt('<'), 'wait');
  assert.equal(loneWrapperAt('<replay>'), 'none');
  assert.equal(loneWrapperAt('<reasoning_effort>'), 'none');
});
