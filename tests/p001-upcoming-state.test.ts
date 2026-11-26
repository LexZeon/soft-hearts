/**
 * P-001 step 1: the pure rules of the list she remembers (shared/behaviors/upcoming/state.ts): expiry after three days, closed items
 * leaving after seven, at most twenty (never pushing an older one out), deleted segments blocked, cascades, and strict reading from disk.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { UpcomingStored } from '../shared/behaviors/upcoming/interface';
import { UPCOMING_KNOBS } from '../shared/behaviors/upcoming/knobs';
import {
  addUpcoming, clearUpcoming, compactUpcoming, dropUpcomingSegments, dueUpcoming, emptyUpcoming, isEmptyUpcoming, keepUpcomingSegments, makeUpcomingDue,
  markUpcoming, removeUpcoming, settleUpcoming, shownUpcoming, validateUpcoming,
} from '../shared/behaviors/upcoming/state';

const DAY = 86_400_000, HOUR = 3_600_000;
const T = new Date(2026, 10, 12, 18, 0).getTime();
let n = 0;
const id = () => `i${++n}`;
const one = (from = 'seg-1', what = '去面试', dueAt = T, now = T - DAY) => addUpcoming(emptyUpcoming(), { from, items: [{ what, said: '明天下午', dueAt }] }, now, id).state;

test('a new plan waits, is due from its due time, and may be asked about for three days', () => {
  const state = one();
  assert.equal(state.items[0].state, 'waiting');
  assert.equal(state.items[0].expiresAt, T + 3 * DAY);
  assert.deepEqual(dueUpcoming(state, T - 1), [], 'not before');
  assert.equal(dueUpcoming(state, T).length, 1);
  assert.equal(dueUpcoming(state, T + 3 * DAY).length, 1, 'still on the last moment');
  assert.deepEqual(dueUpcoming(state, T + 3 * DAY + 1), [], 'then it is over');
});

test('past three days it quietly expires (no question later), and closed ones leave after seven days', () => {
  const state = one();
  assert.equal(settleUpcoming(state, T + 3 * DAY).expired, 0);
  const late = settleUpcoming(state, T + 3 * DAY + 1);
  assert.equal(late.expired, 1);
  assert.equal(late.state.items[0].state, 'expired');
  assert.equal(late.state.items[0].changedAt, T + 3 * DAY + 1);
  // seven days after it expired it is gone
  assert.equal(settleUpcoming(late.state, late.state.items[0].changedAt + 7 * DAY).state.items.length, 1);
  assert.equal(settleUpcoming(late.state, late.state.items[0].changedAt + 7 * DAY + 1).state.items.length, 0);
  // asked and user-said leave the same way, counted from the change
  const asked = markUpcoming(state, state.items[0].id, 'asked', T + HOUR);
  assert.equal(asked.items[0].state, 'asked');
  assert.equal(settleUpcoming(asked, T + HOUR + 7 * DAY).state.items.length, 1);
  assert.equal(settleUpcoming(asked, T + HOUR + 7 * DAY + 1).state.items.length, 0);
  const said = markUpcoming(state, state.items[0].id, 'user-said', T + HOUR);
  assert.equal(said.items[0].state, 'user-said');
  assert.deepEqual(dueUpcoming(said, T + 2 * HOUR), [], 'once the user said it, she does not ask');
  assert.equal(markUpcoming(asked, asked.items[0].id, 'user-said', T).items[0].state, 'asked', 'only a waiting plan changes state');
});

test('settling an unchanged list gives the same object back (nothing to save)', () => {
  const state = one();
  assert.equal(settleUpcoming(state, T).state, state);
});

test('at most twenty per character; a full list never pushes an older plan out', () => {
  let state = emptyUpcoming();
  for (let i = 0; i < 25; i++) state = addUpcoming(state, { from: `seg-${i}`, items: [{ what: `事${i}`, said: '周五', dueAt: T + i * HOUR }] }, T, id).state;
  assert.equal(state.items.length, UPCOMING_KNOBS.keep.maxPerCharacter);
  assert.equal(state.items[0].what, '事0');
  assert.equal(state.items.at(-1)?.what, '事19');
  const full = addUpcoming(state, { from: 'seg-x', items: [{ what: '新的事', said: '周五', dueAt: T + 99 * HOUR }] }, T, id);
  assert.equal(full.added, 0);
  assert.equal(full.state, state);
});

test('one note gives at most three plans; the same plan is not added twice (a rewritten note says it again)', () => {
  const many = addUpcoming(emptyUpcoming(), { from: 's', items: [1, 2, 3, 4, 5].map(i => ({ what: `事${i}`, said: '周五', dueAt: T + i * HOUR })) }, T, id);
  assert.equal(many.added, 3);
  const again = addUpcoming(many.state, { from: 's', items: [{ what: '事1', said: '周五', dueAt: T + HOUR }, { what: '换个说法', said: '周五', dueAt: T + 2 * HOUR }] }, T, id);
  assert.equal(again.added, 0, 'same segment and moment, or the same words and moment');
  const other = addUpcoming(many.state, { from: 't', items: [{ what: '事1', said: '周五', dueAt: T + HOUR }] }, T, id);
  assert.equal(other.added, 0, 'the same plan said in another segment');
  const different = addUpcoming(many.state, { from: 't', items: [{ what: '事1', said: '周六', dueAt: T + 30 * HOUR }] }, T, id);
  assert.equal(different.added, 1);
});

test('deleting one blocks that segment; clearing blocks every segment it came from; blocked segments add nothing', () => {
  let state = addUpcoming(emptyUpcoming(), { from: 'a', items: [{ what: '甲', said: '周五', dueAt: T }, { what: '乙', said: '周六', dueAt: T + DAY }] }, T, id).state;
  state = addUpcoming(state, { from: 'b', items: [{ what: '丙', said: '周日', dueAt: T + 2 * DAY }] }, T, id).state;
  const removed = removeUpcoming(state, state.items[0].id);
  assert.equal(removed.removed, 1);
  assert.deepEqual(removed.state.blockedFrom, ['a']);
  assert.equal(addUpcoming(removed.state, { from: 'a', items: [{ what: '甲', said: '周五', dueAt: T }] }, T, id).added, 0, 'the same segment cannot bring it back');
  assert.equal(addUpcoming(removed.state, { from: 'c', items: [{ what: '丁', said: '周五', dueAt: T + 5 * DAY }] }, T, id).added, 1, 'other segments still can');
  assert.equal(removeUpcoming(state, 'nope').removed, 0);
  const cleared = clearUpcoming(state);
  assert.equal(cleared.removed, 3);
  assert.deepEqual([...cleared.state.blockedFrom].sort(), ['a', 'b']);
  assert.equal(clearUpcoming(emptyUpcoming()).removed, 0);
});

test('a deleted chat memory or note takes what came from it, and its block mark, with it', () => {
  let state = addUpcoming(emptyUpcoming(), { from: 'a', items: [{ what: '甲', said: '周五', dueAt: T }] }, T, id).state;
  state = addUpcoming(state, { from: 'b', items: [{ what: '乙', said: '周六', dueAt: T + DAY }] }, T, id).state;
  state = removeUpcoming(state, state.items[1].id).state; // blocks b
  const dropped = dropUpcomingSegments(state, ['a', 'b']);
  assert.equal(dropped.removed, 1);
  assert.deepEqual(dropped.state, emptyUpcoming());
  assert.equal(dropUpcomingSegments(state, ['zzz']).state, state, 'nothing to drop: same object');
  const kept = keepUpcomingSegments(state, new Set(['b']));
  assert.equal(kept.removed, 1, 'a is not in the archive any more');
  assert.deepEqual(kept.state.blockedFrom, ['b']);
});

test('what the developer commands add has no chat segment behind it and survives the archive check', () => {
  const state = addUpcoming(emptyUpcoming(), { from: 'dev:123', items: [{ what: '试一试', said: '明天下午', dueAt: T }] }, T, id).state;
  assert.equal(keepUpcomingSegments(state, new Set()).state.items.length, 1);
});

test('the earliest waiting plan can be made due now (developer test), and an empty list has nothing to make due', () => {
  let state = addUpcoming(emptyUpcoming(), { from: 'a', items: [{ what: '晚的', said: '周六', dueAt: T + 2 * DAY }, { what: '早的', said: '周五', dueAt: T + DAY }] }, T, id).state;
  const made = makeUpcomingDue(state, T);
  assert.equal(made.changed, true);
  assert.equal(made.state.items.find(item => item.what === '早的')?.dueAt, T - 60_000);
  assert.equal(made.state.items.find(item => item.what === '晚的')?.dueAt, T + 2 * DAY);
  assert.equal(dueUpcoming(made.state, T).length, 1);
  state = emptyUpcoming();
  assert.equal(makeUpcomingDue(state, T).changed, false);
});

test('the list shown: soonest first, expired last, nothing but id, what, said, due and state', () => {
  let state = addUpcoming(emptyUpcoming(), { from: 'a', items: [{ what: '晚的', said: '周六', dueAt: T + 2 * DAY }, { what: '早的', said: '周五', dueAt: T + DAY }] }, T, id).state;
  state = addUpcoming(state, { from: 'b', items: [{ what: '旧的', said: '昨天', dueAt: T - 10 * DAY }] }, T - 20 * DAY, id).state;
  const shown = shownUpcoming(state, T);
  assert.deepEqual(shown.map(item => item.what), ['早的', '晚的', '旧的']);
  assert.equal(shown[2].state, 'expired');
  assert.deepEqual(Object.keys(shown[0]).sort(), ['dueAt', 'id', 'said', 'state', 'what']);
  assert.deepEqual(shownUpcoming(undefined, T), []);
});

test('nothing at all is not written', () => {
  assert.equal(isEmptyUpcoming(emptyUpcoming()), true);
  assert.equal(compactUpcoming(emptyUpcoming()), undefined);
  assert.equal(compactUpcoming(one()) !== undefined, true);
  assert.equal(compactUpcoming({ items: [], blockedFrom: ['a'] }) !== undefined, true, 'a block mark alone is kept');
});

test('what comes back from disk is read strictly', () => {
  const good = one();
  assert.deepEqual(validateUpcoming(structuredClone(good)), good);
  const bad: unknown[] = [
    null, [], 'x', {}, { items: [], blockedFrom: [], extra: 1 }, { items: 'x', blockedFrom: [] }, { items: [], blockedFrom: [1] },
    { items: [{ ...good.items[0], state: 'done' }], blockedFrom: [] },
    { items: [{ ...good.items[0], dueAt: -1 }], blockedFrom: [] },
    { items: [{ ...good.items[0], what: '' }], blockedFrom: [] },
    { items: [{ ...good.items[0], what: 'x'.repeat(60) }], blockedFrom: [] },
    { items: [{ ...good.items[0], extra: 1 }], blockedFrom: [] },
    { items: [{ ...good.items[0], said: '带\u0000控制符' }], blockedFrom: [] },
    { items: [good.items[0], good.items[0]], blockedFrom: [] },
    { items: Array.from({ length: 21 }, (_, i) => ({ ...good.items[0], id: `x${i}` })), blockedFrom: [] },
  ];
  for (const value of bad) assert.throws(() => validateUpcoming(value), /格式/u, JSON.stringify(value)?.slice(0, 60));
});
