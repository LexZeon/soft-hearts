import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADAPT_GRACE_MS, ADAPT_WINDOW_MS, AdaptDown, FrameGovernor, OVER_BUDGET, PERF_TIERS, QUIET_AFTER_MS, QUIET_FPS, SELF_TEST_MEASURE_MS, SELF_TEST_WARMUP_MS,
  CONFIRM_TESTS, SelfTest, confirmedTests, lowerTier, parsePerf, perfKey, percentile, serializePerf, startingTier, tierOf,
} from '../shared/unbound/perf-tiers';

/** Feeds a source of frame intervals at the display's tick (one frame per interval) until `until` ms; returns the first non-trivial step. */
function drive(test: SelfTest, intervalOf: (tier: string) => number, until = 60_000) {
  let now = 1_000;
  const applied: string[] = [];
  for (; now < until; ) {
    const step = test.feed(now, intervalOf(test.tier));
    if (step.apply) applied.push(step.apply);
    if (step.done) return { done: step.done, applied, at: now };
    now += intervalOf(test.tier);
  }
  return { done: null, applied, at: now };
}

test('tiers go from high to low, each cheaper on at least one axis, none above the user physics', () => {
  assert.deepEqual(PERF_TIERS.map(t => t.id), ['high', 'medium', 'low']);
  for (let i = 1; i < PERF_TIERS.length; i++) {
    const a = PERF_TIERS[i - 1]!, b = PERF_TIERS[i]!;
    assert.ok(b.pixelRatioCap <= a.pixelRatioCap && b.fps <= a.fps, `${b.id} is no dearer than ${a.id}`);
    assert.ok(b.pixelRatioCap < a.pixelRatioCap || b.fps < a.fps || b.antialias !== a.antialias);
  }
  assert.equal(lowerTier('high'), 'medium'); assert.equal(lowerTier('medium'), 'low'); assert.equal(lowerTier('low'), 'low');
  assert.equal(tierOf('ultra'), null);
});

test('self-test keeps the highest tier whose p95 fits, throwing the warm-up away', () => {
  // A machine that holds 60 fps at every tier: stays at high, after the warm-up and the measuring stretch.
  const fast = drive(new SelfTest(), () => 16.7);
  assert.equal(fast.done, 'high'); assert.deepEqual(fast.applied, ['high']);
  assert.ok(fast.at - 1_000 >= SELF_TEST_WARMUP_MS + SELF_TEST_MEASURE_MS);
  // High cannot hold (28 ms frames); medium can: the answer is medium, high was tried first.
  const mid = drive(new SelfTest(), tier => (tier === 'high' ? 28 : 16.7));
  assert.equal(mid.done, 'medium'); assert.deepEqual(mid.applied, ['high', 'medium']);
  // Only low (30 fps, 33 ms) fits.
  const slow = drive(new SelfTest(), tier => (tier === 'low' ? 33.3 : 40));
  assert.equal(slow.done, 'low');
  // Nothing fits: the lowest tier is kept, not an endless loop.
  assert.equal(drive(new SelfTest(), () => 90).done, 'low');
});

test('a warm-up hitch does not lower her; hitches in the measured stretch do', () => {
  const hitchy = (hitchIn: 'warm' | 'measure') => {
    const test = new SelfTest();
    let now = 0, result: string | null = null;
    while (!result && now < 20_000) {
      const warm = now < SELF_TEST_WARMUP_MS;
      const bad = hitchIn === 'warm' ? warm : !warm;
      const step = test.feed(now, bad ? 60 : 16.7);
      if (step.done) result = step.done;
      now += bad ? 60 : 16.7;
    }
    return result;
  };
  assert.equal(hitchy('warm'), 'high');
  assert.notEqual(hitchy('measure'), 'high');
});

test('a re-test inside a session starts at the current tier and never goes up', () => {
  assert.equal(drive(new SelfTest('medium'), () => 16.7).done, 'medium');
  assert.deepEqual(drive(new SelfTest('medium'), () => 16.7).applied, ['medium']);
});

