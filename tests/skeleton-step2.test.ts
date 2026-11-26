/**
 * Universal skeleton, step 2 (docs/claude/2026-11-06-universal-skeleton-plan.md, docs/claude/2026-11-06-skeleton-step2.md):
 *  - 嘟嘴 (mouthPucker) is a standard face slot like the other 16: found by name and aliases, kept only when the lips really
 *    move forward and draw in (a name that moves nothing, or moves the lips another way, does not count);
 *  - without it, 撅嘴 is built from the model's own "う" (lighter) and mouth corners; without the left eye's own wink, 眨一只眼
 *    uses the right eye. The card and the stage get this from the one rule (shared/foundation/face-morphs.ts resolveFaceMorphs) and say
 *    the same: "近似", and what it is built from. Neither there: cannot, and what is missing.
 *  - the approximated pout is still a mouth shape: speech takes the mouth back from it, smoothly (T-215);
 *  - Gene, which has its own shapes, is unchanged: the same writes, the same tracks, frame for frame.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL_PROFILE_VERSION, acceptCachedProfile, buildModelProfile } from '../shared/stage/model-profile';
import { HER_ACTION_SPECS, herActionSupport, type HerActionId } from '../shared/actions/her-actions';
import { missingNeeds } from '../shared/stage/model-capability-check';
import * as skeleton from '../shared/foundation/universal-skeleton';
import { FaceExclusive, resolveFaceMorphs } from '../src/stage/face-exclusive';
import { readGene } from './helpers/bundled-motions';
import { JAPANESE_MORPHS, profileInput, toThreeMesh, toyModel, type ModelData, type ToyMorph } from './helpers/model-fixtures';

/** Lips forward (+z, the face's front) and in toward the midline: a real pucker on the toy face. */
const PUCKER: ToyMorph = { name: 'mouthPucker', region: 'mouth', amount: 0.2, offset: (x: number) => [-x * 3, 0, 0.15] };
const CORNERS: ToyMorph = { name: '口角下げ', region: 'mouth', amount: 0.05 };
const without = (morphs: readonly ToyMorph[], ...names: string[]) => morphs.filter(morph => !names.includes(morph.name));

/** The stage's own lookup (MmdStage.playFaceAction): the mesh's names, the profile's slots, real vertex movement. */
function stageResolve(data: ModelData, id: HerActionId) {
  const mesh = toThreeMesh(data), profile = buildModelProfile(profileInput(data)), face = new FaceExclusive(mesh);
  return { mesh, ...resolveFaceMorphs(HER_ACTION_SPECS[id].face!, { names: mesh.morphTargetDictionary, count: mesh.morphTargetInfluences?.length ?? 0,
    slot: slot => profile.morphs[slot]?.index ?? -1, displaces: index => face.displaced(index).length > 0 }) };
}

// ---------------------------------------------------------------- the slot: name, then where the lips really move

test('嘟嘴 is a standard face slot: found by name, kept only when the lips move forward and draw in', () => {
  assert.ok((skeleton.MORPH_SLOTS as readonly string[]).includes('mouthPucker'));
  assert.equal(skeleton.isNamedFaceShape('mouthPucker'), false, 'a slot now, not a name-only shape');
  const good = buildModelProfile(profileInput(toyModel({ morphs: [...JAPANESE_MORPHS, PUCKER] })));
  assert.equal(good.morphs.mouthPucker.name, 'mouthPucker');
  assert.deepEqual(good.morphs.mouthPucker.rejected, []);
  // An alias (Japanese) is found the same way.
  const alias = buildModelProfile(profileInput(toyModel({ morphs: [...JAPANESE_MORPHS, { ...PUCKER, name: '口すぼめ' }] })));
  assert.equal(alias.morphs.mouthPucker.name, '口すぼめ');
  // There by name but moves nothing: not there.
  const still = buildModelProfile(profileInput(toyModel({ morphs: [...JAPANESE_MORPHS, { ...PUCKER, amount: 0, offset: undefined }] })));
  assert.equal(still.morphs.mouthPucker.index, -1);
  assert.equal(still.morphs.mouthPucker.rejected[0]?.reason, 'moves no vertices');
  // There by name, moves the mouth, but the lips go down, not forward and in: not there either.
  const wrong = buildModelProfile(profileInput(toyModel({ morphs: [...JAPANESE_MORPHS, { name: 'mouthPucker', region: 'mouth', amount: 0.2 }] })));
  assert.equal(wrong.morphs.mouthPucker.index, -1);
  assert.match(wrong.morphs.mouthPucker.rejected[0]?.reason ?? '', /forward/);
  // Forward but spreading out (a cheek-puff-like push): not a pucker.
  const spread = buildModelProfile(profileInput(toyModel({ morphs: [...JAPANESE_MORPHS, { ...PUCKER, offset: (x: number) => [x * 3, 0, 0.15] }] })));
  assert.equal(spread.morphs.mouthPucker.index, -1);
  assert.match(spread.morphs.mouthPucker.rejected[0]?.reason ?? '', /draw in/);
});

test('Gene: its own mouthPucker passes the lip check (no rejection), so its pout is not approximated', () => {
  const gene = readGene(), profile = buildModelProfile(profileInput(gene));
  assert.equal(profile.morphs.mouthPucker.name, 'mouthPucker');
  assert.equal(gene.morphs[profile.morphs.mouthPucker.index].name, 'mouthPucker');
  assert.deepEqual(profile.morphs.mouthPucker.rejected, []);
  assert.equal(profile.morphs.mouthPucker.scale, 1, 'no reference amount: written as the clip says');
});

