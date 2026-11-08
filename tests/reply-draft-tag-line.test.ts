// 2026-11-08 (stable build, the user: "又把思考链发出来了"): a reply began with a bare tag line, then a blank line, then her reply;
// the tag was not in WRAPPER_TAGS, so it was shown and read aloud. A first line of bare tags is now cut. Synthetic texts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyDraftGuard } from '../electron/reply-draft-guard';
import { MoodReplyProtocol } from '../electron/mood-chat';

function chunkings(text: string): string[][] {
  const pieces = (sizes: (i: number) => number) => { const out: string[] = []; for (let i = 0, n = 0; i < text.length; n++) { const size = Math.max(1, sizes(n)); out.push(text.slice(i, i + size)); i += size; } return out; };
  let seed = 2026;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return [[text], pieces(() => 1), pieces(() => 3), pieces(n => n === 0 ? 18 : 1 + Math.floor(random() * 9)), pieces(() => 1 + Math.floor(random() * 30))];
}
function play(chunks: string[], chinese = true) {
  const guard = new ReplyDraftGuard([], { chinese });
  let shown = '';
  for (const chunk of chunks) shown += guard.push(chunk);
  return { shown: shown + guard.finish(), dropped: guard.dropped };
}

const REPLY = '好呀，陪你看！\n\n这个开头好安静……你喜欢这种慢慢来的片子吗？';

test('a first line of bare tags is cut, however the stream is chunked', () => {
  for (const tags of ['<thinking_mode>off</thinking_mode>', '</thinking_mode>', '<reasoning_effort>low</reasoning_effort>', '<mode>auto</mode> <tone>soft</tone>'])
    for (const chunks of chunkings(`${tags}\n\n${REPLY}`)) {
      const { shown, dropped } = play(chunks);
      assert.equal(shown, REPLY, `${tags} / ${JSON.stringify(chunks.slice(0, 2))}`);
      assert.ok(dropped.some(drop => drop.kind === 'wrapper-tag'), tags);
    }
});

test('the same in an English chat', () => {
  const reply = 'Sure, let\'s watch it together!';
  assert.equal(play(['<thinking_mode>off</thinking_mode>\n\n', reply], false).shown, reply);
});

test('replies that start with "<" but are not a tag line go out unchanged', () => {
  for (const reply of ['<3 最喜欢你啦', '<b>重点</b>在这里哦～', '<- 往这边看', '<这个>是书名号打错了吧', '<sh'])
    for (const chunks of chunkings(reply)) {
      const { shown, dropped } = play(chunks);
      assert.equal(shown, reply, `${reply} / ${JSON.stringify(chunks.slice(0, 3))}`);
      assert.equal(dropped.length, 0, reply);
    }
});

test('through the reply protocol: the tag line is neither shown nor kept, the reply is', () => {
  const shown: string[] = [];
  const protocol = new MoodReplyProtocol(text => shown.push(text), { chineseChat: true });
  for (const chunk of ['<thinking_mode>off', '</thinking_mode>\n', '\n好呀，陪你看！']) protocol.push(chunk);
  protocol.finish();
  assert.equal(shown.join(''), '好呀，陪你看！');
});

test('Chinese chat: behind a cut tag line, a paragraph of English reasoning is cut too (to its blank line)', () => {
  const reasoning = 'The user pinched her cheek and says she looks cute. She should react shyly, keep it short, maybe pout a little and not mention the footer.';
  for (const chunks of chunkings(`</thinking_mode>\n${reasoning}\n\n${REPLY}`)) {
    const { shown, dropped } = play(chunks);
    assert.equal(shown, REPLY, JSON.stringify(chunks.slice(0, 2)));
    assert.ok(dropped.some(drop => drop.kind === 'english-note'));
  }
});

test('behind a cut tag line, a short English word or a Chinese reply is kept; an English chat keeps its English', () => {
  for (const reply of ['OK～好呀，陪你看！', REPLY])
    for (const chunks of chunkings(`<thinking_mode>off</thinking_mode>\n${reply}`)) assert.equal(play(chunks).shown, reply, reply);
  const english = 'Sure! Let me get comfy first, then you tell me what this show is about and why you picked it today.';
  assert.equal(play(['<thinking_mode>off</thinking_mode>\n', english], false).shown, english);
});
