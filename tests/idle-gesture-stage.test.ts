/**
 * #11 on the stage (shared/behaviors/idle-gesture/perform.ts through src/stage/mood-feedback.ts), R29 continuity:
 *  - Gene, the real Stage frame loop (gene-stage-harness: bundled Gene, Stand VMD, real procedural life, the display guard) at 60 and
 *    30 fps, on time and with a late frame whenever the host's view arrives: each of the six shapes plays while the cue shows and
 *    finishes after it is gone; the display guard catches nothing ("跳变为 0"), the head's unexpected step stays within
 *    max(1.25 × the same seconds without it, floor 0.15° at 60 fps / 0.6° at 30 fps), and the head really moves.
 *  - Non-Gene synthetic bodies (A and T pose, twist bones), MoodFeedback writing the head and eyes the stage's way, guard on top.
 * IDLE_GESTURE_REPORT=1 prints the numbers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Quaternion, type Bone, type SkinnedMesh } from 'three';
import { IDLE_SHAPE_IDS, type IdleShapeId } from '../shared/behaviors/idle-gesture/knobs';
import type { IdleGestureView } from '../shared/behaviors/idle-gesture/interface';
import { IDLE_GESTURE_TIMELINES } from '../shared/behaviors/idle-gesture/perform';
import { EMPTY_CONTACT, MoodFeedback } from '../src/stage/mood-feedback';
import { PoseContinuity } from '../src/stage/pose-continuity';
import { between, geneStage, surprises, TRACKED_BONES, type GeneStage } from './helpers/gene-stage-harness';
import { bodyModel } from './helpers/body-fixtures';
import { toThreeMesh } from './helpers/model-fixtures';

const DEG = 180 / Math.PI;
const report = !!process.env.IDLE_GESTURE_REPORT;
const floor = (fps: number) => fps >= 60 ? 0.15 : 0.6;
const START = 2;
/** A typical pick for each shape (amplitudes at the top of their knob ranges, the slowest pace for the longest run). */
const AMPLITUDE: Record<IdleShapeId, number> = { tilt: 0.09, nod: 0.07, glance: 0.12, lift: 0.05, stretch: 0.08, sway: 0.02 };
const gestureView = (shape: IdleShapeId, kind: 'look' | 'motion' = 'motion'): IdleGestureView =>
  ({ cueId: `idle-${shape}`, kind, shape, side: -1, amplitude: AMPLITUDE[shape], eyes: 1, pace: 1.15, smile: 0.8 });
const HEAD = ['首', '頭'].map(name => TRACKED_BONES.indexOf(name as never));
const ALL = TRACKED_BONES.map((_, i) => i);
const worst = (series: number[][], idx: readonly number[]) => Math.max(0, ...idx.map(i => Math.max(0, ...series[i])));
const guardAll = (frames: GeneStage['shown']) => frames.slice(1).filter((frame, i) => frame.guardJumps > frames[i].guardJumps).map(frame => `${frame.guardLast}@${frame.t.toFixed(2)}`);

/** One run: START s plain, then the cue (with or without a picked shape) for 3 s, then 3 s more. `late` ms are added at each view. */
async function play(fps: number, shape: IdleShapeId | null, late = 0) {
  const h = await geneStage(late ? { fps, refreshHz: 60 } : { fps });
  const tick = h.stage.tick;
  let offset = 0;
  h.stage.tick = (time: number) => tick(time + offset);
  try {
    h.run(START);
    // Without a shape the same two views still arrive (and are as late): the reference for the same seconds.
    const v = h.stage.moodView, at = Date.now();
    h.stage.setMood(shape ? { ...v, revision: v.revision + 1, snapshot: { ...v.snapshot, cue: { id: `idle-${shape}`, kind: 'motion', at, until: at + 3_000 } }, idleGesture: gestureView(shape) }
      : { ...v, revision: v.revision + 1 });
    offset += late;
    h.run(3);
    const w = h.stage.moodView;
    h.stage.setMood({ ...w, revision: w.revision + 1, snapshot: { ...w.snapshot, cue: null }, idleGesture: undefined });
    offset += late;
    h.run(3);
    return h;
  } catch (error) { h.close(); throw error; }
}

const reference = new Map<string, Promise<GeneStage>>();
const control = (fps: number, late: number) => { const key = `${fps}:${late}`; if (!reference.has(key)) reference.set(key, play(fps, null, late)); return reference.get(key)!; };
test.after(async () => { for (const run of reference.values()) (await run).close(); });

