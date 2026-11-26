// I-184: a kiss and a hug in her real Unbound body (the bundled public Gene through the real frame loop: MMDLoader, CCD IK, gait and
// contact owner, intent layer, the director with the close-moment action, the procedural generator, her arm reach), at 60 and 30 fps,
// with this laptop's screen-camera. She walks to the front, leans in, holds, eases back and walks home without a jump (the R29d
// unexpected-step numbers, compared with the peek she already does from the same place); the pucker never shows while she speaks; the
// hug's hands come forward in front of her chest, and stay down while a game holds her arms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { UNITS_PER_M } from '../src/unbound/figure';
import { Director } from '../src/unbound/director/director';
import { CLOSE_BEATS, closeMomentAction } from '../src/unbound/director/close-moment';
import { ProceduralGenerator } from '../src/unbound/motion/procedural';
import { nearBodyOf, nearStations } from '../src/unbound/pull-near';
import { planCloseMoment, type CloseMomentPlan } from '../shared/unbound/close-moments';
import { NEUTRAL_MOOD, type PeekPhase } from '../shared/unbound/director';
import { geneFigure, max, surpriseAngles, TRACKED } from './helpers/unbound-gene';
import { laptopLens, pointSteps, pointSurprises, runPeek, CURIOUS } from './helpers/unbound-peek';

const UPPER = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => !/足|ひざ/.test(name)).map(([, i]) => i);
const TORSO = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => /^(センター|上半身2?|首|頭)$/.test(name)).map(([, i]) => i);
const WARM = { ...NEUTRAL_MOOD, O: 78, E: 65, D: 60 };
type V = { x: number; y: number; z: number };
interface Frame { t: number; phase: PeekPhase | null; rotations: Quaternion[]; root: Vector3; head: V | null; eyes: { left: V | null }; wrists: (V | null)[]; chest: V; pucker: number; handsUp: number }

async function runClose(fps: number, kind: 'kiss' | 'hug', options: { speaking?: (t: number) => boolean; armsFree?: boolean; seconds?: number; cancelAt?: number } = {}) {
  const { fixture, figure } = await geneFigure({ xM: 0.25, depthM: 1.2 });
  const lens = laptopLens(), home = { x: 0.25, z: -1.2 };
  let t = 0;
  const hooks = {
    near: () => { const body = nearBodyOf(figure); return body ? nearStations(lens, body) : null; },
    mouth: () => { const speaking = options.speaking?.(t) ?? false; return { mayStart: !speaking, speaking }; },
    armsFree: () => options.armsFree ?? true,
  };
  const director = new Director([closeMomentAction(hooks)], new ProceduralGenerator(), () => {});
  const plan: CloseMomentPlan = planCloseMoment({ kind, after: 'grin', via: 'own', mood: WARM, label: 'close' }, () => 0.5);
  const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
  const find = (name: string) => fixture.mesh.skeleton.bones.find(b => b.name === name) ?? null;
  const wristBones = [find('左手首'), find('右手首')], chest = find('上半身2')!;
  const m = 1 / UNITS_PER_M, frames: Frame[] = [];
  let cancelled = false;
  try {
    for (let frame = 0; frame <= Math.round(fps * (options.seconds ?? 40)); frame++) {
      t = frame / fps;
      const dt = frame ? 1 / fps : 0;
      if (frame === 30) director.command({ type: 'start', id: 'close-test', plan, trial: false, armAfterMs: 0 }, { lens, home });
      if (options.cancelAt !== undefined && !cancelled && t >= options.cancelAt) { director.cancel('input'); cancelled = true; } // the host's cancel (2026-11-23: the page's mouse never cancels)
      director.frame(dt, { lens, home }, figure);
      figure.frame(dt);
      const sense = figure.sense!;
      fixture.mesh.updateMatrixWorld(true);
      const world = (b: typeof chest | null) => b ? (({ x, y, z }) => ({ x: x * m, y: y * m, z: z * m }))(b.getWorldPosition(new Vector3())) : null;
      const performance = (director as unknown as { performance: { puckerNow?: number } | null }).performance;
      frames.push({ t, phase: director.phase, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), root: fixture.mesh.position.clone().multiplyScalar(m),
        head: sense.head, eyes: { left: sense.eyes.left }, wrists: wristBones.map(world), chest: world(chest)!, pucker: performance?.puckerNow ?? 0, handsUp: figure.handsUp });
      if (frame > 30 && !director.active && t > 3) break;
    }
    return { frames, plan, lens, heightM: figure.heightM, faceToLensM: (hooks.near()?.faceDepthM ?? NaN) + lens.camera.z };
  } finally { figure.dispose(); fixture.close(); }
}

