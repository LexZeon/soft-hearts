/**
 * I-073 parts 1 and 2 (docs/claude/how-to-tune-mood-face.md): the universal face sliders follow the mood's numbers, with an
 * afterglow after an event and a slow drift. Ideas from Soullink Emotion SDK and SoullinkEmotion3D (Apache-2.0; read only, our
 * own code and numbers, ACKNOWLEDGEMENTS.md).
 *
 *  - calibration: at every typical state (anchor) the sliders are exactly the old table row of that name; at the test presets
 *    (shared/foundation/mood-presets.ts, stronger states) they are within the stated tolerance; the idle eye smile of mood feedback is
 *    0.16 at the pleasant states and 0 elsewhere, as it was by name;
 *  - continuity: the weights move smoothly with the numbers and with a label change (no step anywhere), the kernel is exact
 *    at the anchors (its radius below the closest two anchors' distance);
 *  - the reading follows critically damped (zero speed at the start, no overshoot), holds after an event for a time that grows
 *    with the lift (bounded), and lets go smoothly (no step at the hold's end);
 *  - the drift is bounded and slow, and never makes a hidden shape show (the eyelid and drowsy rules wait for exact zeros);
 *  - mood feedback: with the numbers the idle smile follows them, without them it follows the name as before; a serious name
 *    still clears the smile at once (kept on purpose);
 *  - Gene, real frame loop (gene-stage-harness), 60 and 30 fps: a chat lift on a card whose mood decays fast; the face rises
 *    gently, holds, then follows; the display guard has nothing to catch.
 * FACE_TWITCH_REPORT=1 prints the numbers in the doc.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ANCHORS, ANCHOR_LABELS, ANCHOR_LEVELS, anchorWeights, moodStrength } from '../src/mood/mood-face/anchors';
import { FACE_AXES, FaceMoodReading, emptyPoint, rawPoint, type FacePoint } from '../src/mood/mood-face/reading';
import { MOOD_FACE_KNOBS } from '../src/mood/mood-face/knobs';
import { LabelBlend } from '../src/mood/mood-face/label-blend';
import { EXPRESSION_CHANNELS, EXPRESSION_LIMITS, emptyExpression, expressionTargets, type ExpressionChannels } from '../src/stage/continuous-expression';
import { EMPTY_CONTACT, MoodFeedback, type StageMoodState } from '../src/mood/mood-feedback';
import { MOOD_PRESETS } from '../shared/foundation/mood-presets';

const REPORT = process.env.FACE_TWITCH_REPORT === '1';
const still = { smile: 0, brow: 0, lid: 0, blush: 0 };
const NONE = [{ label: '', weight: 1 }];
const numbers = (levels: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>>) => ({ D: 50, O: 50, E: 50, N: 50, C: 50, ...levels });
/** The sliders the new path gives for these numbers and this name (no wobble, no drift). */
function sliders(levels: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>>, longing: number, label: string): ExpressionChannels {
  const mood = { primary: label, values: numbers(levels), longing };
  return expressionTargets(mood, 1, 0, 1, still, emptyExpression(), { primary: anchorWeights(rawPoint(mood), [{ label, weight: 1 }]), companion: NONE });
}
const old = (levels: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>>, label: string) => expressionTargets({ primary: label, values: numbers(levels) }, 1, 0, 1, still);
const distance = (a: FacePoint, b: FacePoint) => Math.sqrt(FACE_AXES.reduce((sum, axis) => sum + (a[axis] - b[axis]) ** 2, 0));

