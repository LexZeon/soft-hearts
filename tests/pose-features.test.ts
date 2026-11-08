import test from 'node:test';
import assert from 'node:assert/strict';
import { PoseFeatureTracker, periodicity, type PoseSample } from '../electron/pose/features';
import { POSE_SIGNAL_KEYS, parsePoseSignal } from '../shared/pose-signals';

// Synthetic COCO-17 bodies in a 320×240 frame (no person, no camera): a seated user facing the screen,
// shoulders 80 px apart. Each test changes only what it is about.
type Point = [number, number, number?]; // x, y, score
const SEATED: Point[] = [
  [160, 90], [150, 82], [170, 82], [138, 88], [182, 88], // nose, eyes, ears
  [120, 150], [200, 150], [110, 200], [210, 200], [115, 235], [205, 235], // shoulders, elbows, wrists
  [130, 250, 0.05], [190, 250, 0.05], [130, 320, 0.05], [190, 320, 0.05], [130, 380, 0.05], [190, 380, 0.05], // hips, knees, ankles (off frame)
];
function sample(t: number, points: Point[] = SEATED, shift: [number, number] = [0, 0]): PoseSample {
  const kpts = new Float32Array(34), scores = new Float32Array(17);
  points.forEach(([x, y, s = 0.9], i) => { kpts[i * 2] = x + shift[0]; kpts[i * 2 + 1] = y + shift[1]; scores[i] = s; });
  return { t, detected: true, detScore: 0.9, kpts, scores };
}
const edit = (changes: Record<number, Point>) => SEATED.map((p, i) => changes[i] ?? p);
const run = (tracker: PoseFeatureTracker, frames: number, fps: number, make: (t: number, i: number) => PoseSample, start = 1000) => {
  for (let i = 0; i < frames; i++) tracker.push(make(start + i * 1000 / fps, i));
  return start + frames * 1000 / fps;
};

test('presence needs two confident frames to start and 3 s without anyone to end', () => {
  const tracker = new PoseFeatureTracker();
  tracker.push(sample(1000));
  assert.equal(tracker.signal().present, false, 'one frame is not enough');
  tracker.push(sample(1200));
  assert.equal(tracker.signal().present, true);
  const nobody = (t: number): PoseSample => ({ t, detected: false, detScore: 0, kpts: null, scores: null });
  run(tracker, 10, 5, t => nobody(t), 1400); // 2 s of empty frames
  assert.equal(tracker.signal().present, true, 'a short glance away does not count as leaving');
  run(tracker, 8, 5, t => nobody(t), 3400);
  assert.equal(tracker.signal().present, false);
  const gone = tracker.signal();
  assert.deepEqual({ facing: gone.facing, posture: gone.posture, energy: gone.energy, rhythm: gone.rhythm }, { facing: 'unknown', posture: 'unknown', energy: 0, rhythm: false });
});

test('facing: toward, side, away from the face keypoints', () => {
  const facing = (points: Point[]) => { const tracker = new PoseFeatureTracker(); run(tracker, 6, 5, t => sample(t, points)); return tracker.signal().facing; };
  assert.equal(facing(SEATED), 'toward');
  assert.equal(facing(edit({ 0: [178, 90] })), 'side', 'nose off to one side of the eyes');
  assert.equal(facing(edit({ 2: [170, 82, 0.1], 4: [182, 88, 0.1] })), 'side', 'one eye hidden');
  assert.equal(facing(edit({ 0: [160, 90, 0.05], 1: [150, 82, 0.05], 2: [170, 82, 0.05] })), 'away', 'shoulders but no face');
});

test('posture: sitting, slumped on the desk, standing, leaning back', () => {
  const posture = (points: Point[]) => { const tracker = new PoseFeatureTracker(); run(tracker, 7, 5, t => sample(t, points)); return tracker.signal().posture; };
  assert.equal(posture(SEATED), 'sitting');
  assert.equal(posture(edit({ 0: [160, 160], 1: [150, 152], 2: [170, 152] })), 'slumped');
  assert.equal(posture(edit({ 11: [135, 260], 12: [185, 260], 13: [135, 345], 14: [185, 345] })), 'standing');
  const tracker = new PoseFeatureTracker();
  const end = run(tracker, 300, 5, t => sample(t)); // a minute of normal sitting sets the baseline width
  const far = SEATED.map(([x, y, s]): Point => [160 + (x - 160) * 0.7, 150 + (y - 150) * 0.7, s]);
  run(tracker, 7, 5, t => sample(t, far), end);
  assert.equal(tracker.signal().posture, 'leaning-back');
});