function numbers(frames: Frame[], fps: number) {
  const roots = frames.map(f => ({ x: f.root.x, y: f.root.y, z: f.root.z })), heads = frames.map(f => f.head), eyes = frames.map(f => f.eyes.left);
  return {
    rootStepCm: max(pointSteps(roots)), rootSurpriseCm: max(pointSurprises(roots)), headSurpriseCm: max(pointSurprises(heads)), eyeSurpriseCm: max(pointSurprises(eyes)),
    torsoSurpriseDeg: max(surpriseAngles(frames as never, 0, TORSO)), upperSurpriseDeg: max(surpriseAngles(frames as never, 0, UPPER)), seconds: frames.length / fps,
  };
}
/** Where the largest unexpected step of an arm bone is (bone, phase, time). */
function worstBone(frames: Frame[]) {
  let best = { deg: 0, bone: '', phase: '' as string | null, t: 0 };
  for (const b of UPPER) { const values = surpriseAngles(frames as never, 0, [b]); values.forEach((deg, i) => { if (deg > best.deg) best = { deg, bone: TRACKED[b], phase: frames[i + 2].phase, t: frames[i + 2].t }; }); }
  return best;
}
const peekCache = new Map<number, ReturnType<typeof numbers>>();
async function peekNumbers(fps: number) {
  if (!peekCache.has(fps)) { const run = await runPeek(fps, 30, { mood: CURIOUS }); peekCache.set(fps, numbers(run.frames as unknown as Frame[], fps)); }
  return peekCache.get(fps)!;
}

