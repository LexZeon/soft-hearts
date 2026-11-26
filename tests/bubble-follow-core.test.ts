// I-165: the pure state machine both windows and
// the host run (shared/voice/bubble-follow/follow.ts). Fake clock throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BubbleFollow } from '../shared/voice/bubble-follow/follow';
import { BUBBLE_FOLLOW_KNOBS, bubbleFollowMode, type BubbleFollowKnobs } from '../shared/voice/bubble-follow/knobs';

const knobs = (patch: Partial<BubbleFollowKnobs> = {}): BubbleFollowKnobs => ({ ...BUBBLE_FOLLOW_KNOBS, ...patch });
// "第一句。" ends at 4, "第二句话。" at 9, "第三。" at 12.
const ENDS = [4, 9, 12];

test('the default is whole sentences; the knob can only say sentence, char or off', () => {
  assert.equal(BUBBLE_FOLLOW_KNOBS.mode, 'sentence');
  assert.equal(bubbleFollowMode(), 'sentence');
  assert.equal(bubbleFollowMode(knobs({ mode: 'char' })), 'char');
  assert.equal(bubbleFollowMode(knobs({ mode: 'off' })), 'off');
  assert.equal(bubbleFollowMode(knobs({ mode: 'whatever' as never })), 'sentence');
});

test('whole-sentence mode: nothing ("……") before the first audio, then each sentence exactly when its audio starts', () => {
  const f = new BubbleFollow(knobs());
  assert.equal(f.begin('r1', 0), true);
  assert.equal(f.cap('r1', 0), 0, 'held: the bubble shows "……"');
  f.segment('r1', 0, ENDS[0], 100); f.segment('r1', 1, ENDS[1], 120);
  assert.equal(f.cap('r1', 2000), 0, 'its text is known but she has not said it yet');
  f.heard('r1', 0, 'start', 2500);
  assert.equal(f.cap('r1', 2500), 4, 'the first sentence, whole, the moment it is heard');
  assert.equal(f.cap('r1', 4000), 4, 'not the second one yet, even though its text is there');
  f.heard('r1', 0, 'end', 4200); f.heard('r1', 1, 'start', 4200);
  assert.equal(f.cap('r1', 4200), 9);
  f.segment('r1', 2, ENDS[2], 4300);
  assert.equal(f.cap('r1', 4300), 9);
  f.heard('r1', 2, 'start', 6000);
  assert.equal(f.cap('r1', 6000), 12);
});

test('released for any reason: everything shows and stays shown; late facts never hold it again', () => {
  for (const reason of ['over', 'cancelled', 'error', 'interrupted', 'off', 'superseded'] as const) {
    const f = new BubbleFollow(knobs());
    f.begin('r1', 0); f.segment('r1', 0, 4, 0); f.heard('r1', 0, 'start', 10);
    assert.equal(f.release('r1', reason), true);
    assert.equal(f.cap('r1', 11), null, reason);
    f.heard('r1', 1, 'start', 20); f.segment('r1', 1, 9, 20);
    assert.equal(f.cap('r1', 21), null, `${reason}: sticky`);
    assert.equal(f.released, reason);
  }
});

test('a cancelled or superseded reply never touches the newer one, and the newer one starts held again', () => {
  const f = new BubbleFollow(knobs());
  f.begin('old', 0); f.segment('old', 0, 4, 0); f.heard('old', 0, 'start', 10);
  f.begin('new', 50);
  f.heard('old', 0, 'end', 60); f.heard('old', 1, 'start', 60); f.release('old', 'cancelled');
  assert.equal(f.cap('new', 70), 0, 'the old reply cannot release or advance the new one');
  assert.equal(f.cap('old', 70), null, 'a reply that is not the current one is never held');
  f.segment('new', 0, 3, 80); f.heard('new', 0, 'start', 90);
  assert.equal(f.cap('new', 90), 3);
});

test('a stage direction the voice skips shows when its turn comes; a sentence heard before its end is known shows once the end arrives', () => {
  const f = new BubbleFollow(knobs());
  f.begin('r1', 0); f.segment('r1', 0, 4, 0);
  f.heard('r1', 0, 'start', 10);
  f.heard('r1', 1, 'skip', 20);
  assert.equal(f.cap('r1', 20), 4, 'the skipped sentence\'s end is not known yet');
  f.segment('r1', 1, 11, 25);
  assert.equal(f.cap('r1', 25), 11, 'shown as soon as its end is known');
  f.heard('r1', 2, 'start', 30);
  assert.equal(f.cap('r1', 30), 11);
  f.segment('r1', 2, 15, 40);
  assert.equal(f.cap('r1', 40), 15);
});

