/**
 * Pretrial 2026-11-03 (docs/claude/2026-11-03-pretrial-fixes-motion.md, G1): the display guard caught 6–7 jumps in one match
 * on the real app: 笑い during natural blinks (the eye smile gives way to the blink at the blink's own speed), and the middle
 * phalanges (右中指２ / 右小指２, ~4.1°) when the hand changed at the reveal at ~30 fps with a late frame. Fixed by
 *  - the guard following, not judging, the lid shapes that ride a natural blink (pose-continuity.ts `ownedMorphs`);
 *  - hand shapes as minimum-jerk weights sized by the finger turn (an interrupted change turns round from the blend shown);
 * and held here on the real Stage frame loop at 60 and 30 fps, with a late frame whenever the host's view arrives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RPS_TIMING as T, type RpsFace, type RpsHand, type RpsPhase, type RpsView } from '../shared/rps';
import { PoseContinuity } from '../src/stage/pose-continuity';
import { RpsPerformance, rpsStageCue } from '../src/stage/rps-performance';
import { Quaternion } from 'three';
import { geneStage } from './helpers/gene-stage-harness';

function view(phase: RpsPhase, round: number, extra: Partial<RpsView> = {}): RpsView {
  return { id: 'm1', revision: 1, phase, round, score: { her: 0, user: 0 }, firstTo: 2, accepting: phase === 'ready' || phase === 'count' || phase === 'wait',
    commitment: null, revealed: null, userHand: null, outcome: null, line: null, face: 'nervous' as RpsFace, tease: null, beatMs: T.beatMs,
    phaseMs: 0, elapsedMs: 0, result: null, ...extra } as RpsView;
}
const revealed = (hand: RpsHand) => ({ hand, intent: 'fair' as const, nonce: 'n' });

test('the guard follows a morph its dedicated owner moves this frame, and still catches it on any other frame', () => {
  const make = () => { const influences = [0.4]; return { mesh: { skeleton: { bones: [] }, morphTargetInfluences: influences }, influences }; };
  const run = (owned: boolean) => {
    const { mesh, influences } = make(), guard = new PoseContinuity(mesh);
    // The mixer leaves the morph at 0 (trusted base); a layer then writes `value` (the eye smile, giving way to a blink).
    const frame = (value: number, own: boolean) => { influences[0] = 0; guard.captureBase(true); influences[0] = value; guard.apply(1 / 60, 1 / 60, own ? [0] : null); const shown = influences[0]; guard.remove(); return shown; };
    // The layer holds 0.4, then a blink pulls it to 0.1 in two frames and lets it back.
    const shown: number[] = [];
    for (let i = 0; i < 10; i++) shown.push(frame(0.4, false));
    for (const value of [0.25, 0.1, 0.25, 0.4]) shown.push(frame(value, owned));
    for (let i = 0; i < 10; i++) shown.push(frame(0.4, false));
    return { jumps: guard.getState().jumps, shown };
  };
  const followed = run(true), judged = run(false);
  assert.equal(followed.jumps, 0, 'owned this frame: followed');
  assert.deepEqual(followed.shown.slice(10, 14).map(v => +v.toFixed(6)), [0.25, 0.1, 0.25, 0.4], 'shown exactly as the owner wrote it');
  assert.ok(judged.jumps > 0, 'the same steps on frames nobody owns are caught (the guard is not switched off)');
});

/** One match on the real stage; `late` ms are added to the next frame whenever a view arrives (the host round trip). */
async function match(fps: number, late: number) {
  const h = await geneStage({ fps, refreshHz: 60 });
  const tick = h.stage.tick;
  let offset = 0;
  h.stage.tick = (time: number) => tick(time + offset);
  const caught: string[] = [];
  let last = 0;
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      h.tick();
      const state = h.stage.continuity?.getState();
      if (state && state.jumps > last) { caught.push(`${state.lastJump?.property} ${state.lastJump?.size} @${h.time().toFixed(2)}`); last = state.jumps; }
    }
  };
  const set = (v: RpsView | null) => { h.stage.setRps(v); offset += late; };
  try {
    run(3);
    set(view('ready', 1, { phaseMs: T.readyMs })); run(T.readyMs / 1000);
    set(view('count', 1)); run((T.leadMs + 2 * T.beatMs) / 1000);
    set(view('reveal', 1, { revealed: revealed('scissors'), userHand: 'rock', outcome: 'her', face: 'smug' })); run(T.reactMs / 1000);
    set(view('ready', 2)); run(T.nextMs / 1000);
    set(view('count', 2)); run((T.leadMs + 2 * T.beatMs) / 1000);
    set(view('reveal', 2, { revealed: revealed('paper'), userHand: 'paper', outcome: 'draw', face: 'surprised' })); run(T.reactMs / 1000);
    set(view('ready', 3)); run(T.nextMs / 1000);
    set(view('count', 3)); run((T.leadMs + 2 * T.beatMs) / 1000);
    set(view('reveal', 3, { revealed: revealed('rock'), userHand: 'paper', outcome: 'user', face: 'tease', tease: 'scissors' })); run(T.teaseMs / 1000);
    set(view('reveal', 3, { revealed: revealed('rock'), userHand: 'paper', outcome: 'user', face: 'happy' })); run(T.reactMs / 1000);
    set(view('end', 3, { revealed: revealed('rock'), face: 'happy' })); run(T.endMs / 1000);
    set(null); run(3);
    return caught;
  } finally { h.close(); }
}

for (const fps of [60, 30]) {
  test(`${fps} fps: a whole match, smiling through blinks and a late frame at every view, leaves the guard nothing to catch`, async () => {
    assert.deepEqual(await match(fps, 0), [], 'on time');
    assert.deepEqual(await match(fps, 1000 / 30), [], 'a frame late at every view');
  });
}

for (const fps of [60, 30]) {
  test(`${fps} fps: a hand change interrupted part way turns round from the blend shown, at its speed (it restarted from the nearer shape: 40–70° jumps)`, async () => {
    for (const at of [8, 14, 20]) { // frames (at 60 fps) into opening the middle finger for scissors, a new round asks for the fist
      const h = await geneStage({ fps });
      try {
        const layer: RpsPerformance = h.stage.rps = new RpsPerformance();
        const finger = h.mesh.skeleton.bones.find((bone: { name: string }) => bone.name === '右中指２')!;
        h.run(2);
        layer.cue(rpsStageCue(view('ready', 1, { phaseMs: T.readyMs })));
        h.run(2);
        layer.cue(rpsStageCue(view('reveal', 1, { revealed: revealed('scissors'), userHand: 'rock', outcome: 'her' })));
        const frames: Quaternion[] = [];
        const shown = () => { h.tick(); frames.push(finger.getWorldQuaternion(new Quaternion())); };
        for (let i = 0, n = Math.round(at * fps / 60); i < n; i++) shown();
        layer.cue(rpsStageCue(view('ready', 2)));
        for (let i = 0; i < fps; i++) shown();
        let worst = 0;
        for (let i = 2; i < frames.length; i++) {
          const step = frames[i].clone().multiply(frames[i - 1].clone().invert()), previous = frames[i - 1].clone().multiply(frames[i - 2].clone().invert());
          worst = Math.max(worst, step.angleTo(previous) * 180 / Math.PI);
        }
        assert.equal(h.stage.continuity?.getState().jumps ?? 0, 0, `interrupted ${at} frames in: nothing for the guard`);
        assert.ok(worst < (fps === 60 ? 1.5 : 5), `interrupted ${at} frames in: largest unexpected step of the middle finger ${worst.toFixed(3)}°`);
      } finally { h.close(); }
    }
  });
}
