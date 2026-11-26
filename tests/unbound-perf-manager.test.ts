import assert from 'node:assert/strict';
import test from 'node:test';
import { PerfManager, type PerfStorage } from '../src/unbound/perf';
import { ADAPT_GRACE_MS, ADAPT_WINDOW_MS, CALM_BEFORE_TEST_MS, PERF_STORAGE_KEY, RAISE_AFTER_S, perfKey, type PerfTier } from '../shared/unbound/perf-tiers';
import { PERF_JOURNAL_KEY, parseJournal } from '../shared/unbound/perf-raise';

function memory(): PerfStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}
const KEY = perfKey(2560, 1520, 1.5, '1000:100');

/** A display that tick-draws every `intervalOf(tier)` ms for `ms` (the manager decides which ticks draw). */
function run(manager: PerfManager, from: number, ms: number, intervalOf: (tier: PerfTier) => number, busy = true) {
  let now = from, last = 0;
  while (now < from + ms) {
    if (manager.admit(now, busy)) { if (last) manager.frame(now, now - last); last = now; }
    now += intervalOf(manager.tier) > 16.7 ? intervalOf(manager.tier) : 16.7;
  }
  return now;
}

test('first open: a fast machine is tested at the top tier, keeps it and stores it; the next start begins there', () => {
  const storage = memory(), applied: string[] = [];
  const first = new PerfManager({ storage, onTier: t => applied.push(t.id) });
  first.setKey(KEY);
  assert.equal(first.testing, true);
  run(first, 1_000, 8_000, () => 16.7);
  assert.equal(first.testing, false);
  assert.equal(first.tier.id, 'high');
  assert.match(storage.data.get(PERF_STORAGE_KEY)!, /"tier":"high".*"adapted":false/);
  const second = new PerfManager({ storage, onTier: () => {} });
  second.setKey(KEY);
  assert.equal(second.testing, false, 'a stored tier for the same display and model is not tested again');
  assert.equal(second.tier.id, 'high');
});

test('first open on a slow machine settles on the highest tier that fits', () => {
  const storage = memory();
  const m = new PerfManager({ storage, onTier: () => {} });
  m.setKey(KEY);
  run(m, 1_000, 30_000, tier => (tier.id === 'low' ? 33.3 : 40));
  assert.equal(m.tier.id, 'low');
  assert.equal(JSON.parse(storage.data.get(PERF_STORAGE_KEY)!).tier, 'low');
});

test('a different display or model tests again; a session never starts a test above the current tier after the first', () => {
  const storage = memory();
  const first = new PerfManager({ storage, onTier: () => {} });
  first.setKey(KEY);
  run(first, 1_000, 14_000, tier => (tier.id === 'high' ? 40 : 16.7));
  assert.equal(first.tier.id, 'medium');
  const other = new PerfManager({ storage, onTier: () => {} });
  other.setKey(perfKey(1920, 1080, 1, '1000:100'));
  assert.equal(other.testing, true, 'another display: tested');
  // Inside a session the display changes: the new test starts from the current tier (medium), so high is never tried again.
  const seen: string[] = [];
  storage.setItem(PERF_STORAGE_KEY, JSON.stringify({ v: 1, tier: 'medium', key: KEY, at: 1, adapted: false, tests: 2 })); // confirmed by two starts
  const session = new PerfManager({ storage, onTier: t => seen.push(t.id) });
  session.setKey(KEY);
  assert.equal(session.testing, false);
  session.setKey(perfKey(1920, 1080, 1, '1000:100'));
  assert.equal(session.testing, true);
  run(session, 1_000, 8_000, () => 16.7);
  assert.equal(session.tier.id, 'medium');
  assert.ok(!seen.includes('high'), `never raised: ${seen.join(',')}`);
});

