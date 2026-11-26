// Unbound U1: her body goes only through the dynamics layer (src/unbound/dynamics.ts, figure.ts), measured on the bundled public
// Gene with her reviewed Stand VMD through the real MMDLoader / MMDAnimationHelper path, frame by frame at 60 and 30 fps (the
// R29b/R29c way: per-frame step and "unexpected step" = how far a frame's step departs from the previous one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Quaternion, Vector3, type AnimationClip, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { BodyDynamics, BreathOscillator } from '../src/unbound/dynamics';
import { UNITS_PER_M, UnboundFigure } from '../src/unbound/figure';
import { parseVmdWith } from '../src/foundation/vmd';
import { withKeyframeInterpolation } from '../src/stage/keyframe-interpolation';
import { loadPublicGeneForTargets } from './public-gene-fixture';

const STAND = new URL('../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/motions/pose/stand.vmd', import.meta.url);
const TRACKED = ['センター', '上半身', '上半身2', '首', '頭', '左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ'];
const DEG = 180 / Math.PI;

test('a channel meets a new target the same way at any frame rate, from rest, without overshoot', () => {
  const run = (fps: number) => {
    const body = new BodyDynamics(); body.begin('depth', 8); body.target('depth', 2);
    const out = new Map<number, number>(); let firstStep = 0, overshoot = 0;
    for (let frame = 1; frame <= fps * 5; frame++) {
      const before = body.value('depth');
      body.step(1 / fps);
      if (frame === 1) firstStep = Math.abs(body.value('depth') - before);
      overshoot = Math.max(overshoot, 2 - body.value('depth'));
      if (frame % (fps / 2) === 0) out.set(frame / fps, body.value('depth'));
    }
    return { out, firstStep, overshoot };
  };
  const a = run(60), b = run(30);
  // Fixed 1/120 s sub-steps: 60 and 30 fps walk the same path.
  for (const [t, value] of a.out) assert.ok(Math.abs(value - b.out.get(t)!) < 1e-9, `t=${t}: ${value} vs ${b.out.get(t)}`);
  assert.ok(a.firstStep < 0.0005, `first 60 fps frame moves ${a.firstStep} m of a 6 m change (eases out of rest)`);
  assert.ok(a.overshoot <= 1e-9, 'no overshoot from rest');
  assert.ok(Math.abs(a.out.get(5)! - 2) < 0.02, `there in 5 s (${a.out.get(5)})`);
});

test('a new target mid-way keeps the speed she has (no stop dead, no jump)', () => {
  const body = new BodyDynamics(); body.begin('x', 0); body.target('x', 1);
  for (let i = 0; i < 30; i++) body.step(1 / 60);
  const speed = body.velocity('x'), at = body.value('x');
  body.target('x', -1);
  assert.equal(body.velocity('x'), speed, 'the velocity is state, not reset by the new target');
  body.step(1 / 60);
  assert.ok(Math.abs(body.value('x') - at - speed / 60) < 0.002, 'the next frame continues the same motion');
});

test('the breath is phase-continuous through a change of rate', () => {
  const breath = new BreathOscillator();
  let last = breath.step(1 / 60), worst = 0;
  for (let i = 0; i < 600; i++) {
    if (i === 300) breath.setRate(0.4);
    const value = breath.step(1 / 60);
    worst = Math.max(worst, Math.abs(value - last)); last = value;
  }
  assert.ok(worst < 2 * Math.PI * 0.4 / 60 + 1e-9, `largest per-frame change ${worst}`);
});

async function gene(breath = 0.5) {
  const fixture = await loadPublicGeneForTargets();
  const bytes = await readFile(STAND);
  const vmd = parseVmdWith(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const builder = (withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(vmd: unknown, mesh: SkinnedMesh): AnimationClip } }).animationBuilder;
  const clip = builder.build(vmd, fixture.mesh);
  clip.duration = Math.max(clip.duration, 120 / 30);
  const figure = new UnboundFigure(fixture.mesh, { xM: 0.9, depthM: 8 });
  figure.setClips({ pose: clip, gesture: null, expression: null }, false);
  figure.setBreath(breath);
  return { fixture, figure };
}

