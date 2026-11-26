/**
 * One rule for how long a finished reply bubble stays, in the companion window and in full-screen Unbound
 * (docs/claude/2026-11-22-bubble-linger-one-rule.md): both ask the same decision (shared/behaviors/reply-linger/); full-screen feeds
 * it the whole reply at once (`readAll`), so it is never cut below its reading time, while the window's own numbers stay as they were.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { REPLY_LINGER_KNOBS } from '../shared/behaviors/reply-linger/knobs';
import { readBubbleLingerMs } from '../shared/brain';
import { chooseReplyLinger, readableChars, readableMs, ReplyLingerDirector, replyLingerMood, replyLingerNow } from '../shared/behaviors/reply-linger/choose';

import type { ReplyLingerBubble } from '../shared/behaviors/reply-linger/interface';
import { bubbleLingerFor, unboundBubbleLingerMs, wholeReplyBubble } from '../electron/unbound/bubble-linger';

const [SHORTEST, LONGEST] = REPLY_LINGER_KNOBS.range;
const CALM = replyLingerMood({ snapshot: { primary: 'calm', companion: null }, personality: null });
const HAPPY = replyLingerMood({ snapshot: { primary: 'happy', companion: null }, personality: null });

/** The window's side (the reply window asks the director for one bubble) and full-screen's side (the wiring port over the same director). */
function sides(mood = CALM, roll = 0.4) {
  const director = new ReplyLingerDirector({ random: () => roll });
  const moodHost = { decideReplyLinger: (bubble: ReplyLingerBubble) => director.decide('her', bubble, mood) };
  return {
    window: (text: string) => director.decide('her', { text, pieces: null, segmented: false }, mood),
    fullscreen: (text: string) => unboundBubbleLingerMs(moodHost, text),
    director,
  };
}
const chars = (n: number) => '字'.repeat(n);

test('the same finished reply: the same milliseconds in the window and in full-screen (short, a question at the end)', () => {
  for (const mood of [CALM, HAPPY]) {
    const s = sides(mood);
    for (const text of ['好呀，我在。', '嗯。', '今天过得怎么样呀，累不累，要不要我陪你一会儿？', '我刚刚在想一件事，想听听你的看法。你呢', chars(60) + '。']) {
      assert.equal(s.fullscreen(text), s.window(text), text);
    }
  }
  const s = sides();
  assert.ok(s.fullscreen('你今天累不累？') > s.fullscreen('你今天累不累。'), 'a question waits longer, here too');
  assert.ok(s.fullscreen('开心。') >= SHORTEST && s.fullscreen('开心。') <= LONGEST);
});

test('a long reply: the window keeps its cap; full-screen is never cut below the time it takes to read all of it', () => {
  const s = sides();
  for (const n of [80, 114, 120, 200, 400, 900]) {
    const text = chars(n) + '。', read = readableMs(readableChars(text));
    assert.equal(s.window(text), Math.min(LONGEST, Math.max(SHORTEST, s.window(text))), 'the window stays within its range');
    assert.ok(s.window(text) <= LONGEST, 'the window numbers are unchanged: capped');
    assert.ok(s.fullscreen(text) >= Math.round(read) - 1, `${n} chars: ${s.fullscreen(text)} ms covers reading ${Math.round(read)} ms`);
    assert.ok(s.fullscreen(text) >= s.window(text), 'never shorter than the window would keep it');
  }
  const long = chars(200) + '。';
  assert.equal(s.window(long), LONGEST, '200 characters: the window shows its last bubble for the longest');
  assert.equal(s.fullscreen(long), Math.round(readableMs(200)), '34.3 s of reading, not 20');
});

test('a full-screen bubble never lingers shorter than its reading time, whatever her mood leans to or the roll', () => {
  for (const mood of [null, CALM, HAPPY, replyLingerMood({ snapshot: { primary: 'excited', companion: 'playful' }, personality: { playful: 3, close: 0, comfortable: 1, cautious: 1 }, fatiguePhase: null })]) {
    for (const roll of [0, 0.5, 0.999]) {
      for (const n of [0, 1, 30, 100, 114, 115, 150, 300, 700]) {
        const bubble = wholeReplyBubble(chars(n));
        const choice = chooseReplyLinger(replyLingerNow(bubble, mood), () => roll);
        assert.ok(choice.ms >= Math.round(readableMs(n)) - 1, `${n} chars, roll ${roll}: ${choice.ms} < reading`);
        assert.ok(choice.ms >= SHORTEST);
        if (Math.round(readableMs(n)) > LONGEST) assert.ok(choice.why.some(line => line.includes('按读完留')), 'says why it is past the cap');
      }
    }
  }
});

test('only a bubble that shows the whole reply (readAll) lifts the cap; the window\'s own bubble does not', () => {
  const text = chars(300);
  const own = chooseReplyLinger(replyLingerNow({ text, pieces: null, segmented: false }, CALM), () => 0.5);
  assert.equal(own.ms, LONGEST);
  const whole = chooseReplyLinger(replyLingerNow(wholeReplyBubble(text), CALM), () => 0.5);
  assert.equal(whole.ms, Math.round(readableMs(300)));
  assert.equal(wholeReplyBubble('x').segmented, false, 'one bubble, not segmented');
});

test('the page reads the host\'s number; a missing or broken one keeps the bubble the longest, a long reading time is not cut to the range', () => {
  assert.equal(readBubbleLingerMs(34_333), 34_333);
  for (const bad of [undefined, null, NaN, Infinity, -5, 0, '9000']) assert.equal(readBubbleLingerMs(bad), LONGEST);
  assert.equal(bubbleLingerFor(undefined, '嗯。'), undefined);
  assert.equal(bubbleLingerFor(() => { throw new Error('gone'); }, '嗯。'), undefined);
  assert.equal(bubbleLingerFor(() => NaN, '嗯。'), undefined);
  assert.equal(bubbleLingerFor(() => 6_000, '嗯。'), 6_000);
});
