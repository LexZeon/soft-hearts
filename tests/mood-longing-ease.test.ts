// I-085: seeing the user there (her own camera look) eases her longing a little. Longing stays time-based;
// the ease is subtracted, never makes it negative, is never stored up beyond the longing she has, resets with a real interaction,
// and is not an interaction itself (lastInteractionAt and boredom stay, so she can still speak first).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MOOD_PARAMETERS, advanceMood, applyMoodEvent, applyMoodLift, createMoodState, restoreMoodState } from '../shared/foundation/mood';
import { MOOD_MOMENTS } from '../shared/foundation/mood-moments';
import { MoodMoments, type MoodMomentLift } from '../electron/mood/mood-moments';

const HOUR = 3_600_000;
const p = DEFAULT_MOOD_PARAMETERS;
const start = Date.UTC(2026, 10, 1, 12);

/** A state whose last interaction was `hoursAgo` hours before `now`. */
function stateAt(hoursAgo: number, now: number) {
  const first = applyMoodEvent(createMoodState(start, p), { type: 'food', id: 'fed' }, start, p);
  return advanceMood({ ...first, lastInteractionAt: now - hoursAgo * HOUR }, now, { online: true }, p);
}
const lookLift = (id: string, ease = 4) => ({ id, delta: {}, reason: '她看了你一眼，你在', keepReason: true, longingEase: ease });

test('seeing the user eases longing by the given points, and longing keeps growing from there', () => {
  const now = start + 48 * HOUR;
  const before = stateAt(30, now);                        // 30 h since the last interaction: (30 - 12) * 1.5 = 27 points
  assert.ok(Math.abs(before.longing - (30 * HOUR - p.longing.graceMs) / HOUR * p.longing.perHour) < 1e-6);
  const eased = applyMoodLift(before, lookLift('look-1'), now, p);
  assert.ok(Math.abs(eased.longing - (before.longing - 4)) < 1e-6, String(eased.longing));
  const later = advanceMood(eased, now + 2 * HOUR, { online: true }, p);
  assert.ok(Math.abs(later.longing - (before.longing + 2 * p.longing.perHour - 4)) < 1e-6, String(later.longing));
});

test('seeing is not an interaction: last interaction and boredom stay', () => {
  const now = start + 48 * HOUR;
  const before = stateAt(30, now);
  const eased = applyMoodLift(before, lookLift('look-2'), now, p);
  assert.equal(eased.lastInteractionAt, before.lastInteractionAt);
  assert.equal(eased.boredom, before.boredom);
  assert.equal(eased.reunion, before.reunion);
});

test('the ease never makes longing negative and is never stored up against the future', () => {
  const now = start + 48 * HOUR;
  const small = stateAt(13, now);                          // 1.5 points of longing
  const eased = applyMoodLift(small, lookLift('look-3'), now, p);
  assert.equal(eased.longing, 0);
  assert.ok(Math.abs((eased.longingEase ?? 0) - small.longing) < 1e-6, 'capped at the longing she had');
  const later = advanceMood(eased, now + HOUR, { online: true }, p);
  assert.ok(Math.abs(later.longing - p.longing.perHour) < 1e-6, String(later.longing));
});

test('a real interaction resets the ease with longing', () => {
  const now = start + 48 * HOUR;
  const eased = applyMoodLift(stateAt(30, now), lookLift('look-4'), now, p);
  assert.ok((eased.longingEase ?? 0) > 0);
  const met = applyMoodEvent(eased, { type: 'food', id: 'fed-again' }, now + 1_000, p);
  assert.equal(met.longing, 0);
  assert.equal(met.longingEase, 0);
  const later = advanceMood(met, now + 1_000 + p.longing.graceMs + 2 * HOUR, { online: true }, p);
  assert.ok(Math.abs(later.longing - 2 * p.longing.perHour) < 1e-6, 'grows normally again');
});

test('no ease before any interaction, and the same look id eases once', () => {
  const now = start + 48 * HOUR;
  const fresh = createMoodState(start, p);
  assert.equal(applyMoodLift(fresh, lookLift('look-5'), now, p).longingEase, undefined);
  const before = stateAt(30, now);
  const once = applyMoodLift(before, lookLift('look-6'), now, p);
  const twice = applyMoodLift(once, lookLift('look-6'), now, p);
  assert.equal(twice.longing, once.longing);
});

test('the ease survives a restart and a bad value is refused', () => {
  const now = start + 48 * HOUR;
  const eased = applyMoodLift(stateAt(30, now), lookLift('look-7'), now, p);
  const restored = restoreMoodState(JSON.parse(JSON.stringify(eased)), now, p);
  assert.equal(restored.longingEase, eased.longingEase);
  assert.throws(() => restoreMoodState({ ...JSON.parse(JSON.stringify(eased)), longingEase: -1 }, now, p));
  const old = JSON.parse(JSON.stringify(stateAt(30, now)));
  delete old.longingEase;
  assert.equal(restoreMoodState(old, now, p).longingEase, undefined, 'older states load as before');
});

test('only "she saw you there" carries the ease, and it applies even when its O lift scales to nothing', () => {
  assert.equal(MOOD_MOMENTS['look-present'].longingEase, 4);
  assert.equal(MOOD_MOMENTS['look-smile'].longingEase, undefined);
  const lifts: MoodMomentLift[] = [];
  const baseline = { D: 50, O: 50, E: 50, N: 50, C: 50 };
  const moments = new MoodMoments({
    clock: () => start, current: () => 'c',
    // O far above baseline: the relative O lift scales to nothing.
    state: () => ({ values: { ...baseline, O: 100 }, baseline, evidence: 1, primary: 'close' }),
    lift: lift => { lifts.push(lift); return true; },
  });
  assert.equal(moments.note('look-present', 'c', 'k1'), true);
  assert.equal(lifts.length, 1);
  assert.equal(lifts[0].longingEase, 4);
  assert.equal(moments.note('look-smile', 'c', 'k2') && lifts.at(-1)?.longingEase, undefined);
});
