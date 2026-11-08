// 识图分三档第 1 步：发送前在本机认出"你叫她看"（docs/claude/2026-11-03-image-depth-step1.md）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLookAffirmation, isLookOffer, scanLookRequest, type LookTarget } from '../shared/look-request';

const cases: ReadonlyArray<[string, LookTarget | null]> = [
  // 对她说的：看屏幕上的东西
  ['你看看这个', 'either'], ['你看看这个报错', 'screen'], ['帮我看看', 'either'], ['帮我看看这道题', 'screen'],
  ['看这道题', 'screen'], ['看看这道题怎么做', 'screen'], ['这道题你看看', 'screen'], ['这道题帮我看看', 'screen'],
  ['看我屏幕', 'screen'], ['你看下我屏幕', 'screen'], ['你看一眼电脑', 'screen'], ['看一下屏幕上的', 'screen'],
  ['你瞧瞧', 'either'], ['你瞅瞅这个', 'either'], ['瞅一眼这个', 'either'], ['你能看看吗', 'either'],
  ['你可以帮我看一下这段代码吗', 'screen'], ['麻烦看一下这个', 'either'], ['你帮我看一下这个报错', 'screen'],
  ['给你看个东西', 'either'], ['给你看看我写的', 'screen'], ['我给你看看这个视频', 'screen'], ['你快来看', 'either'],
  ['快来看这个', 'either'], ['过来瞧瞧', 'either'], ['你过来看看这个', 'either'], ['你看这道题', 'screen'], ['你看这个', 'either'],
  ['你看看，这个报错什么意思', 'screen'], ['这题怎么做，帮我看看', 'screen'], ['你要不要看看我画的图', 'screen'],
  ['你再看看这里', 'either'], ['看下这个', 'either'], ['看一下这题', 'screen'], ['你可以看看我写的作文吗', 'screen'],
  ['你看看我屏幕上这个', 'screen'], ['宝贝看看这个', 'either'], ['让你看看我写的代码', 'screen'],
  // 对她说的：看我（摄像头）
  ['你看看我', 'camera'], ['看看我今天的发型', 'camera'], ['瞧瞧我这身', 'camera'], ['你看我这身怎么样', 'camera'],
  ['你看看我的新衣服', 'camera'], ['让你看看我的新发型', 'camera'], ['看看我', 'camera'],
  // 不算：用户自己看、逗她、口头禅、问她能不能看见、看电影
  ['我看看', null], ['让我看看', null], ['我先看看', null], ['我去看一下', null], ['我看一下屏幕', null], ['我在看屏幕', null],
  ['你看看你', null], ['你看看你，又迷糊了', null], ['你瞧瞧你', null], ['你瞅瞅你那样', null], ['你看看人家', null],
  ['你看，我就说吧', null], ['你看我说得对吧', null], ['你看我干嘛', null], ['让你看看我的厉害', null], ['你看着办吧', null],
  ['你看过这部电影吗', null], ['你看到我屏幕了吗', null], ['你能看到我屏幕吗', null], ['你能看见我吗', null], ['你看得到吗', null],
  ['我想看看电影', null], ['我在看电视', null], ['今天看了一部电影', null], ['看情况吧', null], ['看心情', null], ['看起来不错', null],
  ['你看起来很累', null], ['好看', null], ['看看再说', null], ['看看吧', null], ['再看看', null], ['给我看看你的新衣服', null],
  ['你给我看看', null], ['你看这次又这样', null], ['你看这样子要下雨', null], ['来看看今天吃什么', null], ['我们一起看看', null],
  ['今天好累啊', null], ['晚上吃什么好呢', null], ['这个报错到底什么意思啊，烦死了', null], ['看得我头大', null], ['', null],
];

test('细看的说法：对她说的才算，正例和反例', () => {
  const wrong = cases.filter(([text, expected]) => scanLookRequest(text) !== expected).map(([text, expected]) => `${text} → ${scanLookRequest(text)}（应为 ${expected}）`);
  assert.deepEqual(wrong, []);
  assert.ok(cases.filter(([, expected]) => expected).length >= 40 && cases.filter(([, expected]) => !expected).length >= 40, '正例反例都多');
});

test('细看的说法：空格、标点、超长和非文字都不出错', () => {
  assert.equal(scanLookRequest('你 看 看 这 个！'), 'either');
  assert.equal(scanLookRequest('嗯……你看看这道题？'), 'screen');
  assert.equal(scanLookRequest('x'.repeat(4001) + '你看看这个'), null);
  for (const value of [undefined, null, 3, {}, []]) assert.equal(scanLookRequest(value), null);
});

test('回她"要我凑近看看吗"的短回答：嗯、看吧、好；不、算了、反问都不算', () => {
  for (const yes of ['那你看吧', '那看看', '嗯', '嗯嗯', '恩', '好', '好呀', '好的', '好啊～', '看吧', '你看吧', '看看吧', '可以', '可以呀', '行', '要', '要的', '对', '是的', '来吧', '凑近看看', '好的谢谢', 'ok', 'OK！', '嗯，看吧'])
    assert.equal(isLookAffirmation(yes), true, yes);
  for (const no of ['不用', '不要', '不了', '算了', '别看', '没事', '等会', '看什么', '是吗', '你', '吧', '哦', '啊', '嗯不用了', '今天好累啊', '好好好好好好好好好好好', '', undefined, 1])
    assert.equal(isLookAffirmation(no), false, String(no));
});

test('她的回答里问"要我凑近看看吗"：问句或邀请才算；说看不到、说自己看过、普通问句都不算', () => {
  for (const offer of ['要我凑近看看吗？', '报错啊……我还没看你的屏幕呢，要我凑近看看吗？', '要不要我帮你看一眼？', '需要我看看吗',
    '你叫我看我就看哦～', '想让我看的话喊我一声。', '我帮你看看吧？', '让我看看？', '要我瞧瞧吗？', '我看不到你的屏幕呢，要我看看吗？',
    '可是我还不知道是哪个报错呀，你把那段红字贴给我看看？或者叫我看一眼屏幕也行。', '或者叫我一声，我去看看你屏幕上那段。'])
    assert.equal(isLookOffer(offer), true, offer);
  for (const not of ['报错最烦了，先深呼吸一下。', '我看不到你的屏幕呢。', '我看到了！', '你要不要先休息一下？', '让我想想。', '我帮你记着。',
    '你看看你，又熬夜。', '晚上吃什么好呢？', '要我陪你吗？', '我去看看饭好了没。', '你把报错贴给我？', '', undefined, 3])
    assert.equal(isLookOffer(not), false, String(not));
});
