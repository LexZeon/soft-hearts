import assert from 'node:assert/strict';
import test from 'node:test';
import { EYELID_BLINK_SUPPRESS, EYELID_RELEASE_HOLD, EyelidCompositor, composeMouth } from '../src/stage/channel-compositors';

const blinkPulse = (t: number) => t < 0 || t > 0.16 ? 0 : Math.sin(t / 0.16 * Math.PI); // ~80 ms close, ~80 ms open

test('eyelid: a request that flickers off for a moment cannot flutter the lids', () => {
  const lids = new EyelidCompositor(), dt = 1 / 30, out: number[] = [];
  for (let frame = 0; frame < 150; frame++) {
    const t = frame * dt, gap = t > 1 && (t % 0.42) < 0.12; // 120 ms drop-outs, as a stroke crossing the scalp edge
    out.push(lids.frame(dt, { contact: gap ? 0 : 0.38, cheek: 0, fatigue: 0, naturalBlink: 0 }).blink);
  }
  const steady = out.slice(31);
  assert.ok(Math.max(...steady) - Math.min(...steady) < 1e-9, `held through every gap (${Math.min(...steady)}..${Math.max(...steady)})`);
});

test('eyelid: closing follows at once, reopening waits a hold and then eases', () => {
  const lids = new EyelidCompositor(), dt = 1 / 60;
  assert.equal(lids.frame(dt, { contact: 0.4, cheek: 0, fatigue: 0, naturalBlink: 0 }).blink, 0.4, 'no lag when the eyes close');
  const values: number[] = [];
  for (let frame = 0; frame < 60; frame++) values.push(lids.frame(dt, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 0 }).blink);
  const holdFrames = Math.floor(EYELID_RELEASE_HOLD / dt);
  assert.ok(values.slice(0, holdFrames - 1).every(value => value === 0.4), 'held');
  assert.ok(values.at(-1)! < 0.05, `reopened within a second (${values.at(-1)})`);
  for (let i = 1; i < values.length; i++) assert.ok(values[i] <= values[i - 1] && values[i - 1] - values[i] < 0.06, 'monotone and eased');
});

test('eyelid: one writer composes natural blink, contact, cheek and fatigue', () => {
  const lids = new EyelidCompositor(), dt = 1 / 60;
  // Requests combine by meaning (the strongest closure), not by summing.
  const combined = lids.frame(dt, { contact: 0.3, cheek: 0.2, fatigue: 0.1, naturalBlink: 0 });
  assert.equal(combined.closure, 0.3);
  // While the lids are held gently shut the natural blink yields completely...
  for (let t = 0; t < 0.2; t += dt) assert.equal(lids.frame(dt, { contact: 0.3, cheek: 0, fatigue: 0, naturalBlink: blinkPulse(t) }).blink, 0.3);
  // ...and a small fatigue droop still lets a full blink through, riding on the remaining openness.
  const drowsy = new EyelidCompositor();
  let peak = 0;
  for (let t = 0; t < 0.2; t += dt) peak = Math.max(peak, drowsy.frame(dt, { contact: 0, cheek: 0, fatigue: 0.05, naturalBlink: blinkPulse(t) }).blink);
  const expected = 0.05 + 0.95 * (1 - 0.05 / EYELID_BLINK_SUPPRESS);
  assert.ok(Math.abs(peak - expected) < 0.02, `blink rides on the droop (${peak.toFixed(3)} vs ${expected.toFixed(3)})`);
  // A shared-vertex morph already closing the same lids caps the blink morph (R36 hook).
  assert.ok(new EyelidCompositor().frame(dt, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 1, sharedClosure: 0.3 }).blink <= 0.7 + 1e-12);
});

test('eyelid: a new owner (model swap) starts from open lids', () => {
  const lids = new EyelidCompositor(), first = {}, second = {};
  lids.frame(1 / 30, { contact: 0.5, cheek: 0, fatigue: 0, naturalBlink: 0 }, first);
  assert.equal(lids.frame(1 / 30, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 0 }, first).blink, 0.5, 'same owner holds');
  assert.equal(lids.frame(1 / 30, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 0 }, second).blink, 0, 'new owner has no stale closure');
  assert.equal(lids.frame(NaN, { contact: NaN, cheek: Infinity, fatigue: -1, naturalBlink: NaN }, second).blink, 0, 'malformed input cannot close the eyes');
});

test('mouth: feeding near the mouth wins over speech by its eased weight, speech returns afterwards', () => {
  const dt = 1 / 30, out: number[] = [];
  let feed = 0, weight = 0;
  for (let frame = 0; frame < 150; frame++) {
    const t = frame * dt, lip = 0.23 + Math.abs(Math.sin(t * 12)) * 0.45; // the stage's lip-sync shape
    const feeding = t > 1 && t < 3;
    feed += ((feeding ? 0.85 : 0) - feed) * (1 - Math.exp(-7 * dt));
    weight += ((feeding ? 1 : 0) - weight) * (1 - Math.exp(-8 * dt));
    out.push(composeMouth(lip, feed, weight));
  }
  const fed = out.slice(Math.round(2.2 * 30), Math.round(2.9 * 30));
  assert.ok(Math.min(...fed) > 0.8 && Math.max(...fed) - Math.min(...fed) < 0.06, `the snack holds the mouth open (${Math.min(...fed).toFixed(2)}..${Math.max(...fed).toFixed(2)})`);
  const after = out.slice(Math.round(4.2 * 30));
  assert.ok(Math.max(...after) - Math.min(...after) > 0.3, 'lip-sync is back in full afterwards');
  assert.equal(composeMouth(0.5, 0, 0), 0.5, 'no feeding: speech unchanged');
  assert.equal(composeMouth(NaN, NaN, NaN), 0);
});
