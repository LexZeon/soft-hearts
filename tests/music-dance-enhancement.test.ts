import assert from 'node:assert/strict';
import test from 'node:test';
import { MUSIC_DANCE_LIMITS, MUSIC_RELEASE_SECONDS, MusicDance, musicReleaseGain, type MusicDancePose, type MusicEnergySample } from '../src/stage/music-dance';

const ZERO: MusicDancePose = { sway: 0, bounce: 0, chestRoll: 0, headRoll: 0, headPitch: 0 };
const sample = (time: number): MusicEnergySample => ({ time, rms: 0.016, low: 0.12, mid: 0.008, high: 0.001 });
const radians = (degrees: number) => degrees * Math.PI / 180;

function run(strength: number, frameRate = 60): MusicDancePose[] {
  const dance = new MusicDance();
  const poses: MusicDancePose[] = [];
  for (let i = 0; i < frameRate * 12; i++) {
    // Native capture supplies at most 30 Hz, while the pose is rendered every frame.
    if (i % (frameRate / 30) === 0) dance.update(sample(i / frameRate));
    const pose = dance.frame(1 / frameRate, strength);
    if (i >= frameRate * 8) poses.push(pose);
  }
  return poses;
}

test('sustained soft bass retains continuous visible nodding after onset has ended', () => {
  for (const frameRate of [30, 60]) {
    const poses = run(0.7, frameRate);
    const head = poses.map(pose => pose.headPitch);
    const span = Math.max(...head) - Math.min(...head);
    assert.ok(span >= radians(2), `${frameRate} Hz nod span ${span * 180 / Math.PI} degrees`);
    // There must be several down-and-back cycles, not merely a surviving offset.
    let turningPoints = 0;
    for (let i = 2; i < head.length; i++) {
      if ((head[i] - head[i - 1]) * (head[i - 1] - head[i - 2]) < 0) turningPoints++;
    }
    assert.ok(turningPoints >= 10, `${frameRate} Hz has ${turningPoints} reversals`);
    assert.ok(head.every(value => value >= 0 && value <= MUSIC_DANCE_LIMITS.headPitch));
  }
});

test('independent strength scales every pose channel without changing sample timing', () => {
  const zero = run(0), half = run(0.35), full = run(0.7);
  assert.ok(zero.every(pose => Object.values(pose).every(value => value === 0)));
  for (let i = 0; i < full.length; i++) {
    for (const key of Object.keys(ZERO) as (keyof MusicDancePose)[]) {
      assert.ok(Math.abs(full[i][key] - half[i][key] * 2) < 1e-6, `${key} frame ${i}`);
      assert.ok(Number.isFinite(full[i][key]));
      assert.ok(Math.abs(full[i][key]) <= MUSIC_DANCE_LIMITS[key]);
    }
  }
});

test('changing strength to zero fades smoothly and does not need new capture consent', () => {
  const dance = new MusicDance();
  let before = ZERO;
  for (let i = 0; i < 64; i++) {
    dance.update(sample(i / 30));
    before = dance.frame(1 / 30, 0.7);
  }
  const first = dance.frame(1 / 60, 0);
  assert.ok(first.headPitch > 0 && first.headPitch < before.headPitch);
  for (let i = 0; i < 180; i++) {
    dance.update(sample((64 + i) / 30));
    dance.frame(1 / 30, 0);
  }
  assert.deepEqual(dance.frame(1 / 30, 0), ZERO);
});

test('suppression fades the existing offset, discards incoming beats and never replays them on release', () => {
  const dance = new MusicDance();
  for (let i = 0; i < 64; i++) {
    dance.update(sample(i / 30));
    dance.frame(1 / 30, 0.7);
  }
  dance.setSuppressed(true);
  const fading = dance.frame(1 / 60, 0.7);
  assert.ok(fading.headPitch > 0, 'the current presentation fades instead of snapping');
  for (let i = 0; i < 180; i++) {
    const rejected = dance.update({ time: 5 + i / 30, rms: 0.8, low: 0.9, mid: 0.7, high: 0.5 });
    assert.deepEqual(rejected, { active: false, pulse: false, strength: 0 });
    dance.frame(1 / 30, 0.7);
  }
  assert.deepEqual(dance.frame(1 / 30), ZERO);
  dance.setSuppressed(false);
  for (let i = 0; i < 60; i++) assert.deepEqual(dance.frame(1 / 30), ZERO);
  const fresh = dance.update(sample(20));
  assert.equal(fresh.active, true);
  assert.equal(fresh.pulse, true, 'fresh input gets a fresh onset, with no old timing or backlog');
  assert.notDeepEqual(dance.frame(1 / 30), ZERO);
});

