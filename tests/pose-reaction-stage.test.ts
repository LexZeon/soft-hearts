/**
 * P1 第二阶段, stage side (src/stage/pose-reaction-stage.ts): the small stretch, the yawn, the wave back and the arrival glance on the
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
import { Euler, Quaternion, Vector3, type Bone, type SkinnedMesh } from 'three';
import { PoseReactionStage, POSE_REACTION_TIMELINES, sampleKeys, type PoseReactionStageInput } from '../src/stage/pose-reaction-stage';
import type { HerLifeStageGates } from '../src/stage/her-life-stage';
import type { LifeActivity } from '../src/stage/procedural-life';
import { PoseContinuity } from '../src/stage/pose-continuity';
import type { PoseReactionKind, PoseReactionView } from '../shared/pose-reactions';
import { between, geneStage, patContact, pointAtScalp, surprises, TRACKED_BONES, type GeneStage } from './helpers/gene-stage-harness';
import { bodyModel } from './helpers/body-fixtures';
import { toThreeMesh } from './helpers/model-fixtures';

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
interface Run { h: GeneStage; marks: { start: number; end: number; interrupt?: number } }
async function play(fps: number, kind: PoseReactionKind | null, interrupt?: 'pat' | 'typing', at = 1.5): Promise<Run> {
  const h = await geneStage({ fps });
  const duration = kind === 'wave' ? 4.5 : kind ? POSE_REACTION_TIMELINES[kind].duration : 5.2;
  const marks: Run['marks'] = { start: START, end: START + duration };
  try {
    h.run(START);
    if (kind) {
      const moodView = h.stage.moodView;
      h.stage.setMood({ ...moodView, revision: moodView.revision + 1, pose: { attention: 1, boost: 2.2, cue: { id: `cue-${kind}`, kind, source: 'follow', at: Date.now() - 1, strength: 1 } } });
    }
    if (interrupt) {
      h.run(at);
      marks.interrupt = h.time();
      if (interrupt === 'pat') { pointAtScalp(h); h.run(2.5, time => { h.stage.setMoodContact(patContact(time)); }); h.stage.setMoodContact({ ...patContact(0), contact: false, hover: 0 }); }
      else { h.stage.setBodyInputBlocked(true); h.stage.setTyping(true); h.run(2.5); h.stage.setTyping(false); h.stage.setBodyInputBlocked(false); }
      h.run(Math.max(0, duration - at - 2.5) + 2);
    } else h.run(duration + 2);
    return { h, marks };
  } catch (error) { h.close(); throw error; }
}

const bone = (h: GeneStage, name: string) => h.mesh.skeleton.bones.find((b: Bone) => b.name === name)!;
const guardBones = (frames: GeneStage['shown']) => frames.slice(1).filter((frame, i) => frame.guardJumps > frames[i].guardJumps && !(frame.guardLast ?? '').startsWith('.morph'))
  .map(frame => `${frame.guardLast}@${frame.t.toFixed(2)}`);
const guardAll = (frames: GeneStage['shown']) => frames.slice(1).filter((frame, i) => frame.guardJumps > frames[i].guardJumps).map(frame => `${frame.guardLast}@${frame.t.toFixed(2)}`);
const worst = (series: number[][], idx: readonly number[]) => Math.max(0, ...idx.map(i => Math.max(0, ...series[i])));
const window = (frames: GeneStage['shown'], from: number, to: number, fps: number) => surprises(between(frames, from - 2 / fps, to));
const ALL = TRACKED_BONES.map((_, i) => i);
const ARM = ['右肩', '右腕', '右ひじ'].map(name => TRACKED_BONES.indexOf(name as never));
const TORSO = ['上半身', '上半身2', '首', '頭', '左肩', '右肩', '左腕', '右腕'].map(name => TRACKED_BONES.indexOf(name as never));

const controls = new Map<number, Promise<Run>>();
const control = (fps: number) => { if (!controls.has(fps)) controls.set(fps, play(fps, null)); return controls.get(fps)!; };
test.after(async () => { for (const run of controls.values()) (await run).h.close(); });

for (const fps of [60, 30]) {
  test(`${fps} fps on Gene: the small stretch, the yawn and the arrival glance enter and leave without a jump; the guard catches nothing`, async () => {
    const reference = await control(fps);
    const undisturbed = worst(surprises(between(reference.h.shown, START - 0.2, START + 7.5)), ALL);
    const rows: string[] = [];
    for (const kind of ['stretch', 'yawn', 'glance'] as const) {
      const { h, marks } = await play(fps, kind);
      try {
        const during = between(h.shown, marks.start - 0.2, marks.end + 1.5);
        assert.deepEqual(guardAll(during), [], `${kind}: nothing for the guard (bones or morphs)`);
        const whole = worst(window(h.shown, marks.start, marks.end + 1.5, fps), ALL);
        rows.push(`${kind} ${whole.toFixed(3)}°`);
        assert.ok(whole <= Math.max(floor(fps), 1.25 * undisturbed), `${kind}: largest unexpected step ${whole} (undisturbed ${undisturbed})`);
        // The pose layer really played and ended.
        const state = h.stage.poseReaction.getState();
        assert.equal(state?.played, 1, `${kind} played`); assert.equal(state?.playing, null, `${kind} ended`);
      } finally { h.close(); }
    }
    if (report) console.log(`[pose ${fps}fps] undisturbed ${undisturbed.toFixed(3)}° · ${rows.join(' · ')}`);
  });

  test(`${fps} fps on Gene: the wave back raises the arm, swings three times outward and lowers it; the guard catches no bone`, async () => {
    const reference = await control(fps);
    const { h, marks } = await play(fps, 'wave');
    try {
      const during = between(h.shown, marks.start - 0.2, marks.end + 1.5);
      assert.deepEqual(guardBones(during), [], 'no bone jump for the guard');
      const base = worst(surprises(between(reference.h.shown, START - 0.2, START + 7.5)), ARM);
      const enter = worst(window(h.shown, marks.start, marks.start + 0.6, fps), ARM);
      const swings = worst(window(h.shown, marks.start, marks.end, fps), ARM);
      const others = worst(window(h.shown, marks.start, marks.end + 1.5, fps), ALL.filter(i => !ARM.includes(i)));
      const othersBase = worst(surprises(between(reference.h.shown, START - 0.2, START + 7.5)), ALL.filter(i => !ARM.includes(i)));
      if (report) console.log(`[wave ${fps}fps] enter ${enter.toFixed(3)}° swings ${swings.toFixed(3)}° others ${others.toFixed(3)}° (undisturbed arm ${base.toFixed(3)}°, others ${othersBase.toFixed(3)}°)`);
      assert.ok(enter <= Math.max(floor(fps), 1.25 * base), `enter ${enter}`);
      // Deliberate swings, bounded like G1's count strokes.
      assert.ok(swings <= (fps === 60 ? 0.6 : 2.4), `swings ${swings}`);
      assert.ok(others <= Math.max(floor(fps), 1.25 * othersBase), `others ${others} vs ${othersBase}`);
      const state = h.stage.poseReaction.getState();
      assert.equal(state?.wave?.swings, 3); assert.equal(state?.playing, null, 'ended');
      // Back with the undisturbed run once the arm is down.
      const tail = between(h.shown, marks.end + 1, Infinity), tailBase = between(reference.h.shown, marks.end + 1, Infinity);
      const rejoin = Math.max(...tail.slice(0, tailBase.length).map((frame, i) => Math.max(...ARM.map(k => frame.world[k].angleTo(tailBase[i].world[k]) * DEG))));
      assert.ok(rejoin < 0.3, `rejoin ${rejoin}`);
    } finally { h.close(); }
  });

  test(`${fps} fps on Gene: a pat or typing mid-way makes the stretch and the wave give way smoothly; the guard catches no bone`, async () => {
    for (const [kind, interrupt] of [['stretch', 'pat'], ['wave', 'typing'], ['yawn', 'typing']] as const) {
      const { h, marks } = await play(fps, kind, interrupt);
      try {
        const during = between(h.shown, marks.start - 0.2, marks.end + 2);
        assert.deepEqual(guardBones(during), [], `${kind} interrupted by ${interrupt}`);
        const state = h.stage.poseReaction.getState();
        assert.equal(state?.playing, null, `${kind} gave way and ended`);
        const leave = worst(window(h.shown, marks.interrupt!, marks.interrupt! + 1.4, fps), kind === 'wave' ? ARM : TORSO);
        if (report) console.log(`[interrupt ${fps}fps] ${kind} by ${interrupt}: ${leave.toFixed(3)}°`);
        assert.ok(leave <= (kind === 'wave' ? (fps === 60 ? 0.6 : 2.4) : Math.max(floor(fps) * 2, 0.3)), `${kind} leave ${leave}`);
      } finally { h.close(); }
    }
  });
}

/**
 * The real app at 60 fps (2026-11-03, after merging main) caught 4 jumps of 右手捩連 during the wave: the elbow was written as the
 * smallest swing to the swung forearm, so the wrist twist bones had to turn faster than the swing itself. Reproduced here with the
 * stage's own frame clock on a 60 Hz screen, vsync jitter and late frames (30 fps, 40 ms late: 右手捩 2.5°); the forearm now turns
 * with its hinge and the twist bones keep still.
 */
