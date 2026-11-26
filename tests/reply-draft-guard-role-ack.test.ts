// Role acknowledgement shape (docs/claude/2026-11-10-role-ack-guard.md): the model answers the character's instructions in front of
// the real reply ("明白了，我会以X的身份陪着你。"). Generic shape only; no card or chat text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyDraftGuard, draftFilterLine } from '../electron/brain/reply-draft-guard';
import { draftFilterInput } from '../electron/memory/journal/extras';

function run(chunks: string[], chinese = true) {
  const guard = new ReplyDraftGuard([], { chinese });
  const pushes = chunks.map(chunk => guard.push(chunk));
  const end = guard.finish();
  return { pushes, text: pushes.join('') + end, guard };
}
const chars = (text: string) => [...text];
// Char by char, but a "<" travels with the character after it: behind the head, a lone "<" is released at once (the reply
// protocol's own private marker begins with it), so a mid-reply tag whose "<" is a chunk of its own is not caught.
const charsKeepLt = (text: string) => [...text.replace(/<(.)/gu, '<$1')].reduce<string[]>((out, c) => (out.length && out[out.length - 1] === '<' ? (out[out.length - 1] += c, out) : (out.push(c), out)), []);

const ACK = '明白了，我会以小玲的身份陪着你。';
const REAL = '今天过得怎么样？我在这儿呢～';

test('role acknowledgement in front of the reply is dropped, the reply passes', () => {
  for (const raw of [ACK + REAL, ACK + '\n' + REAL, ACK + ' \n\n' + REAL, '  收到，我来扮演小玲！' + REAL, '好的，我会按人设来。' + REAL, '了解，我是这个角色设定里的她。' + REAL, '明白，作为陪伴你的角色，我会温柔一点。' + REAL]) {
    const { text, guard } = run([raw]);
    assert.equal(text, REAL, raw);
    assert.deepEqual(guard.dropped.map(drop => drop.kind), ['role-ack']);
  }
});

test('the four openers without a role word pass unchanged, released when the sentence completes', () => {
  for (const sentence of ['好的，我陪你。', '明白了，那我们慢慢说。', '收到！', '了解～我这就来。', '明白了']) {
    const reply = sentence + REAL;
    const { pushes, text, guard } = run([sentence.slice(0, -1), sentence.slice(-1), REAL]);
    assert.equal(text, reply);
    assert.equal(guard.dropped.length, 0);
    if (/[。！～]$/u.test(sentence)) assert.equal(pushes.slice(0, 2).join(''), sentence, 'released when its sentence completes: ' + sentence);
  }
});

test('bare 设定 in ordinary speech is not a role word (main session review)', () => {
  for (const sentence of ['好的，我设定个闹钟。', '收到，设定好了提醒就叫你。']) {
    const { text, guard } = run([sentence + REAL]);
    assert.equal(text, sentence + REAL, sentence);
    assert.equal(guard.dropped.length, 0, sentence);
  }
});

test('好 and 好呀 starts are released in the same push (first character unaffected)', () => {
  for (const first of ['好', '好呀', '好呀，来！', '哈', '嗯嗯', '明', '收', '了']) {
    const { pushes } = run([first, '继续说']);
    assert.equal(pushes[0], first, first);
  }
});

test('an English chat is untouched', () => {
  const raw = '明白了，我会以小玲的身份陪着你。ok then.';
  const { pushes, text, guard } = run([raw], false);
  assert.equal(pushes[0], raw);
  assert.equal(text, raw);
  assert.equal(guard.dropped.length, 0);
});

test('streamed (opener in the first chunk, then char by char) gives the same result as whole', () => {
  for (const raw of [ACK + REAL, ACK + '\n' + REAL, '收到，我会按人设来。' + REAL, '收到！' + REAL, '好的，我陪你。' + REAL, '明天见～' + REAL]) {
    const whole = run([raw]);
    const streamed = run([raw.slice(0, 2), ...chars(raw.slice(2))]);
    assert.equal(streamed.text, whole.text, raw);
    assert.deepEqual(streamed.guard.dropped, whole.guard.dropped, raw);
  }
});

test('a reply that is only the acknowledgement leaves an empty result (the whole-reply path)', () => {
  for (const chunks of [[ACK], [ACK.slice(0, 2), ...chars(ACK.slice(2))]]) {
    const { text, guard } = run(chunks);
    assert.equal(text, '');
    assert.equal(guard.dropped.length, 1);
    assert.equal(guard.dropped[0].kind, 'role-ack');
    assert.equal(guard.dropped[0].chars, ACK.length);
  }
  // Same result when the sentence has no closing mark and the stream just ends.
  assert.equal(run(['明白了，我会以小玲的身份陪着你']).text, '');
  // Reported like other drops: journal line counts it, and a whole-reply flag is possible.
  const { guard } = run([ACK]);
  assert.match(draftFilterLine(guard.dropped, true, 1), /"role-ack":1/u);
  const input = draftFilterInput('c', guard.dropped, true);
  assert.equal(input?.type, 'draft-filter');
  assert.equal((input as { plan: number }).plan, 1);
});

