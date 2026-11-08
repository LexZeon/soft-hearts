/**
 * R29f
 * Motion should move between key poses like keyframe animation: every frame lands smoothly between two keys and
 * the speed is continuous too. Record: docs/claude/2026-11-03-R29f-smoothness.md.
 *
 * 1. Modules: VMD keyframe interpolation (keyframe-interpolation.ts), the VMD curve-byte repair (vmd.ts), the
 *    frame clock's schedule (frame-clock.ts), the settings migration (validation.ts), cursor keys (pointer-keys.ts),
 *    a hand-off that starts at the shown speed (motion-transition.ts), sized chat-gesture fades (chat-gesture.ts).
 * 2. Typical scenes on the real Stage frame loop (gene-stage-harness: bundled Gene, its Stand VMD, real procedural
 *    life, mood feedback, chat gestures, her life, M1, the R15 dance), on a 60 Hz screen (refreshHz 60) with the
 *    stage's own frame clock at the 30 and 60 fps settings, measured per bone (tests/helpers/smoothness.ts):
 *    speed change per refresh (Δω), lone speed spikes, "stood still for a refresh, then caught up" holds, and the
 *    display guard's catches. R29F_REPORT=1 prints the table recorded in the R29f record.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AnimationClip, Bone, BufferGeometry, MeshBasicMaterial, NumberKeyframeTrack, Quaternion, QuaternionKeyframeTrack, Skeleton,
  SkinnedMesh, Vector3, VectorKeyframeTrack,
} from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
// @ts-expect-error Bundled parser has no TypeScript declaration.
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { AssetRegistry } from '../electron/assets';
import { SettingsStore } from '../electron/settings';
import { migrateStoredSettings, SETTINGS_VERSION, validateSettings } from '../electron/validation';
import { acceptStageFrame, type FrameSurface } from '../src/stage/frame-clock';
import { KeyframeInterpolant, keyframeClip, withKeyframeInterpolation } from '../src/stage/keyframe-interpolation';
import { repairVmdCurveBytes, parseVmdWith } from '../src/stage/vmd';
import { PointerKeys } from '../src/stage/pointer-keys';
import { MAX_DRIFT_DEG, MotionTransition, captureMotionPose } from '../src/stage/motion-transition';
import { ChatGesturePlayer, GESTURE_FADE_IN_S } from '../src/stage/chat-gesture';
import { MoodFeedback, EMPTY_CONTACT } from '../src/stage/mood-feedback';
import { MusicNod } from '../src/stage/music-nod';
import { songSample } from './helpers/gene-stage-harness';
import { seeded } from './helpers/seeded';
import { reportRow, runScenario, SCENARIOS, type ScenarioResult } from './helpers/r29f-scenarios';

const REPORT = !!process.env.R29F_REPORT;
const ONLY = process.env.R29F_ONLY;
const DEG = 180 / Math.PI;
const STAND = new URL('../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/motions/pose/stand.vmd', import.meta.url);
const STRAIGHT = [20 / 127, 107 / 127, 20 / 127, 107 / 127];
const yaw = (degrees: number) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), degrees / DEG).toArray();
const angleOf = (values: ArrayLike<number>) => 2 * Math.atan2(values[1], values[3]) * DEG;

/** A track through three's MMDLoader builder (its CubicBezierInterpolation and cut rule), with straight curves on every key. */
function mmdTrack(times: number[], angles: number[], curve: number[] = STRAIGHT): QuaternionKeyframeTrack {
  const builder = (new MMDLoader() as unknown as { animationBuilder: { _createTrack(node: string, type: unknown, times: number[], values: number[], interpolations: number[]): QuaternionKeyframeTrack } }).animationBuilder;
  return builder._createTrack('.bones[b].quaternion', QuaternionKeyframeTrack, times, angles.flatMap(yaw), times.flatMap(() => curve));
}
/** Angular speed (°/s) of a track sampled at `hz` over [from, to]. */
function speeds(evaluate: (t: number) => ArrayLike<number>, from: number, to: number, hz: number): number[] {
  const out: number[] = []; let last = angleOf(evaluate(from));
  for (let t = from + 1 / hz; t <= to + 1e-9; t += 1 / hz) { const now = angleOf(evaluate(t)); out.push((now - last) * hz); last = now; }
  return out;
}