test('adapt down: ten seconds over budget drops once, a short hitch or a calm machine does not', () => {
  const watch = new AdaptDown();
  watch.reset(0);
  let now = ADAPT_GRACE_MS, dropAt: number | null = null;
  for (let i = 0; i < 2_000 && dropAt === null; i++) { now += 30; if (watch.feed(now, 30, 60)) dropAt = now; } // 30 ms when 16.7 is asked
  assert.ok(dropAt !== null, 'dropped');
  assert.ok(dropAt! - ADAPT_GRACE_MS >= ADAPT_WINDOW_MS * 0.9, `waited the window (${dropAt})`);
  // After a reset there is a grace stretch; nothing fires inside it, even with slow frames.
  watch.reset(dropAt!);
  let again: number | null = null;
  for (let t = dropAt! + 30; t < dropAt! + 60_000 && again === null; t += 30) if (watch.feed(t, 30, 60)) again = t;
  // The next drop (still slow after the first one) comes after the grace stretch and a full window of bad seconds, not at once.
  assert.ok(again !== null && again - dropAt! >= ADAPT_GRACE_MS + ADAPT_WINDOW_MS * 0.8, `second drop ${again! - dropAt!} ms after the first`);

  const calm = new AdaptDown(); calm.reset(0);
  for (let t = ADAPT_GRACE_MS; t < 60_000; t += 16.7) assert.equal(calm.feed(t, 16.7, 60), false);

  // A 1.5 s stall of 100 ms frames (a scene loading) in otherwise good frames: under 5 % of the window, no drop.
  const hitch = new AdaptDown(); hitch.reset(0);
  let t = ADAPT_GRACE_MS, fired = false;
  for (let i = 0; i < 1_800 && !fired; i++) { const slow = i > 300 && i < 315; t += slow ? 100 : 16.7; fired = hitch.feed(t, slow ? 100 : 16.7, 60); }
  assert.equal(fired, false);
});

test('adapt down judges frames against the rate they were asked for, and skips the frame where the rate changed', () => {
  const watch = new AdaptDown(); watch.reset(0);
  // Quiet 30 fps with 33 ms frames is on time; and the 33 ms frame right after waking at 60 is not held against her.
  let t = ADAPT_GRACE_MS;
  for (let i = 0; i < 1_000; i++) { t += 33.3; assert.equal(watch.feed(t, 33.3, 30), false); }
  assert.equal(watch.feed(t + 33.3, 33.3, 60), false); // the wake-up frame: the rate changed, skipped
  // A display that goes quiet and wakes all the time: each wake-up frame is 33 ms at the 60 fps rate (late), one frame in nine. Not a slow machine.
  const flipping = new AdaptDown(); flipping.reset(0);
  let u = ADAPT_GRACE_MS, fired = false;
  for (let cycle = 0; cycle < 400 && !fired; cycle++) {
    for (let i = 0; i < 3; i++) { u += 33.3; fired ||= flipping.feed(u, 33.3, 30); }
    u += 33.3; fired ||= flipping.feed(u, 33.3, 60); // the wake-up frame
    for (let i = 0; i < 5; i++) { u += 16.7; fired ||= flipping.feed(u, 16.7, 60); }
  }
  assert.equal(fired, false, 'wake-up frames are not held against her');
});

test('the adapt watcher offers no way up: only a drop signal exists', () => {
  const watch = new AdaptDown(); watch.reset(0);
  const result = watch.feed(5_000, 16.7, 60);
  assert.equal(typeof result, 'boolean');
});

test('quiet governor: 30 fps after calm, full rate the same tick anything moves', () => {
  const g = new FrameGovernor(60);
  const tick = 1000 / 60;
  let now = 0, drawn = 0;
  const run = (ms: number, busy: boolean) => { const end = now + ms; let n = 0; for (; now < end; now += tick) if (g.admit(now, busy)) { drawn++; n++; } return n; };
  // Moving: every tick.
  const busyDrawn = run(1_000, true);
  assert.ok(Math.abs(busyDrawn - 60) <= 1, `full rate while busy (${busyDrawn})`);
  // Calm: the first QUIET_AFTER_MS at full rate, then 30 fps.
  run(QUIET_AFTER_MS, false);
  const quiet = run(2_000, false);
  assert.ok(Math.abs(quiet - 60) <= 2, `about 30 fps while calm (${quiet} in 2 s)`);
  assert.equal(g.fps, QUIET_FPS); assert.equal(g.quiet, true);
  // Wake: drawn at once (the very tick), then full rate.
  let sawAtOnce = false;
  for (let tries = 0; tries < 1; tries++) { sawAtOnce = g.admit(now, true); now += tick; }
  assert.equal(sawAtOnce, true, 'the wake tick draws');
  assert.equal(g.fps, 60);
  const again = run(1_000, true);
  assert.ok(Math.abs(again - 60) <= 1, `full rate again (${again})`);
});