test('calibration: exactly the old row at every typical state; within tolerance at the stronger test presets', () => {
  for (const label of ANCHOR_LABELS) {
    const anchor = ANCHOR_LEVELS[label], now = sliders(anchor.levels, anchor.longing ?? 0, label), before = old(anchor.levels, label);
    for (const key of EXPRESSION_CHANNELS) assert.ok(Math.abs(now[key] - before[key]) < 1e-6, `${label} ${key}: ${now[key]} vs ${before[key]}`);
  }
  // Tolerance at the presets (stronger than the anchors): morph sliders ±0.01, head pitch ±0.001 rad (0.06°).
  const lines: string[] = [];
  for (const [label, preset] of Object.entries(MOOD_PRESETS)) {
    const now = sliders(preset.levels, preset.longing, label), before = old(preset.levels, label);
    const strict = ['calm', 'close', 'happy', 'content', 'concerned', 'sad', 'excited', 'disappointed', 'longing', 'tense-expectation', 'upset'].includes(label);
    const worst = Math.max(...EXPRESSION_CHANNELS.map(key => Math.abs(now[key] - before[key]) / (key === 'headX' ? 0.1 : 1)));
    lines.push(`| ${label} | ${(['smileEyes', 'mouthSmile', 'sad', 'angry', 'blush', 'headX', 'browUp'] as const).map(key => `${before[key].toFixed(3)} → ${now[key].toFixed(3)}`).join(' | ')} |`);
    if (strict) assert.ok(worst <= 0.01, `${label}: largest difference ${worst} (in 0.01 units; head 0.001 rad)`);
    else assert.ok(worst <= 0.06, `${label} (a reunion, no numbers of its own): ${worst}`);
  }
  if (REPORT) console.log(['| 预设 | 笑眼 | 嘴角笑 | 难过眉 | 生气眉 | 脸红 | 头俯仰(rad) | 挑眉 |', '|---|---|---|---|---|---|---|---|', ...lines].join('\n'));
});

test('the kernel is exact at the anchors and smooth between them; the label adds its style smoothly and only as the mood is clear', () => {
  let closest = Infinity;
  for (const a of ANCHORS) for (const b of ANCHORS) if (a !== b) closest = Math.min(closest, distance(a.point, b.point));
  assert.ok(MOOD_FACE_KNOBS.anchorWidth < closest, `radius ${MOOD_FACE_KNOBS.anchorWidth} below the closest two anchors (${closest.toFixed(3)})`);
  for (const anchor of ANCHORS) {
    const weights = anchorWeights(anchor.point, null);
    assert.deepEqual(weights.map(e => [e.label, e.weight]), [[anchor.label, 1]], `${anchor.label}: only itself`);
  }
  assert.equal(moodStrength(ANCHORS[0].point), 0, 'calm: no label style');
  // Straight paths between every two anchors, and far past them: the weights never jump.
  const point = emptyPoint(), step = 1e-3;
  let largest = 0;
  for (const a of ANCHORS) for (const b of ANCHORS) {
    if (a === b) continue;
    let last: Map<string, number> | null = null;
    for (let t = -0.5; t <= 1.5 + 1e-9; t += step) {
      for (const axis of FACE_AXES) point[axis] = a.point[axis] + (b.point[axis] - a.point[axis]) * t;
      const now = new Map(anchorWeights(point, [{ label: 'happy', weight: 1 }]).map(e => [e.label, e.weight]));
      if (last) for (const label of new Set([...now.keys(), ...last.keys()])) largest = Math.max(largest, Math.abs((now.get(label) ?? 0) - (last.get(label) ?? 0)) / (step * distance(a.point, b.point)));
      last = now;
    }
  }
  if (REPORT) console.log(`largest weight change per unit of mood distance: ${largest.toFixed(2)}`);
  // Steepest where two far anchors meet half way (≈ 18 per unit: a quarter of the weight per 1.5 mood points); a step would be 1000.
  assert.ok(largest < 25, `weights change at most ${largest.toFixed(2)} per unit (a step would be ~1/step = 1000)`);
  // A label change at a clear mood: the style drifts in with LabelBlend (zero speed at both ends), never steps.
  const blend = new LabelBlend(), happy = ANCHORS.find(a => a.label === 'happy')!.point, dt = 1 / 60;
  blend.frame(dt, 'happy', MOOD_FACE_KNOBS.driftSeconds);
  let previous = anchorWeights(happy, blend.out, []).find(e => e.label === 'upset')?.weight ?? 0, peak = 0;
  for (let i = 0; i < 120; i++) {
    const upset = anchorWeights(happy, blend.frame(dt, 'upset', MOOD_FACE_KNOBS.driftSeconds), []).find(e => e.label === 'upset')?.weight ?? 0;
    peak = Math.max(peak, upset - previous); previous = upset;
  }
  assert.ok(previous > 0.5 && peak <= 1.875 * dt / MOOD_FACE_KNOBS.driftSeconds + 1e-9, `an upset name at a happy face's numbers: ${previous.toFixed(2)}, per frame ≤ ${peak.toFixed(4)}`);
});