test('invalid strength and frame times cannot escape bounds and duplicate samples do not refresh stale audio', () => {
  const dance = new MusicDance();
  const first = sample(1);
  dance.update(first);
  for (let i = 0; i < 360; i++) {
    const duplicate = dance.update(first);
    assert.equal(duplicate.pulse, false);
    const pose = dance.frame(i % 2 ? 1 / 30 : 1 / 60, i % 4 === 0 ? Number.NaN : 1000);
    for (const key of Object.keys(ZERO) as (keyof MusicDancePose)[]) {
      assert.ok(Number.isFinite(pose[key]));
      assert.ok(Math.abs(pose[key]) <= MUSIC_DANCE_LIMITS[key]);
    }
  }
  assert.deepEqual(dance.frame(1 / 30), ZERO, 'duplicates do not keep audio alive');
  dance.update(sample(0.5));
  const backwards = dance.frame(1 / 30, 0.7);
  assert.ok(Object.values(backwards).every(Number.isFinite));
  dance.update({ ...sample(Number.NaN), rms: Infinity, low: Number.NaN });
  assert.deepEqual(dance.frame(Infinity), ZERO);
});

test('read-only engine diagnostics distinguish a recent pulse from stale input', () => {
  const dance = new MusicDance();
  assert.deepEqual(dance.getState(), { active: false, pulse: false, level: 0, sampleAge: null, suppressed: false,
    releasing: false, releaseProgress: 1, releaseRemainingMs: 0, presence: 1 });
  dance.update(sample(0)); dance.frame(1 / 30);
  const first = dance.getState();
  assert.equal(first.active, true); assert.equal(first.pulse, true);
  assert.deepEqual(dance.getState(), first, 'reading does not advance any clock');
  dance.frame(0.21);
  assert.equal(dance.getState().active, false); assert.equal(dance.getState().pulse, false);
  dance.setSuppressed(true);
  assert.equal(dance.getState().suppressed, true); assert.equal(dance.getState().sampleAge, null);
});

function playingPose(dance: MusicDance, fps = 60): MusicDancePose {
  for (let frame = 0; frame < fps * 5; frame++) {
    dance.update(sample(frame / fps));
    const pose = dance.frame(1 / fps, 0.7);
    if (frame >= fps && pose.headPitch > 0.03 && Math.abs(pose.sway) > 0.00001) return pose;
  }
  assert.fail('the fixture must first reach a visible nonzero actual music pose');
}

const channels = Object.keys(ZERO) as (keyof MusicDancePose)[];

/** Largest per-frame change of each channel while the dance is playing. */
function playingSteps(dance: MusicDance, fps: number): { pose: MusicDancePose; steps: MusicDancePose } {
  const steps = { ...ZERO };
  let previous = ZERO, pose = ZERO;
  for (let frame = 0; frame < fps * 5; frame++) {
    dance.update(sample(frame / fps));
    pose = dance.frame(1 / fps, 0.7);
    if (frame >= fps * 3) for (const channel of channels) steps[channel] = Math.max(steps[channel], Math.abs(pose[channel] - previous[channel]));
    previous = pose;
  }
  assert.ok(pose.headPitch > 0.01 || Math.abs(pose.sway) > 1e-4, 'the fixture is visibly dancing');
  return { pose, steps };
}
/** Shown music offsets can never exceed the strength-scaled limit times the exit envelope. */
const envelope = (channel: keyof MusicDancePose, seconds: number) =>
  MUSIC_DANCE_LIMITS[channel] * 0.7 * musicReleaseGain(seconds / MUSIC_RELEASE_SECONDS) + 1e-12;

