/**
 * 2026-11-22 (docs/claude/2026-11-22-mouth-shut-while-talking.md). User, on the dev build with One (a VRoid VRM) in the companion window on the
 * Unbound engine: he reported the mouth staying shut for a stretch while she talked (it moved but stayed closed), that a few lines were open, and then asked that
 * a mouth shape never grow too large nor too small. That reply held smile-small (a confirm smile) from its 8th character to the end.
 *
 * Cause (measured, not assumed): VRM expression overrides play no part (the engine reads VRM binds itself and One's overrides are all "none");
 * I-175 leaned a smiling flap fully onto い, ×0.6, and い parts One's lips by nothing. Here, on the real lips (mouth-gap.ts measures the gap
 * between the lips' inner edges in eye-to-mouth units):
 *  - the meter on a synthetic VRoid-like face and on the public Gene;
 *  - the rules: a smile's lean is a blend, the floor keeps the lips parting ≥ flapFloor of an ordinary flap on any expression, the calibration
 *    lands each model's peak near flapPeakGap and never past flapGapCeiling;
 *  - the real window frame loop (streamed reading on 250 ms / off 100 ms), 60 and 30 fps, before (I-175's rules: the knobs as they were, no
 *    calibration) and after, on the synthetic VRoid-like VRM (the VRM path) and on Gene, with no expression and with each expression word held:
 *    every flap parts the lips; per-frame change bounded; Gene's pout still shows its pucker while the mouth moves.
 * Private models (never in the repo; numbers only): MOUTH_GAP_VRM=<One .vrm> MOUTH_GAP_PMX=<a converted VRoid .pmx> add their rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SkinnedMesh } from 'three';
import { lipGapMeter, type LipGapMeter } from '../shared/behaviors/part-mix/mouth-gap';
import { DEFAULT_OPENNESS, FLAP_PEAK, flapCalibration, talkThroughMouth } from '../shared/behaviors/part-mix/mouth';
import { PART_MIX_KNOBS, type PartMixKnobs } from '../shared/behaviors/part-mix/knobs';
import { UnboundMouth, vowelIndices } from '../src/unbound/mouth';
import { legacyMorphIndices } from '../src/stage/model-profile';
import { mouthGapOf, mmdLipGapInput, standardFaceBlock, standardLipGapInput } from '../src/unbound/mouth-geometry';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { StageModelProfile } from '../src/stage/model-profile';
import { WindowBody } from '../src/unbound/window-mode/window-body';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { readFile } from 'node:fs/promises';
import { windowGene } from './helpers/unbound-window';
import { windowVrm } from './helpers/unbound-vrm';
import { syntheticVrm } from './helpers/synthetic-vrm';
import { faceView } from './helpers/window-face-fixture';
import { geneFigure } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import type { Vowel } from '../shared/behaviors/part-mix/interface';

const REPORT = process.env.MOUTH_REPORT === '1';
const say = (line: string) => { if (REPORT) console.log(line); };
/** I-175 as it was: a smile cut like a pout and leaned fully onto い, no floor, no calibration. */
const BEFORE: PartMixKnobs = Object.freeze({ ...PART_MIX_KNOBS, smileTalkThrough: PART_MIX_KNOBS.mouthTalkThrough, smileVowelMax: 1, flapFloor: 0 });
const reading = (t: number, from: number, long: number) => t >= from && t < from + long && ((t - from) * 1000) % 350 < 250;
const max = (v: readonly number[]) => v.reduce((m, x) => Math.max(m, x), -Infinity);
const min = (v: readonly number[]) => v.reduce((m, x) => Math.min(m, x), Infinity);

// ---- the meter ---------------------------------------------------------------------------------------------------------------------

