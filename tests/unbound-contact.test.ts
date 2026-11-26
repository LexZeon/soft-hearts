// Unbound U1 part 2: the bundled public Gene standing and walking in her Unbound body, frame by frame at 60 and 30 fps through
// the real MMDLoader / MMDAnimationHelper / CCD IK path (tests/helpers/unbound-gene.ts). Feet on the floor (src/unbound/
// contact.ts), the gait (gait.ts), balance (balance.ts), and the motion passing through untouched (style-filter.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { NumberKeyframeTrack, QuaternionKeyframeTrack, AnimationClip, Quaternion, Vector3 } from 'three';
import { LayeredMmdAnimation } from '../src/stage/motion-layers';
import { UNITS_PER_M, type UnboundFigure } from '../src/unbound/figure';
import { loadPublicGeneForTargets } from './public-gene-fixture';
import {
  TRACKED, ankleSurprises, geneFigure, max, min, plantedDrift, rootSteps, rootSurprises, runGene, standClip, stepAngles, surpriseAngles, type Shown,
} from './helpers/unbound-gene';

const REST_ANKLE_M = 0.1065;
const LEGS = TRACKED.map((name, i) => /足|ひざ/.test(name) ? i : -1).filter(i => i >= 0);
const UPPER = TRACKED.map((name, i) => /足|ひざ/.test(name) ? -1 : i).filter(i => i >= 0);
const face = (t: number, f: UnboundFigure) => { if (t === 0) f.faceToward({ x: 0, z: 0.55 }); };
/** Toe travel along the floor while the toe touches it (cm): a foot that slides instead of stepping shows here. */
function floorSlide(frames: readonly Shown[]): number {
  let slide = 0;
  for (let i = 1; i < frames.length; i++) for (let k = 0; k < 2; k++) {
    const a = frames[i - 1].feet[k]?.toe, b = frames[i].feet[k]?.toe;
    if (a && b && a.y < 0.002 && b.y < 0.002) slide += Math.hypot(b.x - a.x, b.z - a.z) * 100;
  }
  return slide;
}
const standing = (f: Shown) => !f.walking && f.feet.every(x => x.planted) && f.stance === 'both';

test('standing: feet exactly on their points on the floor, COM well inside the feet, no step', async t => {
  for (const fps of [60, 30]) {
    const { frames } = await runGene(fps, 10, face);
    const d = plantedDrift(frames, REST_ANKLE_M), margin = min(frames.filter(standing).map(f => f.comMargin!));
    t.diagnostic(`${fps} fps standing: ankle drift ${d.drift.toFixed(4)} cm, toe drift ${d.toeDrift.toFixed(4)} cm, sink ${d.sink.toFixed(4)} cm, toe below floor ${d.toeBelow.toFixed(4)} cm, IK miss ${d.targetMiss.toFixed(4)} cm, COM margin ≥ ${(margin * 100).toFixed(1)} cm, largest leg unexpected step ${max(surpriseAngles(frames, 0, LEGS)).toFixed(3)}°`);
    assert.ok(d.drift < 0.01 && d.toeDrift < 0.01 && d.sink < 0.01 && d.toeBelow < 0.01, 'planted means planted');
    assert.ok(d.targetMiss < 0.01, 'the knee seed lets the model\'s IK reach a nearly straight leg');
    assert.ok(margin > 0.04, `COM ${(margin * 100).toFixed(1)} cm inside the support region`);
    assert.equal(frames.at(-1)!.steps, 0);
    assert.ok(max(surpriseAngles(frames, 0, LEGS)) < 0.05, 'standing legs: no jolt');
  }
});