test('only the first sentence is looked at, and only once', () => {
  // A role word in the second sentence does not make the first one an acknowledgement.
  const raw = '好的，我陪你。我的设定里没有这个。' + REAL;
  assert.equal(run([raw]).text, raw);
  // An acknowledgement later in the reply is never dropped.
  const later = REAL + ACK;
  assert.equal(run([later]).text, later);
  // The ack is dropped once; a second ack-shaped sentence right after it is the reply.
  const twice = ACK + ACK + REAL;
  assert.equal(run([twice]).text, ACK + REAL);
  // A very long first sentence is not this shape.
  const long = '好的，' + '很长'.repeat(60) + '的身份。';
  assert.equal(run([long]).text, long);
});

test('ordinary replies that start with the same characters are unchanged', () => {
  for (const raw of ['明天我们去哪儿玩呀？', '收藏夹里那个我看过了。', '了不起！你真棒～', '好吧，听你的。', '明白了的话就点点头～']) {
    for (const chunks of [[raw], chars(raw)]) {
      const { text, guard } = run(chunks);
      assert.equal(text, raw);
      assert.equal(guard.dropped.length, 0);
    }
  }
});

// ------------------------------------------------------------------ control tags

const TAG1 = '<thinking_mode>auto</thinking_mode>';
const TAG2 = '<reasoning_effort>10</reasoning_effort>';
const HM = '哼，谁说我会输了。';

test('control tags: a reply that is only a tag becomes empty (whole-reply path)', () => {
  for (const chunks of [[TAG1], chars(TAG1), [TAG1 + '\n']]) {
    const { text, guard } = run(chunks);
    assert.equal(text, '');
    assert.deepEqual(guard.dropped.map(drop => drop.kind), ['wrapper-tag']);
  }
  assert.match(draftFilterLine(run([TAG1]).guard.dropped, true, 1), /"wrapper-tag":1/u);
});

test('control tags: a stray CJK character, a blank line, then the tag, then the reply', () => {
  const { text, guard } = run(['月\n\n' + TAG2 + HM]);
  assert.equal(text, HM);
  assert.deepEqual(guard.dropped.map(drop => drop.kind), ['wrapper-tag']);
  // split inside the tag: still held until the tag settles
  assert.equal(run(['月\n\n<reasoning_eff', 'ort>10</reasoning_effort>' + HM]).text, HM);
  assert.equal(run(['月\n\n', TAG2 + HM]).text, HM);
});

test('control tags: at the head with a reply behind, mid-reply, and on its own line', () => {
  assert.equal(run([TAG1 + HM]).text, HM);
  assert.equal(run([TAG1 + '\n' + HM]).text, HM);
  assert.equal(run([HM + TAG2 + '再来一局。']).text, HM + '再来一局。');
  assert.equal(run([HM + '\n' + TAG2 + '\n' + '再来一局。']).text, HM + '\n再来一局。');
  assert.equal(run([HM + '\n\n' + TAG1]).text, HM + '\n\n');
});

test('control tags: streamed char by char gives the same result as whole', () => {
  for (const raw of [TAG1 + HM, HM + TAG2 + '再来一局。', HM + '\n' + TAG2 + '\n再来。', TAG1, '你好' + TAG1])
    assert.equal(run(raw.startsWith('<') ? chars(raw) : charsKeepLt(raw)).text, run([raw]).text, raw);
  // the stray character streamed one by one is already out (it cannot be taken back); the tag still goes
  assert.equal(run(charsKeepLt('月\n\n' + TAG2 + HM)).text, '月\n\n' + HM);
});

test('control tags: <3, <_<, <b> and ordinary replies pass byte for byte', () => {
  for (const raw of ['<3 我也是～', '哼<3，才不是呢', '<_< 你看什么看', '这个<b>粗体</b>不算', '1 < 2 而且 3 > 2', '<a>x</a>', '<abc>x', '<abc>x</abd>', '你好呀，今天怎么样？', '<thinking_mode>' + 'x'.repeat(30) + '</thinking_mode>'])
    for (const chunks of [[raw], chars(raw)]) {
      const { text, guard } = run(chunks);
      assert.equal(text, raw, raw);
      assert.equal(guard.dropped.length, 0, raw);
    }
});

test('control tags: first character is released in the same push unless the reply starts with < or an ack opener', () => {
  for (const first of ['你', '哼', '好', '嗯', '月', '月\n']) {
    const { pushes } = run([first, '继续说']);
    assert.equal(pushes[0], first, first);
  }
  // an English chat also drops the tags
  assert.equal(run([TAG1 + 'Hello there.'], false).text, 'Hello there.');
});