interface Shown { rotations: Quaternion[]; head: Vector3; root: Vector3 }
/** Runs her for `seconds` at `fps`; `script(t)` may hand targets in. Every frame's displayed pose. */
async function run(fps: number, seconds: number, script: (t: number, figure: UnboundFigure) => void = () => {}, breath = 0.5, after: (t: number, figure: UnboundFigure) => void = () => {}) {
  const { fixture, figure } = await gene(breath);
  try {
    const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
    const head = bones[TRACKED.indexOf('頭')];
    const frames: Shown[] = [];
    for (let frame = 0; frame <= fps * seconds; frame++) {
      const t = frame / fps;
      script(t, figure);
      figure.frame(frame ? 1 / fps : 0);
      after(t, figure);
      frames.push({ rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), head: head.getWorldPosition(new Vector3()).divideScalar(UNITS_PER_M),
        root: fixture.mesh.position.clone().divideScalar(UNITS_PER_M) });
    }
    return { frames, heightM: figure.heightM };
  } finally { figure.dispose(); fixture.close(); }
}
const stepAngles = (frames: Shown[]) => frames.slice(1).flatMap((f, i) => f.rotations.map((q, b) => q.angleTo(frames[i].rotations[b]) * DEG));
function surpriseAngles(frames: Shown[]): number[] {
  const out: number[] = [], step = new Quaternion(), last = new Quaternion(), inverse = new Quaternion();
  for (let i = 2; i < frames.length; i++) for (let b = 0; b < TRACKED.length; b++) {
    step.copy(frames[i].rotations[b]).multiply(inverse.copy(frames[i - 1].rotations[b]).invert());
    last.copy(frames[i - 1].rotations[b]).multiply(inverse.copy(frames[i - 2].rotations[b]).invert());
    out.push(step.angleTo(last) * DEG);
  }
  return out;
}
const rootSteps = (frames: Shown[]) => frames.slice(1).map((f, i) => f.root.distanceTo(frames[i].root) * 100);
const rootSurprises = (frames: Shown[]) => frames.slice(2).map((f, i) => {
  const a = f.root.clone().sub(frames[i + 1].root), b = frames[i + 1].root.clone().sub(frames[i].root);
  return a.sub(b).length() * 100;
});
const max = (values: number[]) => values.reduce((a, b) => Math.max(a, b), 0);

test('Gene standing in Unbound (Stand VMD + breath) is as smooth as the Stand VMD alone, at 60 and 30 fps', async t => {
  for (const fps of [60, 30]) {
    const { frames, heightM } = await run(fps, 6);
    const alone = await run(fps, 6, undefined, 0); // breath 0: the VMD through the same mixer, nothing of ours on top
    const steps = stepAngles(frames), surprises = surpriseAngles(frames), vmd = max(surpriseAngles(alone.frames));
    t.diagnostic(`${fps} fps idle: largest bone step ${max(steps).toFixed(3)}°, largest unexpected step ${max(surprises).toFixed(3)}° (Stand VMD alone ${vmd.toFixed(3)}°), root moved ${max(rootSteps(frames)).toFixed(4)} cm/frame; height ${heightM.toFixed(2)} m`);
    assert.ok(heightM > 1.3 && heightM < 2, `Gene is ${heightM} m tall at 8 cm per unit`);
    assert.ok(max(surprises) <= vmd + 0.02, `${fps} fps: breath and arms add no jolt (${max(surprises)}° vs ${vmd}°)`);
    assert.equal(max(rootSteps(frames)), 0, 'standing still: her place does not move');
  }
});

test('she stands on her floor (y = 0) where she was placed, in meters', async () => {
  const { fixture, figure } = await gene();
  try {
    figure.frame(0);
    const ankle = fixture.mesh.skeleton.bones.find(b => b.name === '左足首')!.getWorldPosition(new Vector3()).divideScalar(UNITS_PER_M);
    assert.ok(ankle.y > 0 && ankle.y < 0.15, `ankle ${ankle.y.toFixed(3)} m above the floor`);
    assert.ok(Math.abs(ankle.z + 8) < 0.3 && Math.abs(ankle.x - 0.9) < 0.3, `standing at (0.9, -8): ${ankle.x.toFixed(2)}, ${ankle.z.toFixed(2)}`);
  } finally { figure.dispose(); fixture.close(); }
});

test('moving her from 8 m to 2 m: she walks there through the gait instead of jumping (direct write as the before)', async t => {
  for (const fps of [60, 30]) {
    // Part 2: she walks (src/unbound/gait.ts); her place moves at walking speed, eased in and out.
    const walk = await run(fps, 14, (time, figure) => { if (Math.abs(time - 1) < 1e-9) figure.place({ xM: 0.9, depthM: 2 }); });
    // The before: the same request written straight to her place after each frame (what "只给目标，不写骨头" forbids).
    const direct = await run(fps, 3, undefined, 0.5, (time, figure) => {
      if (time >= 1 - 1e-9) (figure as unknown as { mesh: SkinnedMesh }).mesh.position.z = -2 * UNITS_PER_M;
    });
    const g = { step: max(rootSteps(walk.frames)), surprise: max(rootSurprises(walk.frames)), arrived: walk.frames.at(-1)!.root.z };
    const d = { step: max(rootSteps(direct.frames)), surprise: max(rootSurprises(direct.frames)) };
    t.diagnostic(`${fps} fps 8 m→2 m: direct write: largest step ${d.step.toFixed(1)} cm/frame, unexpected ${d.surprise.toFixed(1)} cm; walking: largest step ${g.step.toFixed(2)} cm/frame, unexpected ${g.surprise.toFixed(3)} cm; at 14 s z = ${g.arrived.toFixed(3)} m`);
    assert.ok(d.step > 500, 'the direct write is one 6 m jump');
    assert.ok(g.step <= 0.7 / fps * 100 * 1.01, `walking step ${g.step} cm/frame (≤ 0.7 m/s)`);
    assert.ok(g.surprise < (fps === 60 ? 0.05 : 0.2), `walking unexpected step ${g.surprise} cm`);
    assert.ok(Math.abs(g.arrived + 2) < 0.02, 'she arrives');
  }
});