test('the lip gap: lips that meet part by how far the open morph pulls them, in eye-to-mouth units; a closed smile parts nothing', () => {
  // A column of lips: upper lip rows above y=0, lower lip rows at and below, all on the front (z = 1); teeth behind (z = 0.5) move too.
  const rows = [0.3, 0.2, 0.1, 0, 0, -0.1, -0.2, -0.3], positions: number[] = [], a: number[] = [], i: number[] = [], smile: number[] = [];
  rows.forEach((y, k) => { for (const x of [-0.4, 0, 0.4]) {
    positions.push(x, y, 1); const lower = k >= 4;
    a.push(0, lower ? -0.2 : 0.02, 0); i.push(0, lower ? -0.01 : 0, 0); smile.push(0, Math.abs(x) > 0.2 ? 0.05 : 0, 0);
  } });
  for (const x of [-0.1, 0.1]) { positions.push(x, 0.05, 0.5); a.push(0, -0.6, 0); i.push(0, 0, 0); smile.push(0, 0, 0); } // teeth: deeper, move more
  const meter = lipGapMeter({ positions, morphs: { a, i, mouthSmile: smile }, frontZ: 1, eyeY: 1 })!;
  assert.ok(meter, 'found');
  assert.equal(meter.unit, 1);
  assert.ok(Math.abs(meter.gap({ a: 1 }) - 0.22) < 1e-9, `あ parts them 0.22 (${meter.gap({ a: 1 })})`);
  assert.ok(Math.abs(meter.gap({ i: 1 }) - 0.01) < 1e-9, 'い barely');
  assert.equal(meter.gap({ mouthSmile: 1 }), 0, 'a closed smile parts nothing');
  assert.equal(meter.gap({}), 0, 'at rest they meet');
  // Facing −z: the same face turned round reads the same.
  const turned = positions.map((v, k) => k % 3 === 2 ? -v : k % 3 === 0 ? -v : v);
  const back = lipGapMeter({ positions: turned, morphs: { a: a.map((v, k) => k % 3 === 0 ? -v : v) }, frontZ: -1, eyeY: 1 })!;
  assert.ok(Math.abs(back.gap({ a: 1 }) - 0.22) < 1e-9);
  assert.equal(lipGapMeter({ positions, morphs: {}, frontZ: 1, eyeY: 1 }), null, 'no open morph: nothing to measure');
});

// ---- the rules ---------------------------------------------------------------------------------------------------------------------

/** How far each vowel parts One's lips against あ, measured on her VRM (MOUTH_GAP_VRM; numbers only, in the record). */
const ONE_OPENNESS: Record<Vowel, number> = { a: 1, i: 0, u: 0.588, e: 0.132, o: 1.213 };
const GENE_OPENNESS: Record<Vowel, number> = { a: 1, i: 0.096, u: 0.788, e: 0.264, o: 1.167 };
const MUMI_OPENNESS: Record<Vowel, number> = { a: 1, i: 0.083, u: 0.352, e: 0.435, o: 1.15 };

test('a smile leans the flap a little toward い (a blend), cuts it less than a pout, and the lips always part at least the floor', () => {
  const smile = { pucker: 0, smile: 0.5, strength: 0.5 }, pout = { pucker: 1, smile: 0, strength: 1 };
  // Before (I-175's rules) on One's lips: all い at 0.6 — her lips do not part at all.
  const before = talkThroughMouth(smile, () => true, BEFORE, ONE_OPENNESS);
  assert.equal(before.vowels.i, 1); assert.equal(before.scale, 0.6); assert.equal(before.open, 0, 'before: the mouth moves shut');
  for (const [name, openness] of [['One', ONE_OPENNESS], ['Gene', GENE_OPENNESS], ['Mumi', MUMI_OPENNESS], ['unmeasured', null]] as const) {
    const after = talkThroughMouth(smile, () => true, PART_MIX_KNOBS, openness);
    assert.ok(after.vowels.a >= 1 - PART_MIX_KNOBS.smileVowelMax - 1e-9, `${name}: mostly あ (${after.vowels.a.toFixed(3)})`);
    assert.ok(after.open >= PART_MIX_KNOBS.flapFloor - 1e-9, `${name}: the lips part at least the floor (${after.open.toFixed(3)})`);
    assert.ok(Math.abs(after.scale - PART_MIX_KNOBS.smileTalkThrough) < 1e-9, `${name}: a full smile keeps ${PART_MIX_KNOBS.smileTalkThrough} of the flap`);
    for (const base of [pout, { pucker: 0.3, smile: 0.6, strength: 0.6 }, { pucker: 0, smile: 0, strength: 1 }, null]) {
      const mouth = talkThroughMouth(base, () => true, PART_MIX_KNOBS, openness);
      assert.ok(mouth.open >= PART_MIX_KNOBS.flapFloor - 1e-9, `${name} ${JSON.stringify(base)}: floor (${mouth.open.toFixed(3)})`);
      assert.ok(Math.abs(Object.values(mouth.vowels).reduce((s, v) => s + v, 0) - 1) < 1e-9, 'shares sum to 1');
    }
  }
  // Gene's pout as I-175 left it: full う (う parts her lips 0.79 of あ, × 0.6 is over the floor), exactly the knob's amplitude.
  const genePout = talkThroughMouth(pout, () => true, PART_MIX_KNOBS, GENE_OPENNESS);
  assert.equal(genePout.vowels.u, 1); assert.equal(genePout.scale, PART_MIX_KNOBS.mouthTalkThrough); assert.equal(genePout.floored, false);
  // On Mumi's う (0.35 of あ) the floor brings some あ back, continuously.
  const mumiPout = talkThroughMouth(pout, () => true, PART_MIX_KNOBS, MUMI_OPENNESS);
  assert.ok(mumiPout.floored && mumiPout.vowels.u > 0.5 && mumiPout.vowels.a > 0.2, JSON.stringify(mumiPout.vowels));
  // Continuous: a smile growing from nothing never jumps the opening.
  let last = talkThroughMouth({ pucker: 0, smile: 0, strength: 0 }, () => true, PART_MIX_KNOBS, ONE_OPENNESS).open;
  for (let s = 0.005; s <= 1; s += 0.005) {
    const now = talkThroughMouth({ pucker: 0, smile: s, strength: s }, () => true, PART_MIX_KNOBS, ONE_OPENNESS).open;
    assert.ok(Math.abs(now - last) < 0.02, `smile ${s.toFixed(3)}: ${last.toFixed(4)} → ${now.toFixed(4)}`); last = now;
  }
  assert.deepEqual(DEFAULT_OPENNESS.a, 1);
});