test('a real frame clock (60 Hz screen, jitter, late frames) at 60, 30 and 24 fps: the wave, the stretch and the yawn leave the guard nothing', async () => {
  const rows: string[] = [];
  for (const [fps, jitter, late] of [[60, 8, 100], [30, 4, 40], [30, 8, 100], [24, 8, 80]] as const) for (const kind of ['wave', 'stretch', 'yawn'] as const) {
    const h = await geneStage({ fps, refreshHz: 60, jitterMs: jitter });
    try {
      h.run(2);
      const v = h.stage.moodView;
      h.stage.setMood({ ...v, revision: v.revision + 1, pose: { attention: 1, boost: 2.2, cue: { id: `clock-${kind}`, kind, source: 'follow', at: Date.now() - 1, strength: 1 } } });
      const tick = h.stage.tick;
      let extra = 0;
      h.stage.tick = (time: number) => tick(time + extra);
      const before = h.stage.continuity?.getState().jumps ?? 0, caught: string[] = [];
      let last = before;
      for (let i = 0; i < 60 * 6.5; i++) {
        if (i % 45 === 20) extra += late;
        h.tick();
        const state = h.stage.continuity?.getState();
        if (state && state.jumps > last) { caught.push(`${state.lastJump?.property}@${h.time().toFixed(2)}`); last = state.jumps; }
      }
      rows.push(`${kind} ${fps}fps±${jitter}+${late}: ${caught.length}`);
      assert.deepEqual(caught, [], `${kind} at ${fps} fps, jitter ${jitter} ms, ${late} ms late frames`);
      assert.equal(h.stage.poseReaction.getState().played, 1);
    } finally { h.close(); }
  }
  if (report) console.log('[frame clock]', rows.join(' · '));
});

