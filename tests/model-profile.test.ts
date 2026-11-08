import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Bone, Float32BufferAttribute, PerspectiveCamera, ShaderMaterial, SkinnedMesh, Vector3 } from 'three';
import {
  MORPH_SLOTS, acceptCachedProfile, buildModelProfile, calibratedWeight, profileBindings, summarizeModelProfile,
  validateStoredModelProfile, type ModelProfile,
} from '../shared/model-profile';
import { StageModelProfile, legacyMorphIndices, writeProfiledMorph } from '../src/stage/model-profile';
import { probeHeadContact } from '../src/stage/head-contact';
import { probeBlushAnchors } from '../src/stage/procedural-blush';
import { projectCheekRegions } from '../src/stage/cheek-pinch-region';
import { readPmxLite } from './helpers/pmx-lite';
import { JAPANESE_MORPHS, profileInput, toThreeMesh, toyModel, type ToyMorph } from './helpers/model-fixtures';

const genePath = new URL('../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/model/gene.pmx', import.meta.url);
const gene = readPmxLite(new Uint8Array(readFileSync(genePath)));
const geneProfile = buildModelProfile(profileInput(gene));
const geneDictionary = Object.fromEntries(gene.morphs.map((morph, index) => [morph.name, index]));
const without = (...names: string[]) => JAPANESE_MORPHS.filter(morph => !names.includes(morph.name));
const withMorphs = (morphs: ToyMorph[], options = {}) => buildModelProfile(profileInput(toyModel({ ...options, morphs })));
function profileMorphIndex(profile: ModelProfile, name: string): number {
  const slot = MORPH_SLOTS.find(key => profile.morphs[key].name === name);
  return slot ? profile.morphs[slot].index : -1;
}
/** What the stage's old applyMorph wrote (before the profile): max with the mixer value, clamped to [0, 1]. */
function legacyWrite(influences: number[], index: number, weight: number) {
  influences[index] = Math.max(influences[index] ?? 0, Math.max(0, Math.min(1, weight)));
}

test('Gene: every slot maps to the morph the stage already used, verified by where it moves', () => {
  const legacy = legacyMorphIndices(geneDictionary);
  assert.deepEqual(legacy, { blink: 88, mouth: 123, smile: 89, sad: 68 });
  const bindings = profileBindings(geneProfile, true);
  assert.deepEqual({ blink: bindings.blink, mouth: bindings.mouth, smile: bindings.smile, sad: bindings.sad }, legacy);
  assert.equal(bindings.blinkPartner, -1);
  assert.deepEqual(bindings.scales, [], 'the reviewed Gene keeps every reviewed amount');
  const names = Object.fromEntries(MORPH_SLOTS.map(slot => [slot, geneProfile.morphs[slot].name]));
  assert.deepEqual(names, { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お', blink: 'まばたき', blinkLeft: 'ウィンク', blinkRight: 'ウィンク右',
    smileEyes: '笑い', mouthSmile: 'にっこり', sad: '困る', angry: '怒り', surprise: 'びっくり', shy: '赤み', jitome: 'じと目', browUp: '上', mouthPucker: 'mouthPucker' });
  // E1: the raised-brow slot is the morph the frozen surprise preview wrote by index (84).
  assert.equal(geneProfile.morphs.browUp.index, 84);
  assert.ok(MORPH_SLOTS.every(slot => geneProfile.morphs[slot].rejected.length === 0));
  // Calibration is anchored on Gene: even an unreviewed copy of Gene stays within 0.1% of its reviewed amounts.
  for (const [, scale] of profileBindings(geneProfile, false).scales) assert.ok(Math.abs(scale - 1) < 1e-3, String(scale));
  const p = geneProfile.proportions;
  assert.equal(p.eyeLineSource, 'bones'); assert.equal(p.mouth.source, 'morph');
  assert.ok(Math.abs(p.mouth.point[1] - 17.13) < 0.05 && Math.abs(p.mouth.point[0]) < 1e-3);
  assert.equal(p.restPose, 'A'); assert.ok(Math.abs(p.restArmDeg! - 34) < 1);
  assert.ok(p.headsTall > 6.5 && p.headsTall < 7.5, String(p.headsTall));
  assert.deepEqual(geneProfile.bones.missing, ['waist']);
  assert.deepEqual(geneProfile.bones.features, { ik: true, legIk: true, armTwist: true, wristTwist: true, groove: true, eyes: 'pair' });
});