test('the calibration lands each model\'s flap peak near flapPeakGap (One up, Gene down) and keeps it under the morph\'s top', () => {
  const k = PART_MIX_KNOBS;
  const one = flapCalibration(0.2349), gene = flapCalibration(0.4211), mumi = flapCalibration(0.2897);
  assert.ok(one.gain > 1.3 && one.gain * FLAP_PEAK <= 0.95 + 1e-9, `One opens more (gain ${one.gain.toFixed(3)}), never pinned at the top`);
  assert.ok(gene.gain < 1 && Math.abs(gene.gain * FLAP_PEAK * 0.4211 - k.flapPeakGap) < 1e-9, `Gene opens less (gain ${gene.gain.toFixed(3)})`);
  assert.ok(Math.abs(mumi.gain * FLAP_PEAK * 0.2897 - k.flapPeakGap) < 1e-9);
  assert.deepEqual(flapCalibration(null), { gain: 1, gapCap: Infinity }, 'unmeasured: as before');
  assert.equal(one.gapCap, k.flapGapCeiling);
});

test('the flap on a measured model: calibrated, never parting the lips past the ceiling; the reading says when the floor or the ceiling held', () => {
  const run = (knobs: PartMixKnobs, base: { pucker: number; smile: number; strength: number } | null) => {
    const influences = [0, 0, 0, 0, 0];
    const mouth = new UnboundMouth(influences, 0, { i: 1, u: 2, e: 3, o: 4 }, { knobs, gap: { openness: MUMI_OPENNESS, fullGap: 0.4 } });
    const face = { mouthBase: base ?? { pucker: 0, smile: 0, strength: 0 }, setMouthTalk() {} };
    let gap = 0, capped = false, floored = false;
    mouth.speaking(true);
    for (let k = 0; k < 120; k++) { mouth.restore(); mouth.apply(1 / 60, null, face); gap = Math.max(gap, mouth.lastReading.aa * 0.4); capped ||= mouth.lastReading.capped; floored ||= mouth.lastReading.floored; }
    return { gap, capped, floored, gain: mouth.flapGain };
  };
  const normal = run(PART_MIX_KNOBS, null);
  assert.ok(normal.gain < 1 && !normal.capped && normal.gap <= PART_MIX_KNOBS.flapPeakGap + 1e-6, `a wide mouth is brought down (gain ${normal.gain.toFixed(3)}, peak gap ${normal.gap.toFixed(3)})`);
  const tight = run({ ...PART_MIX_KNOBS, flapGapCeiling: 0.1 }, null);
  assert.ok(tight.capped && tight.gap <= 0.1 + 1e-9, `the ceiling holds (${tight.gap.toFixed(3)})`);
  const pout = run(PART_MIX_KNOBS, { pucker: 1, smile: 0, strength: 1 });
  assert.ok(pout.floored && pout.gap >= PART_MIX_KNOBS.flapFloor * normal.gap - 1e-6, `a pout on lips whose う barely parts: the floor holds (${pout.gap.toFixed(3)})`);
});