// ------------------------------------------------------------------ 1. VMD playback as keyframe animation

test('R29f keyframe: a key on every frame is interpolated; MMD\'s cut rule had each pose stand still for a 60 fps frame', () => {
  // Captured motion: a key every 1/30 s turning 2° per key (60°/s), like every bundled gesture, idle and dance.
  const times = Array.from({ length: 10 }, (_, i) => i / 30), angles = times.map((_, i) => 2 * i);
  const track = mmdTrack(times, angles);
  const old = track.createInterpolant(), fresh = keyframeClip(new AnimationClip('c', 1, [mmdTrack(times, angles)])).tracks[0].createInterpolant();
  const oldSpeeds = speeds(t => old.evaluate(t), 2 / 30, 7 / 30, 60), newSpeeds = speeds(t => fresh.evaluate(t), 2 / 30, 7 / 30, 60);
  if (REPORT) console.log(`dense keys at 60 fps: MMDLoader ${oldSpeeds.map(v => v.toFixed(0)).join(' ')} °/s | keyframe ${newSpeeds.map(v => v.toFixed(0)).join(' ')} °/s`);
  assert.ok(oldSpeeds.some(v => Math.abs(v) < 1e-6) && oldSpeeds.some(v => v > 100), 'the old interpolant holds a pose and then takes a double step');
  for (const v of newSpeeds) assert.ok(Math.abs(v - 60) < 0.5, `steady 60°/s between and across keys (${v.toFixed(2)})`);
  for (let i = 0; i < times.length; i++) assert.ok(Math.abs(angleOf(fresh.evaluate(times[i])) - angles[i]) < 1e-4, 'every key is kept exactly');
});

test('R29f keyframe: straight segments become clamped cubics: speed carries through a key it passes, eases at turns, holds and ends, stays within its keys (one axis)', () => {
  // Hand-set keys a second apart: rise, rise more, hold, come back (the Stand idle\'s kind of keys).
  const times = [0, 1, 2, 3, 4], angles = [0, 10, 30, 30, 0];
  const curve = keyframeClip(new AnimationClip('c', 4, [mmdTrack(times, angles)])).tracks[0].createInterpolant();
  const at = (t: number) => angleOf(curve.evaluate(t)), slope = (t: number, h: number) => (at(t + h) - at(t)) / h;
  for (let i = 0; i < times.length; i++) assert.ok(Math.abs(at(times[i]) - angles[i]) < 1e-4, `key ${i} kept`);
  const left = slope(1 - 1e-3, 1e-3), right = slope(1, 1e-3);
  assert.ok(left > 5 && Math.abs(left - right) < 0.1, `the speed carries through key 1 (${left.toFixed(3)} vs ${right.toFixed(3)} °/s)`);
  assert.ok(Math.abs(slope(2 - 1e-4, 1e-4)) < 0.05 && Math.abs(slope(3, 1e-4)) < 0.05 && Math.abs(slope(4 - 1e-4, 1e-4)) < 0.05, 'eases into the hold, out of it and at the end');
  for (let t = 0; t <= 4; t += 0.01) assert.ok(at(t) > -1e-6 && at(t) < 30 + 1e-6, `no overshoot (${at(t).toFixed(4)} at ${t.toFixed(2)} s)`);
  for (let t = 2; t <= 3; t += 0.01) assert.ok(Math.abs(at(t) - 30) < 1e-6, 'a hold stays exactly still');
  // The same keys through MMDLoader: constant speed, turning at the key (a triangle-wave sway).
  const old = mmdTrack(times, angles).createInterpolant();
  const oldLeft = (angleOf(old.evaluate(1)) - angleOf(old.evaluate(1 - 1e-3))) / 1e-3, oldRight = (angleOf(old.evaluate(1 + 1e-3)) - angleOf(old.evaluate(1))) / 1e-3;
  assert.ok(Math.abs(oldLeft - oldRight) > 5, `the old interpolant kinks at the key (${oldLeft.toFixed(1)} → ${oldRight.toFixed(1)} °/s)`);
});