test('Gene through the real Three adapter: same slots, and every stage write and region is unchanged', () => {
  const mesh = toThreeMesh(gene);
  try {
    const reviewed = new StageModelProfile(mesh, { reviewed: true });
    assert.equal(reviewed.source, 'computed');
    assert.deepEqual(reviewed.indices, legacyMorphIndices(mesh.morphTargetDictionary));
    assert.equal(reviewed.scales.size, 0); assert.equal(reviewed.links.size, 0); assert.deepEqual(reviewed.linkedMorphs, []);
    const head = reviewed.bone('head')!, eyes = [reviewed.bone('eyeLeft')!, reviewed.bone('eyeRight')!];
    assert.equal(head.name, '頭'); assert.deepEqual(eyes.map(bone => bone.name), ['左目', '右目']);
    reviewed.attachHead(head);
    assert.deepEqual(reviewed.contactEyes, []); assert.equal(reviewed.mouthLocal, null); assert.equal(reviewed.cheekAnchors, null);
    assert.deepEqual(probeHeadContact(mesh, head, eyes, 20, reviewed.contactEyes), probeHeadContact(mesh, head, eyes, 20));
    for (const slot of MORPH_SLOTS) assert.equal(reviewed.profile!.morphs[slot].index, geneProfile.morphs[slot].index, slot);
    // Writes are bit-identical to the old applyMorph for lip-sync, feeding, blink, smile and brows.
    for (const target of [reviewed.indices.mouth, reviewed.indices.blink, reviewed.indices.smile, reviewed.indices.sad])
      for (const prior of [0, 0.3, 1]) for (const weight of [-0.2, 0, 0.23, 0.4567, 0.68, 0.85, 1, 1.4]) {
        const before = Array.from({ length: 184 }, () => prior), after = before.slice(), layers: { index: number; value: number }[] = [];
        legacyWrite(before, target, weight); writeProfiledMorph(after, layers, reviewed, target, weight);
        assert.deepEqual(after, before); assert.deepEqual(layers, [{ index: target, value: prior }]);
      }
    const summary = reviewed.summary;
    assert.equal(summary.reviewed, true); assert.deepEqual(summary.scales, {}); assert.deepEqual(summary.missing, []);
    assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary, 'plain data');
    const unreviewed = new StageModelProfile(mesh, { reviewed: false });
    assert.deepEqual(unreviewed.indices, reviewed.indices);
    for (const scale of unreviewed.scales.values()) assert.ok(Math.abs(scale - 1) < 1e-3);
  } finally { mesh.geometry.dispose(); }
});

test('English-only names map the humanoid bones and every semantic slot', () => {
  const profile = buildModelProfile(profileInput(toyModel({ names: 'english' })));
  assert.equal(profile.bones.map.head?.name, 'Head'); assert.equal(profile.bones.map.armLeft?.name, 'Arm_L'); assert.equal(profile.bones.map.eyeRight?.name, 'Eye_R');
  assert.ok(['center', 'upperBody', 'neck', 'head', 'armLeft', 'elbowRight', 'wristLeft', 'kneeRight', 'ankleLeft'].every(bone => !profile.bones.missing.includes(bone as never)));
  assert.deepEqual(profile.bones.ambiguous, []);
  const found = summarizeModelProfile(profile, 'computed', false);
  assert.deepEqual(found.missing, ['mouthPucker'], 'the toy face has no pucker (skeleton step 2 slot)');
  assert.deepEqual(found.found, { a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh', blink: 'Blink', blinkLeft: 'Blink_L', blinkRight: 'Blink_R', smileEyes: 'Eye_Smile',
    mouthSmile: 'Mouth_Smile', sad: 'Sad', angry: 'Angry', surprise: 'Surprised', shy: 'Blush', jitome: 'Half_Closed', browUp: 'Brow_Up' });
  const legacy = legacyMorphIndices(Object.fromEntries(toyModel({ names: 'english' }).morphs.map((morph, i) => [morph.name, i])));
  assert.equal(legacy.mouth, -1, 'the old exact-name lookup gave this model no lip-sync');
  assert.equal(profileBindings(profile, false).mouth, 0);
});