// ---- the real frame loop -------------------------------------------------------------------------------------------------------------

type Expression = 'confirm-smile' | 'warm-smile' | 'laugh' | 'pout' | 'shy' | 'surprise' | 'sly' | 'content' | null;
const WORDS: readonly Expression[] = [null, 'confirm-smile', 'warm-smile', 'laugh', 'shy', 'pout', 'surprise', 'sly', 'content'];

/** The lips' gap as drawn this frame: the meter's two vertices moved by every morph influence of their mesh (eye-to-mouth units). */
function shownGap(mesh: SkinnedMesh, meter: LipGapMeter): number {
  const geometry = mesh.geometry, position = geometry.getAttribute('position'), targets = geometry.morphAttributes.position ?? [], relative = geometry.morphTargetsRelative;
  const influences = mesh.morphTargetInfluences ?? [], e = mesh.bindMatrix.elements;
  const y = (v: number) => {
    let x0 = position.getX(v), y0 = position.getY(v), z0 = position.getZ(v);
    const bx = x0, by = y0, bz = z0;
    for (let k = 0; k < targets.length; k++) {
      const w = influences[k] ?? 0;
      if (!w) continue;
      x0 += w * (targets[k].getX(v) - (relative ? 0 : bx)); y0 += w * (targets[k].getY(v) - (relative ? 0 : by)); z0 += w * (targets[k].getZ(v) - (relative ? 0 : bz));
    }
    return e[1] * x0 + e[5] * y0 + e[9] * z0 + e[13];
  };
  return Math.max(0, (y(meter.upper) - y(meter.lower)) / meter.unit);
}

interface Rig { body: WindowBody; face: WindowFace; lips: SkinnedMesh; meter: LipGapMeter; close(): void }

/** Swap in I-175's mouth (the knobs as they were, uncalibrated): the "before". */
function beforeMouth(body: WindowBody, mesh: SkinnedMesh): void {
  const dictionary = mesh.morphTargetDictionary!, index = legacyMorphIndices(dictionary).mouth;
  (body as { mouth: UnboundMouth | null }).mouth = new UnboundMouth(mesh.morphTargetInfluences!, index, vowelIndices(dictionary), { knobs: BEFORE, gap: null });
}

async function vrmRig(bytes: Uint8Array): Promise<Rig> {
  const w = await windowVrm(bytes);
  const rig = windowFaceRig(w.standard.mesh, null, false, w.figure.head, w.standard);
  const face = new WindowFace(); face.attach(rig); face.setMood(faceView({ primary: 'calm', companion: null }));
  w.body.bindFace(slotBindings(rig, face.blushMorph()));
  const block = standardFaceBlock(w.standard.model)!, gap = mouthGapOf(standardLipGapInput(w.standard.model))!;
  return { body: w.body, face, lips: block.mesh, meter: gap.meter, close: w.close };
}
async function pmxRig(modelPath?: string): Promise<Rig> {
  let body: WindowBody, mesh: SkinnedMesh, close: () => void;
  if (!modelPath) { const g = await windowGene(); body = g.body; mesh = g.fixture.mesh; close = g.close; }
  else {
    const { fixture, figure } = await geneFigure({ xM: 0, depthM: 0, modelPath });
    const idle = await shippedIdle();
    let s = 7; const random = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    body = new WindowBody(figure, async heightM => createBundledIdle(heightM, idle, 11), random);
    await new Promise(resolve => setImmediate(resolve));
    body.settle(); mesh = fixture.mesh; close = () => body.dispose();
  }
  const profile = new StageModelProfile(mesh, { reviewed: true }), rig = windowFaceRig(mesh, profile, true, body.figure.head);
  const face = new WindowFace(); face.attach(rig); face.setMood(faceView({ primary: 'calm', companion: null }));
  body.bindFace(slotBindings(rig, face.blushMorph()));
  const gap = mouthGapOf(mmdLipGapInput(mesh, vowelIndices(mesh.morphTargetDictionary)))!;
  return { body, face, lips: mesh, meter: gap.meter, close };
}

