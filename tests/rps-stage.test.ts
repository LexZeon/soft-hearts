/**
 * G1 猜拳 on the real Stage frame loop (tests/helpers/gene-stage-harness.ts: bundled Gene, its Stand VMD, real
 * MMDLoader / MMDAnimationHelper, procedural life, the R29 continuity guard), at 60 and 30 fps.
 * R29_REPORT=1 prints the numbers used in docs/claude/2026-11-03-rps.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3, type Bone } from 'three';
import { RPS_TIMING, type RpsFace, type RpsHand, type RpsPhase, type RpsView } from '../shared/rps';
import { buildRpsRig, MinJerk, RpsPerformance, rpsStageCue, segmentDistance } from '../src/stage/rps-performance';
import { geneStage, surprises, steps, percentile, between, TRACKED_BONES, type GeneStage } from './helpers/gene-stage-harness';
import { bodyModel } from './helpers/body-fixtures';
import { profileInput, toThreeMesh } from './helpers/model-fixtures';
import { buildModelProfile } from '../shared/model-profile';
import type { CollisionProxy } from '../shared/collision-proxy';

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
/** Records the extra bones' displayed world rotation and the right hand's position every rendered frame. */
function recordExtra(h: GeneStage): Shown[] {
  const out: Shown[] = [], bones = EXTRA.map(name => h.mesh.skeleton.bones.find((b: Bone) => b.name === name)!);
  const wrist = bones[1], elbow = h.mesh.skeleton.bones.find((b: Bone) => b.name === '右ひじ')!;
  const render = h.stage.renderer.render;
  h.stage.renderer.render = (...args: unknown[]) => {
    render.apply(h.stage.renderer, args);
    const q = new Quaternion();
    out.push({ t: h.time(), extra: bones.map(b => b.getWorldQuaternion(q).clone()), handPos: wrist.getWorldPosition(new Vector3()), elbowPos: elbow.getWorldPosition(new Vector3()) });
  };
  return out;
}
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

/** One whole match on the stage: ready, count, reveal (paper), next, count, reveal (scissors, pretending paper), end, gone. */
async function playMatch(fps: number, game: boolean) {
  const h = await geneStage({ fps });
  const extra = recordExtra(h);
  const marks: Record<string, number> = {};
  const set = (name: string, value: RpsView | null) => { marks[name] = h.time(); if (game) h.stage.setRps(value); };
  try {
    h.run(3);
    set('ready', view('ready', 1, { face: 'nervous', phaseMs: T.readyMs })); h.run(T.readyMs / 1000);
    set('count', view('count', 1, { face: 'nervous' })); h.run((T.leadMs + 2 * T.beatMs) / 1000);
    set('reveal', view('reveal', 1, { revealed: revealed('paper'), userHand: 'rock', outcome: 'her', face: 'smug' })); h.run(T.reactMs / 1000);
    set('next', view('ready', 2, { face: 'nervous' })); h.run(T.nextMs / 1000);
    set('count2', view('count', 2)); h.run((T.leadMs + 2 * T.beatMs) / 1000);
    set('tease', view('reveal', 2, { revealed: revealed('scissors'), userHand: 'rock', outcome: 'user', face: 'tease', tease: 'paper' })); h.run(T.teaseMs / 1000);
    set('admit', view('reveal', 2, { revealed: revealed('scissors'), userHand: 'rock', outcome: 'user', face: 'happy', tease: null })); h.run(T.reactMs / 1000);
    set('end', view('end', 2, { revealed: revealed('scissors'), face: 'happy' })); h.run(T.endMs / 1000);
    set('gone', null); h.run(3);
    return { h, extra, marks, shown: h.shown };
  } catch (error) { h.close(); throw error; }
}

const runs = new Map<number, Promise<{ control: Awaited<ReturnType<typeof playMatch>>; event: Awaited<ReturnType<typeof playMatch>> }>>();
function pair(fps: number) {
  if (!runs.has(fps)) runs.set(fps, (async () => ({ control: await playMatch(fps, false), event: await playMatch(fps, true) }))());
  return runs.get(fps)!;
}
test.after(async () => { for (const run of runs.values()) { const { control, event } = await run; control.h.close(); event.h.close(); } });