test('no blink morph: blink is reported missing, never guessed; a per-eye pair blinks both eyes together', () => {
  const none = withMorphs(without('まばたき', 'ウィンク', 'ウィンク右'));
  assert.equal(none.morphs.blink.index, -1); assert.equal(profileBindings(none, false).blink, -1);
  assert.ok(summarizeModelProfile(none, 'computed', false).missing.includes('blink'));
  assert.equal(none.proportions.eyeLineSource, 'bones');
  const pair = withMorphs(without('まばたき'));
  const bindings = profileBindings(pair, false);
  assert.equal(pair.morphs.blink.index, -1);
  assert.equal(bindings.blink, profileMorphIndex(pair, 'ウィンク')); assert.equal(bindings.blinkPartner, profileMorphIndex(pair, 'ウィンク右'));
  const mesh = toThreeMesh(toyModel({ morphs: without('まばたき') }));
  const stage = new StageModelProfile(mesh, { reviewed: false });
  const influences = mesh.morphTargetInfluences!, layers: { index: number; value: number }[] = [];
  writeProfiledMorph(influences, layers, stage, stage.indices.blink, 0.8);
  assert.equal(influences[bindings.blink], 0.8); assert.equal(influences[bindings.blinkPartner], 0.8);
  assert.deepEqual(stage.linkedMorphs, [bindings.blinkPartner], 'the second eyelid stays out of the continuity guard');
  mesh.geometry.dispose();
});

test('huge and tiny mouth morphs open to a similar visible amount', () => {
  const visible = (amount: number, lip: number) => {
    const profile = withMorphs([{ name: 'あ', region: 'mouth', amount }, ...without('あ')]);
    const entry = profile.morphs.a, scales = new Map(profileBindings(profile, false).scales);
    return { shown: calibratedWeight(scales, entry.index, lip) * entry.amplitude, raw: Math.min(1, lip) * entry.amplitude, scale: entry.scale };
  };
  for (const lip of [0.23, 0.45, 0.68]) {
    const normal = visible(0.38, lip), huge = visible(0.38 * 3, lip), tiny = visible(0.38 / 1.4, lip);
    assert.ok(Math.abs(huge.raw / normal.raw - 3) < 0.01, 'without calibration the huge mouth opens three times as far');
    assert.ok(Math.abs(huge.shown / normal.shown - 1) < 0.02, `calibrated huge/normal ${huge.shown / normal.shown}`);
    assert.ok(Math.abs(tiny.shown / normal.shown - 1) < 0.02, `calibrated tiny/normal ${tiny.shown / normal.shown}`);
  }
  // A morph too small to reach Gene's opening saturates at its own 1.0, never beyond.
  const minute = withMorphs([{ name: 'あ', region: 'mouth', amount: 0.38 / 10 }, ...without('あ')]);
  const scales = new Map(profileBindings(minute, false).scales);
  assert.equal(minute.morphs.a.scale, 4);
  assert.equal(calibratedWeight(scales, minute.morphs.a.index, 0.68), 1);
  assert.equal(calibratedWeight(scales, minute.morphs.a.index, 0.1), 0.4);
});

test('rest pose: T-pose arms are horizontal, the toy A-pose matches Gene', () => {
  const t = buildModelProfile(profileInput(toyModel({ pose: 'T' }))).proportions;
  assert.equal(t.restPose, 'T'); assert.ok(Math.abs(t.restArmDeg!) < 0.5);
  const a = buildModelProfile(profileInput(toyModel())).proportions;
  assert.equal(a.restPose, 'A'); assert.ok(Math.abs(a.restArmDeg! - geneProfile.proportions.restArmDeg!) < 1);
  assert.ok(a.armLength! > 4 && a.shoulderWidth! > 2 && a.legLength! > 8);
  const scaled = buildModelProfile(profileInput(toyModel({ scale: 0.08 })));
  assert.ok(Math.abs(scaled.morphs.a.scale - buildModelProfile(profileInput(toyModel())).morphs.a.scale) < 1e-4, 'calibration ignores model units');
});

