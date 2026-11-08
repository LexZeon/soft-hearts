/**
 * Universal skeleton, step 2 (docs/claude/2026-11-06-universal-skeleton-plan.md, docs/claude/2026-11-06-skeleton-step2.md):
 *  - 嘟嘴 (mouthPucker) is a standard face slot like the other 16: found by name and aliases, kept only when the lips really
 *    move forward and draw in (a name that moves nothing, or moves the lips another way, does not count);
 *  - without it, 撅嘴 is built from the model's own "う" (lighter) and mouth corners; without the left eye's own wink, 眨一只眼
 *    uses the right eye. The card and the stage get this from the one rule (shared/face-morphs.ts resolveFaceMorphs) and say
 *    the same: "近似", and what it is built from. Neither there: cannot, and what is missing.
 *  - the approximated pout is still a mouth shape: speech takes the mouth back from it, smoothly (T-215);
 *  - Gene, which has its own shapes, is unchanged: the same writes, the same tracks, frame for frame.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL_PROFILE_VERSION, acceptCachedProfile, buildModelProfile } from '../shared/model-profile';
import { HER_ACTION_DETAILS, HER_ACTION_SPECS, HER_FACE_ACTIONS, herActionSupport, type HerActionId } from '../shared/her-actions';
import { modelAdaptation } from '../shared/model-adaptation';
import { missingNeeds } from '../shared/model-capability-check';
import * as skeleton from '../shared/universal-skeleton';
import * as faceModule from '../src/stage/face-exclusive';
import { FaceExclusive, faceTracksByName, resolveFaceMorphs } from '../src/stage/face-exclusive';
import { adaptationLines } from '../src/ui/ModelCapabilityPanel';
import { readGene } from './helpers/bundled-motions';
import { stageOn } from './helpers/her-action-harness';
import { geneStage, type GeneStage } from './helpers/gene-stage-harness';
import { ENGLISH_MORPHS, JAPANESE_MORPHS, profileInput, toThreeMesh, toyModel, type ModelData, type ToyMorph } from './helpers/model-fixtures';

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

// ---------------------------------------------------------------- 撅嘴 without 嘟嘴

test('撅嘴 without 嘟嘴: the card says 近似 (built from "う"), and the stage really plays "う" for it', async () => {
  const data = toyModel(); // あ, う, both winks … no mouthPucker
  const support = herActionSupport(buildModelProfile(profileInput(data)));
  assert.deepEqual(support.pout, { id: 'pout', ok: true, missing: [], approximate: [{ part: '嘟嘴的表情（mouthPucker）', using: ['口型“う”'], lighter: true }] });
  const lines = adaptationLines(modelAdaptation(buildModelProfile(profileInput(data))));
  assert.ok(lines.includes('撅嘴是近似的：没有嘟嘴的表情（mouthPucker），用口型“う”拼的，会轻一点。'), lines.join('\n'));
  // The stage's lookup: the same answer, from the mesh itself.
  const stage = stageResolve(data, 'pout'), u = stage.mesh.morphTargetDictionary!['う'];
  assert.deepEqual(stage.missing, []);
  assert.deepEqual(stage.approximations, support.pout.approximate);
  assert.deepEqual(stage.writes.map(write => [write.from, write.index]), [['う', u], ['mouthPucker', u]]);
  assert.ok(stage.writes[1].gain > 0.4 && stage.writes[1].gain < 0.9, 'lighter than the real pucker');
  // The stage plays it: "う" is what the lease writes, and it says it was an approximation.
  const h = await stageOn(data);
  h.stage.faceExclusive = new FaceExclusive(h.mesh);
  try {
    const report = await h.play('pout');
    assert.deepEqual({ status: report.status, missing: report.missing, detail: report.detail }, { status: 'played', missing: [], detail: HER_ACTION_DETAILS.approximate });
    const lease = h.stage.faceExclusive.getState().mouth;
    assert.deepEqual([...new Set(lease.targets)], [u]);
    // Its peak "う": the clip's pucker (0.9) times the gain, above the clip's own う (0.42), never the full pucker.
    const influences = h.mesh.morphTargetInfluences!, layers: { index: number; value: number }[] = [];
    let peak = 0;
    for (let i = 0; i < 150; i++) {
      for (const layer of layers.splice(0)) influences[layer.index] = layer.value;
      h.stage.faceExclusive.frame(1 / 60, { key: lease ? h.stage.faceScopeKey() : '' }, influences, layers);
      peak = Math.max(peak, influences[u]);
    }
    assert.ok(Math.abs(peak - 0.9 * stage.writes[1].gain) < 0.01, `peak う ${peak}`);
  } finally { h.close(); }
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

// ---------------------------------------------------------------- 眨一只眼 with only the right eye

test('眨一只眼 with only the right eye\'s own wink: the card says 近似 (the right eye), the stage closes the right eye', async () => {
  for (const [names, morphs, right] of [['japanese', without(JAPANESE_MORPHS, 'ウィンク'), 'ウィンク右'], ['english', without(ENGLISH_MORPHS, 'Blink_L'), 'Blink_R']] as const) {
    const data = toyModel({ names, morphs: [...morphs] });
    const profile = buildModelProfile(profileInput(data));
    assert.equal(profile.morphs.blinkLeft.index, -1, `${names}: no left wink`);
    const support = herActionSupport(profile);
    assert.deepEqual(support.wink, { id: 'wink', ok: true, missing: [], approximate: [{ part: '单眼闭眼的表情（ウィンク）', using: ['右眼单独闭的表情（ウィンク右）'], lighter: false }] });
    assert.ok(adaptationLines(modelAdaptation(profile)).includes('眨一只眼是近似的：没有单眼闭眼的表情（ウィンク），用右眼单独闭的表情（ウィンク右）代替。'));
    const stage = stageResolve(data, 'wink');
    assert.deepEqual(stage.approximations, support.wink.approximate);
    assert.deepEqual(stage.writes, [{ from: 'ウィンク', index: stage.mesh.morphTargetDictionary![right], gain: 1 }]);
    const h = await stageOn(data);
    h.stage.faceExclusive = new FaceExclusive(h.mesh);
    try {
      const report = await h.play('wink');
      assert.deepEqual({ status: report.status, detail: report.detail }, { status: 'played', detail: HER_ACTION_DETAILS.approximate }, names);
      assert.deepEqual(h.stage.faceExclusive.getState().eyelids.targets, [h.mesh.morphTargetDictionary![right]], `${names}: the right eye`);
    } finally { h.close(); }
  }
});

// ---------------------------------------------------------------- neither: cannot, and says what is missing

test('neither the shape nor what it could be built from: cannot, naming both, on the card and the stage', async () => {
  const data = toyModel({ morphs: without(JAPANESE_MORPHS, 'う', 'ウィンク', 'ウィンク右') });
  const support = herActionSupport(buildModelProfile(profileInput(data)));
  assert.deepEqual(support.pout, { id: 'pout', ok: false, missing: ['嘟嘴的表情（mouthPucker）', '口型“う”'] });
  assert.deepEqual(support.wink, { id: 'wink', ok: false, missing: ['单眼闭眼的表情（ウィンク）', '右眼单独闭的表情（ウィンク右）'] });
  for (const id of ['pout', 'wink'] as const) assert.deepEqual(stageResolve(data, id).missing, support[id].missing, id);
  const h = await stageOn(data);
  h.stage.faceExclusive = new FaceExclusive(h.mesh);
  try {
    assert.deepEqual((await h.play('pout')).missing, ['嘟嘴的表情（mouthPucker）', '口型“う”']);
    assert.deepEqual((await h.play('wink')).missing, ['单眼闭眼的表情（ウィンク）', '右眼单独闭的表情（ウィンク右）']);
    assert.equal(h.stage.faceExclusive.owned(), null, 'nothing written');
  } finally { h.close(); }
});

// ---------------------------------------------------------------- Gene: unchanged

test('Gene: every face action resolves to its own morphs exactly as before (no approximation), and the tracks are the same arrays', async () => {
  const gene = readGene(), profile = buildModelProfile(profileInput(gene)), support = herActionSupport(profile);
  const mesh = toThreeMesh(gene), face = new FaceExclusive(mesh);
  const { readFile } = await import('node:fs/promises');
  const { catalogMotionFile } = await import('./helpers/gene-stage-harness');
  const { MMDLoader } = await import('three/examples/jsm/loaders/MMDLoader.js');
  const parser = (MMDLoader.prototype as unknown as { _getParser(): { parseVmd(buffer: ArrayBuffer, leftToRight: boolean): { morphs: { morphName: string; frameNum: number; weight: number }[] } } })._getParser.call(new MMDLoader());
  for (const id of HER_FACE_ACTIONS) {
    assert.deepEqual(support[id], { id, ok: true, missing: [] }, id);
    const resolved = resolveFaceMorphs(HER_ACTION_SPECS[id].face!, { names: mesh.morphTargetDictionary, count: mesh.morphTargetInfluences!.length,
      slot: slot => profile.morphs[slot]?.index ?? -1, displaces: index => face.displaced(index).length > 0 });
    assert.deepEqual(resolved.approximations, [], id);
    // Exactly the T-215 binding: each of the clip's morphs on Gene's own morph of that name, written as the clip says.
    assert.deepEqual(resolved.writes, HER_ACTION_SPECS[id].face!.morphs.map(morph => ({ from: morph.track, index: mesh.morphTargetDictionary![morph.track], gain: 1 })), id);
    assert.deepEqual([...resolved.indices], resolved.writes.map(write => [write.from, write.index]), id);
    // The tracks the stage hands the face exclusive are what it built before (the same key arrays, in the same order).
    const bytes = await readFile(catalogMotionFile('soft-hearts-actions', id));
    const keys = faceTracksByName(parser.parseVmd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, true).morphs);
    const before: { index: number; times: number[]; values: number[] }[] = [];
    for (const [name, index] of resolved.indices) { const track = keys.get(name); if (track) before.push({ index, ...track }); }
    const after = faceModule.faceWriteTracks(resolved.writes, keys);
    assert.equal(after.length, before.length, id);
    after.forEach((track, k) => { assert.equal(track.index, before[k].index); assert.equal(track.times, before[k].times); assert.equal(track.values, before[k].values); });
  }
});

// ---------------------------------------------------------------- the real stage: a Gene whose pucker has another name

const RENAMED = { mouthPucker: 'lips_unknown' } as const;
async function puckerless(fps: number): Promise<{ a: GeneStage; b: GeneStage; close(): void }> {
  const a = await geneStage({ herActions: true, fps, recordAll: true, renameMorphs: RENAMED });
  const b = await geneStage({ herActions: true, fps, recordAll: true, renameMorphs: RENAMED });
  return { a, b, close: () => { b.close(); a.close(); } };
}
function lockstep(a: GeneStage, b: GeneStage, seconds: number) { for (let i = 0, n = Math.round(seconds * a.rate); i < n; i++) { a.tick(); b.tick(); } }

for (const fps of [60, 30]) {
  test(`a Gene whose pucker is not recognised (${fps} fps): the pout is "う" plus her own corners, lighter, smooth, the guard has nothing, then back to idle`, async t => {
    const { a, b, close } = await puckerless(fps);
    try {
      assert.equal(a.stage.modelProfile.profile.morphs.mouthPucker.index, -1, 'the renamed shape is not found by name');
      lockstep(a, b, 0.7);
      const start = a.shown.length, jumps = a.shown.at(-1)!.guardJumps;
      const report = await a.playAction('pout');
      assert.deepEqual(report && { status: report.status, detail: report.detail }, { status: 'played', detail: HER_ACTION_DETAILS.approximate });
      const u = a.mesh.morphTargetDictionary!['う'], frownL = a.mesh.morphTargetDictionary!.mouthFrownLeft, lips = a.mesh.morphTargetDictionary!.lips_unknown;
      assert.deepEqual([...new Set<number>(a.stage.faceExclusive.getState().mouth.targets)].sort((x, y) => x - y),
        [u, a.mesh.morphTargetDictionary!.mouthFrownLeft, a.mesh.morphTargetDictionary!.mouthFrownRight].sort((x, y) => x - y));
      lockstep(a, b, HER_ACTION_SPECS.pout.durationFrames / 30 + 0.6);
      const frames = a.shown.slice(start - 1), idle = b.shown.slice(start - 1);
      const peakU = Math.max(...frames.map(frame => frame.all![u])), peakFrown = Math.max(...frames.map(frame => frame.all![frownL]));
      const peakLips = Math.max(...frames.map(frame => frame.all![lips]));
      let step = 0;
      const group: number[] = a.stage.faceExclusive.conflictGroup([u, frownL]);
      for (let k = 1; k < frames.length; k++) for (const i of group) step = Math.max(step, Math.abs(frames[k].all![i] - frames[k - 1].all![i]));
      let apart = 0;
      for (const frame of a.shown.slice(-4)) { const other = b.shown[a.shown.indexOf(frame)]; for (let i = 0; i < frame.all!.length; i++) apart = Math.max(apart, Math.abs(frame.all![i] - other.all![i])); }
      // The stage that never made the shape, over the same frames: how much the group moves anyway (life, blinks).
      let idleStep = 0;
      for (let k = 1; k < idle.length; k++) for (const i of group) idleStep = Math.max(idleStep, Math.abs(idle[k].all![i] - idle[k - 1].all![i]));
      t.diagnostic(`${fps} fps: peak う ${peakU.toFixed(3)}, corners ${peakFrown.toFixed(3)}, renamed pucker ${peakLips}, largest group step ${step.toFixed(4)} (idle stage ${idleStep.toFixed(4)}), guard ${a.shown.at(-1)!.guardJumps - jumps}, afterwards ${apart.toExponential(2)} from idle`);
      assert.ok(peakU > 0.5 && peakU < 0.6, `う shows, lighter than the real pucker (${peakU})`);
      assert.ok(Math.abs(peakFrown - 0.35) < 0.02, `her own corners as the clip says (${peakFrown})`);
      assert.equal(peakLips, 0, 'the unrecognised shape is never written');
      assert.ok(step < (fps === 60 ? 0.06 : 0.12), `smooth (${step})`);
      assert.equal(a.shown.at(-1)!.guardJumps, jumps, `nothing for the guard (${a.shown.at(-1)!.guardLast})`);
      assert.ok(apart < 1e-9, `afterwards exactly the idle stage (${apart})`);
    } finally { close(); }
  });
}

test('the approximated pout is a mouth shape: speech takes the mouth back from the prepare signal, smoothly, onto the live lip-sync', async t => {
  const { a, b, close } = await puckerless(60);
  try {
    lockstep(a, b, 0.7);
    assert.equal((await a.playAction('pout'))?.status, 'played');
    lockstep(a, b, 0.6);
    const start = a.shown.length, jumps = a.shown.at(-1)!.guardJumps;
    for (const h of [a, b]) h.stage.setSpeechPreparing(true);
    assert.equal(a.stage.faceExclusive.getState().mouth.phase, 'releasing', 'handing back from the prepare signal');
    lockstep(a, b, 0.3);
    for (const h of [a, b]) h.stage.setSpeaking(true);
    lockstep(a, b, 0.8);
    assert.equal(a.stage.faceExclusive.getState().ended?.reason, 'speech');
    const refused = await a.playAction('pout');
    assert.equal(refused?.status, 'busy'); assert.match(refused!.detail, /说话/u);
    const u = a.mesh.morphTargetDictionary!['う'], group: number[] = a.stage.faceExclusive.conflictGroup([u]);
    let step = 0, apart = 0;
    for (let k = start; k < a.shown.length; k++) for (const i of group) step = Math.max(step, Math.abs(a.shown[k].all![i] - a.shown[k - 1].all![i]));
    for (let k = start + 17; k < a.shown.length; k++) for (let i = 0; i < a.shown[k].all!.length; i++) apart = Math.max(apart, Math.abs(a.shown[k].all![i] - b.shown[k].all![i]));
    t.diagnostic(`hand-back: largest group step ${step.toFixed(4)}, afterwards ${apart.toExponential(2)} from the stage that never made the shape`);
    assert.ok(step < 0.12, `${step}`);
    assert.equal(a.shown.at(-1)!.guardJumps, jumps);
    assert.ok(apart < 1e-9, `exactly the live lip-sync after the hand-back (${apart})`);
    for (const h of [a, b]) { h.stage.setSpeaking(false); h.stage.setSpeechPreparing(false); }
  } finally { close(); }
});
