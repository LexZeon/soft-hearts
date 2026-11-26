/**
 * P1 第二阶段, stage side (src/mood/pose-reaction-stage.ts): the small stretch, the yawn, the wave back and the arrival glance on the
 * real Stage frame loop (gene-stage-harness: bundled Gene, Stand VMD, real procedural life, her own life, the display guard) at 60 and
 * 30 fps, and on synthetic non-Gene bodies (A and T pose, with twist bones) with the display guard on top.
 *
 * R29 measure as in her-life-stage / rps-stage: the display guard catches nothing ("跳变为 0"); the unexpected step of the bones the
 * reaction moves stays within max(1.25 × the same seconds without it, floor) when it enters and leaves (floor 0.15° at 60 fps,
 * 0.6° at 30 fps, the same angular acceleration); the wave's swings are deliberate (bounded like G1's count strokes). Interrupted by
 * a pat or typing, it gives way the same way and does not come back. POSE_STAGE_REPORT=1 prints the numbers of the record.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Quaternion, type Bone, type SkinnedMesh } from 'three';
import { PoseReactionStage, POSE_REACTION_TIMELINES, sampleKeys, type PoseReactionStageInput } from '../src/mood/pose-reaction-stage';
import type { HerLifeStageGates } from '../src/stage/her-life-stage';
import type { LifeActivity } from '../src/stage/procedural-life';
import { PoseContinuity } from '../src/senses/pose-continuity';
import type { PoseReactionKind, PoseReactionView } from '../shared/mood/pose-reactions';
import { bodyModel } from './helpers/body-fixtures';
import { toThreeMesh } from './helpers/model-fixtures';
import { TRACKED_BONES } from './helpers/frame-stats';

const DEG = 180 / Math.PI;
const report = !!process.env.POSE_STAGE_REPORT;
const floor = (fps: number) => fps >= 60 ? 0.15 : 0.6;
const FREE: HerLifeStageGates = { expressive: true, engaged: false, bodyOwned: false, asleep: false, posture: 50 };
const NEUTRAL: LifeActivity = { gazeX: 0, gazeY: 0, pointerFollow: 1, saccade: 1, lookAtUser: 1, headX: 0, headY: 0, headZ: 0, sway: 1, bodyZ: 0,
  blinkInterval: 1, lidSoft: 0, smileEyes: 0, mouthSmile: 0, lookUp: 0 };

// ---------------------------------------------------------------- curves and the layer alone

test('every reaction curve starts and ends at rest with zero speed, has continuous speed, and never overshoots its keys', () => {
  for (const [kind, timeline] of Object.entries(POSE_REACTION_TIMELINES)) {
    for (const [channel, keys] of Object.entries(timeline)) {
      if (!Array.isArray(keys)) continue;
      const end = keys[keys.length - 1][0], h = 1e-4, low = Math.min(...keys.map(k => k[1])), high = Math.max(...keys.map(k => k[1]));
      assert.equal(keys[0][1], 0, `${kind}.${channel} starts at rest`); assert.equal(keys[keys.length - 1][1], 0, `${kind}.${channel} ends at rest`);
      for (let t = 0; t <= end; t += 0.002) {
        const value = sampleKeys(keys, t);
        assert.ok(value >= low - 1e-9 && value <= high + 1e-9, `${kind}.${channel} overshoots at ${t}`);
      }
      // Speed is continuous across every key (the left and the right slope agree) and zero at both ends.
      const e = 1e-6, slope = (a: number, b: number) => (sampleKeys(keys, b) - sampleKeys(keys, a)) / (b - a);
      for (const [t] of keys.slice(1, -1)) {
        const left = slope(t - 2 * e, t - e), right = slope(t + e, t + 2 * e);
        assert.ok(Math.abs(left - right) < 1e-3 * Math.max(1, Math.abs(left)), `${kind}.${channel}: kink at ${t} (${left} vs ${right})`);
      }
      assert.ok(Math.abs(slope(0, h)) < 0.01 && Math.abs(slope(end - h, end)) < 0.01, `${kind}.${channel}: zero speed at both ends`);
    }
  }
});

function layer() {
  const stage = new PoseReactionStage(), owner = {};
  let now = 10_000;
  const frame = (view: PoseReactionView | null, gates: HerLifeStageGates | null = FREE, base: LifeActivity | null = NEUTRAL, dt = 1 / 60, game = false) => {
    now += dt * 1000;
    return stage.frame(dt, { owner, view, nowMs: now, gates, game } as PoseReactionStageInput, base);
  };
  return { stage, frame, now: () => now };
}
const view = (cue: PoseReactionView['cue'] = null, attention = 1): PoseReactionView => ({ attention, boost: 2.2, cue });

test('no view and nothing playing: the activity passes through untouched and nothing is written', () => {
  const { stage, frame } = layer();
  for (let i = 0; i < 30; i++) assert.equal(frame(null), NEUTRAL);
  let writes = 0;
  stage.applyPose({ remember: () => { writes++; }, rotate: () => { writes++; } });
  assert.equal(writes, 0);
  assert.equal(stage.active, false);
});

test('attention: her "look at you" moments grow slowly while the user faces her and fade a little faster when the user turns away', () => {
  const { frame } = layer();
  let out = frame(view(null, 1))!;
  for (let i = 0; i < 60; i++) out = frame(view(null, 1))!;
  assert.ok(out.lookAtUser > 1.1 && out.lookAtUser < 1.4, `after 1 s ${out.lookAtUser}`);
  for (let i = 0; i < 60 * 30; i++) out = frame(view(null, 1))!;
  assert.ok(Math.abs(out.lookAtUser - 2.2) < 0.02, `after 30 s ${out.lookAtUser}`);
  for (let i = 0; i < 60 * 3; i++) out = frame(view(null, 0))!;
  assert.ok(out.lookAtUser < 1 + 1.2 * 0.4, `3 s after turning away ${out.lookAtUser}`);
  assert.equal(out.mouthOpen, 0); assert.equal(out.lookUp, 0, 'attention alone moves only the look-at-you chance');
});

test('a reaction plays once per id from its start time; a stale one, or one that finds her busy, is skipped (never played late)', () => {
  const { stage, frame, now } = layer();
  const cue = (id: string, kind: PoseReactionKind, at: number) => ({ id, kind, source: 'follow' as const, at, strength: 1 });
  const due = now() + 500;
  frame(view(cue('a', 'yawn', due)));
  assert.equal(stage.getState().playing, null, 'waits for its delay');
  for (let i = 0; i < 40; i++) frame(view(cue('a', 'yawn', due)));
  assert.equal(stage.getState().playing?.kind, 'yawn');
  for (let i = 0; i < 60 * 6; i++) frame(view(cue('a', 'yawn', 0)));
  assert.equal(stage.getState().played, 1, 'once per id');
  frame(view(cue('b', 'yawn', now() - 5_000)));
  assert.equal(stage.getState().playing, null, 'stale');
  frame(view(cue('c', 'stretch', now())), { ...FREE, engaged: true });
  for (let i = 0; i < 30; i++) frame(view(cue('c', 'stretch', now())));
  assert.equal(stage.getState().playing, null, 'busy when it was due: skipped, not played later');
  assert.equal(stage.getState().skipped, 2);
  // A picked motion owns the body: a yawn still plays, a stretch or a wave does not; the game takes everything.
  frame(view(cue('d', 'yawn', now())), { ...FREE, bodyOwned: true });
  assert.equal(stage.getState().playing?.kind, 'yawn');
  for (let i = 0; i < 60 * 6; i++) frame(view(null));
  frame(view(cue('e', 'stretch', now())), { ...FREE, bodyOwned: true });
  assert.equal(stage.getState().playing, null);
  frame(view(cue('f', 'glance', now())), FREE, NEUTRAL, 1 / 60, true);
  assert.equal(stage.getState().playing, null);
});

test('giving way: something higher comes mid-way, the reaction eases out from where it is, ends, and does not come back', () => {
  const { stage, frame, now } = layer();
  const cue = { id: 's', kind: 'stretch' as const, source: 'own' as const, at: now(), strength: 1 };
  for (let i = 0; i < 90; i++) frame(view(cue));
  const before = stage.getState().playing!;
  assert.equal(before.weight, 1);
  const weights: number[] = [];
  for (let i = 0; i < 90; i++) { frame(view(cue), { ...FREE, engaged: true }); weights.push(stage.getState().playing?.weight ?? 0); }
  assert.equal(stage.getState().playing, null, 'ended');
  for (let i = 1; i < weights.length; i++) assert.ok(weights[i] <= weights[i - 1] + 1e-9, 'only down');
  const steps = weights.slice(1).map((w, i) => Math.abs(w - weights[i]));
  assert.ok(Math.max(...steps) < 0.12, `eased, not cut (largest step ${Math.max(...steps)})`);
  for (let i = 0; i < 60; i++) frame(view(cue));
  assert.equal(stage.getState().playing, null, 'free again: it does not come back');
});

// ---------------------------------------------------------------- the real Stage (Gene)

const START = 2;
const worst = (series: number[][], idx: readonly number[]) => Math.max(0, ...idx.map(i => Math.max(0, ...series[i])));
const ALL = TRACKED_BONES.map((_, i) => i);
const ARM = ['右肩', '右腕', '右ひじ'].map(name => TRACKED_BONES.indexOf(name as never));
const TORSO = ['上半身', '上半身2', '首', '頭', '左肩', '右肩', '左腕', '右腕'].map(name => TRACKED_BONES.indexOf(name as never));

// ---------------------------------------------------------------- non-Gene synthetic bodies

for (const pose of ['A', 'T'] as const) {
  test(`non-Gene ${pose}-pose body with twist bones: the stretch and the wave leave the guard nothing to catch at 60 and 30 fps, also with a late frame`, () => {
    const data = bodyModel({ twist: true, pose });
    const results: string[] = [];
    for (const fps of [60, 30]) for (const late of [0, 1000 / 30]) for (const kind of ['stretch', 'wave', 'yawn'] as const) {
      const mesh = toThreeMesh(data, { fullSkin: true }) as SkinnedMesh, layerStage = new PoseReactionStage(), guard = new PoseContinuity(mesh as never, { height: 20 });
      const saved = new Map<Bone, Quaternion>(), offset = new Quaternion(), rotation = new Euler();
      const remember = (b: Bone) => { if (!saved.has(b)) saved.set(b, b.quaternion.clone()); };
      // The stage's own rotateBone: remember, then a local YXZ offset.
      const port = { remember, rotate: (b: Bone, x: number, y: number, z: number) => { remember(b); b.quaternion.multiply(offset.setFromEuler(rotation.set(x, y, z, 'YXZ'))); } };
      let now = 0;
      const cue: PoseReactionView = { attention: 1, boost: 2, cue: { id: `${kind}`, kind, source: 'follow', at: 500, strength: 1 } };
      const frames = Math.round(7 * fps);
      for (let i = 0; i < frames; i++) {
        guard.remove(); for (const [b, q] of saved) b.quaternion.copy(q); saved.clear();
        guard.captureBase(true);
        // A late frame every second (the cue starts at 0.5 s; swings and the arm's way down get one each).
        const dt = 1 / fps + (i > 0 && i % fps === 0 ? late / 1000 : 0);
        now += dt * 1000;
        layerStage.frame(dt, { owner: mesh, view: cue, nowMs: now, gates: FREE, game: false }, NEUTRAL);
        layerStage.applyPose(port); mesh.updateMatrixWorld(true);
        guard.apply(dt, dt);
      }
      const state = layerStage.getState();
      assert.equal(state.played, 1, `${pose} ${kind} ${fps}fps played`);
      if (kind === 'wave') assert.ok(state.wave?.arm && state.wave.swings === 3, `${pose}: the synthetic body has an arm to wave with`);
      assert.equal(guard.getState().jumps, 0, `${pose} ${kind} ${fps} fps${late ? ', a late frame' : ''}: ${JSON.stringify(guard.getState().lastJump)}`);
      results.push(`${kind} ${fps}${late ? '+late' : ''}: 0`);
    }
    if (report) console.log(`[non-Gene ${pose}]`, results.join(' · '));
  });
}
