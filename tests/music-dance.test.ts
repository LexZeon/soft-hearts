import assert from "node:assert/strict";
import test from "node:test";
import { MUSIC_DANCE_LIMITS, MusicDance, type MusicDancePose, type MusicEnergySample } from "../src/stage/music-dance";

const ZERO: MusicDancePose = { sway: 0, bounce: 0, chestRoll: 0, headRoll: 0, headPitch: 0 };
const energy = (time: number, values: Partial<Omit<MusicEnergySample, "time">> = {}): MusicEnergySample =>
  ({ time, rms: 0.1, low: 0.05, mid: 0.05, high: 0.03, ...values });

function checkBounds(pose: MusicDancePose): void {
  for (const key of Object.keys(MUSIC_DANCE_LIMITS) as (keyof MusicDancePose)[]) {
    assert.ok(Number.isFinite(pose[key]), key);
    assert.ok(Math.abs(pose[key]) <= MUSIC_DANCE_LIMITS[key], `${key} is bounded`);
  }
  assert.ok(pose.bounce >= 0);
}

test("silence and a quiet noise floor cannot start rhythmic motion", () => {
  const dance = new MusicDance();
  assert.deepEqual(dance.frame(1 / 30), ZERO);
  for (let i = 0; i < 300; i++) {
    const jitter = i % 3 * 0.001;
    const beat = dance.update(energy(i / 30, { rms: 0.005 + jitter, low: 0.006 + jitter, mid: 0.005, high: 0.004 }));
    assert.equal(beat.active, false);
    assert.equal(beat.pulse, false);
    assert.deepEqual(dance.frame(1 / 30), ZERO);
  }
});

test("sustained soft music stays active beyond ten seconds and still returns to silence", () => {
  const dance = new MusicDance();
  // Warm the quiet-floor learner before introducing low-volume music.
  for (let i = 0; i < 300; i++) {
    assert.equal(dance.update(energy(i / 30, { rms: 0.007, low: 0.006, mid: 0.005, high: 0.004 })).active, false);
    assert.deepEqual(dance.frame(1 / 30), ZERO);
  }
  for (let i = 300; i < 900; i++) {
    const beat = dance.update(energy(i / 30, { rms: 0.016, low: 0.06, mid: 0.04, high: 0.02 }));
    assert.equal(beat.active, true, `soft music remains active at ${(i - 300) / 30}s`);
    const pose = dance.frame(1 / 30);
    checkBounds(pose);
    if (i > 600) assert.ok(Object.values(pose).some(value => Math.abs(value) > 1e-7));
  }
  for (let i = 900; i < 1200; i++) {
    dance.update(energy(i / 30, { rms: 0, low: 0, mid: 0, high: 0 }));
    dance.frame(1 / 30);
  }
  assert.deepEqual(dance.frame(1 / 30), ZERO);
});

test("periodic bass onsets make pulses with a refractory period instead of retriggering every sample", () => {
  const dance = new MusicDance();
  const pulses: number[] = [];
  let largestBounce = 0;
  for (let i = 0; i < 180; i++) {
    const kick = i % 15 < 2;
    const beat = dance.update(energy(i / 30, { rms: kick ? 0.3 : 0.08, low: kick ? 0.6 : 0.04 }));
    if (beat.pulse) pulses.push(i / 30);
    largestBounce = Math.max(largestBounce, dance.frame(1 / 30).bounce);
  }
  assert.equal(pulses.length, 12);
  for (let i = 1; i < pulses.length; i++) assert.ok(pulses[i] - pulses[i - 1] >= 0.18);
  assert.ok(largestBounce > 0.0001);
});

test("stronger bass changes produce larger beat strength and body bounce", () => {
  function beatSize(low: number) {
    const dance = new MusicDance();
    for (let i = 0; i < 60; i++) {
      dance.update(energy(i / 30));
      dance.frame(1 / 30);
    }
    const beat = dance.update(energy(2, { rms: 0.2, low }));
    let bounce = 0;
    for (let i = 0; i < 5; i++) bounce = Math.max(bounce, dance.frame(1 / 60).bounce);
    return { beat, bounce };
  }
  const weak = beatSize(0.13);
  const strong = beatSize(0.8);
  assert.equal(weak.beat.pulse, true);
  assert.equal(strong.beat.pulse, true);
  assert.ok(strong.beat.strength > weak.beat.strength);
  assert.ok(strong.bounce > weak.bounce * 1.2);
});

