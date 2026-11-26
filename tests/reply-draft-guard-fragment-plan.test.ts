// A Chinese fragment, an ellipsis, then English notes in front of the reply (docs/claude/2026-11-10-draft-leak-fragment-plan.md).
// All text is made up; the shape is the one seen, nothing here is from a real chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyDraftGuard, isChineseChatNote } from '../electron/brain/reply-draft-guard';

function run(chunks: string[], chinese = true, englishAsked = false) {
  const guard = new ReplyDraftGuard([], { chinese, englishAsked });
  const pushes = chunks.map(chunk => guard.push(chunk));
  const end = guard.finish();
  return { pushes, text: pushes.join('') + end, guard };
}
const chars = (text: string) => [...text];

const FRAG = '页面里有个蓝色按钮';
const NOTE = 'etc. The screen shows a settings page with a blue button. The user is teasing about the button color. Respond playfully. 1-3 sentences.';
const REPLY = '嘿嘿，那个蓝色确实有点亮。';

test('SELF_TALK: numeric ranges and screen descriptions count, ordinary English does not', () => {
  assert.equal(isChineseChatNote('The screen shows a settings page. Keep going, 1-3 sentences.', false), true);
  assert.equal(isChineseChatNote('Respond playfully, 2–3 lines.', false), true);
  assert.equal(isChineseChatNote('Some text on screen. Respond kindly.', false), true);
  for (const line of ['Good night!', 'OK, 1-3 apples please.', 'The screen shows nothing.', 'Rock, paper, scissors!', 'No way!'])
    assert.equal(isChineseChatNote(line, false), false, line);
});

test('fragment + ellipsis + English note: all of it goes, whole or chunked after the ellipsis', () => {
  for (const sep of ['', ' ']) for (const dots of ['…', '...']) for (const gap of ['', '\n', '\n\n']) {
    const raw = FRAG + dots + sep + NOTE + gap + REPLY;
    const kinds = ['mixed-note'];
    const whole = run([raw]);
    assert.equal(whole.text, REPLY, JSON.stringify(raw));
    assert.deepEqual(whole.guard.dropped.map(d => d.kind), kinds);
    // the fragment and its ellipsis in one chunk, then the rest piece by piece
    const split = run([FRAG + dots, ...chars(sep + NOTE + gap + REPLY)]);
    assert.equal(split.text, REPLY, 'split ' + JSON.stringify(raw));
    // the first chunk ends inside the fragment's ellipsis run
    const mid = run([FRAG + dots.slice(0, 1), dots.slice(1) + sep + NOTE.slice(0, 20), NOTE.slice(20) + gap + REPLY]);
    assert.equal(mid.text, REPLY, 'mid ' + JSON.stringify(raw));
  }
});

test('char by char: the English note is still cut (the fragment already shown cannot be taken back)', () => {
  for (const dots of ['…', '...']) {
    const raw = FRAG + dots + ' ' + NOTE + '\n' + REPLY;
    for (const chunks of [chars(raw), [raw.slice(0, 2), ...chars(raw.slice(2))]]) {
      const { text, guard } = run(chunks);
      assert.equal(text, FRAG + REPLY, JSON.stringify(dots));
      assert.deepEqual(guard.dropped.map(d => d.kind), ['mixed-note']);
      assert.equal(guard.onlyLabelShown(), false);
    }
  }
});

test('the same English without the fragment is still cut', () => {
  for (const raw of [NOTE + '\n' + REPLY, NOTE + REPLY, 'The screen shows a settings page. The user is teasing. Respond playfully.' + REPLY]) {
    for (const chunks of [[raw], chars(raw)]) {
      const { text } = run(chunks);
      assert.equal(text, REPLY, raw);
    }
  }
});

test('ordinary replies with an ellipsis and a few English words are untouched', () => {
  for (const raw of ['好呀…OK 啦～', '嗯…Good night!', '今天天气真好…OK 啦～我们出去玩吧', '今天天气真好...Good night 啦', '今天天气真好…Let me guess 你是不是饿了', '今天天气真好…Okay, 好吧～']) {
    for (const chunks of [[raw], chars(raw), [raw.slice(0, 7), ...chars(raw.slice(7))]]) {
      const { text, guard } = run(chunks);
      assert.equal(text, raw, raw);
      assert.equal(guard.dropped.length, 0, raw);
    }
  }
});

test('an English chat and a turn that asked for English are not changed', () => {
  const raw = FRAG + '… ' + NOTE + '\n' + REPLY;
  for (const chunks of [[raw], chars(raw)]) assert.equal(run(chunks, false).text, raw);
  const story = FRAG + '… She should reply to the letter at last, and then the rain stopped.' + REPLY;
  for (const chunks of [[story], chars(story)]) {
    const { text, guard } = run(chunks, true, true);
    assert.equal(text, story);
    assert.equal(guard.dropped.length, 0);
  }
});

test('first character: a pure Chinese start is released in the same push', () => {
  for (const first of ['今天过得怎么样？', '今天过得怎么样', '好呀…', '今', '今天天气真好，']) {
    const { pushes } = run([first, '继续说']);
    assert.equal(pushes[0], first, first);
  }
  // a start that has only a fragment and an ellipsis so far waits for what follows, then goes out whole when it is ordinary
  const { pushes, text } = run([FRAG + '…', '嗯，' + REPLY]);
  assert.equal(pushes[0], '');
  assert.equal(text, FRAG + '…嗯，' + REPLY);
});
