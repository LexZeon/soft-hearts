// Round 16: the showcase fits any MMD model by what it measures (src/unbound/showcase/model-fit.ts, src/unbound/face-region.ts):
// stand-off from the lens by head size, per-slot strength factors, a painted blush where the model has no blush shape, and a
// face-only surface for the hand clearance. The bundled Gene must come out exactly as before (factors 1, nothing strengthened).
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBeats } from '../shared/unbound/showcase';
import { inFaceRegion, type FaceRegionRef } from '../src/unbound/face-region';
import { applySlotGain } from '../src/unbound/motion/showcase-motion';
import { SHOWCASE_HOME, runShowcase } from './helpers/unbound-showcase';
import { geneFigure } from './helpers/unbound-gene';
import { ShowcasePerformer } from '../src/unbound/showcase/performer';
import { laptopLens } from './helpers/unbound-peek';
import {
  DISTANCE_SCALE_RANGE, GENE_HEAD_EXTENT_M, GENE_SLOT_REACH, SLOT_GAIN_CAP, blushPath, distanceScaleFor, fitModel, headExtentM, morphMove, slotGains,
} from '../src/unbound/showcase/model-fit';

test('distance scale: Gene and near-Gene heads are exactly 1; a larger head stands farther, capped; a smaller one closer, capped', () => {
  assert.equal(distanceScaleFor(GENE_HEAD_EXTENT_M), 1);
  assert.equal(distanceScaleFor(GENE_HEAD_EXTENT_M * 1.03), 1, 'inside the dead zone');
  assert.ok(Math.abs(distanceScaleFor(GENE_HEAD_EXTENT_M * 1.25) - 1.25) < 1e-9);
  assert.equal(distanceScaleFor(GENE_HEAD_EXTENT_M * 3), DISTANCE_SCALE_RANGE.max);
  assert.equal(distanceScaleFor(GENE_HEAD_EXTENT_M * 0.3), DISTANCE_SCALE_RANGE.min);
  assert.equal(distanceScaleFor(0), 1, 'nothing measured: unchanged');
  assert.equal(distanceScaleFor(NaN), 1);
});

test('head extent: sqrt of the width and the height above the chin line (metres)', () => {
  const xs = Array.from({ length: 200 }, (_, i) => -50 + i * 0.5), ys = Array.from({ length: 200 }, (_, i) => i * 0.5);
  const e = headExtentM(xs, ys, 0);
  assert.ok(e > 0.01 && e < 100, String(e));
  assert.equal(headExtentM(xs.slice(0, 10), ys.slice(0, 10), 0), 0, 'too few points to say');
  // Doubling both sizes doubles the extent.
  assert.ok(Math.abs(headExtentM(xs.map(x => 2 * x), ys.map(y => 2 * y), 0) / e - 2) < 0.02);
});

test('slot gains: only a weaker slot is strengthened, in proportion, capped; stronger, equal and unknown slots stay 1', () => {
  const ref = { mouthSmile: 0.01, surprise: 0.02, a: 0.1, blink: 0.09 } as const;
  const gain = slotGains({ mouthSmile: 0.005, surprise: 0.04, a: 0.08, blink: 0.0899 }, ref);
  assert.equal(gain.mouthSmile, SLOT_GAIN_CAP, 'half as far: doubled, capped');
  assert.equal(gain.surprise, undefined, 'a stronger shape is left alone');
  assert.ok(Math.abs(gain.a! - 0.1 / 0.08) < 1e-9);
  assert.equal(gain.blink, undefined, 'within the dead zone');
  assert.deepEqual(slotGains({}, ref), {}, 'nothing measured: nothing changes');
  assert.deepEqual(slotGains({ a: 0 }, ref), {}, 'a shape that moves nothing (a group morph) is unknown, not weak');
});

test('morph move: the 90th percentile of what moves; a morph that moves nothing is 0', () => {
  const deltas = [0, 0, 0, 0, 0, 0];
  for (let i = 1; i <= 10; i++) deltas.push(i, 0, 0);
  assert.equal(morphMove(deltas), 9);
  assert.equal(morphMove([0, 0, 0, 0, 0, 0]), 0);
});

