/** M1: the smallest "跳一个" recognition: a narrow, local scan of the user's own message. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { scanDanceRequest } from '../shared/dance-request';

test('M1 request: asking her to dance is recognized', () => {
  for (const text of ['跳一个', '跳一个！', '跳个舞', '跳舞吧', '给我跳一支舞', '来跳个舞', '你跳个舞吧', '那你跳一下', '快跳起来', '可以跳个舞吗',
    '能不能给我跳一段', '跳！', '好，跳一个', '今天辛苦啦，来段舞吧', '扭一扭', '请你跳舞', 'dance', 'Dance for me!', 'can you dance?', 'please do a little dance', 'okay, dance'])
    assert.equal(scanDanceRequest(text), true, text);
});

test('M1 request: stories, questions about ability, refusals and unrelated words are not requests', () => {
  for (const text of ['我昨天去跳舞了', '你会跳舞吗', '别跳了', '不要跳舞', '不想跳舞', '我不喜欢跳舞', '我朋友在跳舞', '舞会真好玩', '跳了半天累死了',
    '今天天气不错', '', '    ', '音乐很好听', '跳过这一段', '我想看你跳舞但是今天算了不太对', 'I love to dance', 'dancing is fun', "don't dance", 'she can dance well'])
    assert.equal(scanDanceRequest(text), false, text);
});

test('M1 request: only the start of a clause counts, and only the first few hundred characters are read', () => {
  assert.equal(scanDanceRequest('今天好累。你跳个舞吧'), true, 'a later clause can be the request');
  assert.equal(scanDanceRequest('我'.repeat(500) + '。跳一个'), false, 'long text is not scanned to the end');
  assert.equal(scanDanceRequest(undefined as unknown as string), false);
  assert.equal(scanDanceRequest(42 as unknown as string), false);
});