test('wake draws on a tick that would otherwise be skipped', () => {
  const g = new FrameGovernor(60);
  const tick = 1000 / 60;
  let now = 0;
  for (; now < QUIET_AFTER_MS + 1_000; now += tick) g.admit(now, false);
  // Find a tick the quiet governor skips, and wake exactly there.
  let skipped = false;
  for (let i = 0; i < 4 && !skipped; i++) { if (!g.admit(now, false)) { skipped = true; break; } now += tick; }
  assert.ok(skipped, 'the quiet rate skips ticks');
  assert.equal(g.admit(now, true), true, 'the same tick, now busy, draws');
});

test('quiet governor never goes above the tier, a 30 fps tier has no quiet rate, a 144 Hz display averages the asked rate', () => {
  const low = new FrameGovernor(30);
  let now = 0, drawn = 0;
  for (; now < 6_000; now += 1000 / 60) if (low.admit(now, false)) drawn++;
  assert.ok(Math.abs(drawn - 180) <= 3, `30 fps tier stays 30 (${drawn} in 6 s)`);
  assert.equal(low.quiet, false);
  const fast = new FrameGovernor(60);
  drawn = 0;
  for (now = 0; now < 4_000; now += 1000 / 144) if (fast.admit(now, true)) drawn++;
  assert.ok(Math.abs(drawn - 240) <= 6, `60 fps on 144 Hz (${drawn} in 4 s)`);
  const off = new FrameGovernor(60, false);
  drawn = 0;
  for (now = 0; now < 5_000; now += 1000 / 60) if (off.admit(now, false)) drawn++;
  assert.ok(drawn >= 298, 'quiet off: stays at the tier rate');
});

test('the stored record round-trips; a different display or model, an old drop record or an unconfirmed lower tier means a new test', () => {
  const key = perfKey(2560, 1520, 1.5, '12345:200');
  const stored = parsePerf(serializePerf('medium', key, 1_000, false, CONFIRM_TESTS))!;
  assert.equal(stored.tier, 'medium');
  assert.equal(startingTier(stored, key), 'medium');
  assert.equal(startingTier(stored, perfKey(1920, 1080, 1, '12345:200')), null, 'another display');
  assert.equal(startingTier(stored, perfKey(2560, 1520, 1.5, '999:1')), null, 'another model');
  assert.equal(startingTier(stored, null), 'medium', 'key unknown yet: start at the stored tier');
  assert.equal(startingTier(null, key), null);
  assert.equal(startingTier(parsePerf(serializePerf('low', key, 1_000, true, 5))!, key), null, 'a drop record (older builds) is never trusted');
  assert.equal(startingTier(parsePerf(serializePerf('low', key, 1_000, false, 1))!, key), null, 'one self-test below high is provisional');
  assert.equal(startingTier(parsePerf(serializePerf('low', key, 1_000, false, 2))!, key), 'low', 'two starts agreed');
  assert.equal(startingTier(parsePerf(serializePerf('high', key, 1_000, false, 1))!, key), 'high', 'high needs no confirmation');
  assert.equal(parsePerf('{"v":1,"tier":"low","key":"k","at":1,"adapted":false}')!.tests, 1, 'an older record counts as one test');
  assert.equal(confirmedTests(parsePerf(serializePerf('low', key, 1, false, 1)), key, 'low', true), 2, 'same tier on the same display, from the top: agrees');
  assert.equal(confirmedTests(parsePerf(serializePerf('low', key, 1, false, 1)), key, 'medium', true), 1, 'another tier: starts over');
  assert.equal(confirmedTests(parsePerf(serializePerf('low', key, 1, false, 1)), key, 'low', false), 1, 'a test that did not start from the top does not confirm');
  assert.equal(confirmedTests(parsePerf(serializePerf('low', key, 1, true, 1)), key, 'low', true), 1, 'a drop record does not confirm');
  for (const bad of [null, '', 'nope', '{"v":2}', JSON.stringify({ v: 1, tier: 'ultra', key, at: 0 }), JSON.stringify({ v: 1, tier: 'low', key: 5, at: 0 })]) assert.equal(parsePerf(bad), null);
});

test('percentile is nearest rank and ignores non-finite values', () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, NaN], 0.5), 5);
  assert.ok(OVER_BUDGET > 1);
});