/** A card whose mood decays fast (10 s half-life): `lift` points on D and E at `at`, then decay toward 50. */
function decaying(lift: number, at: number, halfLife = 10) {
  return (t: number) => {
    const extra = t < at ? 0 : lift * 0.5 ** ((t - at) / halfLife);
    return { values: numbers({ D: 50 + extra, E: 50 + extra * 0.6 }), event: t >= at ? { id: `lift-${lift}`, delta: { D: lift, E: lift * 0.6 } } : null };
  };
}
function read(mood: (t: number) => ReturnType<ReturnType<typeof decaying>>, seconds: number, dt = 1 / 60) {
  const reading = new FaceMoodReading(), out: { t: number; D: number; raw: number }[] = [];
  for (let i = 0, n = Math.round(seconds / dt); i < n; i++) {
    const t = i * dt, m = mood(t);
    out.push({ t, D: reading.frame(dt, m).D, raw: rawPoint(m).D });
  }
  return out;
}
const secondDifference = (values: readonly number[]) => Math.max(...values.slice(2).map((v, i) => Math.abs(v - 2 * values[i + 1] + values[i])));

test('the reading: rises from rest, holds after a lift (longer for a bigger one, bounded), then lets go without a step', () => {
  const hold = MOOD_FACE_KNOBS.hold;
  for (const lift of [6, 15]) {
    const series = read(decaying(lift, 1), 20), D = series.map(s => s.D);
    const expected = Math.min(hold.max, hold.base + hold.perPoint * lift);
    // Rises from rest: the first frame after the event moves by almost nothing.
    const start = series.findIndex(s => s.t >= 1);
    assert.ok(D[start + 1] - D[start] < 0.02 * (lift / 50), `gentle start (${(D[start + 1] - D[start]).toFixed(5)})`);
    assert.ok(Math.max(...D) <= lift / 50 + 1e-9, 'no overshoot past the lift');
    // Holds: until the hold ends the face stays at (or follows up to) the lift, while the numbers already fell.
    const holdEnd = series.findIndex(s => s.t >= 1 + expected);
    const kept = D[holdEnd - 1], fell = series[holdEnd - 1].raw;
    assert.ok(kept > fell + 0.1 * (lift / 50 - fell) && kept >= 0.9 * (lift / 50),
      `held at ${(kept * 50).toFixed(2)} points while the numbers are at ${(fell * 50).toFixed(2)} (hold ${expected.toFixed(2)} s)`);
    // Then follows: some seconds after the release the face is back on the numbers.
    const late = series.findIndex(s => s.t >= 1 + expected + hold.release + 3);
    assert.ok(Math.abs(D[late] - series[late].raw) < 0.1 * (lift / 50), `back on the numbers after the release (${((D[late] - series[late].raw) * 50).toFixed(2)} points behind)`);
    // No step anywhere (second difference tiny compared with the lift).
    assert.ok(secondDifference(D) < 0.002 * (lift / 50), `smooth (${secondDifference(D).toExponential(2)})`);
    if (REPORT) console.log(`lift ${lift}: hold ${expected.toFixed(2)} s, face ${(kept * 50).toFixed(2)} vs numbers ${(fell * 50).toFixed(2)} points at its end`);
  }
  assert.ok(hold.base + hold.perPoint * 6 < hold.base + hold.perPoint * 15 && hold.base + hold.perPoint * 100 > hold.max, 'bigger lift, longer hold, bounded');
  // A new event in the middle of a hold continues from what is held (no jump).
  const twice = (t: number) => t < 4 ? decaying(10, 1)(t) : { values: numbers({ D: 50 + 10 * 0.5 ** ((t - 1) / 10) - 4, E: 56 }), event: { id: 'second', delta: { D: -4, E: 0 } } };
  assert.ok(secondDifference(read(twice, 12).map(s => s.D)) < 0.002, 'a second event mid-hold');
});

