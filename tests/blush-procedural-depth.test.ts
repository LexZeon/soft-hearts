import test from 'node:test';
import assert from 'node:assert/strict';
import { proceduralBlushDepth } from '../shared/behaviors/blush/choose';
import { BLUSH_KNOBS } from '../shared/behaviors/blush/knobs';
import { DEFAULT_MOOD_PARAMETERS, getBlushAmount } from '../shared/mood';

test('the painted blush (models without their own blush morph, like Gene): a light blush is drawn clearly deeper, a deep one stays', () => {
  assert.equal(BLUSH_KNOBS.procedural.boost, 2);
  // Gene's card: intensity 35; at the top of a usual blush the amount is about 0.35, drawn at about 0.58 now.
  const peak = getBlushAmount(DEFAULT_MOOD_PARAMETERS.blush.riseMs + 1, 1, DEFAULT_MOOD_PARAMETERS.blush);
  assert.ok(Math.abs(peak - 0.35) < 1e-9, `the card's peak ${peak}`);
  assert.ok(proceduralBlushDepth(peak) > 0.55, `drawn ${proceduralBlushDepth(peak)}`);
  assert.ok(proceduralBlushDepth(0.25) > 0.4, 'a faint one is visible too');
  assert.equal(proceduralBlushDepth(0), 0); assert.equal(proceduralBlushDepth(1), 1);
  assert.equal(proceduralBlushDepth(-1), 0); assert.equal(proceduralBlushDepth(Number.NaN), 0); assert.equal(proceduralBlushDepth(3), 1);
  let previous = 0;
  for (let a = 0.05; a <= 1; a += 0.05) { const d = proceduralBlushDepth(a); assert.ok(d >= previous && d >= a, `order kept at ${a.toFixed(2)}`); previous = d; }
  assert.ok(proceduralBlushDepth(0.9) - 0.9 < 0.1, 'a deep one is nearly unchanged');
  assert.equal(proceduralBlushDepth(0.35, 1), 0.35, 'boost 1 is the amount unchanged');
});
