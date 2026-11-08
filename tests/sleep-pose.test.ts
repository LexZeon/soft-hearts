import assert from 'node:assert/strict';
import test from 'node:test';
import { NEUTRAL_SLEEP_FRAME, SLEEP_POSE_ANGLES, SleepPose, WAKE_BLINK, type SleepPoseFrame } from '../src/stage/sleep-pose';

const owner = {};
const DT = 1 / 30;
/** Runs `seconds` of one phase and returns every frame. */
function run(pose: SleepPose, phase: string | null, seconds: number, allowed = true, extra: { rate?: number; side?: number } = {}): SleepPoseFrame[] {
  const frames: SleepPoseFrame[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) frames.push(pose.frame(DT, { owner, phase, allowed, ...extra }));
  return frames;
}
/** Largest per-frame change and largest change of that change (a speed jump) of one channel. */
function steps(frames: SleepPoseFrame[], key: 'headX' | 'neckX' | 'headZ' | 'amount') {
  let step = 0, jerk = 0, last = 0, lastStep = 0;
  frames.forEach((frame, i) => {
    const d = frame[key] - last;
    if (i > 0) jerk = Math.max(jerk, Math.abs(d - lastStep));
    step = Math.max(step, Math.abs(d)); lastStep = d; last = frame[key];
  });
  return { step, jerk };
}
const blinkCount = (frames: SleepPoseFrame[]) => frames.filter((frame, i) => frame.blink > 0 && !(frames[i - 1]?.blink > 0)).length;

test('falling asleep lowers the head slowly, with no jump and no overshoot', () => {
  const pose = new SleepPose();
  const first = run(pose, 'asleep', 1), rest = run(pose, 'asleep', 6), all = [...first, ...rest];
  assert.ok(first.at(-1)!.amount > 0.05 && first.at(-1)!.amount < 0.35, `slow start: ${first.at(-1)!.amount}`);
  assert.ok(rest.at(-1)!.amount > 0.9, `settles asleep: ${rest.at(-1)!.amount}`);
  assert.ok(all.every(frame => frame.amount <= 1 && frame.headX <= SLEEP_POSE_ANGLES.headX + 1e-12));
  assert.ok(rest.at(-1)!.headX > 0.14 && rest.at(-1)!.neckX > 0.1, 'chin down over neck and head');
  assert.ok(rest.at(-1)!.headZ > 0.07, 'a slight roll to her side');
  const { step, jerk } = steps(all, 'headX');
  assert.ok(step < 0.004, `per-frame head change stays small: ${step}`);
  assert.ok(jerk < 0.0005, `the speed changes smoothly from rest: ${jerk}`);
  assert.ok(all.at(-1)!.breathScale < 0.7 && all.at(-1)!.breathRate < 0.75, 'lighter and slower breath');
});

test('a phase change mid-way changes the speed smoothly instead of the pose (R29)', () => {
  const pose = new SleepPose();
  const frames = [...run(pose, 'asleep', 2), ...run(pose, 'awake', 1), ...run(pose, 'asleep', 1), ...run(pose, 'micro-awake', 3)];
  const head = steps(frames, 'headX'), neck = steps(frames, 'neckX');
  assert.ok(head.step < 0.004 && neck.step < 0.003, `no per-frame jump: ${head.step} ${neck.step}`);
  assert.ok(head.jerk < 0.0008 && neck.jerk < 0.0006, `no speed jump at the switches: ${head.jerk} ${neck.jerk}`);
  const micro = frames.at(-1)!;
  assert.ok(micro.depth > 0.3 && micro.depth < 0.5, `micro-awake lifts the head part way: ${micro.depth}`);
});