test('the drift: slow, bounded, and a shape that is not showing stays exactly 0', () => {
  const mood = { primary: 'calm', values: numbers({}) }, weights = { primary: [{ label: 'calm', weight: 1 }], companion: NONE };
  const base = expressionTargets(mood, 1, 0, 1, still, emptyExpression(), weights);
  let previous: ExpressionChannels | null = null, largest = 0, spread = 0;
  for (let i = 0; i <= 600; i++) {
    const phase = i / 600 * 2 - 1, value = expressionTargets(mood, 1, 0, 1, { ...still, drift: { face: phase, headX: -phase } }, emptyExpression(), weights);
    for (const key of ['smileEyes', 'sad', 'angry', 'blush', 'browUp'] as const) assert.equal(value[key], 0, `${key} stays 0 at calm`);
    assert.ok(Math.abs(value.mouthSmile / base.mouthSmile - 1) <= MOOD_FACE_KNOBS.drift.face + 1e-12, 'within ±face of what shows');
    assert.ok(Math.abs(value.headX - base.headX) <= MOOD_FACE_KNOBS.drift.headX + 1e-12, 'head within ±headX');
    spread = Math.max(spread, Math.abs(value.headX - base.headX));
    if (previous) largest = Math.max(largest, Math.abs(value.mouthSmile - previous.mouthSmile));
    previous = value;
  }
  assert.ok(spread > 0.5 * MOOD_FACE_KNOBS.drift.headX && largest > 0, 'it does move');
  // Slow: the drift's noise runs at `speed` (cycles of tens of seconds).
  assert.ok(MOOD_FACE_KNOBS.drift.speed <= 0.05 && MOOD_FACE_KNOBS.drift.face <= 0.25 && MOOD_FACE_KNOBS.drift.headX <= 0.004);
  for (const key of EXPRESSION_CHANNELS) assert.ok(Number.isFinite(EXPRESSION_LIMITS[key]));
});

const feedState = (mood: string, levels: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>> | null, extra: Partial<StageMoodState> = {}): StageMoodState =>
  ({ mood, phase: 'idle', expressive: true, face: 50, posture: 50, playful: 0, responding: false, companion: null,
    ...(levels ? { values: numbers(levels), longing: 0 } : {}), ...extra });
const settle = (state: StageMoodState, seconds = 6) => { const fb = new MoodFeedback(); let out = fb.frame(1 / 60, EMPTY_CONTACT, state); for (let i = 0; i < seconds * 60; i++) out = fb.frame(1 / 60, EMPTY_CONTACT, state); return { fb, out }; };

test('mood feedback: the idle eye smile follows the numbers (0.16 at the pleasant states); without numbers, the name; serious clears it at once', () => {
  for (const label of ANCHOR_LABELS) {
    const { out } = settle(feedState(label, ANCHOR_LEVELS[label].levels, { longing: ANCHOR_LEVELS[label].longing ?? 0 }));
    const pleasant = ['content', 'close', 'happy', 'excited'].includes(label);
    assert.ok(Math.abs(out.smile - (pleasant ? 0.16 : 0)) < 1e-6, `${label}: ${out.smile}`);
  }
  // In between: a little past calm toward happy smiles a little, not all or nothing.
  const between = settle(feedState('calm', { D: 57, E: 54 })).out.smile;
  assert.ok(between > 0.01 && between < 0.15, `between calm and happy: ${between.toFixed(3)}`);
  // Without numbers (older callers): by name, exactly as before.
  assert.ok(Math.abs(settle(feedState('happy', null)).out.smile - 0.16) < 1e-6);
  assert.equal(settle(feedState('calm', null)).out.smile, 0);
  // A serious name still clears the smile at once (original design), whatever the numbers say.
  const { fb } = settle(feedState('happy', ANCHOR_LEVELS.happy.levels));
  assert.equal(fb.frame(1 / 60, EMPTY_CONTACT, feedState('concerned', ANCHOR_LEVELS.happy.levels)).smile, 0);
});
