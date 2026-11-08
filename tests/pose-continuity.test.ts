import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Quaternion, Vector3 } from 'three';
import { DEFAULT_CONTINUITY_TUNING, PoseContinuity, type ContinuityMesh } from '../src/stage/pose-continuity';

const DEG = Math.PI / 180;
interface FakeBone { name: string; quaternion: Quaternion; position: Vector3 }

function rig(bones = 3, morphs = 3): { skeleton: { bones: FakeBone[] }; morphTargetInfluences: number[] } {
  const mesh = {
    skeleton: { bones: Array.from({ length: bones }, (_, i) => ({ name: `b${i}`, quaternion: new Quaternion(), position: new Vector3(0, 1, 0) })) },
    morphTargetInfluences: new Array<number>(morphs).fill(0),
  };
  const structural: ContinuityMesh = mesh; // the guard only needs this structural surface
  void structural;
  return mesh;
}
const yaw = (radians: number) => new Quaternion().setFromEuler(new Euler(0, radians, 0));
const angle = (a: Quaternion, b: Quaternion) => a.angleTo(b) / DEG;

/** Drive one frame: writers set targets, guard applies, the "renderer" samples, guard removes. */
function frame(guard: PoseContinuity, mesh: ReturnType<typeof rig>, dt: number, write: () => void) {
  write();
  const targets = mesh.skeleton.bones.map(bone => ({ q: bone.quaternion.clone(), p: bone.position.clone() }));
  const morphTargets = [...mesh.morphTargetInfluences];
  guard.apply(dt);
  const shown = mesh.skeleton.bones.map(bone => ({ q: bone.quaternion.clone(), p: bone.position.clone() }));
  const shownMorphs = [...mesh.morphTargetInfluences];
  guard.remove();
  mesh.skeleton.bones.forEach((bone, i) => {
    assert.deepEqual(bone.quaternion.toArray(), targets[i].q.toArray(), 'remove() restores the exact composed target');
    assert.deepEqual(bone.position.toArray(), targets[i].p.toArray());
  });
  assert.deepEqual(mesh.morphTargetInfluences, morphTargets);
  return { shown, shownMorphs, targets };
}

for (const fps of [30, 60]) {
  test(`a 90 degree one-frame jump is shown step by step and converges (${fps} FPS)`, () => {
    const mesh = rig(), guard = new PoseContinuity(mesh, { height: 20 }), dt = 1 / fps;
    for (let i = 0; i < 10; i++) frame(guard, mesh, dt, () => mesh.skeleton.bones[0].quaternion.identity());
    let previous = new Quaternion(), maxStep = 0, last = 0;
    for (let i = 1; i <= Math.round(0.8 * fps); i++) {
      const { shown } = frame(guard, mesh, dt, () => mesh.skeleton.bones[0].quaternion.copy(yaw(90 * DEG)));
      maxStep = Math.max(maxStep, angle(shown[0].q, previous));
      previous = shown[0].q;
      last = angle(shown[0].q, yaw(90 * DEG));
      if (i === Math.round(0.3 * fps)) assert.ok(last < 12, `most of the jump is done after 300 ms (${last.toFixed(1)} deg left)`);
      if (i === Math.round(0.5 * fps)) assert.ok(last < 1, `converged within 500 ms (${last.toFixed(2)} deg left)`);
    }
    // Critically damped from rest: the fastest frame moves well under a third of the jump.
    assert.ok(maxStep <= 90 * (fps === 30 ? 0.22 : 0.12), `per-frame change bounded (${maxStep.toFixed(1)} deg)`);
    assert.ok(last < 0.05);
    assert.equal(guard.active, false, 'settled properties return to pass-through');
  });

  test(`steady motion passes through without lag (${fps} FPS)`, () => {
    const mesh = rig(), guard = new PoseContinuity(mesh, { height: 20 }), dt = 1 / fps;
    let worst = 0;
    for (let i = 0; i < fps * 4; i++) {
      const t = i * dt;
      const { shown, shownMorphs } = frame(guard, mesh, dt, () => {
        mesh.skeleton.bones[0].quaternion.copy(yaw(t * 180 * DEG)); // 180 deg/s constant spin
        // A music-like nod: 8 degrees at 2 Hz on another axis.
        mesh.skeleton.bones[1].quaternion.setFromEuler(new Euler(Math.sin(t * 2 * Math.PI * 2) * 0.14, 0, Math.sin(t * 5) * 0.03));
        mesh.skeleton.bones[2].position.set(0, 1 + Math.sin(t * 9) * 0.12, 0); // breathing/bounce
        mesh.morphTargetInfluences[0] = 0.23 + Math.abs(Math.sin(t * 12)) * 0.45; // lip-sync shape
      });
      if (i < 3) continue;
      worst = Math.max(worst, angle(shown[0].q, yaw(t * 180 * DEG)), angle(shown[1].q, mesh.skeleton.bones[1].quaternion));
      assert.equal(shown[2].p.y, mesh.skeleton.bones[2].position.y);
      assert.equal(shownMorphs[0], mesh.morphTargetInfluences[0]);
    }
    assert.ok(worst < 1e-3, `no lag on steady motion (${worst} deg; acos precision only)`);
    assert.equal(guard.getState().jumps, 0, 'nothing was ever captured');
    assert.equal(guard.active, false);
  });
}

