import test from 'node:test';
import assert from 'node:assert/strict';
import { PoseFeatureTracker, type PoseSample } from '../electron/senses/pose/features';
import { facingScore, voteConfidence } from '../electron/senses/pose/confidence';
import { EMPTY_POSE_SIGNAL, parsePoseSignal } from '../shared/senses/pose-signals';
import { POSE_MAYBE_AT, POSE_SURE_AT, poseConfidenceBand } from '../shared/senses/pose-confidence';
import { poseConfidenceBand as exported } from '../shared/senses';

// Synthetic COCO-17 bodies (same idea as tests/pose-features.test.ts): a seated user in a 320x240 frame, shoulders 80 px apart.
type Point = [number, number, number?];
const SEATED: Point[] = [
  [160, 90], [150, 82], [170, 82], [138, 88], [182, 88],
  [120, 150], [200, 150], [110, 200], [210, 200], [115, 235], [205, 235],
  [130, 250, 0.05], [190, 250, 0.05], [130, 320, 0.05], [190, 320, 0.05], [130, 380, 0.05], [190, 380, 0.05],
];
function sample(t: number, points: Point[] = SEATED): PoseSample {
  const kpts = new Float32Array(34), scores = new Float32Array(17);
  points.forEach(([x, y, s = 0.9], i) => { kpts[i * 2] = x; kpts[i * 2 + 1] = y; scores[i] = s; });
  return { t, detected: true, detScore: 0.9, kpts, scores, width: 320, height: 240 };
}
const edit = (changes: Record<number, Point>) => SEATED.map((p, i) => changes[i] ?? p);
const run = (tracker: PoseFeatureTracker, frames: number, fps: number, make: (t: number, i: number) => PoseSample, start = 1000) => {
  for (let i = 0; i < frames; i++) tracker.push(make(start + i * 1000 / fps, i));
  return start + frames * 1000 / fps;
};
const withScore = (points: Point[], indices: number[], score: number): Point[] => points.map((p, i): Point => indices.includes(i) ? [p[0], p[1], score] : p);
const SIDE = edit({ 0: [178, 90] });

test('facing and posture confidence: high on a clean sequence, lower with weak keypoint scores, lower when the frames flip-flop, 0 for unknown', () => {
  const read = (make: (t: number, i: number) => PoseSample, frames = 12) => { const tracker = new PoseFeatureTracker(); run(tracker, frames, 5, make); return tracker.signal(); };
  const clean = read(t => sample(t));
  assert.equal(clean.facing, 'toward');
  assert.equal(clean.posture, 'sitting');
  assert.ok(clean.facingConfidence >= 0.85 && clean.postureConfidence >= 0.85, `${clean.facingConfidence} ${clean.postureConfidence}`);
  assert.equal(poseConfidenceBand(clean.facingConfidence), 'sure');

  const weak = read(t => sample(t, withScore(SEATED, [0, 1, 2, 5, 6], 0.45)));
  assert.equal(weak.facing, 'toward', 'scores above the keypoint thresholds still decide');
  assert.ok(weak.facingConfidence < clean.facingConfidence - 0.3 && weak.postureConfidence < clean.postureConfidence - 0.3, `${weak.facingConfidence} ${weak.postureConfidence}`);
  assert.equal(poseConfidenceBand(weak.facingConfidence), 'maybe');

  const flip = read((t, i) => sample(t, i % 2 ? SIDE : SEATED));
  assert.ok(flip.facingConfidence < clean.facingConfidence - 0.25, `flip-flopping facing: ${flip.facingConfidence}`);
  assert.notEqual(poseConfidenceBand(flip.facingConfidence), 'sure');

  const unknown = read(t => sample(t, withScore(SEATED, [1, 2], 0.1)));
  assert.equal(unknown.facing, 'unknown');
  assert.equal(unknown.facingConfidence, 0, "'unknown' facing has confidence 0");
  assert.equal(voteConfidence([], 'sitting'), 0);
  assert.equal(voteConfidence([{ value: 'unknown' as const, score: 1 }], 'unknown'), 0);
});

test('facing confidence: side and away are scored on the keypoints that decided them; a window of one frame is discounted', () => {
  const side = new PoseFeatureTracker(); run(side, 8, 5, t => sample(t, SIDE));
  assert.equal(side.signal().facing, 'side');
  assert.ok(side.signal().facingConfidence >= 0.85);
  const away = new PoseFeatureTracker(); run(away, 8, 5, t => sample(t, withScore(SEATED, [0, 1, 2], 0.05)));
  const awaySignal = away.signal();
  assert.equal(awaySignal.facing, 'away');
  assert.ok(awaySignal.facingConfidence >= 0.85, `${awaySignal.facingConfidence}`);
  assert.equal(facingScore('unknown', [1, 1, 1]), 0);
  assert.ok(voteConfidence([{ value: 'toward' as const, score: 1 }], 'toward') <= 0.34, 'one frame of history is not sure');
});

