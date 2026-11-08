/**
 * X-343 (docs/claude/2026-11-07-x343-shy-extend.md): the show clock (src/stage/show-clock.ts). Asked again while 害羞 comes in or
 * holds, the show comes to rest in its hold and ends SHOW_MS after the latest ask; the show's time never goes back (procedural
 * life would take that as a restart), its rate is continuous (so every track's speed is), and a show nobody asks again for is the
 * wall clock itself. The Stage frame loop on Gene is in tests/i037-reaction-stage-r29.test.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SHOW_KEYS, SHOW_LIMITS, SHOW_MS, showSample } from '../src/stage/expression-show';
import { showRequest } from '../src/stage/show-blend';
import { SHOW_CLOCK_EASE_MS, SHOW_HOLD, SHOW_HOLD_LATEST_ASK_MS, ShowClock, showEndWallMs } from '../src/stage/show-clock';

const SHY = SHOW_MS.shy, HOLD = SHOW_HOLD.shy!;
const DEG = 180 / Math.PI;
const BONES = ['headX', 'headY', 'headZ', 'bodyX', 'bodyZ', 'eyePitch', 'eyeYaw'] as const;

/** Walks a clock at `stepMs` (with asks at the given wall times, each at the last frame shown) and checks the R29 properties. */
function walk(asks: readonly number[], stepMs: number, untilMs = 20_000) {
  const clock = new ShowClock('shy'), pending = [...asks];
  const times: number[] = [], show: number[] = [], rates: number[] = [];
  for (let w = 0; w <= untilMs; w += stepMs) {
    while (pending.length && pending[0] <= w) { const at = times.at(-1) ?? 0; clock.extend(at); pending.shift(); }
    times.push(w); show.push(clock.at(w)); rates.push(clock.rateAt(w));
  }
  return { clock, times, show, rates };
}

test('a show nobody asks again for is the wall clock itself (byte-identical frames)', () => {
  const clock = new ShowClock('shy');
  for (const w of [0, 1e-9, 16.666666666666668, 1000, 1599.9999999, 2999.99, 3000, 12_345.678]) assert.equal(clock.at(w), w);
  assert.equal(clock.extended, false); assert.equal(showEndWallMs(clock), SHY);
});

test('惊喜 has no hold: asking again does not move its end; 害羞 letting go is not extended either', () => {
  const surprise = new ShowClock('surprise');
  assert.equal(surprise.extend(300), false); assert.equal(surprise.at(1234.5), 1234.5); assert.equal(showEndWallMs(surprise), SHOW_MS.surprise);
  const shy = new ShowClock('shy');
  assert.equal(shy.extend(HOLD.releaseMs + 1), false); assert.equal(shy.extend(0), false); assert.equal(shy.extend(Number.NaN), false);
  assert.equal(shy.extended, false);
});

test('asked again 1 s in: it comes to rest at the flattest point of the hold, waits, and ends a full show after the ask', () => {
  const clock = new ShowClock('shy');
  assert.equal(clock.extend(1000), true);
  assert.ok(Math.abs(showEndWallMs(clock) - (1000 + SHY)) < 1e-6, `ends at ${showEndWallMs(clock)}`);
  // Up to the start of the ease it is the wall clock; it rests at the pause point; it starts again and ends.
  assert.equal(clock.at(1000), 1000); assert.equal(clock.at(HOLD.pauseMs - SHOW_CLOCK_EASE_MS / 2), HOLD.pauseMs - SHOW_CLOCK_EASE_MS / 2);
  for (const w of [1800, 2200, 2440]) assert.ok(Math.abs(clock.at(w) - HOLD.pauseMs) < 1e-9, `rests at ${HOLD.pauseMs} (${clock.at(w)} at ${w})`);
  assert.equal(clock.rateAt(2000), 0); assert.equal(clock.rateAt(3500), 1);
  // While it rests, the same recipe asked again is still kept (show-blend.ts sees the show's own time).
  assert.equal(showRequest({ recipe: 'shy', elapsedMs: clock.at(2600) }, 'shy'), 'keep');
});