for (const fps of [60, 30]) {
  for (const kind of ['kiss', 'hug'] as const) {
    test(`Gene ${fps} fps, ${kind}: to the front, lean, hold, back and home — every beat, no teleport, no jolt (compared with the peek from the same place)`, async () => {
      const run = await runClose(fps, kind), n = numbers(run.frames, fps), peek = await peekNumbers(fps), k = 60 / fps;
      const phases = [...new Set(run.frames.map(f => f.phase).filter(Boolean))];
      // I-203: she walks first to where she begins only when she stands farther than it (here she starts 1.2 m back: sometimes not).
      assert.deepEqual(phases.filter(p => p !== 'walk'), ['notice', 'lean', 'hold', 'back', 'settle'], 'every beat');
      const hold = run.frames.filter(f => f.phase === 'hold');
      const lensZ = run.lens.camera.z, headAt = hold.map(f => f.head ? Math.hypot(f.head.x - run.lens.camera.x, f.head.y - run.lens.camera.y, f.head.z - lensZ) : Infinity);
      const report = { ...n, peek, worstArm: worstBone(run.frames), faceToLensM: run.faceToLensM, holdS: hold.length / fps, headToLensM: Math.min(...headAt), lastRoot: run.frames.at(-1)!.root };
      console.log(`[I-184 ${kind} ${fps} fps]`, JSON.stringify(report));
      // I-203: the step in from where she begins may be brisker than her walk (CLOSE_BEATS.stepMaxMps), never faster.
      assert.ok(n.rootStepCm <= Math.max(run.plan.walkSpeedMps, CLOSE_BEATS.stepMaxMps) * 100 / fps * 1.25 + 0.05, 'root at most her walking (or stepping-in) speed');
      assert.ok(n.rootSurpriseCm < 0.1 * k * k, `root: ${n.rootSurpriseCm}`);
      assert.ok(n.headSurpriseCm < 0.3 * k * k && n.eyeSurpriseCm < 0.3 * k * k, `head ${n.headSurpriseCm}, eye ${n.eyeSurpriseCm}`);
      assert.ok(n.torsoSurpriseDeg < 0.3 * k * k, `upper body and head: no jolt (${n.torsoSurpriseDeg})`);
      assert.ok(n.upperSurpriseDeg < Math.max(1.5 * peek.upperSurpriseDeg, 0.3 * k * k), `arms included: ${n.upperSurpriseDeg} (peek ${peek.upperSurpriseDeg})`);
      assert.ok(report.holdS >= run.plan.holdS - 0.05, 'held');
      assert.ok(report.headToLensM < run.faceToLensM + 0.1, `she came to the front: her head ${report.headToLensM} m from the lens (face station ${run.faceToLensM})`);
      const last = run.frames.at(-1)!.root;
      assert.ok(Math.hypot(last.x - 0.25, last.z + 1.2) < 0.06, 'back home');
      if (kind === 'kiss') assert.ok(Math.max(...hold.map(f => f.pucker)) > 0.9, 'the pucker shows in a pause');
      if (kind === 'hug') {
        const at = hold[hold.length - 1];
        // I-203 (the user's hug picture): her arms open and come forward round you (her hands apart, on either side of you), never past your eye plane.
        const [l, r] = at.wrists;
        assert.ok(l && r && Math.abs(l.x - r.x) > 0.12, `her hands apart, round you: ${l && r && Math.abs(l.x - r.x)} m`);
        for (const wrist of at.wrists) {
          assert.ok(wrist && wrist.z < lensZ - 0.03, `never past your eye plane: ${wrist && lensZ - wrist.z} m in front of it`);
        }
        assert.ok(at.handsUp > 0.6, `her arm reach holds them (${at.handsUp})`);
        const after = run.frames.at(-1)!;
        assert.ok(after.handsUp < 0.05, 'and lets them go again');
      }
    });
  }

  test(`Gene ${fps} fps: the pucker never shows while she speaks (it waits), and comes once she stops; a game holding her arms keeps the hug's hands down`, async () => {
    const speaking = await runClose(fps, 'kiss', { speaking: () => true, seconds: 25 });
    assert.equal(Math.max(...speaking.frames.map(f => f.pucker)), 0, 'speaking the whole time: never (the kiss run above shows it in a pause)');
    const held = await runClose(fps, 'hug', { armsFree: false, seconds: 25 });
    assert.ok(Math.max(...held.frames.map(f => f.handsUp)) < 0.02, `her arms stay with the game (${Math.max(...held.frames.map(f => f.handsUp))})`);
  });

  test(`Gene ${fps} fps: a mouse move mid-lean backs her off from where she is (no jolt), and she still walks home`, async () => {
    const probe = await runClose(fps, 'kiss', { seconds: 40 });
    const leanAt = probe.frames.find(f => f.phase === 'lean')!.t;
    // I-192: a clear move backs her off a short grace later (PoseRelease), so the move comes early in the lean.
    const run = await runClose(fps, 'kiss', { cancelAt: leanAt + 0.05, seconds: 40 }), n = numbers(run.frames, fps), k = 60 / fps;
    console.log(`[I-184 kiss cancelled mid-lean ${fps} fps]`, JSON.stringify(n));
    assert.ok(!run.frames.some(f => f.phase === 'hold'), 'it never reached the hold');
    assert.ok(n.headSurpriseCm < 0.3 * k * k && n.torsoSurpriseDeg < 0.3 * k * k, 'no jolt');
    const last = run.frames.at(-1)!.root;
    assert.ok(Math.hypot(last.x - 0.25, last.z + 1.2) < 0.06, 'home');
    // On her way to the front: she turns back home from where she is (never on to the front first).
    const walkAt = probe.frames.find(f => f.phase === 'walk')!.t;
    const walk = await runClose(fps, 'kiss', { cancelAt: walkAt + 0.3, seconds: 40 }), w = numbers(walk.frames, fps);
    const nearest = Math.min(...walk.frames.map(f => -f.root.z)), full = Math.min(...probe.frames.map(f => -f.root.z));
    console.log(`[I-184 kiss cancelled on the way ${fps} fps]`, JSON.stringify({ ...w, nearestM: nearest, fullNearestM: full }));
    assert.ok(!walk.frames.some(f => f.phase === 'lean'), 'no lean');
    assert.ok(nearest > full + 0.05, `she stopped short of the front (${nearest} vs ${full})`);
    assert.ok(w.rootSurpriseCm < 0.1 * k * k && w.headSurpriseCm < 0.3 * k * k, 'no jolt');
    const back = walk.frames.at(-1)!.root;
    assert.ok(Math.hypot(back.x - 0.25, back.z + 1.2) < 0.06, 'home');
  });
}