test('authored fast onsets stay recognisable: the surprise head curve is not smeared', () => {
  // Same shape as surprise-curves.json head_z: -2 -> 6 degrees in 105 ms (smoothstep), then held.
  const curve = (ms: number) => {
    const points = [[0, 0], [150, -1], [240, -2], [345, 6], [575, 6], [810, -2.4]];
    for (let i = 1; i < points.length; i++) {
      const [a, x] = points[i - 1], [b, y] = points[i];
      if (ms <= b) { const t = (ms - a) / (b - a), u = t * t * (3 - 2 * t); return x + (y - x) * u; }
    }
    return 0;
  };
  for (const fps of [30, 60]) {
    const mesh = rig(), guard = new PoseContinuity(mesh, { height: 20 }), dt = 1 / fps;
    let worstHold = 0;
    for (let ms = 0; ms <= 800; ms += 1000 / fps) {
      const target = new Quaternion().setFromEuler(new Euler(0, 0, curve(ms) * DEG));
      const { shown } = frame(guard, mesh, dt, () => mesh.skeleton.bones[0].quaternion.copy(target));
      if (ms >= 400 && ms <= 575) worstHold = Math.max(worstHold, angle(shown[0].q, target));
    }
    assert.ok(worstHold < 0.8, `the 6 degree hold is reached (${fps} FPS, ${worstHold.toFixed(2)} deg off)`);
  }
});

test('successive jumps compose and never snap', () => {
  const mesh = rig(), guard = new PoseContinuity(mesh, { height: 20 }), dt = 1 / 30;
  for (let i = 0; i < 5; i++) frame(guard, mesh, dt, () => {});
  let previous = new Quaternion(), maxStep = 0;
  for (let i = 0; i < 45; i++) {
    // Target hops 25 degrees back and forth every third frame (worst-case thrash between owners).
    const target = yaw(((Math.floor(i / 3) % 2) ? 25 : -25) * DEG);
    const { shown } = frame(guard, mesh, dt, () => mesh.skeleton.bones[0].quaternion.copy(target));
    maxStep = Math.max(maxStep, angle(shown[0].q, previous));
    previous = shown[0].q;
  }
  assert.ok(maxStep < 25 * 0.5, `no frame snaps through the whole hop (${maxStep.toFixed(1)} deg)`);
  assert.ok(guard.getState().jumps >= 10);
});

test('a jump while moving keeps the motion going instead of stopping dead', () => {
  const mesh = rig(), guard = new PoseContinuity(mesh, { height: 20 }), dt = 1 / 60;
  const speed = 60 * DEG; // rad/s
  const shown: number[] = [];
  for (let i = 0; i < 90; i++) {
    const t = i * dt, jump = i >= 45 ? 20 * DEG : 0;
    const out = frame(guard, mesh, dt, () => mesh.skeleton.bones[0].quaternion.copy(yaw(speed * t + jump)));
    shown.push(new Euler().setFromQuaternion(out.shown[0].q, 'YXZ').y);
  }
  const velocity = (i: number) => (shown[i] - shown[i - 1]) / dt;
  for (let i = 40; i < 60; i++) assert.ok(Math.abs(velocity(i) - speed) < speed * 0.9 + 1e-9 || velocity(i) > 0,
    `displayed motion keeps its direction around the jump (frame ${i}: ${(velocity(i) / DEG).toFixed(1)} deg/s)`);
  assert.ok(Math.abs(shown[89] - (speed * 89 * dt + 20 * DEG)) < 0.3 * DEG, 'and lands on the new trajectory');
});

test('excluded (physics) bones and morphs are never touched', () => {
  const mesh = rig(3, 2), guard = new PoseContinuity(mesh, { height: 20, excludedBones: [1], excludedMorphs: [1] });
  for (let i = 0; i < 5; i++) frame(guard, mesh, 1 / 30, () => {});
  const { shown, shownMorphs } = frame(guard, mesh, 1 / 30, () => {
    mesh.skeleton.bones[1].quaternion.copy(yaw(80 * DEG)); mesh.skeleton.bones[1].position.set(4, 4, 4);
    mesh.morphTargetInfluences[1] = 1;
  });
  assert.deepEqual(shown[1].q.toArray(), yaw(80 * DEG).toArray());
  assert.deepEqual(shown[1].p.toArray(), [4, 4, 4]);
  assert.equal(shownMorphs[1], 1, 'a compositor-owned morph (blink) stays crisp');
  assert.equal(guard.getState().properties, 2 * 2 + 1);
});