for (const [label, asks] of [
  ['once at 1 s', [1000]], ['late in the hold (1.9 s)', [1900]], ['just before it lets go (2.19 s)', [2190]], ['right away (50 ms)', [50]],
  ['four times', [600, 1500, 2600, 4000]], ['while it starts again after a rest', [1000, 2600]], ['after it started again, still in the hold', [1000, 2900]], ['during the ease to rest', [1000, 1520]],
] as const) {
  for (const step of [1000 / 60, 1000 / 30, 7.3]) test(`R29 clock, ${label} at ${step.toFixed(1)} ms: never back, never faster than the wall, rate continuous, ends a full show after the last ask`, () => {
    const { clock, show, rates } = walk(asks, step);
    for (let i = 1; i < show.length; i++) {
      assert.ok(show[i] >= show[i - 1], `never goes back (${show[i - 1]} → ${show[i]})`);
      assert.ok(show[i] - show[i - 1] <= step * (1 + 1e-9), 'never runs ahead of the wall clock');
      // Smoothstep ease: the rate changes by at most 1.5/ease per ms (the shortest ease late in the hold is 100 ms).
      assert.ok(Math.abs(rates[i] - rates[i - 1]) <= 1.5 * step / 100 + 1e-9, `rate continuous (${rates[i - 1]} → ${rates[i]})`);
    }
    const last = asks.at(-1)!, end = showEndWallMs(clock);
    // A full show after the (frame-quantized) ask, or one ease later when the ask came right away; never into the release.
    assert.ok(end >= last - step && end <= last + SHY + SHOW_CLOCK_EASE_MS + 1e-6, `ends at ${end.toFixed(1)} (last ask ${last})`);
    if (last >= SHOW_CLOCK_EASE_MS) assert.ok(Math.abs(end - (last + SHY)) <= step + 1e-6, `ends a full show after the last ask (${end.toFixed(1)})`);
    const rest = Math.max(...show.filter((value, i) => rates[i] === 0));
    assert.ok(rest <= HOLD.releaseMs + 50 + 1e-9, `rests in the hold (${rest.toFixed(1)})`);
  });
}

test('the show itself stays smooth: once it has come in, no track moves more unexpectedly than in one plain show, and the hold is held', () => {
  // Per-frame unexpected step (second difference) of every channel, normalised by its limit, bones in degrees — from the
  // point it has come in (show time 900 ms: the startle and the rise are untouched by the clock and would dwarf the rest).
  const worst = (clock: ShowClock, step: number) => {
    let face = 0, bone = 0, prev = showSample('shy', 0, true), prev2 = prev;
    for (let w = step; w < showEndWallMs(clock) + step; w += step) {
      const now = showSample('shy', clock.at(w), true);
      if (clock.at(w - 2 * step) >= 900) for (const key of SHOW_KEYS) {
        const jerk = Math.abs(now[key] - 2 * prev[key] + prev2[key]);
        if ((BONES as readonly string[]).includes(key)) bone = Math.max(bone, jerk * DEG); else face = Math.max(face, jerk / SHOW_LIMITS[key]);
      }
      prev2 = prev; prev = now;
    }
    return { bone, face };
  };
  for (const step of [1000 / 60, 1000 / 30]) {
    const plain = worst(new ShowClock('shy'), step);
    for (const asks of [[1000], [1900], [2190], [600, 1500, 2600, 4000]]) {
      const clock = new ShowClock('shy');
      for (const ask of asks) clock.extend(Math.floor(ask / step) * step);
      const got = worst(clock, step);
      assert.ok(got.bone <= plain.bone * 1.05 + 1e-9, `${asks} at ${step.toFixed(1)} ms: bones ${got.bone.toFixed(4)}° vs one show ${plain.bone.toFixed(4)}°`);
      assert.ok(got.face <= plain.face * 1.05 + 1e-9, `${asks} at ${step.toFixed(1)} ms: face ${got.face.toFixed(4)} vs one show ${plain.face.toFixed(4)}`);
    }
  }
  // Held look while it rests after an ask 1 s in: the head stays where the hold is (0.15 rad down), nothing lets go.
  const clock = new ShowClock('shy'); clock.extend(1000);
  const held = showSample('shy', clock.at(3000), true);
  assert.ok(held.headX > 0.14 && held.mouthSmile > 0.45 && held.lidSoft > 0.35 && held.blush > 0.85, JSON.stringify(held));
});

test(`cap: an ask more than ${SHOW_HOLD_LATEST_ASK_MS / 1000} s after the show began no longer moves its end`, () => {
  // Asked every second: each keeps her in the hold until the cap; the ones after it change nothing.
  const { clock } = walk(Array.from({ length: 14 }, (_, i) => 1000 * (i + 1)), 1000 / 60, 30_000);
  assert.ok(Math.abs(showEndWallMs(clock) - (SHOW_HOLD_LATEST_ASK_MS + SHY)) < 1000 / 60 + 1e-6, `ends at ${showEndWallMs(clock)}`);
});
