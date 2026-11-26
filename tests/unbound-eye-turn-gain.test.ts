// The skin over her pupils. A converted model's iris fills its eye opening and already sits
// under the upper lid at rest, so the eye-head coordinator's degrees (tuned on Gene) slid it far under the lid and the lid's bare skin
// showed over the pupil. The rule (model/eye-turn-gain.ts): at the soft limit the upper lid covers no more of the iris than Gene's.
// Here on the public Gene, and on the public Gene with her irises raised in memory to sit like the private model's (no file is
// changed), through the real figure frame loop at 60 and 30 fps.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bone, SkinnedMesh } from 'three';
import { UnboundFigure } from '../src/unbound/figure';
import { EYE_TURN_GAIN_MIN, LID_COVER_REFERENCE, blinkMorph, eyeTurnGain, eyeTurnToReference, measureEyeRooms, type EyeRoom } from '../src/unbound/model/eye-turn-gain';
import { EYE_HEAD_DEFAULTS } from '../src/stage/eye-head';
import { REST_TARGETS } from '../src/unbound/motion/generator';
import { loadPublicGeneEdited, loadPublicGeneForTargets } from './public-gene-fixture';
import { standClip } from './helpers/unbound-gene';
import { syntheticStandardBody } from './helpers/unbound-vrm';

const DEG = Math.PI / 180;
const SOFT_UP = EYE_HEAD_DEFAULTS.eyeSoft.up;
const EYES = ['左目', '右目'] as const;

interface PmxLike { bones: { name: string; position: number[] }[]; vertices?: { position: number[]; skinIndices: number[]; skinWeights: number[] }[] }
/** The private model's eyes on Gene: every vertex her eye bones own moves up 0.05 units, so the iris sits a tenth under the upper lid at rest. */
function raisedIrises(data: PmxLike): void {
  const eyes = new Set(EYES.map(name => data.bones.findIndex(b => b.name === name)));
  for (const vertex of data.vertices ?? []) {
    let best = -1, weight = 0;
    vertex.skinIndices.forEach((bone, k) => { if (vertex.skinWeights[k] > weight) { weight = vertex.skinWeights[k]; best = bone; } });
    if (eyes.has(best)) vertex.position[1] += 0.05;
  }
}

const eyeBones = (mesh: SkinnedMesh): Bone[] => EYES.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
const roomsOf = (mesh: SkinnedMesh) => measureEyeRooms(mesh, eyeBones(mesh), blinkMorph(mesh));

/**
 * She looks `up` degrees up for `seconds` (the eye-head coordinator, the real figure). Returns how much of each iris the upper lid
 * covers at the end (its rest cover plus what the eye bone's turn added), the largest per-frame eye-bone step (degrees) and the gain.
 */
async function lookUp(load: () => Promise<{ mesh: SkinnedMesh; close(): void }>, up: number, fps: number, seconds = 1.2) {
  const fixture = await load();
  const figure = new UnboundFigure(fixture.mesh, { xM: 0.9, depthM: 8 });
  try {
    figure.setClips({ pose: await standClip(fixture.mesh), gesture: null, expression: null }, false);
    figure.setBreath(0);
    const rooms = roomsOf(fixture.mesh) as EyeRoom[];
    let last: { yaw: number; pitch: number }[] | null = null, step = 0, eyes: { yaw: number; pitch: number }[] = [];
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      figure.setPoseTargets({ ...REST_TARGETS, eyes: { yaw: 0, pitch: -up * DEG } });
      figure.frame(frame ? 1 / fps : 0);
      eyes = figure.eyeInHead();
      if (last) step = Math.max(step, ...eyes.map((e, i) => Math.hypot(e.yaw - last![i].yaw, e.pitch - last![i].pitch)));
      last = eyes;
    }
    // Eye bones rest at identity; a look up turns them about her left-right axis (negative pitch = up here).
    const cover = rooms.map((room, i) => room.coverAtRest + Math.max(0, -eyes[i].pitch) * DEG * room.lever / room.irisHeight);
    return { cover, step, gain: figure.eyeTurnGain, pitch: eyes.map(e => -e.pitch) };
  } finally { figure.dispose(); fixture.close(); }
}

