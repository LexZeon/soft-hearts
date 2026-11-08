// 2026-11-08 (stable build, the user: "还是把思考链条读出来了"): a numbered plan item went to the bubble and was read aloud,
// "1" + "回复" + a note about the user, then a blank line, then her reply. The first chunk was the digit alone, so the guard
// let the head go at once. Every text below is synthetic (the shape of the leak, not its words); none is a recorded reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyDraftGuard } from '../electron/reply-draft-guard';

function chunkings(text: string): string[][] {
  const pieces = (sizes: (i: number) => number) => { const out: string[] = []; for (let i = 0, n = 0; i < text.length; n++) { const size = Math.max(1, sizes(n)); out.push(text.slice(i, i + size)); i += size; } return out; };
  let seed = 1108;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return [[text], pieces(() => 1), pieces(() => 2), pieces(() => 3), pieces(n => n === 0 ? 1 : 1 + Math.floor(random() * 6)), pieces(() => 1 + Math.floor(random() * 25))];
}

function play(chunks: string[], chinese = true) {
  const guard = new ReplyDraftGuard([], { chinese });
  let shown = '';
  for (const chunk of chunks) shown += guard.push(chunk);
  shown += guard.finish();
  return { shown, dropped: guard.dropped };
}

const REPLY = '早呀……你醒啦？先去洗把脸，然后……别急着看手机，好不好？';
const PLANS = [
  '1回复要短一点，用户刚睡醒；语气软。',
  '1. 回复简短，用户刚起床；温柔些。',
  '1、用户刚醒，回应要轻；别说教。',
  '１）语气放软，用户还没睡醒。',
];

test('a numbered plan item in front of the reply is cut, however the stream is chunked', () => {
  for (const plan of PLANS) for (const chunks of chunkings(`${plan}\n\n${REPLY}`)) {
    const { shown, dropped } = play(chunks);
    assert.equal(shown, REPLY, `${plan} / ${JSON.stringify(chunks.slice(0, 3))}`);
    assert.ok(dropped.some(drop => drop.kind === 'protocol-talk'), plan);
  }
});

test('ordinary replies that start with a digit go out unchanged', () => {
  const replies = [
    '12点啦，该睡了～你明天不是还要早起吗？',
    '1分钟后叫你哦，说好了！',
    '3、2、1——开始！我出石头！',
    '1回合定胜负，输了不许耍赖～',
    '2个小时了诶，起来活动一下吧？',
    '1. 先喝水\n2. 再睡觉\n听我的嘛～',
  ];
  for (const reply of replies) for (const chunks of chunkings(reply)) {
    const { shown, dropped } = play(chunks);
    assert.equal(shown, reply, `${reply} / ${JSON.stringify(chunks.slice(0, 3))}`);
    assert.equal(dropped.length, 0, reply);
  }
});

test('the digit rule is for Chinese chat only: an English chat keeps its own rules', () => {
  const reply = '1 reply from me: good morning!';
  assert.equal(play([reply]).shown.length > 0, true);
  assert.equal(play(['1', ' reply from me: good morning!'], false).shown, reply);
});
