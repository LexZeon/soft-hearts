// I-071 draft guard, minimum: in English mode a normal English reply is not "English self-talk in a Chinese chat". Chinese mode is exactly as before
// (the existing guard tests run unchanged). No new English-only draft rules here (that is open question 6 for the user).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyDraftGuard, asksForEnglish, chatLooksChinese } from '../electron/brain/reply-draft-guard';

const CHINESE_PERSONA = '角色名称：小满\n\n角色描述：\n住在桌面上的伙伴。';
const STORY = 'Nera watched the ferryman count the lanterns one by one. She should reply to the letter before the next ferry left, she thought. The ink had dried beside the blue lamp hours ago, and the wind still lifted the curled edge of the envelope whenever the door opened.';

function shown(reply: string, userText: string, language?: 'zh-CN' | 'en'): string {
  const guard = new ReplyDraftGuard(['Nera'], { chinese: chatLooksChinese(userText, CHINESE_PERSONA, language), englishAsked: asksForEnglish(userText, language) });
  return guard.push(reply) + guard.finish();
}

test('Chinese mode (no language, or zh-CN) decides exactly as before', () => {
  for (const text of ['你好', 'hello', '😊', '123', '', '用英文写一段话', '请用 English 回答']) {
    assert.equal(chatLooksChinese(text, CHINESE_PERSONA, 'zh-CN'), chatLooksChinese(text, CHINESE_PERSONA), text);
    assert.equal(asksForEnglish(text, 'zh-CN'), asksForEnglish(text), text);
  }
  assert.equal(chatLooksChinese('😊', CHINESE_PERSONA), true, 'no letters at all: the Chinese persona decides, as before');
  assert.equal(asksForEnglish('今天能陪我坐一会儿吗？'), false);
  assert.equal(shown(STORY, '今天能陪我坐一会儿吗？'), '', 'a Chinese chat in Chinese mode still cuts an English plan-looking reply');
});

test('English mode: the persona (Chinese on an old card) no longer makes the chat Chinese; a Chinese message still does', () => {
  assert.equal(chatLooksChinese('😊', CHINESE_PERSONA, 'en'), false);
  assert.equal(chatLooksChinese('123', CHINESE_PERSONA, 'en'), false);
  assert.equal(chatLooksChinese('how was your day', CHINESE_PERSONA, 'en'), false);
  assert.equal(chatLooksChinese('你今天怎么样', CHINESE_PERSONA, 'en'), true);
});

test('English mode: a Chinese message is judged like "the user asked for English"; an English one needs nothing', () => {
  assert.equal(asksForEnglish('你今天怎么样', 'en'), true);
  assert.equal(asksForEnglish('how was your day', 'en'), false, 'an English message is an English chat already');
  assert.equal(asksForEnglish('', 'en'), false);
});

test('the same English reply: cut in a Chinese chat in Chinese mode, kept in English mode for a Chinese or an English message', () => {
  assert.equal(shown(STORY, '你今天怎么样'), '', 'Chinese mode: held and cut');
  assert.equal(shown(STORY, '你今天怎么样', 'en'), STORY, 'English mode, Chinese message');
  assert.equal(shown(STORY, 'how was your day', 'en'), STORY, 'English mode, English message');
  assert.equal(shown(STORY, '😊', 'en'), STORY, 'English mode, a message with no letters on a Chinese persona');
});

test('English mode does not let an unmistakable draft through', () => {
  const draft = 'Draft: Respond as Gene, supportive, short, no lecturing. Footer with support context.\nI am doing well, thanks for asking.';
  const guard = new ReplyDraftGuard(['Gene'], { chinese: chatLooksChinese('how are you', '', 'en'), englishAsked: asksForEnglish('how are you', 'en') });
  const out = guard.push(draft) + guard.finish();
  assert.ok(!out.includes('Footer with support context'), out);
});