test('on Gene the motions are the ones decided: chest out and shoulders up for the stretch, the mouth opens for the yawn, the hand up and outward for the wave', async () => {
  const sample = async (kind: PoseReactionKind | null, at: number, read: (h: GeneStage) => number) => {
    const h = await geneStage({ fps: 60 });
    try {
      h.run(START);
      if (kind) { const v = h.stage.moodView; h.stage.setMood({ ...v, revision: v.revision + 1, pose: { attention: 0, boost: 2.2, cue: { id: `k-${kind}`, kind, source: 'follow', at: Date.now() - 1, strength: 1 } } }); }
      h.run(at);
      return read(h);
    } finally { h.close(); }
  };
  const worldY = (name: string) => (h: GeneStage) => bone(h, name).getWorldPosition(new Vector3()).y;
  const neckZ = (h: GeneStage) => bone(h, '首').getWorldPosition(new Vector3()).z;
  // Stretch at its top (2 s in): shoulders up, the chest arched back (the neck goes back), against the same moment without it.
  assert.ok(await sample('stretch', 2, worldY('右腕')) > await sample(null, 2, worldY('右腕')) + 0.05, 'shoulders up');
  assert.ok(await sample('stretch', 2, neckZ) < await sample(null, 2, neckZ) - 0.05, 'chest out: the neck moves back');
  // Yawn: the small "o" morph opens (Gene has お, which is not the lip-sync あ).
  const mouth = (h: GeneStage) => { const index = h.stage.lifeRig?.slots.mouthOpen ?? -1; return index >= 0 ? h.mesh.morphTargetInfluences![index] : -1; };
  assert.ok(await sample('yawn', 1.8, mouth) > 0.4, 'the mouth opens');
  assert.ok(await sample(null, 1.8, mouth) < 0.01);
  // Wave: the right hand is up above the elbow and moves outward during a swing.
  const hand = (h: GeneStage) => { const w = bone(h, '右手首').getWorldPosition(new Vector3()), e = bone(h, '右ひじ').getWorldPosition(new Vector3()); return w.y - e.y; };
  assert.ok(await sample('wave', 1.3, hand) > 1, 'the hand is up');
  const handX = (h: GeneStage) => bone(h, '右手首').getWorldPosition(new Vector3()).x;
  const rest = await sample('wave', 0.9, handX), out = await sample('wave', 0.9 + 0.38, handX);
  assert.ok(out < rest - 0.3, `outward (her right is −x): ${rest} → ${out}`);
});

test('with sensing on but nobody there (attention 0, no cue) the frames are exactly those without sensing: R18 is untouched', async () => {
  const run = async (pose: PoseReactionView | null) => {
    const h = await geneStage({ fps: 60 });
    try {
      if (pose) { const v = h.stage.moodView; h.stage.setMood({ ...v, revision: v.revision + 1, pose }); }
      h.run(4);
      return h.shown.map(frame => frame.world.map(q => q.toArray().join(',')).join(';') + `|${frame.blink}|${frame.smile}|${frame.mouth}`);
    } finally { h.close(); }
  };
  assert.deepEqual(await run({ attention: 0, boost: 2.2, cue: null }), await run(null));
});

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