test('waking up lifts the head slowly, back to exactly upright, with one blink', () => {
  const pose = new SleepPose();
  const asleep = run(pose, 'asleep', 8);
  assert.equal(blinkCount(asleep), 0, 'no blink while asleep');
  const waking = run(pose, 'awake', 1.2);
  assert.ok(waking[Math.round(1 / DT) - 1].amount > 0.3, 'still lifting after a second (slowly)');
  const later = run(pose, 'awake', 8), all = [...waking, ...later];
  assert.equal(blinkCount(all), 1, 'exactly one wake blink');
  const start = all.findIndex(frame => frame.blink > 0);
  assert.ok(start * DT >= WAKE_BLINK.delay - DT && start * DT <= WAKE_BLINK.delay + 2 * DT, 'after the lids had time to open');
  const peak = Math.max(...all.map(frame => frame.blink));
  assert.ok(peak > 0.95 && peak <= 1, `a full blink: ${peak}`);
  assert.ok(steps([...asleep, ...all], 'headX').step < 0.004);
  assert.deepEqual(all.at(-1), NEUTRAL_SLEEP_FRAME, 'nothing left to write once upright');
  assert.equal(pose.wakeBlinks, 1);
});

test('one wake blink per wake: micro-awake stirs do not blink, a doze that never got deep does not either', () => {
  const pose = new SleepPose();
  const frames = [...run(pose, 'asleep', 6), ...run(pose, 'micro-awake', 2), ...run(pose, 'asleep', 3), ...run(pose, 'micro-awake', 1), ...run(pose, 'awake', 4)];
  assert.equal(blinkCount(frames), 1);
  const doze = new SleepPose();
  assert.equal(blinkCount([...run(doze, 'falling-asleep', 6), ...run(doze, 'awake', 4)]), 0, 'falling-asleep only: no wake');
  const back = new SleepPose();
  const again = [...run(back, 'asleep', 6), ...run(back, 'awake', WAKE_BLINK.delay / 2), ...run(back, 'asleep', 3)];
  assert.equal(blinkCount(again), 0, 'back to sleep before the blink came: none');
});

test('another owner of the head makes the layer give way smoothly and come back', () => {
  const pose = new SleepPose();
  const asleep = run(pose, 'asleep', 6), yielded = run(pose, 'asleep', 3, false), back = run(pose, 'asleep', 4);
  assert.equal(yielded.at(-1)!.amount, 0, 'fully given way');
  assert.equal(yielded.at(-1)!.active, false);
  assert.ok(back.at(-1)!.amount > 0.9, 'comes back');
  const all = [...asleep, ...yielded, ...back];
  assert.ok(steps(all, 'headX').step < 0.012, `yield fade has no jump: ${steps(all, 'headX').step}`);
  assert.ok(steps(all, 'headX').jerk < 0.006, `bounded acceleration when an owner takes or returns the head: ${steps(all, 'headX').jerk}`);
  const blocked = new SleepPose();
  assert.equal(blinkCount([...run(blocked, 'asleep', 6), ...run(blocked, 'awake', 3, false)]), 0, 'no wake blink while the layer is not allowed');
});

test('a new owner starts upright, the preview rate settles faster, and her side mirrors the roll', () => {
  const pose = new SleepPose();
  run(pose, 'asleep', 6);
  const other = pose.frame(DT, { owner: {}, phase: 'asleep', allowed: true });
  assert.ok(other.amount < 0.01, 'a model change starts from upright');
  const quick = new SleepPose(), slow = new SleepPose();
  assert.ok(run(quick, 'asleep', 3, true, { rate: 2 }).at(-1)!.amount > run(slow, 'asleep', 3).at(-1)!.amount + 0.2);
  const left = new SleepPose(), right = new SleepPose();
  assert.ok(run(left, 'asleep', 4, true, { side: -1 }).at(-1)!.headZ < 0 && run(right, 'asleep', 4).at(-1)!.headZ > 0);
  assert.deepEqual(new SleepPose().frame(DT, { owner, phase: 'not-a-phase', allowed: true }), NEUTRAL_SLEEP_FRAME);
  assert.deepEqual(new SleepPose().frame(Number.NaN, { owner, phase: 'asleep', allowed: true }), NEUTRAL_SLEEP_FRAME);
});