test('R29f keyframe (Codex T-112 round-005): a hold or a turn in captured motion stays within its keys; elsewhere the speed carries through', () => {
  const f = 1 / 30, dense = [0, f, 2 * f];
  const number = (values: number[], times = dense) => keyframeClip(new AnimationClip('m', times.at(-1)!, [new NumberKeyframeTrack('.morphTargetInfluences[0]', times, values)])).tracks[0].createInterpolant();
  // Codex's cases: [0,1,1] gave 1.0625 in the held segment, [0,0,1] −0.0625, the quaternion [0°,10°,10°] 10.625°, a vector X 1.0625.
  assert.equal(number([0, 1, 1]).evaluate(1.5 * f)[0], 1, 'a held weight stays at its key');
  assert.equal(number([0, 0, 1]).evaluate(0.5 * f)[0], 0, 'a zero hold stays at zero');
  const quaternion = keyframeClip(new AnimationClip('c', 2 * f, [mmdTrack(dense, [0, 10, 10])])).tracks[0].createInterpolant();
  assert.ok(Math.abs(angleOf(quaternion.evaluate(1.5 * f)) - 10) < 1e-6, `a held rotation stays at 10° (${angleOf(quaternion.evaluate(1.5 * f)).toFixed(6)}°)`);
  const vector = new KeyframeInterpolant(dense, [0, 0, 0, 1, 2, 3, 1, 2, 3], 3, undefined, new Array(36).fill(0).map((_, i) => STRAIGHT[i % 4]));
  assert.ok(Array.from(vector.evaluate(1.5 * f) as ArrayLike<number>).every((v, c) => Math.abs(v - [1, 2, 3][c]) < 1e-9), 'a held position stays put');
  // A turn ([0,1,0.5]) and a near-hold ([0,0.001,1]) in captured motion: never past either key of a segment.
  for (const values of [[0, 1, 0.5], [0, 0.001, 1], [1, 0.999, 0]]) {
    const curve = number(values);
    for (let t = 0; t <= 2 * f + 1e-9; t += f / 50) {
      const segment = Math.min(1, Math.floor(t / f)), lo = Math.min(values[segment], values[segment + 1]), hi = Math.max(values[segment], values[segment + 1]);
      const v = curve.evaluate(t)[0];
      assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `${JSON.stringify(values)} at ${(t / f).toFixed(2)} frames: ${v.toFixed(5)} outside [${lo}, ${hi}]`);
    }
  }
  // Seeded captured-like data (a key every frame, random speeds, holds and turns): every segment stays within its two keys.
  const random = seeded(29), times = Array.from({ length: 120 }, (_, i) => i * f);
  const weights: number[] = [], angles: number[] = [];
  for (let i = 0, w = 0.5, a = 0; i < times.length; i++) {
    const roll = random();
    w = roll < 0.15 ? w : Math.min(1, Math.max(0, w + (random() - 0.5) * 0.2)); weights.push(w);
    a = roll < 0.15 ? a : a + (random() - 0.4) * 6; angles.push(a);
  }
  const weightCurve = number(weights, times), angleCurve = keyframeClip(new AnimationClip('c', times.at(-1)!, [mmdTrack(times, angles)])).tracks[0].createInterpolant();
  let worstWeight = 0, worstDeg = 0;
  const past = (v: number, a: number, b: number) => Math.max(0, Math.min(a, b) - v, v - Math.max(a, b));
  for (let k = 0; k < times.length - 1; k++) for (let j = 0; j <= 20; j++) {
    const t = times[k] + j / 20 * f;
    worstWeight = Math.max(worstWeight, past(weightCurve.evaluate(t)[0], weights[k], weights[k + 1]));
    worstDeg = Math.max(worstDeg, past(angleOf(angleCurve.evaluate(t)), angles[k], angles[k + 1]));
  }
  // Tolerances are the tracks' Float32 storage of the keys (a weight ~1e-7, a quaternion ~1e-5°).
  assert.ok(worstWeight < 1e-6 && worstDeg < 1e-4, `largest step past a key: weight ${worstWeight}, rotation ${worstDeg}°`);
  // Where captured motion passes a key without turning or holding, the speed is the same on both sides (C1).
  const passing = number([0, 1, 3, 6, 10], [0, f, 2 * f, 3 * f, 4 * f]), slope = (t: number, h: number) => (passing.evaluate(t + h)[0] - passing.evaluate(t)[0]) / h;
  const left = slope(2 * f - 1e-5, 1e-5), right = slope(2 * f, 1e-5);
  assert.ok(left > 30 && Math.abs(left - right) < 0.05, `speed carries through a passing key (${left.toFixed(3)} vs ${right.toFixed(3)} /s)`);
});