test('adapt: the machine slows down in a session, she drops one tier after the window; nothing is stored, and the floor holds', () => {
  const storage = memory(), seen: string[] = [];
  storage.setItem(PERF_STORAGE_KEY, JSON.stringify({ v: 1, tier: 'high', key: KEY, at: 0, adapted: false }));
  const m = new PerfManager({ storage, onTier: t => seen.push(t.id), wallClock: () => 5_000 });
  m.setKey(KEY);
  assert.equal(m.tier.id, 'high');
  // Smooth for a while, no drop.
  let now = run(m, 0, ADAPT_GRACE_MS + 20_000, () => 16.7);
  assert.equal(m.drops, 0);
  // Then every frame takes 30 ms at the 60 fps tiers.
  const slow = (tier: PerfTier) => (tier.fps === 60 ? 30 : 33.3);
  const start = now;
  const before = storage.data.get(PERF_STORAGE_KEY);
  now = run(m, now, ADAPT_WINDOW_MS + 4_000, slow);
  assert.equal(m.tier.id, 'medium', 'one tier down');
  assert.equal(m.drops, 1);
  assert.ok(seen.includes('medium'));
  assert.equal(storage.data.get(PERF_STORAGE_KEY), before, 'an adapt-down never outlives the session: the stored record is untouched');
  assert.ok(now - start >= ADAPT_WINDOW_MS * 0.9, 'it waited about the window, not a hitch');
  // Still slow at medium: down once more to low, then the floor holds.
  now = run(m, now, ADAPT_WINDOW_MS * 3, () => 30);
  assert.equal(m.tier.id, 'low');
  run(m, now, 40_000, () => 100);
  assert.equal(m.tier.id, 'low');
});

test('a drop is not carried to the next start: the next start begins at the tested tier (and an older build\'s drop record is tested again)', () => {
  const storage = memory();
  storage.setItem(PERF_STORAGE_KEY, JSON.stringify({ v: 1, tier: 'high', key: KEY, at: 0, adapted: false, tests: 1 }));
  const m = new PerfManager({ storage, onTier: () => {} });
  m.setKey(KEY);
  run(m, 0, ADAPT_GRACE_MS + ADAPT_WINDOW_MS + 5_000, tier => (tier.fps === 60 ? 30 : 33.3));
  assert.equal(m.tier.id, 'medium');
  const next = new PerfManager({ storage, onTier: () => {} });
  assert.equal(next.tier.id, 'high', 'the session that dropped is over: she starts at what was tested');
  next.setKey(KEY);
  assert.equal(next.testing, false);
  const old = memory();
  old.setItem(PERF_STORAGE_KEY, JSON.stringify({ v: 1, tier: 'low', key: KEY, at: 1_000, adapted: true }));
  const fromOld = new PerfManager({ storage: old, onTier: () => {} });
  assert.equal(fromOld.tier.id, 'high', 'an older build stored drops; they are not trusted');
  fromOld.setKey(KEY);
  assert.equal(fromOld.testing, true);
});

test('a single self-test below high is never final: the next start tests again, and only two agreeing starts are trusted', () => {
  const storage = memory();
  const slow = (tier: PerfTier) => (tier.fps === 60 ? 40 : 33.3); // a machine that holds only low
  const first = new PerfManager({ storage, onTier: () => {} });
  first.setKey(KEY);
  run(first, 1_000, 30_000, slow);
  assert.equal(first.tier.id, 'low');
  assert.equal(JSON.parse(storage.data.get(PERF_STORAGE_KEY)!).tests, 1);
  const second = new PerfManager({ storage, onTier: () => {} });
  assert.equal(second.tier.id, 'high', 'the canvas of the next start is made at high, with antialiasing');
  assert.equal(second.startTier.antialias, true);
  second.setKey(KEY);
  assert.equal(second.testing, true, 'one low test is provisional: tested again');
  run(second, 1_000, 30_000, slow);
  assert.equal(second.tier.id, 'low');
  assert.equal(JSON.parse(storage.data.get(PERF_STORAGE_KEY)!).tests, 2, 'two starts agreed');
  const third = new PerfManager({ storage, onTier: () => {} });
  assert.equal(third.tier.id, 'low', 'now it is trusted');
  assert.equal(third.startTier.antialias, false, 'antialiasing goes off only for a low that was confirmed twice');
  third.setKey(KEY);
  assert.equal(third.testing, false);
  // The first start was on a busy machine, the second on a calm one: they disagree, nothing is confirmed, she is high.
  const mixed = memory();
  const a = new PerfManager({ storage: mixed, onTier: () => {} }); a.setKey(KEY); run(a, 1_000, 30_000, slow);
  const b = new PerfManager({ storage: mixed, onTier: () => {} }); b.setKey(KEY); run(b, 1_000, 10_000, () => 16.7);
  assert.equal(b.tier.id, 'high');
  assert.equal(new PerfManager({ storage: mixed, onTier: () => {} }).tier.id, 'high');
});

