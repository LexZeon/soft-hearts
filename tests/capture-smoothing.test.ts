/**
 * Pretrial 2026-11-03 (docs/claude/2026-11-03-pretrial-fixes-motion.md, 问题 3): during a chat gesture the display guard caught
 * the right wrist 3 times (2.3–4.7°) at 60 fps, 4 at 30 fps, 15 at 30 fps and the strongest gesture; R29f promised 0.
 * Source: speaking-gesture-2's captured wrist jitters (9–16° per 1/30 s, the turn axis swinging round key to key), and
 * keyframe interpolation eased to rest at every one of those reversals. capture-smoothing.ts low-passes dense captured
 * runs once at load. These tests hold the contract (jitter gone, slow motion and run ends kept, sparse keys untouched)
 * and the R29 frame-loop number: no guard catch during either whole chat gesture, at 60 and 30 fps, at 0.46 and 0.7.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimationClip, Quaternion, QuaternionKeyframeTrack, Vector3 } from 'three';
import { CAPTURE_SMOOTHING_PASSES, smoothCapturedClip, smoothCapturedRotations } from '../src/stage/capture-smoothing';
import { isChatGestureTrack } from '../src/stage/chat-gesture';
import { geneStage } from './helpers/gene-stage-harness';

const DEG = 180 / Math.PI, AXIS = new Vector3(0, 0, 1);
const about = (deg: number) => new Quaternion().setFromAxisAngle(AXIS, deg / DEG);
const keys = (degrees: number[]) => { const out: number[] = []; for (const d of degrees) out.push(...about(d).toArray()); return out; };
const angleAt = (values: ArrayLike<number>, i: number) => 2 * Math.atan2(values[i * 4 + 2], values[i * 4 + 3]) * DEG;
const times30 = (n: number) => Array.from({ length: n }, (_, i) => i / 30);

test('a dense captured run: the frame-to-frame alternation goes, a slow stroke stays, the run ends do not move', () => {
  const n = 91, slow = (i: number) => 30 * Math.sin(2 * Math.PI * 1.5 * i / 30); // a 1.5 Hz, ±30° stroke
  const jitter = (i: number) => (i % 2 ? 4 : -4);
  const values = keys(Array.from({ length: n }, (_, i) => slow(i) + jitter(i)));
  const moved = smoothCapturedRotations(times30(n), values);
  assert.equal(moved, n - 2, 'every inner key of the run');
  assert.equal(angleAt(values, 0).toFixed(6), (slow(0) + jitter(0)).toFixed(6), 'first key unchanged');
  assert.equal(angleAt(values, n - 1).toFixed(6), (slow(n - 1) + jitter(n - 1)).toFixed(6), 'last key unchanged');
  // Inside the run (away from the fixed ends), the ±4° alternation is gone and the stroke keeps its size.
  let alternation = 0, peak = 0;
  for (let i = 4; i < n - 4; i++) {
    const second = angleAt(values, i + 1) - 2 * angleAt(values, i) + angleAt(values, i - 1);
    const slowSecond = slow(i + 1) - 2 * slow(i) + slow(i - 1);
    alternation = Math.max(alternation, Math.abs(second - slowSecond));
    peak = Math.max(peak, Math.abs(angleAt(values, i)));
  }
  assert.ok(alternation < 0.6, `second difference left by the jitter ${alternation.toFixed(3)}° (it was 16°)`);
  assert.ok(peak > 30 * 0.9 && peak < 30.5, `the 1.5 Hz stroke keeps its size: ${peak.toFixed(2)}° of 30°`);
});

test('sparse hand-set keys, short runs and the gaps between runs are left exactly as they are', () => {
  const times = [0, 1, 2, 2 + 1 / 30, 2 + 2 / 30, 5, 5 + 1 / 30, 9];
  const values = keys([0, 40, 10, 30, 0, 20, 25, -10]);
  const before = [...values];
  smoothCapturedRotations(times, values, CAPTURE_SMOOTHING_PASSES);
  // Keys 0, 1 are sparse; 2..4 is a run of three (only its middle key may move); 5, 6 a run of two; 7 sparse.
  for (const i of [0, 1, 2, 4, 5, 6, 7]) assert.deepEqual(values.slice(i * 4, i * 4 + 4), before.slice(i * 4, i * 4 + 4), `key ${i}`);
  assert.ok(Math.abs(angleAt(values, 3) - 30) > 1, 'the middle of the three-key run is smoothed');
});

test('a clip is smoothed once (the stage caches it), only the tracks the filter admits', () => {
  const run = keys([0, 6, -2, 8, 0, 9, 1]), t = times30(7);
  const clip = new AnimationClip('g', 7 / 30, [new QuaternionKeyframeTrack('.bones[右手首].quaternion', t, [...run]), new QuaternionKeyframeTrack('.bones[左足].quaternion', t, [...run])]);
  assert.ok(smoothCapturedClip(clip, isChatGestureTrack) > 0);
  const once = [...clip.tracks[0].values];
  assert.equal(smoothCapturedClip(clip, isChatGestureTrack), 0, 'the second call does nothing');
  assert.deepEqual([...clip.tracks[0].values], once);
  assert.deepEqual([...clip.tracks[1].values], run.map(v => Math.fround(v)), 'a leg track is not a chat-gesture track: untouched');
});

/** A whole chat gesture on the real Stage frame loop (60 Hz screen, the stage's own frame clock): guard catches while it plays. */
async function gestureCatches(packId: 'genea-2022-gestures' | 'mpi-embm-gestures', motionId: 'speaking-gesture-2' | 'conversation-joy', fps: number, strength: number) {
  const h = await geneStage({ fps, refreshHz: 60, chatGesture: { packId, motionId } });
  try {
    for (let i = 0; i < 120; i++) h.tick();
    const before = h.stage.continuity?.getState().jumps ?? 0;
    const cue = { id: `g-${motionId}-${fps}-${strength}`, at: Date.now(), expiresAt: Date.now() + 60_000, intent: 'explain' as const, strength, reason: 'test' };
    h.stage.moodView = { ...h.stage.moodView, gesture: cue };
    await h.stage.playChatGesture(cue, h.stage.moodView.token);
    assert.equal(h.stage.chatGesturePlayer.getState().active, true, `${motionId} ${fps} fps ${strength}: the gesture plays (${h.stage.chatGestureError})`);
    const caught: string[] = [];
    let last = before;
    for (let i = 0; i < 60 * 7.5; i++) {
      h.tick();
      const state = h.stage.continuity?.getState();
      if (state && state.jumps > last) { caught.push(`${state.lastJump?.property} ${state.lastJump?.size}`); last = state.jumps; }
    }
    return caught;
  } finally { h.close(); }
}

for (const fps of [60, 30]) {
  test(`${fps} fps: neither whole chat gesture leaves the display guard anything to catch (strength 0.46 and the maximum 0.7)`, async () => {
    for (const [pack, motion] of [['genea-2022-gestures', 'speaking-gesture-2'], ['mpi-embm-gestures', 'conversation-joy']] as const)
      for (const strength of [0.46, 0.7]) assert.deepEqual(await gestureCatches(pack, motion, fps, strength), [], `${motion} at ${strength}`);
  });
}