test('R29f keyframe: an authored curve is played exactly as MMD does; vectors and morph weights get the same treatment', () => {
  const ease = [64 / 127, 64 / 127, 0, 1]; // x1, x2, y1, y2: a strong ease-in-out between two keys a second apart
  const authored = mmdTrack([0, 1, 2], [0, 40, 40], ease), reference = mmdTrack([0, 1, 2], [0, 40, 40], ease).createInterpolant();
  const curve = keyframeClip(new AnimationClip('c', 2, [authored])).tracks[0].createInterpolant();
  for (let t = 0; t <= 1; t += 0.05) assert.ok(Math.abs(angleOf(curve.evaluate(t)) - angleOf(reference.evaluate(t))) < 1e-4, `authored curve at ${t.toFixed(2)} s`);
  // Morph weights (MMD morph keys are linear): dense keys pass smoothly, the values stay within their keys.
  const morph = keyframeClip(new AnimationClip('m', 1, [new NumberKeyframeTrack('.morphTargetInfluences[0]', [0, 1 / 30, 2 / 30, 3 / 30], [0, 0.2, 0.4, 0.6])])).tracks[0].createInterpolant();
  assert.ok(Math.abs(morph.evaluate(1.5 / 30)[0] - 0.3) < 1e-6, 'a dense morph passes its keys at speed');
  assert.ok(morph.evaluate(0.5 / 30)[0] > 0 && morph.evaluate(0.5 / 30)[0] < 0.1, 'and starts from rest at the first key');
  // A direct interpolant on a vector track (MMD position parameters: 12 per key).
  const vector = new KeyframeInterpolant([0, 1, 2], [0, 0, 0, 1, 2, 3, 1, 2, 3], 3, undefined, new Array(36).fill(0).map((_, i) => STRAIGHT[i % 4]));
  assert.deepEqual(Array.from(vector.evaluate(1) as ArrayLike<number>), [1, 2, 3]);
  assert.ok(Array.from(vector.evaluate(1.5) as ArrayLike<number>).every((v, c) => Math.abs(v - [1, 2, 3][c]) < 1e-9), 'a held position stays put');
});

test('R29f VMD: MMD\'s per-key flag bytes no longer turn straight rotation curves into an infinite-slope start (Stand, in memory only)', async () => {
  const bytes = await readFile(STAND), buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const raw = new MMDParser.Parser().parseVmd(buffer.slice(0), true) as { motions: { interpolation: number[] }[] };
  const before = raw.motions.filter(motion => motion.interpolation[3] === 0 && motion.interpolation[18] !== 0).length;
  assert.ok(before > 100, `the Stand has MMD-written keys with zeroed rotation x1 (${before})`);
  assert.equal(repairVmdCurveBytes(raw.motions), before);
  const parsed = parseVmdWith(buffer) as unknown as { motions: { interpolation: number[] }[] };
  assert.ok(parsed.motions.every(motion => motion.interpolation[2] === motion.interpolation[17] && motion.interpolation[3] === motion.interpolation[18]),
    'the loader path (createVmdParser) sees the repaired curve bytes');
  assert.equal(createHashOf(await readFile(STAND)), createHashOf(bytes), 'the file is untouched');
  // A block whose copies disagree (no MMD shifted rows) is left exactly as it is.
  const odd = [{ interpolation: Array.from({ length: 64 }, (_, i) => i < 16 ? 20 : 0) }];
  assert.equal(repairVmdCurveBytes(odd), 0); assert.equal(odd[0].interpolation[3], 20);
});
function createHashOf(value: Uint8Array): string { let h = 0; for (const byte of value) h = (h * 31 + byte) >>> 0; return `${value.length}:${h}`; }