test('waving: a raised hand swinging side to side fires one event, then a cooldown', () => {
  const tracker = new PoseFeatureTracker();
  const end = run(tracker, 20, 10, (t, i) => sample(t, edit({ 10: [215 + 25 * Math.sin(2 * Math.PI * 2 * i / 10), 100], 8: [215, 140] })));
  const signal = tracker.signal();
  assert.deepEqual(signal.events, ['wave']);
  assert.deepEqual(tracker.signal().events, [], 'an event is handed out once');
  run(tracker, 20, 10, (t, i) => sample(t, edit({ 10: [215 + 25 * Math.sin(2 * Math.PI * 2 * i / 10), 100], 8: [215, 140] })), end);
  assert.deepEqual(tracker.signal().events, [], 'no second wave inside the cooldown');
  const still = new PoseFeatureTracker();
  run(still, 25, 10, t => sample(t, edit({ 10: [230, 100], 8: [215, 140] })));
  assert.deepEqual(still.signal().events, [], 'a raised but still hand is not a wave');
});

test('stretching: both wrists above the head for about a second', () => {
  const tracker = new PoseFeatureTracker();
  run(tracker, 12, 10, t => sample(t, edit({ 9: [130, 40], 10: [190, 40], 7: [120, 90], 8: [200, 90] })));
  assert.deepEqual(tracker.signal().events, ['stretch']);
  const brief = new PoseFeatureTracker();
  run(brief, 4, 10, t => sample(t, edit({ 9: [130, 40], 10: [190, 40] })));
  assert.deepEqual(brief.signal().events, [], 'a quick reach is not a stretch');
});

test('rhythm and tempo from bobbing; stillness has none; energy follows movement', () => {
  for (const [bpm, fps] of [[100, 5], [120, 10], [72, 5]] as const) {
    const tracker = new PoseFeatureTracker();
    run(tracker, fps * 7, fps, t => sample(t, SEATED, [0, 7 * Math.sin(2 * Math.PI * (bpm / 60) * t / 1000)]));
    const signal = tracker.signal();
    assert.equal(signal.rhythm, true, `${bpm} bpm at ${fps} fps`);
    assert.ok(Math.abs(signal.tempo! - bpm) <= bpm * 0.08, `${bpm} bpm → ${signal.tempo}`);
    assert.ok(signal.energy > 0.2, `energy ${signal.energy}`);
  }
  const still = new PoseFeatureTracker();
  run(still, 35, 5, (t, i) => sample(t, SEATED, [((i * 7) % 3) - 1, ((i * 5) % 3) - 1])); // 1-px keypoint jitter
  const calm = still.signal();
  assert.equal(calm.rhythm, false);
  assert.ok(calm.energy < 0.1, `jitter alone is not movement: ${calm.energy}`);
  assert.ok(periodicity([0, 1, 0, -1, 0, 1, 0, -1, 0, 1, 0, -1], 2, 6).lag > 3.5);
});

test('the signal never carries coordinates: exact keys, passes the host validator', () => {
  const tracker = new PoseFeatureTracker();
  run(tracker, 20, 10, (t, i) => sample(t, edit({ 10: [215 + 25 * Math.sin(2 * Math.PI * 2 * i / 10), 100] })));
  for (const capability of ['full', 'presence-only'] as const) {
    const signal = tracker.signal(capability);
    assert.deepEqual(Object.keys(signal).sort(), [...POSE_SIGNAL_KEYS].sort());
    assert.deepEqual(parsePoseSignal(JSON.parse(JSON.stringify(signal))), signal);
    assert.ok(!JSON.stringify(signal).match(/\d{3}\./), 'no pixel-sized numbers');
  }
  assert.deepEqual(tracker.signal('presence-only'), { present: true, confidence: tracker.signal('presence-only').confidence, facing: 'unknown', posture: 'unknown',
    energy: 0, rhythm: false, tempo: null, events: [], hand: null, capability: 'presence-only' });
});