test('turning the rhythm off keeps the dance moving and eases it out to the live base (R15)', () => {
  assert.ok(MUSIC_RELEASE_SECONDS >= 0.3 && MUSIC_RELEASE_SECONDS <= 0.8, 'a few hundred milliseconds');
  // Ease-out: most of the motion leaves early and it lands gently.
  assert.equal(musicReleaseGain(0), 1); assert.equal(musicReleaseGain(1), 0);
  assert.ok(musicReleaseGain(0.5) <= 0.25 && musicReleaseGain(0.9) < 0.02);
  for (const fps of [24, 30, 60]) {
    const dance = new MusicDance(), { pose: before, steps } = playingSteps(dance, fps);
    dance.stop();
    assert.deepEqual(dance.frame(0), before, 'an event between display ticks must not change the pose');
    assert.equal(dance.getState().active, false); assert.equal(dance.getState().pulse, false);
    assert.equal(dance.getState().sampleAge, null, 'capture input and its last beat are already gone');
    assert.equal(dance.getState().releasing, true);
    let previous = before, endedAt = 0, ratiosAt = null as number[] | null;
    for (let frame = 1; frame <= Math.ceil(fps * (MUSIC_RELEASE_SECONDS + 0.2)); frame++) {
      const seconds = frame / fps, pose = dance.frame(1 / fps);
      for (const channel of channels) {
        assert.ok(Number.isFinite(pose[channel]));
        assert.ok(Math.abs(pose[channel]) <= envelope(channel, seconds), `${fps}Hz ${channel} eases out under the envelope at ${seconds}s`);
        // Never faster than the dance itself plus the envelope's own steepest slope: no jump.
        const allowed = steps[channel] + MUSIC_DANCE_LIMITS[channel] * 0.7 * 2 / MUSIC_RELEASE_SECONDS / fps + 1e-9;
        assert.ok(Math.abs(pose[channel] - previous[channel]) <= allowed, `${fps}Hz ${channel} step at ${seconds}s`);
      }
      if (!ratiosAt && seconds >= 0.15) ratiosAt = channels.filter(channel => Math.abs(before[channel]) > 1e-4).map(channel => pose[channel] / before[channel]);
      previous = pose;
      if (channels.every(channel => pose[channel] === 0)) { endedAt = seconds; break; }
    }
    assert.ok(ratiosAt && Math.max(...ratiosAt) - Math.min(...ratiosAt) > 0.05, `${fps}Hz keeps its own motion instead of freezing one pose`);
    assert.ok(Math.abs(endedAt - MUSIC_RELEASE_SECONDS) <= 1 / fps + 1e-9, `${fps}Hz completed in ${endedAt}s`);
    assert.equal(dance.getState().releasing, false);
    assert.equal(dance.getState().releaseProgress, 1);
    assert.equal(dance.getState().releaseRemainingMs, 0);
    assert.deepEqual(dance.frame(1 / fps), ZERO);
  }
});

test('turning the rhythm back on mid-exit continues from what is shown and grows back (R15)', () => {
  const fps = 60, dance = new MusicDance(), { pose: before, steps } = playingSteps(dance, fps);
  dance.stop();
  let shown = before;
  for (let frame = 0; frame < fps * 0.2; frame++) shown = dance.frame(1 / fps);
  dance.resume();
  assert.deepEqual(dance.frame(0), shown, 'turning it on cannot move the displayed pose');
  let previous = shown, peak = 0;
  for (let frame = 0; frame < fps * 1.5; frame++) {
    dance.update(sample(100 + frame / fps));
    const pose = dance.frame(1 / fps);
    for (const channel of channels) assert.ok(Math.abs(pose[channel] - previous[channel]) <= steps[channel] * 1.5 + 0.004, `${channel} frame ${frame}`);
    if (frame >= fps) peak = Math.max(peak, pose.headPitch);
    previous = pose;
  }
  assert.equal(dance.getState().releasing, false);
  assert.ok(peak > 0.03, 'the nod comes back to a clearly visible size');
});