test('eye turn gain: measured from the model, Gene turns exactly as before, an iris that fills its opening turns less', async () => {
  const gene = await loadPublicGeneForTargets();
  try {
    const rooms = roomsOf(gene.mesh) as EyeRoom[];
    assert.equal(rooms.length, 2); assert.ok(rooms.every(Boolean));
    for (const room of rooms) {
      assert.ok(room.coverAtRest < 0 && room.coverAtRest > -0.15, `Gene's iris top sits just below her lid at rest: ${room.coverAtRest}`);
      // At her soft limit up her lid covers about a fifth of her iris, just under the reference.
      const atSoft = room.coverAtRest + EYE_HEAD_DEFAULTS.eyeSoft.up * DEG * room.lever / room.irisHeight;
      assert.ok(atSoft > 0.18 && atSoft < LID_COVER_REFERENCE, `Gene's cover at 9° up: ${atSoft}`);
      assert.ok(eyeTurnToReference(room) > EYE_HEAD_DEFAULTS.eyeSoft.up);
    }
    assert.equal(eyeTurnGain(rooms, SOFT_UP), 1);
  } finally { gene.close(); }
  const raised = await loadPublicGeneEdited(raisedIrises);
  try {
    const rooms = roomsOf(raised.mesh) as EyeRoom[];
    assert.ok(rooms.every(room => room.coverAtRest > 0.05), `raised irises sit under the lid at rest: ${rooms.map(r => r.coverAtRest)}`);
    const gain = eyeTurnGain(rooms, SOFT_UP);
    assert.ok(gain > 0.3 && gain < 0.65, `gain ${gain}`);
    assert.ok(Math.abs(gain - Math.min(...rooms.map(eyeTurnToReference)) / EYE_HEAD_DEFAULTS.eyeSoft.up) < 1e-9);
  } finally { raised.close(); }
  // A VRM: its eyes go by its own lookAt range maps (body-transfer.ts); the standard skeleton has nothing to measure, so no second scaling.
  const vrm = await syntheticStandardBody('1.0');
  const vrmFigure = new UnboundFigure(vrm.mesh, { xM: 0, depthM: 0 });
  try { assert.equal(vrmFigure.eyeTurnGain, 1); } finally { vrmFigure.dispose(); }
  // Not measured (no blink, an eye without its own vertices): left as it was; a broken measurement: never below the floor.
  const room = (coverAtRest: number): EyeRoom => ({ irisHeight: 0.4, lever: 0.8, coverAtRest });
  assert.equal(eyeTurnGain([room(0.1), null], SOFT_UP), 1);
  assert.equal(eyeTurnGain([], SOFT_UP), 1);
  assert.equal(eyeTurnGain([room(0.9), room(0.9)], SOFT_UP), EYE_TURN_GAIN_MIN);
  assert.equal(eyeTurnGain([room(-0.5), room(-0.5)], SOFT_UP), 1, 'lots of room: exactly the look');
  assert.ok(eyeTurnGain([room(0.1), room(0.2)], SOFT_UP) < eyeTurnGain([room(0.1), room(0.1)], SOFT_UP), 'the tighter eye decides, both eyes move together');
});

for (const fps of [60, 30]) {
  test(`eye turn gain (${fps} fps, real frame loop): looking up, the lid covers no more of the raised iris than of Gene's, eased as before`, async () => {
    for (const up of [9, 20]) {
      const gene = await lookUp(loadPublicGeneForTargets, up, fps);
      const raised = await lookUp(() => loadPublicGeneEdited(raisedIrises), up, fps);
      assert.equal(gene.gain, 1);
      assert.ok(gene.pitch.every(p => p > 6), `Gene's eyes go up for ${up}°: ${gene.pitch}`);
      // Without the rule the raised irises turned as far as Gene's, on top of the tenth they start under (about 0.29 at a 9° look, 0.36 at 20°).
      for (const cover of raised.cover) assert.ok(cover <= LID_COVER_REFERENCE + 0.01,
        `${up}° up: raised cover ${raised.cover.map(c => c.toFixed(3))} vs Gene ${gene.cover.map(c => c.toFixed(3))} (reference ${LID_COVER_REFERENCE})`);
      if (process.env.EYE_GAIN_REPORT) console.log(`${fps} fps ${up}° up: Gene pitch ${gene.pitch.map(p => p.toFixed(2))} cover ${gene.cover.map(c => c.toFixed(3))} step ${gene.step.toFixed(3)}; raised pitch ${raised.pitch.map(p => p.toFixed(2))} cover ${raised.cover.map(c => c.toFixed(3))} step ${raised.step.toFixed(3)} gain ${raised.gain.toFixed(3)}`);
      assert.ok(raised.pitch.every(p => p > 1.5), `the raised eyes still look up: ${raised.pitch}`);
      // The same eye movements, only smaller: no frame turns the eye bones further than Gene's do.
      assert.ok(raised.step <= gene.step + 1e-9, `largest per-frame eye step: raised ${raised.step} vs Gene ${gene.step}`);
    }
  });
}