test('the dev profile\'s case: a stored provisional low (written while busy, no test count) is tested at the next start and comes back to high', () => {
  const storage = memory();
  storage.setItem(PERF_STORAGE_KEY, JSON.stringify({ v: 1, tier: 'low', key: KEY, at: 1, adapted: false }));
  const m = new PerfManager({ storage, onTier: () => {} });
  assert.equal(m.startTier.antialias, true);
  m.setKey(KEY);
  assert.equal(m.testing, true);
  run(m, 1_000, 8_000, () => 16.7);
  assert.equal(m.tier.id, 'high');
  assert.equal(JSON.parse(storage.data.get(PERF_STORAGE_KEY)!).tier, 'high');
});

test('busy: the self-test waits for a quiet moment, starts after a calm stretch, and is dropped and retried when the app gets busy in the middle', () => {
  const storage = memory(), seen: string[] = [];
  let appBusy = true;
  const m = new PerfManager({ storage, onTier: t => seen.push(t.id), busy: () => appBusy });
  m.setKey(KEY);
  assert.equal(m.testing, true);
  // A call is on: frames are drawn, but nothing is measured and nothing is stored.
  let now = run(m, 1_000, 20_000, () => 16.7);
  assert.equal(storage.data.has(PERF_STORAGE_KEY), false, 'no result while busy');
  assert.equal(m.tier.id, 'high');
  assert.deepEqual(seen, [], 'the tiers were not tried');
  // Quiet again: the test needs CALM_BEFORE_TEST_MS of calm first, then runs.
  appBusy = false;
  const calmAt = now;
  now = run(m, now, CALM_BEFORE_TEST_MS - 500, () => 16.7);
  assert.equal(storage.data.has(PERF_STORAGE_KEY), false);
  // Busy again in the middle of the test (a reply starts): it is dropped, she goes back to where she was.
  now = run(m, now, 3_000, () => 16.7);
  assert.ok(now - calmAt > CALM_BEFORE_TEST_MS);
  appBusy = true;
  m.admit(now, true);
  assert.equal(storage.data.has(PERF_STORAGE_KEY), false, 'a half-finished test stores nothing');
  assert.equal(m.tier.id, 'high');
  // Calm for good: it finishes.
  appBusy = false;
  run(m, now + 100, 20_000, () => 16.7);
  assert.equal(m.testing, false);
  assert.match(storage.data.get(PERF_STORAGE_KEY)!, /"tier":"high"/);
});

