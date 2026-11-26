/**
 * The companion's blush follower (src/stage/blush-follow.ts): no blush source can make the cheeks jump,
 * a short shy still shows, and the fade outlasts the cue. Same thresholds as the showcase scan's "rises too fast" rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BlushFollow } from '../src/stage/blush-follow';
import { showSample, SHOW_MS } from '../src/stage/expression-show';
import { DEFAULT_MOOD_PARAMETERS, getBlushAmount } from '../shared/foundation/mood';

/** Runs `target(t)` through a fresh follower at `fps` for `seconds`; returns [t, value] per frame. */
function run(target: (t: number) => number, seconds: number, fps = 60): Array<[number, number]> {
  const follow = new BlushFollow(), dt = 1 / fps, out: Array<[number, number]> = [];
  for (let i = 1; i <= Math.round(seconds * fps); i++) { const t = i * dt; out.push([t, follow.frame(target(t), dt)]); }
  return out;
}
const firstAt = (rows: Array<[number, number]>, ok: (v: number) => boolean, from = 0) => rows.find(([t, v]) => t >= from && ok(v))?.[0] ?? Infinity;

test('a sudden full blush rises over about a second, never in a few frames (60 and 30 fps alike)', () => {
  for (const fps of [60, 30]) {
    const rows = run(() => 1, 4, fps);
    const t01 = firstAt(rows, v => v >= 0.1), t06 = firstAt(rows, v => v >= 0.6), t09 = firstAt(rows, v => v >= 0.9);
    assert.ok(t06 - t01 >= 0.4, `${fps} fps: 0.1→0.6 took ${(t06 - t01).toFixed(2)} s (the scan's line is 0.3 s)`);
    assert.ok(t09 - t01 >= 0.9 && t09 - t01 <= 1.4, `${fps} fps: 10%→90% ${(t09 - t01).toFixed(2)} s`);
    let step = 0; rows.forEach(([, v], i) => { if (i) step = Math.max(step, v - rows[i - 1][1]); });
    assert.ok(step <= (fps === 60 ? 0.03 : 0.06), `${fps} fps: largest single-frame rise ${step.toFixed(3)}`);
    assert.ok(rows.every(([, v]) => v <= 1), 'never past full');
  }
});

test('frame rate does not change the curve', () => {
  const at60 = run(() => 1, 2, 60), at30 = run(() => 1, 2, 30);
  for (const [t, v] of at30) { const near = at60.find(([u]) => Math.abs(u - t) < 1e-6); if (near) assert.ok(Math.abs(near[1] - v) < 1e-9, `t=${t}`); }
});

test('a fade takes about two seconds and ends at exactly 0', () => {
  const follow = new BlushFollow(); follow.reset(1);
  const rows: Array<[number, number]> = [];
  for (let i = 1; i <= 8 * 60; i++) rows.push([i / 60, follow.frame(0, 1 / 60)]);
  const t09 = firstAt(rows, v => v <= 0.9), t01 = firstAt(rows, v => v <= 0.1);
  assert.ok(t01 - t09 >= 1.6, `90%→10% ${(t01 - t09).toFixed(2)} s`);
  assert.ok(rows.every(([, v], i) => !i || v <= rows[i - 1][1] + 1e-12), 'falls without bouncing back');
  assert.equal(rows.at(-1)![1], 0, 'exactly 0, so the cheeks go back to their own colour');
});

test('the shy show: the blush comes up slowly, still shows strongly, and fades after the head has come back', () => {
  const frame = { blush: 0 } as ReturnType<typeof showSample>;
  const show = (t: number) => showSample('shy', t * 1000, true, frame).blush;
  const rows = run(show, 8);
  const peak = Math.max(...rows.map(([, v]) => v));
  const t01 = firstAt(rows, v => v >= 0.1), t06 = firstAt(rows, v => v >= 0.6);
  assert.ok(t06 - t01 >= 0.4, `0.1→0.6 ${(t06 - t01).toFixed(2)} s (was 0.35 s straight from the show)`);
  assert.ok(peak >= 0.75, `peak ${peak.toFixed(2)} (the show asks for 0.92)`);
  const end = SHOW_MS.shy / 1000;
  const atEnd = rows.find(([t]) => t >= end)![1];
  assert.ok(atEnd >= 0.4, `still blushing when the show ends: ${atEnd.toFixed(2)}`);
  const gone = firstAt(rows, v => v <= 0.05, end);
  assert.ok(gone - end >= 1.2 && gone - end <= 3.5, `gone ${(gone - end).toFixed(2)} s after the show`);
});

test('the mood cue (default card) keeps nearly all of its depth', () => {
  const profile = DEFAULT_MOOD_PARAMETERS.blush;
  const cue = (t: number) => getBlushAmount(t * 1000, 1, profile);
  const rows = run(cue, 8);
  const cuePeak = getBlushAmount(profile.riseMs + 1, 1, profile);
  const peak = Math.max(...rows.map(([, v]) => v));
  assert.ok(peak >= 0.85 * cuePeak, `peak ${peak.toFixed(3)} of the cue's ${cuePeak.toFixed(3)}`);
});

test('bad input and long pauses are safe', () => {
  const follow = new BlushFollow();
  assert.equal(follow.frame(Number.NaN, 1 / 60), 0);
  assert.equal(follow.frame(1, -1), 0, 'no time, no change');
  assert.equal(follow.frame(1, Number.NaN), 0);
  assert.equal(follow.frame(1, 30), 1, 'a long pause settles at the target');
  assert.equal(follow.frame(2, 1 / 60), 1, 'clamped to 0..1');
  follow.reset(); assert.equal(follow.value, 0);
});