test('R29f keyframe: the stage builds every clip with it, once (withKeyframeInterpolation)', async () => {
  const loader = withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(vmd: unknown, mesh: unknown): AnimationClip } };
  assert.equal(withKeyframeInterpolation(loader), loader);
  const bone = new Bone(); bone.name = 'センター';
  const geometry = new BufferGeometry(), material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material);
  mesh.add(bone); mesh.bind(new Skeleton([bone])); mesh.morphTargetDictionary = {};
  try {
    const bytes = await readFile(STAND);
    const clip = loader.animationBuilder.build(parseVmdWith(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer), mesh);
    assert.ok(clip.tracks.length > 0 && clip.tracks.every(track => track.createInterpolant() instanceof KeyframeInterpolant));
  } finally { mesh.skeleton.dispose(); geometry.dispose(); material.dispose(); }
});

// ------------------------------------------------------------------ 2. the frame clock keeps its schedule

const VISIBLE: FrameSurface = { hostVisible: true, documentHidden: false, width: 400, height: 560 };
/** The frame clock before R29f: each frame due 1000 / fps − 0.5 ms after the last one. */
function oldAccept(previous: number, time: number, fps: number) {
  if (previous && time - previous < 1000 / fps - 0.5) return { render: false, previous };
  return { render: true, previous: time };
}
/** Rendered-frame intervals in display refreshes, over `callbacks` vsync callbacks with a fixed ± jitter pattern. */
function cadence(fps: number, hz: number, jitterMs: number, callbacks = 1200, old = false): Map<number, number> {
  let previous = 0, due = 0, lastIndex = -1;
  const counts = new Map<number, number>();
  for (let i = 0; i < callbacks; i++) {
    const wobble = Math.sin(i * 12.9898) * 43758.5453, time = 1000 + i * 1000 / hz + ((wobble - Math.floor(wobble)) * 2 - 1) * jitterMs;
    const decision = old ? oldAccept(previous, time, fps) : acceptStageFrame(previous, time, fps, VISIBLE, due);
    previous = decision.previous; if (!old) due = (decision as { due: number }).due;
    if (decision.render) { if (lastIndex >= 0) counts.set(i - lastIndex, (counts.get(i - lastIndex) ?? 0) + 1); lastIndex = i; }
  }
  return counts;
}
const show = (counts: Map<number, number>) => [...counts].sort((a, b) => a[0] - b[0]).map(([gap, n]) => `${gap}:${n}`).join(' ');

test('R29f frame clock: vsync wobble never holds a frame on screen for an extra refresh, at the 60 and 30 fps settings', () => {
  for (const jitter of [0.6, 1.5]) {
    const at60 = cadence(60, 60, jitter), at30 = cadence(30, 60, jitter), old60 = cadence(60, 60, jitter, 1200, true), old30 = cadence(30, 60, jitter, 1200, true);
    if (REPORT) console.log(`60 Hz, ±${jitter} ms: 60 fps setting new ${show(at60)} | old ${show(old60)}; 30 fps setting new ${show(at30)} | old ${show(old30)} (refreshes between rendered frames: count)`);
    assert.deepEqual([...at60.keys()], [1], `the 60 fps setting renders every refresh (${show(at60)})`);
    assert.deepEqual([...at30.keys()], [2], `the 30 fps setting renders every other refresh (${show(at30)})`);
    assert.ok([...old60.keys()].some(gap => gap > 1) && [...old30.keys()].some(gap => gap > 2), 'the old clock let a slightly early vsync skip a frame');
  }
  // Faster screens keep the cap on average without drift: 120 Hz at 60 fps every other refresh; 144 Hz averages 60.
  assert.deepEqual([...cadence(60, 120, 0.5).keys()], [2]);
  const at144 = cadence(60, 144, 0.5, 1440), frames = [...at144.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(frames / 10 - 60) < 1, `144 Hz: ${frames / 10} rendered frames per second (${show(at144)})`);
});