for (const fps of [60, 30]) {
  test(`${fps} fps: the arm comes up, strokes three beats, shows the hand and goes back down without a jump; the guard never catches a bone`, async () => {
    const { control, event } = await pair(fps);
    const { marks } = event, g0 = marks.ready - 0.2, g1 = marks.gone + 3;
    const during = between(event.shown, g0, g1), base = between(control.shown, g0, g1);
    // What the continuity guard had to catch: bone properties (this layer's writes) and morphs, event run vs undisturbed run.
    const caughtIn = (frames: typeof during, morph: boolean) => frames.slice(1).filter((frame, i) => frame.guardJumps > frames[i].guardJumps
      && (frame.guardLast ?? '').startsWith('.morph') === morph).map(frame => `${frame.guardLast}@${frame.t.toFixed(2)}`);
    const bonesCaught = caughtIn(during, false), morphsCaught = caughtIn(during, true), baseCaught = caughtIn(base, false).length + caughtIn(base, true).length;
    const s = surprises(during), sBase = surprises(base);
    const arms = ['右肩', '右腕', '右ひじ'].map(name => TRACKED_BONES.indexOf(name as never));
    const others = TRACKED_BONES.map((_, i) => i).filter(i => !arms.includes(i));
    const worst = (series: number[][], idx: number[]) => Math.max(...idx.map(i => Math.max(...series[i])));
    const window = (from: number, to: number) => surprises(between(event.shown, from, to));
    const rows: Record<string, number> = {
      enter: worst(window(marks.ready - 2 / fps, marks.ready + 1.6), arms),
      leave: worst(window(marks.gone - 2 / fps, marks.gone + 1.8), arms),
      count: worst(window(marks.count, marks.reveal + 0.4), arms),
      undisturbedArms: worst(sBase, arms),
      others: worst(s, others), othersUndisturbed: worst(sBase, others),
    };
    const ex = extraSurprises(between(event.extra as never, g0, g1) as never);
    EXTRA.forEach((name, k) => { rows[name] = Math.max(...ex[k]); });
    rows.hand = Math.max(...[0, 1, 2, 3].map(k => rows[EXTRA[k]]));
    rows.fingers = Math.max(...[4, 5, 6, 7, 8, 9].map(k => rows[EXTRA[k]]));
    // Back where the undisturbed run is once the arm is down (the arm bones; her head's idle moments run on their own clock).
    const tail = between(event.shown, marks.gone + 2.4, Infinity), tailBase = between(control.shown, marks.gone + 2.4, Infinity);
    rows.rejoin = Math.max(...tail.map((frame, i) => Math.max(...arms.map(k => frame.world[k].angleTo(tailBase[i].world[k]) * DEG))));
    if (report) console.log(`[rps ${fps}fps]`, JSON.stringify(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, Math.round(v * 1000) / 1000]))),
      'guard bones', bonesCaught.length, 'morphs', morphsCaught.join(' ') || 0, 'undisturbed', baseCaught, 'p95 elbow step', percentile(steps(during)[arms[2]], 0.95).toFixed(3));
    assert.deepEqual(bonesCaught, [], 'no bone jump for the continuity guard to absorb');
    // Entering and leaving: within R29's hand-off standard for the arm (0.15° at 60 fps is 540°/s²; the same acceleration is 0.6° at 30 fps).
    const floor = fps === 60 ? 0.15 : 0.6;
    assert.ok(rows.enter <= Math.max(floor, 1.25 * rows.undisturbedArms), `enter ${rows.enter}`);
    assert.ok(rows.leave <= Math.max(floor, 1.25 * rows.undisturbedArms), `leave ${rows.leave}`);
    // The count strokes are deliberate pulses (a 14° dip per beat): bounded, not a cut.
    assert.ok(rows.count <= (fps === 60 ? 0.6 : 2.4), `count ${rows.count}`);
    // Other visible bones (head, neck, torso, left arm) stay within the undisturbed run's own unexpected steps.
    assert.ok(rows.others <= Math.max(floor, 1.25 * rows.othersUndisturbed), `others ${rows.others} vs ${rows.othersUndisturbed}`);
    assert.ok(rows.hand <= (fps === 60 ? 1.2 : 4.5), `hand ${rows.hand}`);
    assert.ok(rows.fingers <= (fps === 60 ? 3 : 10), `fingers ${rows.fingers}`);
    assert.ok(rows.rejoin < 0.3, `rejoin ${rows.rejoin}`);
  });
}

test('the raised hand: above the elbow, beside and in front of the chest; the hand shapes differ; the pretend cheat shows another hand', async () => {
  const { event } = await pair(60);
  const { marks } = event;
  const at = (t: number) => event.extra.find(frame => frame.t >= t)!;
  const mid = at(marks.count + 0.1);
  assert.ok(mid.handPos.y > mid.elbowPos.y + 1, 'the hand is up');
  assert.ok(mid.handPos.z > 0.5, 'in front of the body');
  assert.ok(mid.handPos.x < -1.5, 'on her right side');
  const down = at(marks.gone + 2.8);
  assert.ok(down.handPos.y < mid.handPos.y - 3, 'the arm went back down');
  // Index finger curl: fist while counting, open for paper, straight for scissors; the ring finger folds only for scissors.
  const finger = (frame: Shown) => frame.extra[5].angleTo(frame.extra[4]) * DEG; // 人指２ relative to 人指１
  const fist = finger(at(marks.count + 0.3)), paper = finger(at(marks.reveal + 0.8)), scissors = finger(at(marks.admit + 0.8));
  assert.ok(fist > 60 && paper < 20 && scissors < 20, `fist ${fist} paper ${paper} scissors ${scissors}`);
  const ring = (frame: Shown) => frame.extra[7].angleTo(frame.extra[1]) * DEG; // 薬指１ relative to the wrist
  assert.ok(ring(at(marks.admit + 0.8)) > ring(at(marks.reveal + 0.8)) + 40, 'scissors fold the ring finger, paper does not');
  // Pretend cheat: from 0.45 s into the reveal she shows paper (ring finger open), then scissors again for the admission.
  assert.ok(ring(at(marks.tease + 1.3)) < ring(at(marks.tease + 0.3)) - 40, 'the pretend hand opens the ring finger');
  const state = event.h.stage.rps.getState();
  assert.equal(state.side, 'right'); assert.ok(state.fingers >= 5); assert.ok(state.clearance > 0, `clearance ${state.clearance}`);
});

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