for (const [name, goal, seconds] of [['toward the viewer (8 m → 2 m)', { xM: 0.9 * 2.55 / 8.55, depthM: 2 }, 16], ['away, turning round (8 m → 12 m)', { xM: 0.9 * 12.55 / 8.55, depthM: 12 }, 18]] as const) {
  test(`walking ${name}: planted feet stay put, no frame jumps at 60 and 30 fps, and she arrives (feet sliding as the before)`, async t => {
    const at60 = { legs: 0, upper: 0 };
    for (const fps of [60, 30]) {
      const script = (time: number, f: UnboundFigure) => { face(time, f); if (Math.abs(time - 1) < 1e-9) f.place(goal); };
      const { frames, placement } = await runGene(fps, seconds, script);
      // The before: the part-1 way (her feet ride along with her body; contact owner writes nothing).
      const before = await runGene(fps, seconds, script, { setup: f => f.setContactMode('motion') });
      const d = plantedDrift(frames, REST_ANKLE_M);
      const legs = max(surpriseAngles(frames, 0, LEGS)), upper = max(surpriseAngles(frames, 0, UPPER));
      const step = max(rootSteps(frames)), jolt = max(rootSurprises(frames)), ankle = max(ankleSurprises(frames));
      const reach = max(frames.map(f => f.reachDrop)) * 100;
      t.diagnostic(`${fps} fps ${name}: ${frames.at(-1)!.steps} steps; planted toe drift ${d.toeDrift.toFixed(4)} cm, flat ankle drift ${d.drift.toFixed(4)} cm, toe below floor ${d.toeBelow.toFixed(3)} cm, IK miss ${d.targetMiss.toFixed(4)} cm; `
        + `toe slide on the floor ${floorSlide(frames).toFixed(2)} cm (before: ${floorSlide(before.frames).toFixed(0)} cm); root ≤ ${step.toFixed(2)} cm/frame, unexpected ${jolt.toFixed(3)} cm; `
        + `largest unexpected step legs ${legs.toFixed(2)}°, upper body ${upper.toFixed(3)}°, ankles ${ankle.toFixed(2)} cm; largest bone step ${max(stepAngles(frames)).toFixed(2)}°; hips lowered by the reach guard ≤ ${reach.toFixed(2)} cm; end ${placement.xM.toFixed(3)}, ${placement.depthM.toFixed(3)}`);
      assert.ok(d.toeDrift < 0.01 && d.drift < 0.01, 'a planted foot does not slide');
      assert.ok(d.targetMiss < 0.01, 'every planted ankle is on the point the contact owner chose');
      assert.ok(d.toeBelow < 0.05, 'nothing sinks into the floor');
      assert.ok(floorSlide(frames) < 3 && floorSlide(before.frames) > 600, 'the feet step instead of sliding');
      assert.ok(step <= 0.7 / fps * 100 * 1.01, `her place moves at most walking speed (${step} cm/frame)`);
      assert.ok(jolt < (fps === 60 ? 0.05 : 0.2), `root jolt ${jolt} cm`);
      // A jump shows at 60 fps as much as at 30, so the 60 fps bound is the jump test; a smooth motion's frame-to-frame change
      // grows with the frame time squared (≈ 4× from 60 to 30 fps), so 30 fps may be up to 4.5× the 60 fps value, no more.
      if (fps === 60) { at60.legs = legs; at60.upper = upper; }
      assert.ok(legs < (fps === 60 ? 3 : 4.5 * at60.legs), `legs: largest unexpected step ${legs}°`);
      assert.ok(upper < (fps === 60 ? 0.6 : 4.5 * at60.upper), `upper body: largest unexpected step ${upper}°`);
      assert.ok(reach < 1, `the reach guard barely acts (${reach} cm)`);
      assert.ok(Math.abs(placement.depthM - goal.depthM) < 0.02 && Math.abs(placement.xM - goal.xM) < 0.02, 'she arrives');
      assert.ok(standing(frames.at(-1)!), 'and stands on both feet');
    }
  });
}