test('haiku is not asked about 嘟嘴 (the user has not agreed to that quota): the entry point is there, empty', () => {
  const bare = buildModelProfile(profileInput(toyModel({ morphs: [] })));
  assert.equal(bare.morphs.mouthPucker.index, -1);
  assert.ok(!missingNeeds(bare).morphs.includes('mouthPucker'));
  assert.ok(missingNeeds(bare).morphs.length > 0, 'the capabilities still ask for theirs');
});

test('profile version 6: 嘟嘴 moved to the slots, mouth corners joined the named shapes; a version 5 profile is computed again', () => {
  assert.equal(MODEL_PROFILE_VERSION, 6);
  const data = readGene(), profile = buildModelProfile(profileInput(data));
  assert.deepEqual(Object.keys(profile.faceShapes).sort(), [...skeleton.NAMED_FACE_SHAPE_IDS].sort());
  assert.ok(!('mouthPucker' in profile.faceShapes));
  assert.equal(data.morphs[profile.faceShapes.mouthCornersDown!.index].name, '∧', 'Gene\'s corners-down shape by its MMD name');
  const identity = { vertices: data.positions.length / 3, bones: data.bones.map(bone => bone.name), morphs: data.morphs.map(morph => morph.name) };
  const plain = JSON.parse(JSON.stringify(profile));
  assert.ok(acceptCachedProfile(plain, identity));
  assert.equal(acceptCachedProfile({ ...plain, version: 5 }, identity), null);
  const { mouthPucker: _gone, ...slots } = plain.morphs;
  assert.equal(acceptCachedProfile({ ...plain, morphs: slots }, identity), null, 'a profile without the slot is not taken');
});

test('撅嘴 without 嘟嘴 but with mouth corners: "う" plus the corners; with the ARKit frowns the corners are those, nothing added', () => {
  const data = toyModel({ morphs: [...JAPANESE_MORPHS, CORNERS] });
  const support = herActionSupport(buildModelProfile(profileInput(data)));
  assert.deepEqual(support.pout.approximate, [{ part: '嘟嘴的表情（mouthPucker）', using: ['口型“う”', '嘴角下压的表情'], lighter: true }]);
  const stage = stageResolve(data, 'pout'), names = stage.mesh.morphTargetDictionary!;
  assert.deepEqual(stage.approximations, support.pout.approximate);
  assert.deepEqual(stage.writes.map(write => [write.from, write.index]), [['う', names['う']], ['mouthPucker', names['う']], ['mouthFrownLeft', names['口角下げ']]]);
  // A model with its own frowns (left and right) keeps them: they already write the corners; nothing more is added.
  const frowns = toyModel({ morphs: [...JAPANESE_MORPHS, CORNERS, { name: 'mouthFrownLeft', region: 'mouth', amount: 0.04 }, { name: 'mouthFrownRight', region: 'mouth', amount: 0.04 }] });
  const both = stageResolve(frowns, 'pout'), n = both.mesh.morphTargetDictionary!;
  assert.deepEqual(both.writes.map(write => [write.from, write.index]),
    [['う', n['う']], ['mouthFrownLeft', n.mouthFrownLeft], ['mouthFrownRight', n.mouthFrownRight], ['mouthPucker', n['う']]]);
  assert.deepEqual(both.approximations, [{ part: '嘟嘴的表情（mouthPucker）', using: ['口型“う”', '嘴角下压的表情'], lighter: true }]);
  assert.deepEqual(herActionSupport(buildModelProfile(profileInput(frowns))).pout.approximate, both.approximations);
});

test('a "嘟嘴" that is there by name but does not move the lips forward and in does not count: approximated, as if missing', () => {
  for (const pucker of [{ ...PUCKER, amount: 0, offset: undefined }, { name: 'mouthPucker', region: 'mouth', amount: 0.2 } as ToyMorph]) {
    const data = toyModel({ morphs: [...JAPANESE_MORPHS, pucker] });
    const support = herActionSupport(buildModelProfile(profileInput(data))), stage = stageResolve(data, 'pout');
    assert.deepEqual(support.pout.approximate?.[0]?.using, ['口型“う”']);
    assert.ok(!stage.writes.some(write => write.index === stage.mesh.morphTargetDictionary!.mouthPucker), 'the decoy is never written');
    assert.deepEqual(stage.approximations, support.pout.approximate);
  }
  // A real one: no approximation, the model's own.
  const real = toyModel({ morphs: [...JAPANESE_MORPHS, PUCKER] });
  const support = herActionSupport(buildModelProfile(profileInput(real))), stage = stageResolve(real, 'pout');
  assert.deepEqual(support.pout, { id: 'pout', ok: true, missing: [] });
  assert.deepEqual(stage.approximations, []);
  assert.ok(stage.writes.some(write => write.from === 'mouthPucker' && write.index === stage.mesh.morphTargetDictionary!.mouthPucker && write.gain === 1));
});

// ---------------------------------------------------------------- the real stage: a Gene whose pucker has another name

const RENAMED = { mouthPucker: 'lips_unknown' } as const;
