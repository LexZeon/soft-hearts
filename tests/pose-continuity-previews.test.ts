import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Quaternion, Vector3 } from 'three';
import { PoseContinuity } from '../src/stage/pose-continuity';
import { SURPRISE_CLIP, SURPRISE_DURATION_MS, surpriseSample } from '../src/stage/surprise-preview-overlay';
import { SHY_CLIP_ID } from '../shared/surprise-preview';

// The reviewed surprise/shy timed additive previews (surprise-curves.json,
// shy-curves.json) run through the guard on top of an authored base with an
// idle sway, exactly as the stage layers them: their fast onsets must stay
// recognisable, and both a natural end and a cancel must restore cleanly.
const DEG = Math.PI / 180;
const zRot = (degrees: number) => new Quaternion().setFromEuler(new Euler(0, 0, degrees * DEG));

function drive(clipId: string, fps: number, cancelAtMs = Infinity) {
  const bones = ['頭', '上半身'].map(name => ({ name, quaternion: new Quaternion(), position: new Vector3(0, 1, 0) }));
  const mesh = { skeleton: { bones }, morphTargetInfluences: [0, 0] };
  const guard = new PoseContinuity(mesh, { height: 20 });
  const dt = 1 / fps, rows: { ms: number; target: number[]; shown: number[] }[] = [];
  let maxStepDeg = 0, maxMorphStep = 0, previous: number[] | null = null;
  for (let frame = 0, ms = -500; ms <= SURPRISE_DURATION_MS + 600; frame++, ms += 1000 / fps) {
    const t = frame * dt;
    // Authored base (trusted mixer playback): a slow idle sway.
    bones[0].quaternion.setFromEuler(new Euler(Math.sin(t * 1.1) * 0.03, Math.sin(t * 0.7) * 0.05, 0));
    bones[1].quaternion.setFromEuler(new Euler(Math.sin(t * 1.5) * 0.01, 0, 0));
    mesh.morphTargetInfluences[0] = mesh.morphTargetInfluences[1] = 0;
    guard.captureBase(frame > 0);
    const sample = ms >= 0 && ms < cancelAtMs ? surpriseSample(ms, clipId) : null;
    const curve = [sample?.head_z_degrees ?? 0, sample?.torso_z_degrees ?? 0, sample?.brow_raise ?? 0, sample?.eye_wide ?? 0];
    bones[0].quaternion.multiply(zRot(curve[0])); bones[1].quaternion.multiply(zRot(curve[1]));
    mesh.morphTargetInfluences[0] = curve[2]; mesh.morphTargetInfluences[1] = curve[3];
    const exact = bones.map(bone => bone.quaternion.clone());
    const exactMorphs = [...mesh.morphTargetInfluences];
    guard.apply(dt);
    // Shown layer value = the displayed pose relative to this frame's base sway.
    const shownHead = new Euler().setFromQuaternion(exact[0].clone().multiply(zRot(curve[0]).invert()).invert().multiply(bones[0].quaternion), 'YXZ').z / DEG;
    const shownTorso = new Euler().setFromQuaternion(exact[1].clone().multiply(zRot(curve[1]).invert()).invert().multiply(bones[1].quaternion), 'YXZ').z / DEG;
    const shown = [shownHead, shownTorso, mesh.morphTargetInfluences[0], mesh.morphTargetInfluences[1]];
    if (previous) {
      maxStepDeg = Math.max(maxStepDeg, Math.abs(shown[0] - previous[0]), Math.abs(shown[1] - previous[1]));
      maxMorphStep = Math.max(maxMorphStep, Math.abs(shown[2] - previous[2]), Math.abs(shown[3] - previous[3]));
    }
    previous = shown;
    rows.push({ ms, target: curve, shown });
    guard.remove();
    bones.forEach((bone, i) => assert.deepEqual(bone.quaternion.toArray(), exact[i].toArray(), 'the exact composed target is restored after render'));
    assert.deepEqual(mesh.morphTargetInfluences, exactMorphs);
  }
  return { rows, guard, maxStepDeg, maxMorphStep };
}

for (const clipId of [SURPRISE_CLIP, SHY_CLIP_ID]) {
  for (const fps of [30, 60]) {
    test(`${clipId} keeps its authored onsets and peaks through the guard (${fps} FPS)`, () => {
      const { rows, guard } = drive(clipId, fps);
      for (let track = 0; track < 4; track++) {
        const authored = rows.reduce((best, row) => Math.abs(row.target[track]) > Math.abs(best) ? row.target[track] : best, 0);
        const shown = rows.reduce((best, row) => Math.abs(row.shown[track]) > Math.abs(best) ? row.shown[track] : best, 0);
        if (Math.abs(authored) < 1e-6) continue;
        assert.ok(Math.sign(shown) === Math.sign(authored) && Math.abs(shown) >= Math.abs(authored) * 0.93 && Math.abs(shown) <= Math.abs(authored) * 1.07,
          `track ${track}: peak ${shown.toFixed(3)} vs authored ${authored.toFixed(3)}`);
        // The whole curve stays close: never more than a quarter of its range away.
        const worst = Math.max(...rows.map(row => Math.abs(row.shown[track] - row.target[track])));
        assert.ok(worst <= Math.abs(authored) * 0.25, `track ${track}: worst deviation ${worst.toFixed(3)} of ${authored.toFixed(3)}`);
      }
      // Natural end: back to exact pass-through, nothing left over.
      const tail = rows.filter(row => row.ms > SURPRISE_DURATION_MS + 300);
      assert.ok(tail.length > 0 && tail.every(row => row.shown.every((value, i) => Math.abs(value - row.target[i]) < 1e-9)));
      assert.equal(guard.active, false);
    });
  }
}

test('a preview cancelled mid-onset eases out instead of snapping, then settles', () => {
  for (const fps of [30, 60]) {
    const cancelled = drive(SURPRISE_CLIP, fps, 400);
    const full = drive(SURPRISE_CLIP, fps);
    // At 400 ms the head is at its 6 degree hold and the eyes wide open; the cancel removes both in one frame.
    const at = cancelled.rows.findIndex(row => row.ms >= 400);
    assert.ok(cancelled.rows[at - 1].target[0] > 5, 'the cancel happens at a visible peak');
    const after = cancelled.rows.slice(at, at + 3).map(row => row.shown[0]);
    assert.ok(after[0] > 2.5 && after[1] < after[0] && after[2] < after[1], `head eases out (${after.map(v => v.toFixed(2)).join(' ')})`);
    assert.ok(cancelled.maxStepDeg <= Math.max(full.maxStepDeg, 6 * 0.45), `no cancel frame snaps (${cancelled.maxStepDeg.toFixed(2)} deg)`);
    // Carried velocity gives a short follow-through; what is left after 350 ms is imperceptible.
    const late = cancelled.rows.filter(row => row.ms > 400 + 350);
    assert.ok(late.every(row => Math.abs(row.shown[0]) < 0.5 && Math.abs(row.shown[1]) < 0.5 && row.shown[2] < 0.01 && row.shown[3] < 0.01), 'nearly settled after 350 ms');
    const settled = cancelled.rows.filter(row => row.ms > 400 + 700);
    assert.ok(settled.every(row => row.shown.every((value, i) => Math.abs(value - row.target[i]) < 1e-9)), 'exact pass-through again within 700 ms');
    assert.equal(cancelled.guard.active, false);
  }
});