test('missing eye bones: an eye-closing morph locates the eyes, and the crown pat starts above them', () => {
  const data = toyModel({ eyeBones: false }), profile = buildModelProfile(profileInput(data));
  assert.equal(profile.proportions.eyeLineSource, 'morph'); assert.equal(profile.proportions.eyes?.source, 'morph');
  assert.ok(Math.abs(profile.proportions.eyeLineY - 17.95) < 0.02);
  assert.ok(Math.abs(profile.proportions.eyes!.left[0] - 0.45) < 0.05 && Math.abs(profile.proportions.eyes!.right[0] + 0.45) < 0.05);
  assert.ok(MORPH_SLOTS.every(slot => slot === 'mouthPucker' || profile.morphs[slot].index >= 0), 'all slots still validate against the measured eye line');
  const mesh = toThreeMesh(data), stage = new StageModelProfile(mesh, { reviewed: false }), head = stage.bone('head')!;
  stage.attachHead(head);
  assert.equal(stage.contactEyes.length, 2);
  const fallback = probeHeadContact(mesh, head, [], 20, stage.contactEyes), estimate = probeHeadContact(mesh, head, [], 20);
  assert.equal(estimate.source, 'head-estimate');
  assert.equal(fallback.source, 'profile-eyes');
  const eyeLocal = stage.contactEyes[0].y, bottom = fallback.center.y - fallback.halfHeight, top = fallback.center.y + fallback.halfHeight;
  assert.ok(bottom > eyeLocal + 0.5, `pat region starts above the brows (${bottom} vs eyes ${eyeLocal})`);
  assert.ok(top > 2 && top < 2.6, `reaches the measured crown (${top})`);
  mesh.geometry.dispose();
});

test('a decoy "あ" that moves eyebrows is rejected; the real mouth morph drives lip-sync', () => {
  const profile = withMorphs([{ name: 'あ', region: 'brows', amount: 0.3 }, { name: 'mouth_a', region: 'mouth', amount: 0.38 },
    { name: 'まばたき', region: 'body', amount: 0.3 }, { name: 'blink', region: 'eyes', amount: 0.31 }, ...without('あ', 'まばたき')]);
  assert.equal(profile.morphs.a.name, 'mouth_a');
  assert.equal(profile.morphs.a.rejected[0].name, 'あ'); assert.match(profile.morphs.a.rejected[0].reason, /not at the mouth/);
  assert.equal(profile.morphs.blink.name, 'blink'); assert.match(profile.morphs.blink.rejected[0].reason, /outside the head/);
  const dictionary = { あ: 0, mouth_a: 1, まばたき: 2, blink: 3 };
  assert.equal(legacyMorphIndices(dictionary).mouth, 0, 'the old name lookup flapped the eyebrows while speaking');
  assert.equal(profileBindings(profile, false).mouth, 1);
  const empty = buildModelProfile({ ...profileInput(toyModel()), morphs: [{ name: 'あ', offsets: () => null }] });
  assert.equal(empty.morphs.a.index, -1); assert.equal(empty.morphs.a.rejected[0].reason, 'moves no vertices');
});

test('a cached profile is reused only for the same model content and this algorithm version', () => {
  const data = toyModel(), mesh = toThreeMesh(data), computed = new StageModelProfile(mesh, { reviewed: false });
  assert.equal(computed.fresh, true);
  const stored = validateStoredModelProfile(JSON.parse(JSON.stringify(computed.profile)));
  const model = { vertices: data.positions.length / 3, bones: data.bones.map(bone => bone.name), morphs: data.morphs.map(morph => morph.name) };
  assert.deepEqual(acceptCachedProfile(stored, model), computed.profile);
  const cached = new StageModelProfile(mesh, { reviewed: false, cached: stored });
  assert.equal(cached.source, 'cache'); assert.equal(cached.fresh, false); assert.deepEqual(cached.indices, computed.indices);
  assert.equal(acceptCachedProfile({ ...stored, version: stored.version + 1 }, model), null);
  assert.equal(acceptCachedProfile({ ...stored, version: 1 }, model), null, 'profiles from before the collision proxy are recomputed');
  assert.equal(acceptCachedProfile(stored, { ...model, morphs: model.morphs.map((name, i) => i === stored.morphs.a.index ? 'renamed' : name) }), null);
  assert.equal(acceptCachedProfile(stored, { ...model, vertices: model.vertices + 1 }), null);
  const tampered = JSON.parse(JSON.stringify(stored)); tampered.morphs.a.scale = 40;
  assert.equal(acceptCachedProfile(tampered, model), null);
  assert.equal(new StageModelProfile(mesh, { reviewed: false, cached: tampered }).source, 'computed');
  assert.throws(() => validateStoredModelProfile({ version: 1 }));
  assert.throws(() => validateStoredModelProfile({ ...stored, huge: 'x'.repeat(70_000) }));
  mesh.geometry.dispose();
});