test('stalls release: the first sentence never sounding, the next one not starting, a sentence that never ends', () => {
  const k = knobs({ firstStallMs: 1000, nextStallMs: 500, sentenceMaxMs: 3000 });
  const first = new BubbleFollow(k);
  first.begin('r1', 0); first.segment('r1', 0, 4, 200);
  assert.equal(first.nextChange(300), 1200);
  assert.equal(first.cap('r1', 1199), 0); assert.equal(first.cap('r1', 1200), null); assert.equal(first.released, 'stall');

  const next = new BubbleFollow(k);
  next.begin('r1', 0); next.segment('r1', 0, 4, 0); next.segment('r1', 1, 9, 0);
  next.heard('r1', 0, 'start', 100); next.heard('r1', 0, 'end', 2000);
  assert.equal(next.cap('r1', 2499), 4); assert.equal(next.cap('r1', 2500), null);

  const waitingForText = new BubbleFollow(k);
  waitingForText.begin('r1', 0); waitingForText.segment('r1', 0, 4, 0);
  waitingForText.heard('r1', 0, 'start', 100); waitingForText.heard('r1', 0, 'end', 2000);
  assert.equal(waitingForText.cap('r1', 9000), 4, 'the next sentence has not even been written: nothing is overdue');
  waitingForText.segment('r1', 1, 9, 9000);
  assert.equal(waitingForText.cap('r1', 9499), 4); assert.equal(waitingForText.cap('r1', 9500), null);

  const stuck = new BubbleFollow(k);
  stuck.begin('r1', 0); stuck.segment('r1', 0, 4, 0); stuck.heard('r1', 0, 'start', 100);
  assert.equal(stuck.cap('r1', 3099), 4); assert.equal(stuck.cap('r1', 3100), null);

  const neverAsked = new BubbleFollow(k);
  neverAsked.begin('r1', 0);
  assert.equal(neverAsked.cap('r1', 2999), 0); assert.equal(neverAsked.cap('r1', 3000), null, 'backstop: nothing was ever asked for');
});

test('feeding pauses the stall clocks; they go on from where they were', () => {
  const f = new BubbleFollow(knobs({ nextStallMs: 500 }));
  f.begin('r1', 0); f.segment('r1', 0, 4, 0); f.segment('r1', 1, 9, 0);
  f.heard('r1', 0, 'start', 0); f.heard('r1', 0, 'end', 1000);
  f.pause(1200);
  assert.equal(f.nextChange(1300), null);
  assert.equal(f.cap('r1', 5000), 4, 'no stall while she eats');
  f.resume(5000);
  assert.equal(f.cap('r1', 5299), 4); assert.equal(f.cap('r1', 5300), null, '300 ms were left when she started eating');
});

test('char mode: inside a sentence the reveal follows its estimated audio time, learns her real pace, and snaps to the end when it ends', () => {
  const f = new BubbleFollow(knobs({ charMs: 100, charMsRange: [10, 1000] }));
  f.begin('r1', 0, 'char'); f.segment('r1', 0, 10, 0); f.segment('r1', 1, 30, 0);
  assert.equal(f.cap('r1', 0), 0);
  f.heard('r1', 0, 'start', 1000);
  assert.equal(f.cap('r1', 1000), 0);
  assert.equal(f.cap('r1', 1100), 1);
  assert.equal(f.cap('r1', 1550), 5);
  assert.equal(f.nextChange(1550), 1600, 'the next character is due at 1.6 s');
  assert.equal(f.cap('r1', 5000), 10, 'never past the sentence');
  f.heard('r1', 0, 'end', 3000); // 10 units in 2 s: 200 ms each
  f.heard('r1', 1, 'start', 3000);
  assert.equal(f.cap('r1', 3000), 10);
  assert.equal(f.cap('r1', 3400), 12, 'the second sentence at her learned 200 ms per unit');
  f.heard('r1', 1, 'end', 3500);
  assert.equal(f.cap('r1', 3500), 30, 'it ended sooner than estimated: shown whole');
  assert.equal(f.cap('r1', 3400), 30, 'a cap never goes back');
});

test('bad input changes nothing', () => {
  const f = new BubbleFollow(knobs());
  assert.equal(f.begin('bad id!', 0), false);
  assert.equal(f.begin('r1', 0, 'off'), false);
  f.begin('r1', 0);
  f.segment('r1', -1, 4, 0); f.segment('r1', 999, 4, 0); f.segment('r1', 0, -3, 0);
  f.heard('r1', 1.5, 'start', 0); f.heard('r1', 0, 'later' as never, 0);
  assert.equal(f.cap('r1', 1), 0);
});