/** A streamed reading 1..6 s with `expression` shown at 0.6 s and held 8 s; the lips' gap per frame and each 0.35 s flap's peak. */
async function readRun(make: () => Promise<Rig>, fps: number, expression: Expression, before: boolean) {
  const rig = await make();
  if (before) beforeMouth(rig.body, rig.body.figure.mesh);
  const gaps: number[] = [], aa: number[] = [], times: number[] = [];
  let floored = 0, capped = 0, frames = 0;
  try {
    for (let k = 0; k <= Math.round(fps * 7); k++) {
      const t = k / fps, dt = k ? 1 / fps : 0, raw = reading(t, 1, 5);
      rig.body.setSpeaking(raw);
      if (expression && k === Math.round(0.6 * fps)) assert.equal(rig.face.show(expression, { holdS: 8 }).ok, true, `${expression} shows`);
      const f = rig.face.frame(dt, { shown: true, adjusting: false, voiced: rig.body.mouth?.voiced === true, speaking: raw });
      rig.body.frame(dt, { pointer: { x: 0, y: 0.1 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, face: f });
      gaps.push(shownGap(rig.lips, rig.meter)); times.push(t); aa.push(rig.body.mouth?.lastReading.aa ?? 0);
      if (t >= 2 && t < 6) { frames++; if (rig.body.mouth?.lastReading.floored) floored++; if (rig.body.mouth?.lastReading.capped) capped++; }
    }
  } finally { rig.close(); }
  // Each flap: the peak gap in each 0.35 s on/off cycle from 2 s (the expression is up) to 6 s.
  const peaks: number[] = [];
  for (let c = 1 + Math.ceil(1 / 0.35) * 0.35; c + 0.35 <= 6.0001; c += 0.35) peaks.push(max(gaps.filter((_, i) => times[i] >= c && times[i] < c + 0.35)));
  const steps = gaps.slice(1).map((g, i) => Math.abs(g - gaps[i]));
  const rest = max(gaps.filter((_, i) => times[i] > 6.8));
  return { peaks, minPeak: min(peaks), maxPeak: max(peaks), step: max(steps), rest, floored: floored / Math.max(1, frames), capped: capped / Math.max(1, frames), aaPeak: max(aa) };
}

const fmt = (n: number) => n.toFixed(3);
async function modelRows(name: string, make: () => Promise<Rig>, fps: number, words: readonly Expression[] = WORDS) {
  const plain = await readRun(make, fps, null, false), plainBefore = await readRun(make, fps, null, true);
  const rows: { word: Expression; before: Awaited<ReturnType<typeof readRun>>; after: Awaited<ReturnType<typeof readRun>> }[] = [];
  for (const word of words) rows.push({ word, before: word ? await readRun(make, fps, word, true) : plainBefore, after: word ? await readRun(make, fps, word, false) : plain });
  for (const row of rows) say(`  ${name} ${fps} fps ${row.word ?? '(none)'}: flap peaks before ${fmt(row.before.minPeak)}..${fmt(row.before.maxPeak)} → after ${fmt(row.after.minPeak)}..${fmt(row.after.maxPeak)} (eye-to-mouth units); per-frame gap step ${fmt(row.before.step)} → ${fmt(row.after.step)}; floor held ${(row.after.floored * 100).toFixed(0)}% ceiling ${(row.after.capped * 100).toFixed(0)}%`);
  return { plain, rows };
}

const SYNTHETIC_ONE = () => vrmRig(syntheticVrm({ face: 'full', lips: true }));

for (const fps of [60, 30]) {
  test(`VRM path (a synthetic VRoid face with lips), ${fps} fps: a held smile no longer talks with the mouth shut; every word opens every flap`, async () => {
    const { plain, rows } = await modelRows('synthetic VRoid', SYNTHETIC_ONE, fps);
    const smile = rows.find(r => r.word === 'confirm-smile')!;
    assert.ok(smile.before.maxPeak < 0.25 * plain.minPeak, `before: smile-small held, her lips barely part (${fmt(smile.before.maxPeak)} vs plain ${fmt(plain.minPeak)})`);
    for (const row of rows) {
      assert.ok(row.after.minPeak >= PART_MIX_KNOBS.flapFloor * plain.maxPeak * 0.9, `${row.word}: every flap parts the lips (${fmt(row.after.minPeak)} ≥ floor × ${fmt(plain.maxPeak)})`);
      assert.ok(row.after.maxPeak <= PART_MIX_KNOBS.flapGapCeiling + 0.02, `${row.word}: never past the ceiling (${fmt(row.after.maxPeak)})`);
      assert.ok(row.after.step < (fps === 60 ? 0.12 : 0.2), `${row.word}: no jump (largest per-frame gap change ${fmt(row.after.step)})`);
      if (row.word === null || row.word === 'confirm-smile') assert.ok(row.after.rest < 0.02, `${row.word}: shut again after the reading (${fmt(row.after.rest)})`); // a laugh or surprise keeps its own open mouth
    }
  });

  test(`Gene window, ${fps} fps: every word opens every flap, the peak is calibrated down a little, the pout still shows`, async () => {
    const { plain, rows } = await modelRows('Gene', () => pmxRig(), fps, [null, 'confirm-smile', 'warm-smile', 'pout']);
    const none = rows.find(r => r.word === null)!;
    assert.ok(plain.maxPeak < none.before.maxPeak, `Gene's flap peak comes down (${fmt(none.before.maxPeak)} → ${fmt(plain.maxPeak)})`);
    assert.ok(Math.abs(plain.maxPeak - PART_MIX_KNOBS.flapPeakGap) < 0.04, `near flapPeakGap (${fmt(plain.maxPeak)})`);
    for (const row of rows) {
      assert.ok(row.after.minPeak >= PART_MIX_KNOBS.flapFloor * plain.maxPeak * 0.9, `${row.word}: every flap parts the lips (${fmt(row.after.minPeak)})`);
      assert.ok(row.after.step < (fps === 60 ? 0.12 : 0.2), `${row.word}: no jump (${fmt(row.after.step)})`);
    }
  });
}

test('Gene: the pout still shows while she reads and the mouth moves (I-175\'s case unchanged)', async () => {
  const rig = await pmxRig();
  const dict = rig.lips.morphTargetDictionary!, inf = rig.lips.morphTargetInfluences!;
  let pucker = 0; const opens: number[] = [];
  try {
    for (let k = 0; k <= 60 * 5; k++) {
      const t = k / 60, dt = k ? 1 / 60 : 0, raw = reading(t, 1, 3.5);
      rig.body.setSpeaking(raw);
      if (k === 60 * 2) rig.face.show('pout', { holdS: 2.4, onset: 'quick' });
      const f = rig.face.frame(dt, { shown: true, adjusting: false, voiced: rig.body.mouth?.voiced === true, speaking: raw });
      rig.body.frame(dt, { pointer: { x: 0, y: 0.1 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, face: f });
      if (t >= 2.6 && t <= 4.2) { pucker = Math.max(pucker, inf[dict.mouthPucker] ?? 0); if (rig.body.mouth?.voiced) opens.push(rig.body.mouth.shownOpen); }
    }
  } finally { rig.close(); }
  assert.ok(pucker > 0.3, `pucker ${pucker.toFixed(3)}`);
  assert.ok(min(opens) > 0 && max(opens) - min(opens) > 0.05, 'the mouth keeps moving');
});

// ---- private models (numbers for the record only) --------------------------------------------------------------------------------------

const ONE = process.env.MOUTH_GAP_VRM, MUMI = process.env.MOUTH_GAP_PMX;
test('private: One (VRM) and Mumi (converted PMX) rows', { skip: !ONE && !MUMI ? 'set MOUTH_GAP_VRM / MOUTH_GAP_PMX to a private model' : false }, async () => {
  for (const fps of [60, 30]) {
    if (ONE) {
      const bytes = new Uint8Array(await readFile(ONE));
      const { plain, rows } = await modelRows('One', () => vrmRig(bytes), fps);
      for (const row of rows) assert.ok(row.after.minPeak >= PART_MIX_KNOBS.flapFloor * plain.maxPeak * 0.9, `One ${row.word}: ${fmt(row.after.minPeak)}`);
    }
    if (MUMI) {
      const { plain, rows } = await modelRows('Mumi', () => pmxRig(MUMI), fps, [null, 'confirm-smile', 'warm-smile', 'pout']);
      for (const row of rows) assert.ok(row.after.minPeak >= PART_MIX_KNOBS.flapFloor * plain.maxPeak * 0.9, `Mumi ${row.word}: ${fmt(row.after.minPeak)}`);
    }
  }
});
