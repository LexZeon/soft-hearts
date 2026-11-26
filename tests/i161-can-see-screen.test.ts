// I-161 bug (voice call): asking whether she can see the desktop took no screen frame, so she said her side was dark. A question whether she
// can see the user's screen, with sharing on, asks her to look. Every sentence below is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanLookRequest, withheldLook } from '../shared/senses/look-request';
import { asksCanSeeScreen } from '../shared/senses/look-can-see';
import { spokenLookText } from '../shared/senses/call-look';
import { LookTurns } from '../electron/senses/look-turns';

const read = (text: string) => scanLookRequest(spokenLookText(text));

test('asking whether she can see the screen asks her to look at it (typed or recognized, with or without punctuation)', () => {
  for (const text of ['呃，这会儿能看到我的桌面吗？', '这会儿能看到我的桌面吗', '你能看到我屏幕吗', '你现在能看见我的屏幕吗', '你看得到我的桌面吗', '那你现在看得见我桌面不',
    '能不能看到我的屏幕', '你可以看到我这个屏幕吗', '你能看清我的屏幕吗', '嗯你现在能看到我电脑屏幕吗', '你能看到我屏幕上的字吗', '能看到屏幕吗', '你现在看得到我的显示器没有',
    '你能看到我的桌面了吗'])
    assert.equal(read(text), 'screen', text);
});

test('what is not that question stays no request', () => {
  for (const text of ['你看到我屏幕了吗', '你看见我了吗', '你能看见我吗', '你看得到吗', '我能看到屏幕了', '我这会儿能看到我的桌面吗', '希望你能看到我的屏幕',
    '你能看到我屏幕的话就好了', '我的屏幕能看到吗', '桌面能不能换个壁纸', '你在看我屏幕吗', '你是不是看到我屏幕了', '别看我的屏幕你现在能看到吗',
    '不要看我桌面，你能看到我的桌面吗', '他问你能看到我的屏幕吗', '同事说，你能看到我的桌面吗', '你能看到的桌面是什么样的']) {
    assert.notEqual(read(text), 'screen', text);
    assert.equal(asksCanSeeScreen(text.replace(/[，,？?。]/gu, '')) && withheldLook(text) === null, false, text);
  }
});

test('with screen sharing on the turn takes a frame; with it off nothing is taken and the answer is the refusal note', () => {
  const turns = new LookTurns(() => 0);
  const on = { screen: true, camera: false, scope: 's', cameraHeld: false };
  const asked = turns.decide({ text: spokenLookText('呃，这会儿能看到我的桌面吗？') }, on);
  assert.equal(asked.screen, true, 'a screen frame is wanted');
  const off = turns.decide({ text: spokenLookText('呃，这会儿能看到我的桌面吗？') }, { ...on, screen: false });
  assert.notEqual(off.screen, true, 'sharing off takes nothing');
});
