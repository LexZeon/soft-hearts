// I-161: a voice segment's recognized words go through the typed chat's own look rules. Recognized text
// often has no punctuation and homophone slips; these are such texts. The rules are not loosened for them (a miss only means she does
// not look; a false hit sends a frame nobody asked for); the one speech-only change can only take a frame away: a misheard 别.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanLookRequest, withheldLook } from '../shared/senses/look-request';
import { spokenLookText } from '../shared/senses/call-look';
import { LookTurns } from '../electron/senses/look-turns';

const read = (text: string, appearance = false) => scanLookRequest(spokenLookText(text), { appearance });

test('unpunctuated requests to look are read as typed ones are', () => {
  for (const [text, want] of [
    ['你看看这个', 'either'], ['你看看这个报错', 'screen'], ['嗯你帮我看一下这个', 'either'], ['看我屏幕', 'screen'],
    ['嗯那个你看看我屏幕上这个是什么意思', 'screen'], ['你能不能看一下我这个代码哪里错了', 'screen'], ['你看看 这个 报错 怎么 回事', 'screen'],
    ['那你看看这道题', 'screen'], ['帮我看看这段代码', 'screen'], ['你看一眼电脑', 'screen'], ['给你看个东西', 'either'], ['快来看', 'either'],
    ['宝贝你看看我今天的发型怎么样', 'camera'], ['你看看我', 'camera'],
    // a homophone slip in the thing does not stop the request (报错 heard as 保错)
    ['你看看这个保错', 'either'],
  ] as const) assert.equal(read(text), want, text);
  assert.equal(read('我穿这个好看吗', true), 'camera', 'a looks question (with 「发图片」 on) as in typed chat');
});

test('unpunctuated no, someone else\'s words, the user\'s own looking and talk without a look verb ask nothing', () => {
  for (const text of ['别看我屏幕你看看这个', '你别看了我屏幕不想给你看', '不用你看了', '你不要看', '你在看我屏幕吗', '你是不是在偷看',
    '我同事说你看看这个报错', '他说你看看这个', '我看看这个怎么弄', '你看你又这样', '你看到了吗', '你看见我了吗', '这个是什么', '你说这个怎么办',
    '今天好累啊', '你砍砍这个']) assert.equal(read(text), null, text);
});

test('a misheard 别 before a look verb is read as the no it was ("憋看我屏幕"); only ever a frame less', () => {
  assert.equal(scanLookRequest('憋看我屏幕'), 'screen', 'read as typed, the slip would take a frame');
  for (const text of ['憋看我屏幕', '你鳖看了', '蹩偷看我屏幕', '瘪再看了你看看这个']) {
    assert.equal(read(text), null, text);
    assert.equal(withheldLook(spokenLookText(text)), 'refused', text);
  }
  // Nothing else changes: words with these characters that are not before a look verb stay as they were.
  assert.equal(spokenLookText('憋屈死了你看看这个'), '憋屈死了你看看这个');
  assert.equal(spokenLookText('你看看这个'), '你看看这个');
  assert.equal(spokenLookText(undefined as unknown as string), '');
});

test('a spoken "别看我" holds the small camera frame for the segments after it, as a typed one does', () => {
  const turns = new LookTurns(() => 0);
  const state = { screen: false, camera: true, scope: 's', cameraHeld: false };
  assert.equal(turns.decide({ text: spokenLookText('你好呀') }, state).glance, true);
  const no = turns.decide({ text: spokenLookText('憋看我') }, state);
  assert.equal(no.glance, undefined); assert.equal(no.hold, true);
  assert.equal(turns.decide({ text: spokenLookText('今天怎么样') }, { ...state, cameraHeld: true }).glance, undefined, 'still held');
  const yes = turns.decide({ text: spokenLookText('你看看我') }, { ...state, cameraHeld: true });
  assert.equal(yes.camera, true); assert.equal(yes.hold, false);
});
