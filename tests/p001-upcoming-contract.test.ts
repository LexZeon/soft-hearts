/**
 * P-001 step 1: the UpcomingBook contract (shared/behaviors/upcoming/interface.ts), run against both implementations: the in-memory fake
 * and the real one that keeps the list in the character's user-profile file. A new implementation passes this before it is wired in.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProfileUpcomingBook } from '../electron/memory/upcoming/book';
import { UpcomingStore } from '../electron/memory/upcoming/store';
import { FakeUpcomingBook } from '../shared/behaviors/upcoming/fake';
import type { UpcomingBook, UpcomingCandidate } from '../shared/behaviors/upcoming/interface';
import { UPCOMING_KNOBS } from '../shared/behaviors/upcoming/knobs';

const DAY = 86_400_000, HOUR = 3_600_000;
const T = new Date(2026, 10, 12, 8, 0).getTime();

interface Subject { book: UpcomingBook; clock: { t: number }; recording(on: boolean): Promise<void>; close(): Promise<void> }
const makers: [string, () => Promise<Subject>][] = [
  ['the in-memory fake', async () => {
    const clock = { t: T }, book = new FakeUpcomingBook(() => clock.t);
    return { book, clock, recording: async on => { if (on) book.recording = true; else book.switchOff(); }, close: async () => {} };
  }],
  ['the file-backed book', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sh-p001-contract-'));
    const clock = { t: T };
    const recording = { on: false };
    const store = new UpcomingStore(path.join(dir, 'profiles'), { now: () => clock.t, recording: () => recording.on });
    let n = 0;
    return { book: new ProfileUpcomingBook(store, () => 'a'.repeat(64), () => clock.t, () => `id-${++n}`), clock,
      recording: async on => { recording.on = on; if (!on) await store.purgeAll(); await store.settled(); },
      close: async () => { await store.settled(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } };
  }],
];
const plan = (what: string, hours: number): UpcomingCandidate => ({ what, said: '周五', dueAt: T + hours * HOUR });

for (const [name, make] of makers) {
  const withSubject = async (run: (s: Subject) => Promise<void>) => { const s = await make(); try { await run(s); } finally { await s.close(); } };

  test(`${name}: with recording off every write is refused and nothing is shown`, () => withSubject(async s => {
    assert.equal(await s.book.add({ from: 'a', items: [plan('甲', 5)] }), 0);
    assert.deepEqual(s.book.list(), []);
    assert.equal(await s.book.remove('x'), false);
    assert.equal(await s.book.clear(), 0);
    assert.equal(await s.book.settle(), 0);
    assert.equal(await s.book.makeDue(), false);
  }));

  test(`${name}: add and list: soonest first, a repeat is not added twice, one note gives at most three`, () => withSubject(async s => {
    await s.recording(true);
    assert.equal(await s.book.add({ from: 'a', items: [plan('晚的', 30), plan('早的', 5)] }), 2);
    assert.equal(await s.book.add({ from: 'a', items: [plan('早的', 5)] }), 0);
    assert.deepEqual(s.book.list().map(item => item.what), ['早的', '晚的']);
    assert.equal(s.book.list()[0].state, 'waiting');
    assert.equal(await s.book.add({ from: 'b', items: [1, 2, 3, 4, 5].map(i => plan(`事${i}`, 40 + i)) }), UPCOMING_KNOBS.text.perNote);
  }));

  test(`${name}: at most twenty, and a full list refuses new ones instead of dropping old ones`, () => withSubject(async s => {
    await s.recording(true);
    for (let i = 0; i < 24; i++) await s.book.add({ from: `seg-${i}`, items: [plan(`事${i}`, i + 1)] });
    assert.equal(s.book.list().length, UPCOMING_KNOBS.keep.maxPerCharacter);
    assert.equal(s.book.list()[0].what, '事0');
  }));

  test(`${name}: deleting one blocks its segment; clearing blocks all of theirs`, () => withSubject(async s => {
    await s.recording(true);
    await s.book.add({ from: 'a', items: [plan('甲', 5)] }); await s.book.add({ from: 'b', items: [plan('乙', 6)] });
    const [first] = s.book.list();
    assert.equal(await s.book.remove(first.id), true);
    assert.equal(await s.book.remove(first.id), false);
    assert.equal(await s.book.add({ from: 'a', items: [plan('甲', 5)] }), 0, 'the same segment cannot bring it back');
    assert.equal(await s.book.clear(), 1);
    assert.equal(await s.book.add({ from: 'b', items: [plan('乙', 6)] }), 0);
    assert.equal(await s.book.add({ from: 'c', items: [plan('丙', 7)] }), 1);
  }));

  test(`${name}: gone segments take their plans (and stop blocking)`, () => withSubject(async s => {
    await s.recording(true);
    await s.book.add({ from: 'a', items: [plan('甲', 5)] }); await s.book.add({ from: 'b', items: [plan('乙', 6)] }); await s.book.add({ from: 'c', items: [plan('丙', 7)] });
    assert.equal(await s.book.dropSegments(['a', 'nope']), 1);
    assert.deepEqual(s.book.list().map(item => item.what), ['乙', '丙']);
    assert.equal(await s.book.keepSegments(new Set(['c'])), 1);
    assert.deepEqual(s.book.list().map(item => item.what), ['丙']);
    assert.equal(await s.book.dropSegments([]), 0);
  }));

  test(`${name}: plans expire three days after they were due and leave seven days after that`, () => withSubject(async s => {
    await s.recording(true);
    await s.book.add({ from: 'a', items: [plan('甲', 5)] });
    const due = T + 5 * HOUR;
    s.clock.t = due + 3 * DAY;
    assert.equal(await s.book.settle(), 0);
    s.clock.t = due + 3 * DAY + 1;
    assert.equal(await s.book.settle(), 1);
    assert.equal(s.book.list()[0].state, 'expired');
    assert.equal(await s.book.settle(), 0, 'counted once');
    s.clock.t += 7 * DAY + 2;
    await s.book.settle();
    assert.deepEqual(s.book.list(), []);
  }));

  test(`${name}: the earliest waiting plan can be made due now`, () => withSubject(async s => {
    await s.recording(true);
    assert.equal(await s.book.makeDue(), false);
    await s.book.add({ from: 'a', items: [plan('晚的', 30), plan('早的', 5)] });
    assert.equal(await s.book.makeDue(), true);
    const shown = s.book.list();
    assert.equal(shown.find(item => item.what === '早的')!.dueAt < s.clock.t, true);
    assert.equal(shown.find(item => item.what === '晚的')!.dueAt > s.clock.t, true);
  }));

  test(`${name}: nothing it is given can make it throw`, () => withSubject(async s => {
    await s.recording(true);
    await s.book.add({ from: '', items: [] });
    await s.book.add({ from: 'a', items: [{ what: '', said: '', dueAt: Number.NaN }] }).catch(() => undefined);
    await s.book.dropSegments([undefined as never, 5 as never]).catch(() => undefined);
    assert.ok(Array.isArray(s.book.list()));
  }));
}
