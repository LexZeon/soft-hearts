// I-192: her reply's "凑近一点" (⟦lean-in⟧) stays: at least ARRIVAL_KNOBS.leanInHoldS once played, on
// while she speaks (up to holdCapS), then it eases back by itself (src/unbound/speech-beat-hold.ts). Before, a body word kept its own short time
// (1.8 s), whatever she was still saying. A tilt (another body word) keeps its own short time as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HeldBeats } from '../src/unbound/speech-beat-hold';
import { ARRIVAL_KNOBS } from '../shared/unbound/arrival';
import type { PlayedBeat } from '../src/unbound/showcase/performer';

const beat = (playedAt: number, dur = 1.8) => ({ kind: 'approach', playedAt, dur, intensity: 0.6 } as unknown as PlayedBeat);

test('the lean-in rides her speaking: at least its own hold, up to the cap; a tilt keeps its short time; "once" keeps its short time', () => {
  // She stops speaking soon after: still the lean-in's own hold (before: 1.8 s).
  const a = new HeldBeats(), early = beat(10);
  assert.equal(a.hold('lean-in', early, 10, true), true);
  assert.equal(early.dur, ARRIVAL_KNOBS.holdCapS, 'held to the cap while she speaks');
  a.releaseAll(10.5);
  assert.equal(early.dur, ARRIVAL_KNOBS.leanInHoldS, `she stopped at 0.5 s: it stays its own ${ARRIVAL_KNOBS.leanInHoldS} s`);
  // She speaks on: it stays until she stops.
  const b = new HeldBeats(), long = beat(0);
  b.hold('lean-in', long, 0, 'line');
  b.releaseLine(2); // a sentence's pause does not let it go (it rides the reply)
  assert.equal(long.dur, ARRIVAL_KNOBS.holdCapS);
  b.releaseAll(7.25);
  assert.equal(long.dur, 7.25, 'until she stopped');
  // Speaking past the cap: the cap.
  const c = new HeldBeats(), capped = beat(0);
  c.hold('lean-in', capped, 0, true);
  c.releaseAll(40);
  assert.equal(capped.dur, ARRIVAL_KNOBS.holdCapS);
  // Not held: a tilt, and ⟦lean-in once⟧ (span off).
  const d = new HeldBeats(), tilt = beat(0, 1.8), once = beat(0, 1.8);
  assert.equal(d.hold('tilt', tilt, 0, true), false); assert.equal(tilt.dur, 1.8);
  assert.equal(d.hold('lean-in', once, 0, false), false); assert.equal(once.dur, 1.8);
  // A second lean-in takes over from the first (the first falls at its own least hold).
  const e = new HeldBeats(), first = beat(0), second = beat(5);
  e.hold('lean-in', first, 0, true); e.hold('lean-in', second, 5, true);
  assert.equal(first.dur, 5, 'the first falls when the second comes (past its least hold)');
  assert.equal(second.dur, ARRIVAL_KNOBS.holdCapS);
});