test('R29f frame clock: each rendered frame advances by the real time since the last one (a slow machine never replays a pose)', () => {
  let previous = 0, due = 0; const deltas: number[] = [], times = [1000, 1016.7, 1050.1, 1066.8, 1150, 1166.7];
  for (const time of times) {
    const decision = acceptStageFrame(previous, time, 60, VISIBLE, due);
    if (decision.render) deltas.push(decision.delta);
    previous = decision.previous; due = decision.due;
  }
  assert.deepEqual(deltas.map(v => Math.round(v * 10_000) / 10), [16.7, 16.7, 33.4, 16.7, 83.2, 16.7]);
});

// ------------------------------------------------------------------ 3. settings: 60 fps by default, migrated once

test('R29f settings: 60 fps by default; a version-1 file on the old default 30 moves to 60 once, and later choices stay', async () => {
  assert.equal(DEFAULT_SETTINGS.pet.fps, 60); assert.equal(DEFAULT_SETTINGS.version, SETTINGS_VERSION);
  assert.equal((migrateStoredSettings({ version: 1, pet: { fps: 30 } }).pet as { fps: number }).fps, 60);
  assert.equal((migrateStoredSettings({ pet: { fps: 30 } }).pet as { fps: number }).fps, 60, 'a file older than the version field');
  for (const raw of [{ version: 1, pet: { fps: 24 } }, { version: 1, pet: { fps: 60 } }, { version: 2, pet: { fps: 30 } }])
    assert.deepEqual(migrateStoredSettings(raw), raw, JSON.stringify(raw));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-r29f-settings-'));
  const secret = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };
  try {
    const old = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, any>; old.version = 1; old.pet.fps = 30;
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify(old));
    const store = new SettingsStore(directory, secret, new AssetRegistry());
    await store.load();
    assert.equal(store.current.pet.fps, 60, 'moved once');
    // She later picks 30 herself (a version-1 copy in the renderer is fine): it is saved as version 2 and kept.
    const choice = structuredClone(store.current) as unknown as Record<string, any>; choice.pet.fps = 30; choice.version = 1;
    await store.save(choice);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')).version, SETTINGS_VERSION);
    const again = new SettingsStore(directory, secret, new AssetRegistry());
    await again.load();
    assert.equal(again.current.pet.fps, 30, 'a choice saved after the move is never moved again');
    assert.equal(validateSettings({ ...again.current, pet: { ...again.current.pet, fps: 24 } }).pet.fps, 24);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ 4. smaller writers: cursor keys, hand-off, gesture fades, attention, nod

test('R29f cursor: 100 ms readings of a steadily moving cursor give the gaze a steady target speed', () => {
  const keys = new PointerKeys(), dt = 1 / 60, shown: number[] = [];
  let reading = 0;
  for (let frame = 0; frame < 120; frame++) {
    if (frame % 6 === 0) reading = frame * dt * 0.6; // read every 100 ms; the cursor moves 0.6 per second
    shown.push(keys.frame(dt, reading, 0).x);
  }
  const speedsShown = shown.slice(13).map((value, i) => (value - shown[12 + i]) / dt);
  for (const speed of speedsShown) assert.ok(Math.abs(speed - 0.6) < 0.02, `steady (${speed.toFixed(3)})`);
  const first = new PointerKeys(); assert.equal(first.frame(dt, 0.4, -0.2).x, 0.4, 'the first reading is taken at once');
});

function oneBone() {
  const bone = new Bone(); bone.name = '左腕';
  const geometry = new BufferGeometry(), material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material);
  mesh.add(bone); mesh.bind(new Skeleton([bone])); mesh.morphTargetInfluences = [];
  return { bone, mesh, dispose() { mesh.skeleton.dispose(); geometry.dispose(); material.dispose(); } };
}
test('R29f hand-off: the bridge starts at the speed the pose had (not from rest), coasts a bounded way and lands on the base', () => {
  const run = (rate: number[] | null) => {
    const f = oneBone();
    try {
      f.bone.quaternion.fromArray(yaw(20));
      const bridge = new MotionTransition(f.mesh), snapshot = captureMotionPose(f.mesh);
      f.bone.quaternion.fromArray(yaw(0)); // the base the bridge goes back to
      bridge.start(snapshot, ['.bones[左腕].quaternion'], 500, rate ? () => rate : null); bridge.frame(0);
      const shown: number[] = [angleOf(f.bone.quaternion.toArray())];
      for (let i = 0; i < 40; i++) { bridge.restore(); f.bone.quaternion.fromArray(yaw(0)); bridge.frame(1 / 60); shown.push(angleOf(f.bone.quaternion.toArray())); }
      return shown;
    } finally { f.dispose(); }
  };
  const moving = run([0, 60 / DEG, 0]), still = run(null); // it was turning on at 60°/s when the hand-off began
  const firstMoving = (moving[1] - moving[0]) * 60, firstStill = (still[1] - still[0]) * 60;
  if (REPORT) console.log(`hand-off first-frame speed: with the shown speed ${firstMoving.toFixed(1)}°/s (was turning at 60), from rest ${firstStill.toFixed(1)}°/s`);
  assert.ok(Math.abs(firstMoving - 60) < 6, `starts at the speed it had (${firstMoving.toFixed(2)}°/s)`);
  assert.ok(Math.abs(firstStill) < 1, 'without a rate it starts from rest, as before');
  assert.ok(Math.max(...moving) <= 20 + MAX_DRIFT_DEG + 1e-6, `coasts at most ${MAX_DRIFT_DEG}° on (${Math.max(...moving).toFixed(2)}°)`);
  assert.ok(Math.abs(moving.at(-1)!) < 1e-6 && Math.abs(still.at(-1)!) < 1e-6, 'both land on the base');
  const steps = moving.slice(1).map((value, i) => (value - moving[i]) * 60), changes = steps.slice(1).map((value, i) => Math.abs(value - steps[i]));
  // A cut would change the speed by most of its 60°/s in one frame; the bridge stays well within a third of it.
  assert.ok(Math.max(...changes) < 20, `no speed jump on the way (${Math.max(...changes).toFixed(2)}°/s per frame)`);
});