test('standing on one foot: weight over it first, the other foot up, COM inside the support foot, back down smoothly', async t => {
  for (const fps of [60, 30]) {
    const { frames } = await runGene(fps, 11, (time, f) => { face(time, f); if (Math.abs(time - 1) < 1e-9) f.setStance('left'); if (Math.abs(time - 7) < 1e-9) f.setStance('both'); });
    const holding = frames.filter(f => f.stance === 'holding');
    const lifted = frames.findIndex(f => !f.feet[1].planted);
    const marginAtLift = frames[lifted - 1].comMargin!;
    const holdMargin = min(holding.map(f => f.comMargin!));
    const raised = max(holding.map(f => f.feet[1].ankle.y - REST_ANKLE_M)) * 100;
    const d = plantedDrift(frames, REST_ANKLE_M), legs = max(surpriseAngles(frames, 0, LEGS));
    t.diagnostic(`${fps} fps single stance: lifted after ${(frames[lifted].t - 1).toFixed(2)} s with the COM ${(marginAtLift * 100).toFixed(1)} cm inside both feet; holding: COM ≥ ${(holdMargin * 100).toFixed(1)} cm inside the left foot, right foot up ${raised.toFixed(1)} cm; support foot drift ${d.drift.toFixed(4)} cm; legs largest unexpected step ${legs.toFixed(3)}°`);
    assert.ok(holding.length > fps * 3, 'held');
    assert.ok(frames[lifted].t - 1 > 0.5, 'the weight moves first');
    assert.ok(holdMargin > 0.005, `COM over the support foot while the other is up (${holdMargin})`);
    assert.ok(raised > 5, 'the free foot is clearly off the floor');
    assert.ok(d.drift < 0.01, 'the support foot does not move');
    assert.ok(legs < (fps === 60 ? 0.6 : 1.6), `no jolt (${legs}°)`);
    assert.ok(standing(frames.at(-1)!) && frames.at(-1)!.comMargin! > 0.04, 'back on both feet');
  }
});

test('the contact owner writes the foot targets last: after every frame each IK target is exactly where it was written, and the ankle is on it', async () => {
  const { fixture, figure } = await geneFigure();
  try {
    figure.faceToward({ x: 0, z: 0.55 });
    let worstTarget = 0, worstAnkle = 0, frames = 0;
    for (let i = 0; i <= 60 * 8; i++) {
      if (i === 60) figure.place({ xM: 0.6, depthM: 6 });
      figure.frame(i ? 1 / 60 : 0);
      for (const foot of figure.report!.feet) {
        worstTarget = Math.max(worstTarget, foot.ikWorld.distanceTo(foot.target));
        worstAnkle = Math.max(worstAnkle, foot.ankle.distanceTo(foot.target));
      }
      frames++;
    }
    assert.ok(worstTarget < 1e-6, `an IK target moved after it was written (${worstTarget} units)`);
    assert.ok(worstAnkle / UNITS_PER_M < 1e-4, `an ankle is off its target by ${(worstAnkle / UNITS_PER_M * 1000).toFixed(3)} mm`);
    assert.ok(frames > 400);
  } finally { figure.dispose(); fixture.close(); }
});

