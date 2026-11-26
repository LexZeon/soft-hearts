/**
 * G1 猜拳 on the real Stage frame loop (tests/helpers/gene-stage-harness.ts: bundled Gene, its Stand VMD, real
 * MMDLoader / MMDAnimationHelper, procedural life, the R29 continuity guard), at 60 and 30 fps.
 * R29_REPORT=1 prints the numbers used in docs/claude/2026-11-03-rps.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3, type Bone } from 'three';
import { RPS_TIMING, type RpsFace, type RpsHand, type RpsPhase, type RpsView } from '../shared/initiative/rps';
import { buildRpsRig, MinJerk, RpsPerformance, rpsStageCue, segmentDistance } from '../src/initiative/rps-performance';
import { bodyModel } from './helpers/body-fixtures';
import { profileInput, toThreeMesh } from './helpers/model-fixtures';
import { buildModelProfile } from '../shared/stage/model-profile';
import type { CollisionProxy } from '../shared/foundation/collision-proxy';

const DEG = 180 / Math.PI, T = RPS_TIMING;
const report = process.env.R29_REPORT === '1';
const EXTRA = ['右手捩', '右手首', '右手捩連', '右腕捩連', '右人指１', '右人指２', '右中指１', '右薬指１', '右小指１', '右親指１'] as const;

function view(phase: RpsPhase, round: number, extra: Partial<RpsView> = {}): RpsView {
  return { id: 'm1', revision: 1, phase, round, score: { her: 0, user: 0 }, firstTo: 2, accepting: phase === 'ready' || phase === 'count' || phase === 'wait',
    commitment: null, revealed: null, userHand: null, outcome: null, line: null, face: 'nervous' as RpsFace, tease: null, beatMs: T.beatMs,
    phaseMs: 0, elapsedMs: 0, result: null, ...extra };
}
const revealed = (hand: RpsHand) => ({ hand, intent: 'fair' as const, nonce: 'n' });

interface Shown { t: number; extra: Quaternion[]; handPos: Vector3; elbowPos: Vector3 }
function extraSurprises(frames: Shown[]): number[][] {
  const step = new Quaternion(), last = new Quaternion(), inv = new Quaternion();
  return EXTRA.map((_, k) => {
    const out: number[] = [];
    for (let i = 2; i < frames.length; i++) {
      step.copy(frames[i].extra[k]).multiply(inv.copy(frames[i - 1].extra[k]).invert());
      last.copy(frames[i - 1].extra[k]).multiply(inv.copy(frames[i - 2].extra[k]).invert());
      out.push(step.angleTo(last) * DEG);
    }
    return out;
  });
}

test('body clearance: something in the way of the raised forearm pushes the arm outward until the forearm and hand are clear', () => {
  for (const build of ['slim', 'fat'] as const) {
    const data = bodyModel({ build }), mesh = toThreeMesh(data, { fullSkin: true });
    const proxy = buildModelProfile(profileInput(data)).collision;
    assert.ok(proxy);
    const plain = buildRpsRig(mesh, proxy)!;
    assert.ok(plain.upper && plain.clearance >= 0.08 * plain.points!.shoulder.distanceTo(plain.points!.elbow) && plain.pushed === 0, `${build} clearance ${plain.clearance}`);
    // A body part right where the raised wrist would be (a big bust or a prop): the pose turns out to her side.
    const wrist = plain.points!.wrist;
    const blocked: CollisionProxy = { ...proxy!, capsules: [...proxy!.capsules, { segment: 'chest', bone: proxy!.capsules[0].bone, a: [wrist.x + 0.4, wrist.y - 1, wrist.z], b: [wrist.x + 0.4, wrist.y + 1, wrist.z], radius: 0.6, vertices: 1 }] };
    const pushed = buildRpsRig(mesh, blocked)!;
    assert.ok(pushed.pushed > 0, `${build}: pushed ${pushed.pushed}`);
    assert.ok(pushed.clearance > 0, `${build}: clearance ${pushed.clearance}`);
    assert.ok(pushed.points!.wrist.x < wrist.x, `${build}: moved toward her own side (−x for the right arm)`);
  }
  assert.equal(segmentDistance(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(1, 1, 0)), 1);
});

test('fallbacks: no finger bones moves the arm only; no arm bones writes no bone (face only); the layer never throws', () => {
  const data = bodyModel({}), noFingers = toThreeMesh({ ...data, bones: data.bones.map(b => /中指/u.test(b.name) ? { ...b, name: `x${b.name}` } : b) });
  const rig = buildRpsRig(noFingers)!;
  assert.ok(rig.upper); assert.equal(rig.fingers, 0);
  const noArms = toThreeMesh({ ...data, bones: data.bones.map(b => /[左右](?:腕|ひじ|手首)/u.test(b.name) ? { ...b, name: `x${b.name}` } : b) });
  const armless = buildRpsRig(noArms)!;
  assert.equal(armless.upper, null);
  const layer = new RpsPerformance(), remembered: Bone[] = [];
  layer.cue(rpsStageCue(view('count', 1)));
  for (let i = 0; i < 90; i++) { layer.frame(1 / 60, noArms); layer.applyPose({ remember: bone => remembered.push(bone) }); }
  assert.equal(remembered.length, 0);
  assert.ok(layer.activity(null), 'her face still plays');
  assert.equal(rpsStageCue(view('invite', 0)), null, 'an invitation does not raise the arm');
});

test('presence curves: a minimum-jerk segment turned around halfway keeps position, speed and acceleration continuous', () => {
  const curve = new MinJerk(), dt = 1 / 60, xs: number[] = [];
  curve.to(1, 1);
  for (let i = 0; i < 30; i++) xs.push(curve.step(dt));
  curve.to(0, 0.8);
  for (let i = 0; i < 60; i++) xs.push(curve.step(dt));
  const second = xs.slice(2).map((x, i) => Math.abs(x - 2 * xs[i + 1] + xs[i]));
  assert.ok(Math.max(...second) < 0.01, `max second difference ${Math.max(...second)}`);
  assert.equal(xs.at(-1), 0);
});