test('without eye bones or a mouth bone, cheek pinch and blush still get measured face points', () => {
  const data = toyModel({ eyeBones: false }), mesh = toThreeMesh(data), stage = new StageModelProfile(mesh, { reviewed: false });
  const head = stage.bone('head')!; stage.attachHead(head);
  assert.ok(stage.mouthLocal && Math.abs(stage.mouthLocal.y - (17.15 - 17.3)) < 0.03);
  const camera = new PerspectiveCamera(30, 400 / 560, 0.1, 100); camera.position.set(0, 17.6, 12); camera.lookAt(0, 17.6, 0); camera.updateMatrixWorld(true);
  const regions = projectCheekRegions(stage.cheekAnchors, head, camera, 400, 560, 60);
  assert.deepEqual(regions.map(region => region.side), ['left', 'right']);
  assert.deepEqual(projectCheekRegions(null, head, camera, 400, 560, 60), [], 'before: no blush anchors meant no pinch region');
  const reviewed = new StageModelProfile(mesh, { reviewed: true }); reviewed.attachHead(head);
  assert.equal(reviewed.cheekAnchors, null); assert.equal(reviewed.mouthLocal, null);
  mesh.geometry.dispose();

  // Blush probe: a measured head-local mouth replaces the ratio estimate when no mouth bone exists.
  const face = blushFace();
  const estimated = probeBlushAnchors(face.mesh, face.head, face.eyes);
  const measured = probeBlushAnchors(face.mesh, face.head, face.eyes, undefined, {}, new Vector3(0, 0.1, 1));
  const boned = probeBlushAnchors(face.mesh, face.head, face.eyes, face.mouth);
  assert.equal(estimated.anchors?.mouthEstimated, true);
  assert.equal(measured.anchors?.mouthEstimated, false, measured.reason);
  assert.deepEqual(measured.anchors, boned.anchors, 'a measured mouth at the bone position places the blush exactly like the bone');
  assert.match(measured.reason, /模型档案/);
  assert.deepEqual(probeBlushAnchors(face.mesh, face.head, face.eyes, face.mouth, {}, new Vector3(0, -3, 1)).anchors, boned.anchors, 'a real mouth bone stays authoritative');
});

/** Same flat face as tests/procedural-blush.test.ts, with a stand-in shader carrying the chunks the probe requires. */
function blushFace() {
  const positions: number[] = [], normals: number[] = [];
  for (let row = 0; row < 32; row++) for (let column = 0; column < 42; column++) {
    const x = column / 41 * 2.5 - 1.25, y = row / 31 * 1.9 - 0.5;
    positions.push(x, y, 1 - x * x * 0.08 - (y - 0.5) ** 2 * 0.03);
    normals.push(...new Vector3(x * 0.16, (y - 0.5) * 0.06, 1).normalize().toArray());
  }
  const mesh = toThreeMesh({ positions: Float32Array.from(positions), skinBone: new Int32Array(positions.length / 3), bones: [
    { name: '頭', parent: -1, position: [0, 0, 0], ik: false }, { name: '左目', parent: 0, position: [-0.5, 1, 1.1], ik: false },
    { name: '右目', parent: 0, position: [0.5, 1, 1.1], ik: false }, { name: '口', parent: 0, position: [0, 0.1, 1], ik: false }], morphs: [] });
  mesh.geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  mesh.geometry.addGroup(0, positions.length / 3, 0);
  mesh.material = new ShaderMaterial({ name: 'face-skin',
    vertexShader: '#include <common>\n#include <skinning_vertex>\n#include <displacementmap_vertex>\nvoid main() {}',
    fragmentShader: '#include <common>\nvarying vec3 vViewPosition;\n#include <normal_fragment_maps>\n#include <map_fragment>\nvoid main() {}' });
  const bones = (mesh as SkinnedMesh).skeleton.bones as Bone[];
  return { mesh, head: bones[0], eyes: [bones[1], bones[2]], mouth: bones[3] };
}