test('repeated stops cannot extend the tail, and rejected off-state samples cannot queue another beat', () => {
  const dance = new MusicDance(); playingPose(dance);
  dance.stop(); dance.frame(0.1);
  const midway = dance.getState();
  dance.stop();
  assert.deepEqual(dance.getState(), midway, 'a repeated off acknowledgement cannot restart the release clock');
  for (let frame = 0; frame < 30; frame++) {
    assert.deepEqual(dance.update({ time: 100 + frame, rms: 1, low: 1, mid: 1, high: 1 }), { active: false, pulse: false, strength: 0 });
    dance.frame(1 / 60);
  }
  assert.deepEqual(dance.frame(0), ZERO);
  assert.equal(dance.getState().active, false); assert.equal(dance.getState().sampleAge, null);
  dance.resume();
  for (let frame = 0; frame < 30; frame++) {
    assert.deepEqual(dance.frame(1 / 60), ZERO, 'resuming without new input cannot play the discarded loud samples');
    assert.equal(dance.getState().pulse, false);
  }
});

test('a quick off/on preserves only the unfinished display tail until fresh valid audio arrives', () => {
  const dance = new MusicDance(); playingPose(dance);
  dance.stop(); const tail = dance.frame(0.08);
  assert.ok(channels.some(channel => tail[channel] !== 0));
  for (const channel of channels) assert.ok(Math.abs(tail[channel]) <= envelope(channel, 0.08));
  dance.resume();
  assert.deepEqual(dance.frame(0), tail, 'the on event itself cannot jump the displayed pose');
  assert.equal(dance.getState().active, false); assert.equal(dance.getState().pulse, false);
  const quiet = dance.update({ time: 20, rms: 0, low: 0, mid: 0, high: 0 });
  assert.equal(quiet.active, false); assert.equal(quiet.pulse, false);
  const next = dance.frame(0.08);
  assert.equal(dance.getState().releasing, true, 'fresh silence lets the original tail continue');
  for (const channel of channels) assert.ok(Math.abs(next[channel]) <= envelope(channel, 0.16));
  dance.frame(MUSIC_RELEASE_SECONDS); assert.deepEqual(dance.frame(0), ZERO);
  const fresh = dance.update(sample(21));
  assert.equal(fresh.active, true); assert.equal(fresh.pulse, true, 'only the new input supplies a new onset');
  assert.equal(dance.getState().releasing, false);
  assert.ok(dance.frame(1 / 60).headPitch > 0);
});

test('fresh audible input can rejoin an unfinished release without an event-time pose jump', () => {
  const dance = new MusicDance(); playingPose(dance);
  dance.stop(); const tail = dance.frame(0.1);
  dance.resume();
  const fresh = dance.update(sample(50));
  assert.equal(fresh.active, true); assert.equal(fresh.pulse, true);
  assert.equal(dance.getState().releasing, false);
  assert.deepEqual(dance.frame(0), tail, 'new sample acceptance alone never rewrites the current pose');
  const first = dance.frame(1 / 60);
  assert.ok(first.headPitch > 0 && first.headPitch <= MUSIC_DANCE_LIMITS.headPitch);
  assert.ok(Math.abs(first.headPitch - tail.headPitch) < 0.015, 'the first fresh display moves continuously from the actual residual');
});

test('hard reset cancels a pending release without silently resuming stopped input', () => {
  const dance = new MusicDance(); playingPose(dance);
  dance.stop(); assert.ok(dance.frame(0.08).headPitch > 0);
  dance.reset();
  assert.equal(dance.getState().releasing, false); assert.equal(dance.getState().releaseRemainingMs, 0);
  assert.deepEqual(dance.frame(0), ZERO);
  assert.deepEqual(dance.update(sample(30)), { active: false, pulse: false, strength: 0 });
  assert.deepEqual(dance.frame(1 / 60), ZERO);
  dance.resume(); assert.equal(dance.update(sample(31)).active, true);
  assert.ok(dance.frame(1 / 60).headPitch > 0);
});

test('bad frame deltas cannot turn a release into a jump or an unbounded pose', () => {
  const dance = new MusicDance(), before = playingPose(dance);
  dance.stop(); const initial = dance.getState();
  for (const delta of [NaN, Infinity, -Infinity, -1]) {
    assert.deepEqual(dance.frame(delta), before);
    assert.deepEqual(dance.getState(), initial, 'nonfinite or negative frame time does not advance the tail');
  }
  const afterLongGap = dance.frame(1e6);
  assert.deepEqual(afterLongGap, ZERO); assert.equal(dance.getState().releasing, false);
});