test('applying gains: weights scale and stay at most 1; no gain leaves the slots as they are (the same object)', () => {
  const slots = { mouthSmile: 0.6, a: 0.8, blink: 0.5 };
  assert.equal(applySlotGain(slots, null), slots);
  assert.deepEqual(applySlotGain(slots, { mouthSmile: 1.5, a: 1.5 }), { mouthSmile: 0.6 * 1.5, a: 1, blink: 0.5 });
});

test('blush path: the model\'s own blush shape when it has one, else the painted blush; forced for a development look', () => {
  assert.equal(blushPath({ shy: 12 }), 'morph');
  assert.equal(blushPath({ shy: 0 }), 'morph', 'index 0 is a shape');
  assert.equal(blushPath({}), 'procedural');
  assert.equal(blushPath({ shy: 12 }, true), 'procedural');
});


test('the performer: a distance scale of 1 is the old stand-off exactly; a larger head stands farther and leans in proportionally', () => {
  const beats = validateBeats([{ at: 0, dur: 1, kind: 'notice', intensity: 0.5, feel: '-' }, { at: 1, dur: 4, kind: 'approach', amount: 0.6, intensity: 0.5, feel: '-' }], { from: 0, to: 30 })!.beats;
  const placeAt = (fit?: { distanceScale: number }) => {
    const p = new ShowcasePerformer(SHOWCASE_HOME, 0.5, 0.42, 'away', fit);
    p.append(beats);
    let place = { x: 0, z: 0 };
    for (let i = 0; i <= 600; i++) place = p.frame(i ? 1 / 60 : 0, laptopLens()).intent.place as { x: number; z: number };
    return place;
  };
  const before = placeAt(), same = placeAt({ distanceScale: 1 }), far = placeAt({ distanceScale: 1.3 });
  assert.deepEqual(same, before, 'scale 1 changes nothing');
  // From the lens at 0.55 m: Gene stands 1.4 m back at home; a 1.3x head 1.82 m back, and approaches 1.3x as far.
  const homeFar = 0.55 + 1.3 * (SHOWCASE_HOME.z - 0.55);
  const gene = before.z - SHOWCASE_HOME.z, scaled = far.z - homeFar;
  assert.ok(gene > 0.1, `she came closer: ${gene}`);
  assert.ok(Math.abs(scaled / gene - 1.3) < 1e-9, `${scaled} / ${gene}`);
});

test('the bundled Gene measures exactly as the reference: scale 1 and no strengthened slot (so the showcase is unchanged on it)', async () => {
  const { fixture, figure } = await geneFigure();
  try {
    const fit = fitModel(fixture.mesh, {});
    assert.equal(fit.distanceScale, 1, `extent ${fit.headExtentM}`);
    assert.ok(Math.abs(fit.headExtentM / GENE_HEAD_EXTENT_M - 1) < 0.005, `head extent ${fit.headExtentM}`);
    assert.deepEqual(fit.slotGain, {}, JSON.stringify({ reach: fit.slotReach, gain: fit.slotGain }));
    for (const [slot, ref] of Object.entries(GENE_SLOT_REACH)) assert.ok(Math.abs(fit.slotReach[slot as keyof typeof fit.slotReach]! / ref - 1) < 0.02, `${slot} ${fit.slotReach[slot as keyof typeof fit.slotReach]} vs ${ref}`);
  } finally { figure.dispose(); fixture.close(); }
});

test('Gene\'s hands read as before: the face-only surface does not change what the fingers are measured against', async () => {
  const beats = validateBeats([{ at: 0, dur: 1, kind: 'notice', intensity: 0.5, feel: '-' }, { at: 1, dur: 5, kind: 'hand-face', where: 'cheek', side: 'right', how: 'palm', intensity: 0.5, feel: '-' },
    { at: 7, dur: 4, kind: 'hand-face', where: 'ear', side: 'left', intensity: 0.5, feel: '-' }, { at: 11.5, dur: 3, kind: 'wave', size: 'big', side: 'right', intensity: 0.5, feel: '-' }], { from: 0, to: 30 })!.beats;
  const run = await runShowcase(30, 15, beats, { seed: 0.42 });
  const clear = run.frames.map(f => f.clearance).filter((c): c is number => c !== null);
  assert.ok(clear.length > 100, 'hands were up');
  assert.ok(Math.min(...clear) > 0, `no finger inside her: ${Math.min(...clear) * 100} cm`);
});