test('R29f gesture: the fade-in is sized by how far the arm travels to its first pose (bounded), with zero acceleration at both ends', () => {
  const fadeFor = (startDeg: number) => {
    const f = oneBone(), player = new ChatGesturePlayer(f.mesh);
    try {
      const clip = new AnimationClip('g', 6, [new QuaternionKeyframeTrack('.bones[左腕].quaternion', [0, 6], [...yaw(startDeg), ...yaw(startDeg)])]);
      assert.equal(player.play({ id: `g${startDeg}`, clip, strength: 0.6 }), true);
      const weights: number[] = [];
      for (let i = 0; i < 90; i++) { player.restore(); f.bone.quaternion.identity(); weights.push(player.frame(1 / 60, { blocked: false }).weight); }
      return { fade: (player as unknown as { current: { fadeIn: number } }).current.fadeIn, weights };
    } finally { player.dispose(); f.dispose(); }
  };
  const near = fadeFor(5), far = fadeFor(70);
  if (REPORT) console.log(`gesture fade-in: 5° away ${near.fade.toFixed(2)} s, 70° away ${far.fade.toFixed(2)} s (was 0.25 s for both)`);
  assert.equal(near.fade, GESTURE_FADE_IN_S.min);
  assert.ok(far.fade > 0.7 && far.fade <= GESTURE_FADE_IN_S.max, `a far start fades in slower (${far.fade.toFixed(3)} s)`);
  const w = far.weights, accel = w.slice(2).map((value, i) => (value - 2 * w[i + 1] + w[i]) * 3600);
  // smoothstep starts at its peak acceleration (ratio ~0.9 here); smootherstep from zero (~0.4 two frames in).
  assert.ok(Math.abs(accel[0]) < Math.max(...accel.map(Math.abs)) * 0.5, 'the weight starts without an acceleration step (smootherstep)');
});