test('wave confidence: higher for a clear wave with sure keypoints than with weak ones; only for events in the signal', () => {
  const wave = (wristScore: number) => {
    const tracker = new PoseFeatureTracker();
    run(tracker, 30, 10, (t, i) => sample(t, edit({ 10: [215 + 25 * Math.sin(2 * Math.PI * 2 * i / 10), 100, wristScore], 8: [215, 140, wristScore] })));
    return tracker.signal();
  };
  const clear = wave(0.9), weak = wave(0.4);
  assert.deepEqual(clear.events, ['wave']);
  assert.deepEqual(Object.keys(clear.eventConfidence), ['wave']);
  assert.ok(clear.eventConfidence.wave! > weak.eventConfidence.wave!, `${clear.eventConfidence.wave} vs ${weak.eventConfidence.wave}`);
  assert.ok(clear.eventConfidence.wave! > 0.5, `${clear.eventConfidence.wave}`);
  const again = new PoseFeatureTracker();
  run(again, 30, 10, (t, i) => sample(t, edit({ 10: [215 + 25 * Math.sin(2 * Math.PI * 2 * i / 10), 100], 8: [215, 140] })));
  again.signal();
  assert.deepEqual(again.signal().eventConfidence, {}, 'handed out once, like the event');
});

test('stretch confidence: higher with the wrists far above the head and sure keypoints', () => {
  const stretch = (wristY: number, score: number) => {
    const tracker = new PoseFeatureTracker();
    run(tracker, 12, 10, t => sample(t, edit({ 9: [130, wristY, score], 10: [190, wristY, score], 7: [120, 90, score], 8: [200, 90, score] })));
    return tracker.signal();
  };
  const clear = stretch(30, 0.9), barely = stretch(64, 0.9), weak = stretch(30, 0.4);
  for (const s of [clear, barely, weak]) assert.deepEqual(s.events, ['stretch']);
  assert.ok(clear.eventConfidence.stretch! > barely.eventConfidence.stretch!, `${clear.eventConfidence.stretch} vs ${barely.eventConfidence.stretch}`);
  assert.ok(clear.eventConfidence.stretch! > weak.eventConfidence.stretch!);
  assert.ok(clear.eventConfidence.stretch! >= POSE_SURE_AT - 0.1, `${clear.eventConfidence.stretch}`);
});

test('nobody there or presence only: every confidence is 0 and the validator accepts the signal', () => {
  const tracker = new PoseFeatureTracker();
  run(tracker, 12, 5, t => sample(t));
  const only = tracker.signal('presence-only');
  assert.deepEqual([only.facingConfidence, only.postureConfidence, only.eventConfidence], [0, 0, {}]);
  assert.deepEqual(parsePoseSignal(JSON.parse(JSON.stringify(tracker.signal()))), tracker.signal());
  assert.deepEqual([EMPTY_POSE_SIGNAL.facingConfidence, EMPTY_POSE_SIGNAL.postureConfidence, EMPTY_POSE_SIGNAL.eventConfidence], [0, 0, {}]);
});

test('the strict validator: the three confidences are required, finite, clamped to 0..1; event keys must be events of the signal', () => {
  const good = { ...EMPTY_POSE_SIGNAL, present: true, events: ['wave'], eventConfidence: { wave: 0.7 }, facingConfidence: 0.5, postureConfidence: 0.4 };
  assert.deepEqual(parsePoseSignal(good)!.eventConfidence, { wave: 0.7 });
  const clamped = parsePoseSignal({ ...good, facingConfidence: 7, postureConfidence: -2, eventConfidence: { wave: 1.6 } })!;
  assert.deepEqual([clamped.facingConfidence, clamped.postureConfidence, clamped.eventConfidence.wave], [1, 0, 1], 'clamped, not refused');
  assert.equal(parsePoseSignal({ ...good, facingConfidence: 0.123456 })!.facingConfidence, 0.12, 'two decimals');
  const bad: Record<string, unknown>[] = [
    { facingConfidence: NaN }, { postureConfidence: Infinity }, { facingConfidence: '0.5' }, { postureConfidence: null }, { eventConfidence: { wave: NaN } },
    { eventConfidence: { wave: '0.5' } }, { eventConfidence: { stretch: 0.5 } }, { eventConfidence: { dance: 0.5 } }, { eventConfidence: [0.5] }, { eventConfidence: null },
  ];
  for (const change of bad) assert.equal(parsePoseSignal({ ...good, ...change }), null, JSON.stringify(change));
  const missing: Record<string, unknown> = { ...good }; delete missing.facingConfidence;
  assert.equal(parsePoseSignal(missing), null, 'a signal without the field is refused');
  assert.equal(parsePoseSignal({ ...good, extra: 1 }), null);
});

test('poseConfidenceBand: sure, maybe, unsure; missing or non-finite is unsure; exported from the senses index', () => {
  assert.equal(poseConfidenceBand(1), 'sure');
  assert.equal(poseConfidenceBand(POSE_SURE_AT), 'sure');
  assert.equal(poseConfidenceBand(POSE_SURE_AT - 0.01), 'maybe');
  assert.equal(poseConfidenceBand(POSE_MAYBE_AT), 'maybe');
  assert.equal(poseConfidenceBand(POSE_MAYBE_AT - 0.01), 'unsure');
  assert.equal(poseConfidenceBand(0), 'unsure');
  for (const value of [undefined, null, NaN, Infinity, -Infinity, '0.9' as unknown as number]) assert.equal(poseConfidenceBand(value), 'unsure');
  assert.equal(exported, poseConfidenceBand);
});
