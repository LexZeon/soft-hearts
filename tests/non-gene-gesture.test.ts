/**
 * On a model that is not the reviewed Gene the library gestures go
 * through motion retargeting (shared/motion-retarget.ts): bones that map one to one keep their keys (one per capture frame), the
 * re-posed combinations are baked every 2 frames. The capture smoothing (capture-smoothing.ts) first only took runs one frame
 * apart, so a baked arm or wrist kept its jitter on exactly the models that are not Gene. Here: a synthetic T-pose body with twist
 * bones (no user data), both chat gestures retargeted onto it by the stage's own retarget, played by the stage's ChatGesturePlayer
 * over a still base, with the display guard (PoseContinuity) on top: what it catches, at 60 and 30 fps, at 0.46 and the maximum 0.7.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AnimationClip, Bone, Quaternion, SkinnedMesh } from 'three';
import { RPS_TIMING as T, type RpsView } from '../shared/rps';
import { RpsPerformance, rpsStageCue } from '../src/stage/rps-performance';
import { bodyModel } from './helpers/body-fixtures';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { buildModelProfile } from '../shared/model-profile';
import { StageMotionRetarget, clearRetargetCache } from '../src/stage/motion-retarget';
import { parseVmdWith } from '../src/stage/vmd';
import { withKeyframeInterpolation } from '../src/stage/keyframe-interpolation';
import { ChatGesturePlayer, isChatGestureTrack } from '../src/stage/chat-gesture';
import { smoothCapturedClip, smoothCapturedRotations } from '../src/stage/capture-smoothing';
import { PoseContinuity } from '../src/stage/pose-continuity';
import catalog from '../shared/motion-catalog.json';
import { catalogMotionFile } from './helpers/gene-stage-harness';
import { profileInput, toThreeMesh, toyModel } from './helpers/model-fixtures';

type Gesture = readonly ['genea-2022-gestures' | 'mpi-embm-gestures', 'speaking-gesture-2' | 'conversation-joy'];
const GESTURES: readonly Gesture[] = [['genea-2022-gestures', 'speaking-gesture-2'], ['mpi-embm-gestures', 'conversation-joy']];

async function retargeted(mesh: SkinnedMesh, retarget: StageMotionRetarget, [pack, motion]: Gesture, smooth: boolean): Promise<AnimationClip> {
  const bytes = await readFile(catalogMotionFile(pack, motion));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const vmd = parseVmdWith(buffer, retarget.transform);
  const builder = (withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(vmd: unknown, mesh: SkinnedMesh): AnimationClip } }).animationBuilder;
  const clip = builder.build(vmd, mesh);
  clip.duration = catalog.packs.find(p => p.id === pack)!.motions.find(m => m.id === motion)!.durationFrames / 30;
  if (smooth) smoothCapturedClip(clip, isChatGestureTrack);
  return clip;
}

/** The gesture over the model's still rest pose (a trusted base), the guard after it, as the stage orders them. */
function play(mesh: SkinnedMesh, clip: AnimationClip, fps: number, strength: number) {
  const player = new ChatGesturePlayer(mesh), guard = new PoseContinuity(mesh as never, { height: 20 });
  assert.ok(player.play({ id: `g-${fps}-${strength}-${Math.random()}`, clip, strength }), 'the retargeted gesture plays on the synthetic body');
  const caught: string[] = [];
  let last = 0;
  for (let i = 0, n = Math.round((clip.duration + 0.5) * fps); i < n; i++) {
    guard.remove(); player.restore();
    guard.captureBase(true);
    player.frame(1 / fps, { blocked: false });
    guard.apply(1 / fps, 1 / fps);
    const state = guard.getState();
    if (state.jumps > last) { caught.push(`${state.lastJump?.property} ${state.lastJump?.size}`); last = state.jumps; }
  }
  return caught;
}

test('a run baked every 2 frames is smoothed like one keyed every frame (same time-scale), its ends kept', () => {
  const n = 46, times = Array.from({ length: n }, (_, i) => 2 * i / 30);
  const values: number[] = [];
  for (let i = 0; i < n; i++) { const deg = 20 * Math.sin(2 * Math.PI * 1.2 * times[i]) + (i % 2 ? 3 : -3), half = deg / 2 * Math.PI / 180; values.push(0, 0, Math.sin(half), Math.cos(half)); }
  const first = values.slice(0, 4), lastKey = values.slice(-4);
  assert.equal(smoothCapturedRotations(times, values), n - 2, 'every inner key of a 2-frame run moves');
  assert.deepEqual(values.slice(0, 4), first); assert.deepEqual(values.slice(-4), lastKey);
  const angle = (i: number) => 2 * Math.atan2(values[i * 4 + 2], values[i * 4 + 3]) * 180 / Math.PI;
  let alternation = 0;
  for (let i = 3; i < n - 3; i++) alternation = Math.max(alternation, Math.abs(angle(i + 1) - 2 * angle(i) + angle(i - 1) - (20 * Math.sin(2 * Math.PI * 1.2 * times[i + 1]) - 40 * Math.sin(2 * Math.PI * 1.2 * times[i]) + 20 * Math.sin(2 * Math.PI * 1.2 * times[i - 1]))));
  assert.ok(alternation < 6, `the ±3° alternation (12° in the second difference) is mostly gone: ${alternation.toFixed(2)}°`);
});