test("frequency balance changes the movement mixture rather than replaying one fixed dance", () => {
  function run(values: { low: number; mid: number; high: number }) {
    const dance = new MusicDance();
    const totals = { ...ZERO };
    for (let i = 0; i < 300; i++) {
      const pulse = i % 15 === 0 ? 1 : 0.2;
      dance.update(energy(i / 30, { rms: 0.2, low: values.low * pulse, mid: values.mid * pulse, high: values.high * pulse }));
      const pose = dance.frame(1 / 30);
      checkBounds(pose);
      for (const key of Object.keys(totals) as (keyof MusicDancePose)[]) totals[key] += Math.abs(pose[key]);
    }
    return totals;
  }
  const bass = run({ low: 0.7, mid: 0.06, high: 0.03 });
  const synth = run({ low: 0.04, mid: 0.6, high: 0.55 });
  assert.ok(bass.bounce > synth.bounce * 1.2);
  assert.ok(synth.headRoll > bass.headRoll * 1.2);
  assert.ok(synth.chestRoll > bass.chestRoll * 1.2);
});

test("steady high energy adapts to its recent baseline without generating repeated beats", () => {
  const dance = new MusicDance();
  let pulses = 0;
  let initialMotion = 0;
  let settledMotion = 0;
  for (let i = 0; i < 1800; i++) {
    const beat = dance.update(energy(i / 30, { rms: 0.7, low: 0.8, mid: 0.6, high: 0.4 }));
    pulses += Number(beat.pulse);
    const pose = dance.frame(1 / 30);
    checkBounds(pose);
    if (i >= 30 && i < 150) initialMotion += Math.abs(pose.sway);
    if (i >= 1680) settledMotion += Math.abs(pose.sway);
  }
  assert.equal(pulses, 1);
  assert.ok(settledMotion < initialMotion * 1.1);
});

test("silence and missing capture samples decay to exact zero without accumulating displacement", () => {
  for (const samplesContinue of [false, true]) {
    const dance = new MusicDance();
    for (let i = 0; i < 60; i++) {
      dance.update(energy(i / 30, { rms: 0.3, low: i % 15 === 0 ? 0.7 : 0.1 }));
      dance.frame(1 / 30);
    }
    for (let i = 60; i < 360; i++) {
      if (samplesContinue) dance.update(energy(i / 30, { rms: 0, low: 0, mid: 0, high: 0 }));
      checkBounds(dance.frame(1 / 30));
    }
    assert.deepEqual(dance.frame(1 / 30), ZERO);
    assert.deepEqual(dance.frame(10), ZERO);
  }
});

test("reset cancels impulses immediately and clears previous timing", () => {
  const dance = new MusicDance();
  dance.update(energy(100, { rms: 0.5, low: 0.7 }));
  assert.notDeepEqual(dance.frame(1 / 30), ZERO);
  dance.reset();
  assert.deepEqual(dance.frame(0), ZERO);
  assert.deepEqual(dance.frame(1 / 30), ZERO);
  assert.equal(dance.update(energy(0, { rms: 0.5, low: 0.7 })).pulse, true);
});

test("duplicate or reversed timestamps and malformed energies cannot create nonfinite output", () => {
  const dance = new MusicDance();
  const loud = energy(1, { rms: 0.5, low: 0.6 });
  assert.equal(dance.update(loud).pulse, true);
  assert.equal(dance.update(loud).pulse, false);
  checkBounds(dance.frame(1 / 30));
  dance.update(energy(0.5, { rms: Infinity, low: NaN, mid: -50, high: 1000 }));
  checkBounds(dance.frame(Infinity));
  dance.update(energy(NaN));
  assert.deepEqual(dance.frame(1 / 30), ZERO);
  for (let i = 0; i < 1000; i++) {
    dance.update(energy(i / 30, { rms: i % 2 ? 1000 : 0, low: i % 3 ? 0 : 1000, mid: i % 5 ? 0 : 1000, high: i % 7 ? 0 : 1000 }));
    checkBounds(dance.frame(i % 4 ? 1 / 30 : 0.1));
  }
});

test("returned poses are snapshots and cannot mutate subsequent state", () => {
  const dance = new MusicDance();
  const result = dance.frame(0);
  result.sway = 100;
  assert.deepEqual(dance.frame(0), ZERO);
});