test('the motion passes through untouched: with every style group at 0 the bones and morphs are frame for frame the raw VMD; turning a group up softens only that group, without a pop', async () => {
  const BYPASS = ['首', '左ひじ', '右ひじ', '左手首', '右手首', '左人指１', '左人指２', '右中指１', '右親指１'];
  // A crisp blink on the expression layer: closed in two frames, open in three.
  const blink = (mesh: { morphTargetInfluences?: number[] }) => new AnimationClip('blink', 2, [new NumberKeyframeTrack('.morphTargetInfluences[0]', [0, 0.5, 0.5334, 0.6, 0.65, 2], [0, 0, 1, 1, 0, 0])]);
  // An elbow that sweeps 40° and back on the gesture layer (the Stand VMD's elbow holds still).
  const sweep = () => { const q = (deg: number) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), deg * Math.PI / 180).toArray();
    return new AnimationClip('sweep', 2, [new QuaternionKeyframeTrack('.bones[左ひじ].quaternion', [0, 0.6, 1.2, 2], [...q(0), ...q(0), ...q(40), ...q(0)])]); };
  const raw = await (async () => {
    const fixture = await loadPublicGeneForTargets();
    const animation = new LayeredMmdAnimation(fixture.mesh);
    animation.setClips({ pose: await standClip(fixture.mesh), gesture: sweep(), expression: blink(fixture.mesh) });
    const bones = BYPASS.map(n => fixture.mesh.skeleton.bones.find(b => b.name === n)!);
    const out: { q: number[][]; morph: number }[] = [];
    for (let i = 0; i <= 120; i++) { animation.helper.update(i ? 1 / 60 : 0); out.push({ q: bones.map(b => b.quaternion.toArray()), morph: fixture.mesh.morphTargetInfluences![0] }); }
    animation.dispose(); fixture.close();
    return out;
  })();
  const ours = async (arms: number) => {
    const { fixture, figure } = await geneFigure({ breath: 0 });
    try {
      figure.setClips({ pose: await standClip(fixture.mesh), gesture: sweep(), expression: blink(fixture.mesh) }, false);
      const bones = BYPASS.map(n => fixture.mesh.skeleton.bones.find(b => b.name === n)!);
      const out: { q: number[][]; morph: number }[] = [];
      for (let i = 0; i <= 120; i++) {
        if (i === 30) figure.styleFilter.setWeight('arms', arms);
        figure.frame(i ? 1 / 60 : 0);
        out.push({ q: bones.map(b => b.quaternion.toArray()), morph: fixture.mesh.morphTargetInfluences![0] });
      }
      return out;
    } finally { figure.dispose(); fixture.close(); }
  };
  const bypass = await ours(0);
  for (let i = 0; i < raw.length; i++) {
    assert.deepEqual(bypass[i].q, raw[i].q, `frame ${i}: a bypassed bone differs from the raw motion`);
    assert.equal(bypass[i].morph, raw[i].morph, `frame ${i}: the blink differs`);
  }
  const fastest = max(raw.slice(1).map((f, i) => Math.abs(f.morph - raw[i].morph)));
  assert.ok(fastest > 0.45, `the blink is crisp in the raw motion (${fastest.toFixed(2)} of the way in one frame)`);
  const soft = await ours(1);
  const finger = BYPASS.indexOf('左人指２'), elbow = BYPASS.indexOf('左ひじ');
  // Normalized first: the mixer's interpolated quaternions are not exactly unit length, and angleTo would read that as an angle.
  const angle = (a: number[], b: number[]) => new Quaternion().fromArray(a).normalize().angleTo(new Quaternion().fromArray(b).normalize()) * 180 / Math.PI;
  for (let i = 0; i < raw.length; i++) assert.deepEqual(soft[i].q[finger], raw[i].q[finger], 'only the arms group changes');
  assert.ok(Math.abs(angle(soft[30].q[elbow], raw[30].q[elbow])) < 0.01, 'turning the group on starts where the motion is (no pop)');
  const softSteps = soft.slice(29).map((f, i) => angle(f.q[elbow], soft[i + 28].q[elbow]));
  const rawSteps = raw.slice(29).map((f, i) => angle(f.q[elbow], raw[i + 28].q[elbow]));
  assert.ok(max(softSteps) <= max(rawSteps) + 0.01, `the softened elbow never moves faster than the motion (${max(softSteps).toFixed(3)}° vs ${max(rawSteps).toFixed(3)}°/frame)`);
  assert.ok(max(rawSteps) > 0.005, 'the motion moves the elbow');
  assert.ok(max(soft.slice(31).map((f, i) => angle(f.q[elbow], raw[i + 31].q[elbow]))) > 0.005, 'and then the elbow follows through its spring');
  assert.deepEqual(soft.map(f => f.morph), raw.map(f => f.morph), 'the blink stays crisp');
});

test('a model whose legs have no MMD IK still stands and walks (no contact owner, nothing planted)', async () => {
  const { fixture, figure } = await geneFigure();
  try {
    const md = (fixture.mesh.geometry.userData as { MMD: { iks: unknown[] } }).MMD;
    assert.ok(md.iks.length > 0);
  } finally { figure.dispose(); fixture.close(); }
  const fixture2 = await loadPublicGeneForTargets();
  (fixture2.mesh.geometry.userData as { MMD: { iks: unknown[] } }).MMD.iks = [];
  const { UnboundFigure } = await import('../src/unbound/figure');
  const bare = new UnboundFigure(fixture2.mesh, { xM: 0, depthM: 4 });
  try {
    bare.setClips({ pose: await standClip(fixture2.mesh), gesture: null, expression: null }, false);
    bare.place({ xM: 0, depthM: 3 });
    for (let i = 0; i <= 60 * 6; i++) bare.frame(i ? 1 / 60 : 0);
    assert.deepEqual(bare.report!.feet, []);
    assert.ok(Math.abs(bare.placement.depthM - 3) < 0.05, 'she still gets there');
    assert.ok(new Vector3().copy(fixture2.mesh.position).length() > 0);
  } finally { bare.dispose(); fixture2.close(); }
});
