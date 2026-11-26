// 2026-11-21 (dev build 8d32d394): a reply began ".\n</thinking_mode>\n\n…words…". The tag line alone was already
// cut, but the lone "." in front of it was released first and the tag line then went out with it. Synthetic texts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyDraftGuard, draftFilterLine } from '../electron/brain/reply-draft-guard';
import { strayMarkBeforeTagLine } from '../electron/brain/reply-tag-lead';
import { MoodReplyProtocol } from '../electron/mood/mood-chat';

function chunkings(text: string): string[][] {
  const pieces = (size: number) => { const out: string[] = []; for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size)); return out; };
  return [[text], pieces(1), pieces(2), pieces(5), [text.slice(0, 1), text.slice(1)]];
}
function play(chunks: string[], chinese: boolean) {
  const guard = new ReplyDraftGuard([], { chinese });
  const steps: string[] = [];
  for (const chunk of chunks) steps.push(guard.push(chunk));
  return { steps, shown: steps.join('') + guard.finish(), dropped: guard.dropped };
}

const EN = 'So that take was the keeper. Good. You got it right.';
const ZH = '这一条才是对的，不错嘛。';

test('a lone "." line and a closing tag line in front of her words: only her words, however the stream is chunked', () => {
  for (const [reply, chinese] of [[EN, false], [EN, true], [ZH, true]] as const)
    for (const tag of ['</thinking_mode>', '<thinking>', '</thinking>', '<reflection>', '<reasoning_mode>', '</fast_mode>'])
      for (const lead of ['.', '。', '…']) for (const gap of ['\n', '\r\n', '\n\n'])
        // An ellipsis is never held (a reply may open with one), so only a whole chunk is cut there.
        for (const chunks of chunkings(`${lead}${gap}${tag}\n\n${reply}`).slice(0, lead === '…' ? 1 : 5)) {
          const { steps, shown, dropped } = play(chunks, chinese);
          assert.equal(shown, reply, `${lead}${tag} ${JSON.stringify(chunks.slice(0, 2))}`);
          // The first visible characters are never the tag or the mark: everything shown before her words is blank.
          for (let n = 1; n <= steps.length; n++) { const so = steps.slice(0, n).join(''); assert.ok(reply.startsWith(so.trimStart()) || so.trim() === '', JSON.stringify(so)); }
          assert.ok(dropped.some(drop => drop.kind === 'wrapper-tag'));
        }
});

test('the drop is counted in the existing journal line (format group), never any text', () => {
  const { dropped } = play(['.\n</thinking_mode>\n\n' + EN], false);
  const line = JSON.parse(draftFilterLine(dropped, false, 1));
  assert.equal(line.kinds['wrapper-tag'], 1);
  assert.ok(!JSON.stringify(line).includes('thinking'));
});

test('a "." or an ellipsis that begins her words is untouched, and inline tags in her words stay', () => {
  for (const [reply, chinese] of [['.. what? <b>no</b> way.', false], ['...\nwait, <3 you.', false], ['…\n好吧，<b>重点</b>。', true], ['.\nHm.', false], ['。\n好。', true], ['.\n<b>bold</b> start', false], ['.\n</b> odd', false]] as const)
    for (const chunks of chunkings(reply)) {
      const { shown, dropped } = play(chunks, chinese);
      assert.equal(shown, reply, JSON.stringify(chunks.slice(0, 2)));
      assert.equal(dropped.length, 0, reply);
    }
});

test('a lone "." that is all she said is still shown at the end of the stream', () => {
  assert.equal(play(['.'], false).shown, '.');
  assert.equal(play(['.\n'], false).shown, '.\n');
});

test('through the reply protocol: neither the mark nor the tag line is shown, and the first push stays quiet', () => {
  for (const chinese of [false, true]) {
    const shown: string[] = [];
    const protocol = new MoodReplyProtocol(text => shown.push(text), { chineseChat: chinese });
    for (const chunk of ['.', '\n</thinking_', 'mode>\n\n', EN]) protocol.push(chunk);
    protocol.finish();
    assert.equal(shown.join(''), EN);
  }
});

test('the pure rule: waits only while the shape can still complete', () => {
  const tagLine = (t: string) => /^<\/?[a-z_]+>\r?\n/u.exec(t)?.[0].length ?? 0;
  const start = (l: string) => /^<\/?[a-z_]*$/u.test(l);
  assert.equal(strayMarkBeforeTagLine('.', false, tagLine, start), 'wait');
  assert.equal(strayMarkBeforeTagLine('.', true, tagLine, start), 'none');
  assert.equal(strayMarkBeforeTagLine('…', false, tagLine, start), 'none');
  assert.equal(strayMarkBeforeTagLine('.\n</thin', false, tagLine, start), 'wait');
  assert.equal(strayMarkBeforeTagLine('.\n</thinking_mode>\nHi', false, tagLine, start), 2 + '</thinking_mode>\n'.length);
  assert.equal(strayMarkBeforeTagLine('.\nHi', false, tagLine, start), 'none');
  assert.equal(strayMarkBeforeTagLine('.x', false, tagLine, start), 'none');
});