test('R29f attention: after a snack or a pat the pointer gaze comes back from rest, not at full speed', () => {
  const feedback = new MoodFeedback(), dt = 1 / 60, state = { mood: 'calm', phase: 'idle', expressive: true, face: 50, posture: 50, playful: 50, responding: false };
  for (let i = 0; i < 90; i++) feedback.frame(dt, { ...EMPTY_CONTACT, feeding: true, near: 1 }, state);
  const weights: number[] = [];
  for (let i = 0; i < 60; i++) { feedback.frame(dt, EMPTY_CONTACT, state); weights.push(feedback.attentionWeight); }
  const first = (1 - weights[0]) / dt, peak = Math.max(...weights.slice(1).map((value, i) => (weights[i] - value) / dt));
  assert.ok(first < peak * 0.3, `the hand-back starts gently (${first.toFixed(2)}/s vs peak ${peak.toFixed(2)}/s; first order started at its peak, 5/s)`);
});

test('R29f nod: M1\'s head nod keeps a continuous speed through each beat\'s accent', () => {
  const nod = new MusicNod(), dt = 1 / 60, shown: number[] = [];
  nod.setActive(true);
  for (let frame = 0; frame < 360; frame++) { if (frame % 2 === 0) nod.update(songSample(frame / 2)); shown.push(nod.frame(dt, 0.7).headX); }
  const speed = shown.slice(1).map((value, i) => (value - shown[i]) / dt * DEG), change = speed.slice(1).map((value, i) => Math.abs(value - speed[i]));
  if (REPORT) console.log(`nod: largest speed change per frame ${Math.max(...change.slice(60)).toFixed(2)}°/s (peak speed ${Math.max(...speed.map(Math.abs)).toFixed(1)}°/s)`);
  assert.ok(Math.max(...change.slice(60)) < 2, `no kick at the accents (${Math.max(...change.slice(60)).toFixed(2)}°/s per frame)`);
});

// ------------------------------------------------------------------ 5. typical scenes on the real Stage loop

test('R29f scenes: on a 60 Hz screen at the 60 fps setting no pose stands still and catches up, and no speed jumps past its limit', async () => {
  const rows: string[] = [], results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    if (ONLY && !ONLY.split(',').includes(scenario.name)) continue;
    for (const fps of [30, 60]) {
      for (const result of await runScenario(scenario, fps)) { rows.push(reportRow(result)); results.push(result); }
    }
  }
  if (REPORT) console.log(['| 场景 | fps | 屏幕上最大 Δω °/s（骨骼 @时刻） | 渲染帧最大 Δω °/s | 速度尖峰（全部骨骼） | 停顿后追上（屏幕，全部骨骼） | 护栏拦截 |', '|---|---|---|---|---|---|---|', ...rows].join('\n'));
  for (const result of results) {
    if (result.fps !== 60 || result.limit === null) continue;
    const m = result.measure;
    assert.ok(m.display.maxDv <= result.limit, `${result.window}: ${m.worstBone} ${m.display.maxDv.toFixed(2)} > ${result.limit}°/s at ${m.display.maxAt.toFixed(2)} s`);
    assert.equal(m.displayHolds, 0, `${result.window}: a pose stood still for a refresh and then caught up`);
    assert.equal(m.guard, 0, `${result.window}: the display guard had to catch a cut`);
  }
  const r29e = results.find(result => result.scenario === 'r29e' && result.fps === 60);
  if (r29e) assert.equal(r29e.measure.displayHolds, 0, 'the dance switch: no hold either (the clip\'s own fast steps are its content)');
});