test('non-Gene body with twist bones: neither retargeted chat gesture leaves the display guard anything to catch, at 60 and 30 fps', async () => {
  clearRetargetCache();
  const data = toyModel({ pose: 'T', twist: true, names: 'japanese' }), mesh = toThreeMesh(data);
  const retarget = new StageMotionRetarget(mesh, buildModelProfile(profileInput(data)), { reviewed: false });
  assert.ok(retarget.plan && !retarget.plan.identity, 'a T-pose body is retargeted, not played as Gene');
  const report: string[] = [];
  for (const gesture of GESTURES) {
    const clip = await retargeted(mesh, retarget, gesture, true);
    for (const fps of [60, 30]) for (const strength of [0.46, 0.7]) {
      const caught = play(mesh, clip, fps, strength);
      report.push(`${gesture[1]} ${fps}fps ${strength}: ${caught.length}`);
      assert.deepEqual(caught, [], `${gesture[1]} at ${fps} fps, strength ${strength}`);
    }
  }
  if (process.env.R29_REPORT) console.log('[non-gene gesture]', report.join(' · '));
});

test('the same, unsmoothed (before): what the guard caught on this body', async () => {
  clearRetargetCache();
  const data = toyModel({ pose: 'T', twist: true, names: 'japanese' }), mesh = toThreeMesh(data);
  const retarget = new StageMotionRetarget(mesh, buildModelProfile(profileInput(data)), { reviewed: false });
  const report: string[] = [];
  for (const gesture of GESTURES) {
    const clip = await retargeted(mesh, retarget, gesture, false);
    for (const fps of [60, 30]) for (const strength of [0.46, 0.7]) report.push(`${gesture[1]} ${fps}fps ${strength}: ${play(mesh, clip, fps, strength).join(', ') || 0}`);
  }
  if (process.env.R29_REPORT) console.log('[non-gene gesture, unsmoothed]', report.join(' · '));
});

test('non-Gene body with twist bones: a whole RPS match on the game layer leaves the guard nothing to catch, at 60 and 30 fps, also with a late frame at every view', () => {
  const view = (phase: RpsView['phase'], round: number, extra: Partial<RpsView> = {}): RpsView => ({ id: 'm', revision: 1, phase, round, score: { her: 0, user: 0 }, firstTo: 2,
    accepting: false, commitment: null, revealed: null, userHand: null, outcome: null, line: null, face: 'nervous', tease: null, beatMs: T.beatMs, phaseMs: 0, elapsedMs: 0, result: null, ...extra }) as RpsView;
  const hand = (h: 'rock' | 'scissors' | 'paper') => ({ hand: h, intent: 'fair' as const, nonce: 'n' });
  const data = bodyModel({ twist: true });
  for (const fps of [60, 30]) for (const late of [0, 1000 / 30]) {
    const mesh = toThreeMesh(data, { fullSkin: true }), layer = new RpsPerformance(), guard = new PoseContinuity(mesh as never, { height: 20 });
    const saved = new Map<Bone, Quaternion>();
    const port = { remember: (bone: Bone) => { if (!saved.has(bone)) saved.set(bone, bone.quaternion.clone()); } };
    let extra = 0;
    const run = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds * fps); i++) {
        guard.remove(); for (const [bone, q] of saved) bone.quaternion.copy(q); saved.clear();
        guard.captureBase(true);
        const dt = 1 / fps + extra / 1000; extra = 0;
        layer.frame(dt, mesh); layer.applyPose(port); mesh.updateMatrixWorld(true);
        guard.apply(dt, dt);
      }
    };
    const set = (v: RpsView | null) => { layer.cue(rpsStageCue(v)); extra = late; };
    run(0.5);
    set(view('ready', 1, { phaseMs: T.readyMs })); run(T.readyMs / 1000);
    set(view('count', 1)); run((T.leadMs + 2 * T.beatMs) / 1000);
    set(view('reveal', 1, { revealed: hand('scissors'), outcome: 'her' })); run(T.reactMs / 1000);
    set(view('ready', 2)); run(T.nextMs / 1000);
    set(view('count', 2)); run((T.leadMs + 2 * T.beatMs) / 1000);
    set(view('reveal', 2, { revealed: hand('rock'), outcome: 'user', tease: 'paper' })); run(T.teaseMs / 1000);
    set(view('reveal', 2, { revealed: hand('rock'), outcome: 'user' })); run(T.reactMs / 1000);
    set(view('end', 2, { revealed: hand('rock') })); run(T.endMs / 1000);
    set(null); run(2.5);
    const rig = layer.rigForTest();
    assert.ok(rig?.upper && rig.fingers > 0, 'the synthetic body has an arm and a finger to play with');
    assert.equal(guard.getState().jumps, 0, `${fps} fps, ${late ? 'a late frame at every view' : 'on time'}: ${JSON.stringify(guard.getState().lastJump)}`);
  }
});