test('raise: after a sustained comfortable stretch she goes back up one tier; if that goes over budget she falls back and waits longer; antialias is untouched', () => {
  const storage = memory(), seen: string[] = [];
  const m = new PerfManager({ storage, onTier: t => seen.push(t.id), wallClock: () => 9_000 });
  const antialias = m.startTier.antialias; // read once, when the canvas is made
  storage.setItem(PERF_STORAGE_KEY, JSON.stringify({ v: 1, tier: 'high', key: KEY, at: 0, adapted: false, tests: 1 }));
  m.setKey(KEY);
  // The machine is slow for a while (another program): she drops to medium, then low.
  let now = run(m, 0, 40_000, tier => (tier.id === 'low' ? 33.3 : 40));
  assert.equal(m.tier.id, 'low');

  // It calms down. A hitch inside the stretch starts the count again; she stays at low until 45 comfortable seconds in a row.
  now = run(m, now, 20_000, () => 33.3);
  now = run(m, now, 1_500, () => 100);
  assert.equal(m.tier.id, 'low', 'a hitch restarts the count');
  now = run(m, now, RAISE_AFTER_S * 1000 + 6_000, tier => (tier.fps === 30 ? 33.3 : 16.7));
  assert.equal(m.tier.id, 'medium', 'one tier up, not two');
  assert.equal(m.raises, 1);
  // Medium does not hold: she falls back within a trial, and the next wait is twice as long.
  now = run(m, now, ADAPT_WINDOW_MS + ADAPT_GRACE_MS + 4_000, tier => (tier.id === 'medium' ? 40 : 33.3));
  assert.equal(m.tier.id, 'low', 'over budget: back down');
  now = run(m, now, RAISE_AFTER_S * 1000 + 6_000, tier => (tier.fps === 30 ? 33.3 : 16.7));
  assert.equal(m.tier.id, 'low', 'the second wait is longer than the first');
  now = run(m, now, RAISE_AFTER_S * 1000 + 6_000, tier => (tier.fps === 30 ? 33.3 : 16.7));
  assert.equal(m.tier.id, 'medium');
  assert.equal(antialias, true, 'made with antialiasing; a tier change inside the session never rebuilds the canvas (applyTier only sets the pixel ratio)');
  const journal = parseJournal(storage.data.get(PERF_JOURNAL_KEY) ?? null);
  assert.deepEqual(journal.map(r => `${r.from}>${r.to}:${r.why}`), ['high>medium:adapt', 'medium>low:adapt', 'low>medium:raise', 'medium>low:adapt', 'low>medium:raise']);
  assert.ok(journal.every(r => Number.isFinite(r.n) && Number.isFinite(r.at)), 'closed words and numbers');
});

test('the journal: a finished self-test writes a row (from, to, why test, p95, how many starts agreed)', () => {
  const storage = memory();
  const m = new PerfManager({ storage, onTier: () => {} });
  m.setKey(KEY);
  run(m, 1_000, 30_000, tier => (tier.fps === 60 ? 40 : 33.3));
  const rows = parseJournal(storage.data.get(PERF_JOURNAL_KEY) ?? null);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.from, rows[0]!.to, rows[0]!.why, rows[0]!.n], ['high', 'low', 'test', 1]);
  assert.ok(typeof rows[0]!.p95 === 'number');
});

test('quiet rate: draws about 30 fps when nothing moves, and the very tick something moves it draws at full rate', () => {
  const m = new PerfManager({ storage: memory(), onTier: () => {}, pin: 'high' });
  let now = 0, drawn = 0;
  for (; now < 4_000; now += 1000 / 60) m.admit(now, false);
  for (const start = now; now < start + 2_000; now += 1000 / 60) if (m.admit(now, false)) drawn++;
  assert.ok(Math.abs(drawn - 60) <= 2, `quiet: ${drawn} frames in 2 s`);
  assert.equal(m.quiet, true);
  let wake = false;
  for (let i = 0; i < 4; i++) { if (!m.admit(now, false)) { wake = m.admit(now, true); break; } now += 1000 / 60; }
  assert.equal(wake, true, 'a skipped tick turned into a drawn one by movement');
  assert.equal(m.quiet, false);
});

test('quiet rate off (measurement): stays at the tier rate; pinned runs store nothing and never test or drop', () => {
  const storage = memory();
  const m = new PerfManager({ storage, onTier: () => {}, pin: 'medium', quiet: false });
  m.setKey(KEY);
  assert.equal(m.testing, false);
  let now = 0, drawn = 0;
  for (; now < 6_000; now += 1000 / 60) if (m.admit(now, false)) drawn++;
  assert.ok(drawn >= 358);
  run(m, now, ADAPT_WINDOW_MS * 2, () => 50);
  assert.equal(m.tier.id, 'medium'); assert.equal(m.drops, 0); assert.equal(storage.data.size, 0);
});

test('no usable storage: the page still works (tests every start, nothing throws)', () => {
  const broken: PerfStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const m = new PerfManager({ storage: broken, onTier: () => {} });
  m.setKey(KEY);
  run(m, 1_000, 8_000, () => 16.7);
  assert.equal(m.tier.id, 'high');
  const none = new PerfManager({ storage: null, onTier: () => {} });
  none.setKey(KEY);
  assert.equal(none.testing, true);
});