test('a hard reset snaps instead of blending in from a stale pose', () => {
  const mesh = rig(), guard = new PoseContinuity(mesh, { height: 20 });
  for (let i = 0; i < 5; i++) frame(guard, mesh, 1 / 30, () => {});
  frame(guard, mesh, 1 / 30, () => mesh.skeleton.bones[0].quaternion.copy(yaw(60 * DEG)));
  assert.ok(guard.active);
  guard.reset('model-swap');
  assert.equal(guard.active, false);
  const { shown } = frame(guard, mesh, 1 / 30, () => mesh.skeleton.bones[0].quaternion.copy(yaw(-60 * DEG)));
  assert.deepEqual(shown[0].q.toArray(), yaw(-60 * DEG).toArray(), 'first frame after reset is the exact target');
  assert.equal(guard.getState().lastReset, 'model-swap');
});

test('a stalled/hidden window accumulates no debt: a long real gap snaps', () => {
  const mesh = rig(), guard = new PoseContinuity(mesh, { height: 20 });
  for (let i = 0; i < 5; i++) frame(guard, mesh, 1 / 30, () => {});
  mesh.skeleton.bones[0].quaternion.copy(yaw(70 * DEG));
  guard.apply(0.1, 3); // animation delta is capped, the real gap is 3 s
  assert.deepEqual(mesh.skeleton.bones[0].quaternion.toArray(), yaw(70 * DEG).toArray());
  guard.remove();
  assert.equal(guard.getState().lastReset, 'stale-gap');
});

test('morph jumps use a short half-life so faces stay crisp', () => {
  const mesh = rig(1, 1), guard = new PoseContinuity(mesh, { height: 20 }), dt = 1 / 30;
  for (let i = 0; i < 5; i++) frame(guard, mesh, dt, () => { mesh.morphTargetInfluences[0] = 0.8; });
  const values: number[] = [];
  for (let i = 0; i < 8; i++) values.push(frame(guard, mesh, dt, () => { mesh.morphTargetInfluences[0] = 0; }).shownMorphs[0]);
  assert.ok(values[0] > 0.3 && values[0] < 0.8, `first frame starts from the shown value (${values[0]})`);
  assert.ok(values[2] < 0.1, `gone within ~100 ms (${values[2]})`);
  assert.ok(values.every((value, i) => i === 0 || value <= values[i - 1] + 1e-12), 'monotone, no overshoot below zero');
  assert.ok(values.every(value => value >= 0));
});

test('positions are guarded relative to model height', () => {
  const mesh = rig(1, 0), guard = new PoseContinuity(mesh, { height: 20 }), dt = 1 / 30;
  for (let i = 0; i < 5; i++) frame(guard, mesh, dt, () => mesh.skeleton.bones[0].position.set(0, 9, 0));
  const { shown } = frame(guard, mesh, dt, () => mesh.skeleton.bones[0].position.set(0, 9 - 0.6, 0)); // 3% of height in one frame
  assert.ok(shown[0].p.y > 9 - 0.2, `position jump absorbed (${shown[0].p.y})`);
  const tiny = new PoseContinuity(rig(1, 0), { height: 20 });
  assert.ok(DEFAULT_CONTINUITY_TUNING.position.delta.floor * 20 > 0.02, 'breathing-sized motion is far below the floor');
  void tiny;
});

test('remove() never overwrites a value another owner replaced after apply()', () => {
  const mesh = rig(1, 1), guard = new PoseContinuity(mesh, { height: 20 });
  for (let i = 0; i < 3; i++) frame(guard, mesh, 1 / 30, () => {});
  mesh.skeleton.bones[0].quaternion.copy(yaw(50 * DEG)); mesh.morphTargetInfluences[0] = 1;
  guard.apply(1 / 30);
  const replacement = yaw(-10 * DEG);
  mesh.skeleton.bones[0].quaternion.copy(replacement); mesh.morphTargetInfluences[0] = 0.25;
  guard.remove();
  assert.deepEqual(mesh.skeleton.bones[0].quaternion.toArray(), replacement.toArray());
  assert.equal(mesh.morphTargetInfluences[0], 0.25);
});

test('diagnostics report how many properties blend and the largest remaining offset', () => {
  const mesh = rig(2, 1), guard = new PoseContinuity(mesh, { height: 20 });
  for (let i = 0; i < 3; i++) frame(guard, mesh, 1 / 30, () => {});
  guard.apply(1 / 30); guard.remove();
  mesh.skeleton.bones[1].quaternion.copy(yaw(30 * DEG));
  guard.apply(1 / 30);
  const state = guard.getState();
  guard.remove();
  assert.equal(state.active, 1);
  assert.ok(state.maxAngleDeg > 20 && state.maxAngleDeg <= 30, String(state.maxAngleDeg));
  assert.deepEqual(state.lastJump && { ...state.lastJump, size: Math.round(state.lastJump.size) }, { property: '.bones[b1].quaternion', size: 30 });
  assert.doesNotThrow(() => JSON.stringify(state));
});
