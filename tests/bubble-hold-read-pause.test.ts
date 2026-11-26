// 2026-11-24 12:34. The dev journal: a pose-use read-pause paused at 20:34:18 and resumed at 20:34:43 (26 s) while
// full-screen Unbound showed her reply; the reply's voice read on after the resume. Her full-screen bubble (electron/unbound/bubble-hold.ts)
// kept its stall clocks running through the pause, let go of the whole reply 4 s after the paused sentence, finished and faded, so the
// voice that came back read under an empty screen. The window's pause fact now stops the hold's clocks too. Fake clock throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UnboundBubbleHold, applyReadPause, readPauseOf, type HeldBubbleEvent } from '../electron/unbound/bubble-hold';

const ENDS = [5, 13, 21];
const BODY = '嗯，好呀。第二句话在这里。第三句话在这里。';

function world() {
  let now = 0, next = 0, known = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const emitted: HeldBubbleEvent[] = [];
  const hold = new UnboundBubbleHold({
    emit: event => { emitted.push(event); },
    now: () => now, setTimer: (fn, ms) => { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; }, clearTimer: id => { timers.delete(id as number); },
  });
  hold.connect({ follows: () => true, segmentEnd: (id, index) => id === 'r1' && index < known ? ENDS[index] : null });
  return { hold, emitted,
    learn(count: number) { known = count; },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn();
      }
      now = end;
    },
    sent: () => emitted.filter(event => event.type === 'delta').map(event => event.text).join(''),
    done: () => emitted.some(event => event.type === 'done'),
  };
}

/** The reply as the journal shows it: the whole text is there within seconds, the first sentence (a stage direction) is skipped at once. */
function streamIn(w: ReturnType<typeof world>): void {
  w.hold.take({ id: 'r1', type: 'delta', text: BODY.slice(0, 13) });
  w.learn(2); w.hold.take({ id: 'r1', type: 'delta', text: BODY.slice(13) });
  w.learn(3); w.hold.take({ id: 'r1', type: 'done', text: '' });
}

test('without a pause the stall still lets the whole reply go (the old, shipped behaviour the pause has to beat)', () => {
  const w = world();
  streamIn(w);
  w.advance(400); w.hold.heard('r1', 0, 'skip');
  w.advance(10_000);
  assert.equal(w.sent(), BODY, 'her voice never reached the next sentence: the stall guard shows everything (this is right when her voice really stalled)');
});

test('her reading paused because you looked away: the bubble keeps what was shown and sends nothing while she is paused', () => {
  const w = world();
  streamIn(w);
  w.advance(400); w.hold.heard('r1', 0, 'skip');
  w.hold.pauseForAway(); // the 'pose-use' read-pause 'paused' fact (20:34:18.204)
  const before = w.emitted.length;
  w.advance(26_000);
  assert.equal(w.emitted.length, before, '26 s of pause: not one more piece, no done (the bubble must not finish and fade)');
  assert.equal(w.sent(), BODY.slice(0, 5), 'only the sentence her voice had passed is shown');
  assert.equal(w.hold.holding, 'r1');
});

test('you are back: her voice reads on and the bubble shows each sentence as it starts, then finishes after the last one', () => {
  const w = world();
  streamIn(w);
  w.advance(400); w.hold.heard('r1', 0, 'skip');
  w.hold.pauseForAway(); w.advance(26_000); w.hold.resumeFromAway(); // 20:34:43.792
  assert.equal(w.sent(), BODY.slice(0, 5), 'the resume does not dump the held text');
  w.advance(1_000); w.hold.heard('r1', 1, 'start');
  assert.equal(w.sent(), BODY.slice(0, 13), 'the voice is reading the second sentence: its words are on screen');
  w.hold.heard('r1', 1, 'end'); w.hold.heard('r1', 2, 'start');
  assert.equal(w.sent(), BODY, 'the third sentence too');
  assert.ok(w.done(), 'the bubble ends only after its last sentence was shown');
});

test('the clocks go on from where they stopped: a voice that really stalls after the resume still lets go', () => {
  const w = world();
  streamIn(w);
  w.advance(400); w.hold.heard('r1', 0, 'skip');
  w.hold.pauseForAway(); w.advance(26_000); w.hold.resumeFromAway();
  w.advance(10_000);
  assert.equal(w.sent(), BODY, 'after the resume the next-sentence stall guard works again');
});

test('a pause nobody ends does not hold her bubble for good (the window closed): the hold lets go after the away window plus a margin', () => {
  const w = world();
  streamIn(w);
  w.advance(400); w.hold.heard('r1', 0, 'skip');
  w.hold.pauseForAway();
  w.advance(10 * 60_000);
  assert.equal(w.sent(), BODY, 'the guard resumed it, the stall clock then let everything go');
});

test('the reading ended quietly (you stayed away): everything is shown at once even while paused', () => {
  const w = world();
  streamIn(w);
  w.advance(400); w.hold.heard('r1', 0, 'skip');
  w.hold.pauseForAway(); w.advance(5_000);
  w.hold.release('r1', 'cancelled'); // endAwayReading stops her voice: the host's cancel releases the hold
  assert.equal(w.sent(), BODY);
  assert.ok(w.done());
});

test('the window\'s pose-use fact reaches the bubble: paused pauses it, resumed and ended go on, anything else changes nothing', () => {
  const calls: string[] = [];
  const hold = { pauseForAway: () => { calls.push('pause'); }, resumeFromAway: () => { calls.push('resume'); } };
  applyReadPause(hold, { use: 'read-pause', event: 'paused' });
  applyReadPause(hold, { use: 'read-pause', event: 'resumed', seconds: 26 });
  applyReadPause(hold, { use: 'read-pause', event: 'ended', seconds: 40 });
  applyReadPause(hold, { use: 'barge-hold', event: 'held' });
  applyReadPause(hold, { use: 'read-pause', event: 'nod' });
  applyReadPause(hold, 'paused');
  applyReadPause(null, { use: 'read-pause', event: 'paused' });
  assert.deepEqual(calls, ['pause', 'resume', 'resume']);
  assert.equal(readPauseOf({ use: 'read-pause', event: 'paused', extra: 1 }), null, 'the fact is exactly the closed shape the journal accepts');
});