for (const fps of [60, 30]) {
  test(`${fps} fps on Gene: each of the six shapes plays and finishes without a jump; the guard catches nothing, on time and with late frames`, async () => {
    const rows: string[] = [];
    for (const late of [0, 1000 / 30]) for (const shape of IDLE_SHAPE_IDS) {
      const base = await control(fps, late);
      const undisturbed = worst(surprises(between(base.shown, START - 0.2, START + 6)), ALL);
      if (shape === 'tilt') rows.push(`undisturbed${late ? ' with late frames' : ''}: ${undisturbed.toFixed(3)}°`);
      const h = await play(fps, shape, late);
      try {
        const during = between(h.shown, START - 0.2, START + 6);
        assert.deepEqual(guardAll(during), [], `${shape}${late ? ' late' : ''}: nothing for the guard`);
        const whole = worst(surprises(during), ALL), head = worst(surprises(during), HEAD);
        // How far the head is from where it would have been: the shape really played.
        const moved = Math.max(...between(h.shown, START, START + 4).map((frame, i) => {
          const ref = between(base.shown, START, START + 4)[i];
          return ref ? frame.world[HEAD[1]].angleTo(ref.world[HEAD[1]]) * DEG : 0;
        }));
        // And it is over: back with the undisturbed run once the shape (≤ 2.9 s × 1.15) and the spring have settled.
        const tail = between(h.shown, START + 5.2, START + 6), tailBase = between(base.shown, START + 5.2, START + 6);
        const rejoin = Math.max(...tail.slice(0, tailBase.length).map((frame, i) => frame.world[HEAD[1]].angleTo(tailBase[i].world[HEAD[1]]) * DEG));
        rows.push(`${shape}${late ? '+late' : ''} moved ${moved.toFixed(2)}° step ${whole.toFixed(3)}° (head ${head.toFixed(3)}°) rejoin ${rejoin.toFixed(3)}°`);
        const label = `${shape}${late ? ' with late frames' : ''}`;
        assert.ok(whole <= Math.max(floor(fps), 1.25 * undisturbed), `${label}: largest unexpected step ${whole} (undisturbed ${undisturbed})`);
        assert.ok(moved > (shape === 'sway' ? 0.3 : 1.2), `${label}: the head moved ${moved}°`);
        assert.ok(rejoin < 0.05, `${label}: back on the undisturbed path (${rejoin}°)`);
        assert.ok(IDLE_GESTURE_TIMELINES[shape].duration * 1.15 < 3.5, 'every shape ends before the next look or motion can start');
      } finally { h.close(); }
    }
    if (report) console.log(`[idle-gesture Gene ${fps}fps]\n  ${rows.join('\n  ')}`);
  });
}

// ---------------------------------------------------------------- non-Gene synthetic bodies

for (const pose of ['A', 'T'] as const) {
  test(`non-Gene ${pose}-pose body with twist bones: every shape leaves the guard nothing to catch at 60 and 30 fps, also with a late frame`, () => {
    const data = bodyModel({ twist: true, pose });
    const results: string[] = [];
    for (const fps of [60, 30]) for (const late of [0, 1000 / 30]) for (const shape of IDLE_SHAPE_IDS) {
      const mesh = toThreeMesh(data, { fullSkin: true }) as SkinnedMesh, guard = new PoseContinuity(mesh as never, { height: 20 });
      const head = mesh.skeleton.bones.find((b: Bone) => b.name === '頭')!, eyes = mesh.skeleton.bones.filter((b: Bone) => b.name === '左目' || b.name === '右目');
      const saved = new Map<Bone, Quaternion>(), offset = new Quaternion(), rotation = new Euler();
      const remember = (b: Bone) => { if (!saved.has(b)) saved.set(b, b.quaternion.clone()); };
      // The stage's own rotateBone: remember, then a local YXZ offset.
      const rotate = (b: Bone, x: number, y: number, z: number) => { remember(b); b.quaternion.multiply(offset.setFromEuler(rotation.set(x, y, z, 'YXZ'))); };
      const feedback = new MoodFeedback(), frames = Math.round(7 * fps);
      let peak = 0;
      const rest = head.quaternion.clone();
      for (let i = 0; i < frames; i++) {
        guard.remove(); for (const [b, q] of saved) b.quaternion.copy(q); saved.clear();
        guard.captureBase(true);
        // A late frame every second (the cue shows from 0.5 s to 3.5 s).
        const dt = 1 / fps + (i > 0 && i % fps === 0 ? late / 1000 : 0), t = i / fps;
        const showing = t >= 0.5 && t < 3.5;
        const frame = feedback.frame(dt, EMPTY_CONTACT, { mood: 'calm', phase: 'idle', expressive: true, face: 50, posture: 50, playful: 0, gaze: 50,
          responding: showing, attention: showing, ...(showing ? { gesture: gestureView(shape) } : {}) });
        rotate(head, frame.headX, frame.headY, frame.headZ);
        for (const eye of eyes) rotate(eye, frame.eyePitch, frame.eyeYaw, 0);
        mesh.updateMatrixWorld(true);
        guard.apply(dt, dt);
        peak = Math.max(peak, head.quaternion.angleTo(rest) * DEG);
      }
      assert.equal(guard.getState().jumps, 0, `${pose} ${shape} ${fps} fps${late ? ', a late frame' : ''}: ${JSON.stringify(guard.getState().lastJump)}`);
      assert.ok(peak > (shape === 'sway' ? 0.3 : 1.2), `${pose} ${shape}: the head moved ${peak}°`);
      results.push(`${shape} ${fps}${late ? '+late' : ''}: 0 (peak ${peak.toFixed(2)}°)`);
    }
    if (report) console.log(`[idle-gesture non-Gene ${pose}]`, results.join(' · '));
  });
}
