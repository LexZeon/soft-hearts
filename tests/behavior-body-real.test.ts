import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { MeshBasicMaterial, type AnimationAction, type AnimationClip, type AnimationMixer, type KeyframeTrack, type Quaternion, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { BehaviorBodyPlayer, isBehaviorBodyTrack, type BehaviorBodyMaskId } from '../src/stage/behavior-body';
import { LayeredMmdAnimation } from '../src/stage/motion-layers';
import { createVmdParser } from '../src/stage/vmd';

const cases = [
  { packId: 'gene', motionId: 'convinced', maskId: 'candidate-head-v1', overlap: 2,
    sha256: '10e9afe2685408850935acbf5f54210098896a530c274ebf4f88a0e31ce0ce82' },
  { packId: '100style-idles', motionId: 'neutral-idle', maskId: 'candidate-pose-v1', overlap: 30,
    sha256: '58887fab2e456bc9f5da21f275cc986a5fa8e96997b61b481e064ca3696002bb' },
  { packId: '100style-idles', motionId: 'proud-idle', maskId: 'candidate-pose-v1', overlap: 30,
    sha256: '811ae39e09565bf824baf4803f8467b2881f1b42088448a49e9cb2fde7403a05' },
] as const satisfies readonly { packId: string; motionId: string; maskId: BehaviorBodyMaskId; overlap: number; sha256: string }[];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const buffer = (bytes: Buffer): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const rotationDifference = (left: Quaternion, right: Quaternion) => left.clone().normalize().angleTo(right.clone().normalize());
function trackSnapshot(track: KeyframeTrack) {
  return { name: track.name, times: Array.from(track.times), values: Array.from(track.values), factory: track.createInterpolant };
}

/** Real public PMX/skeleton/animation builder and real helper IK/grant; inert CPU materials only. */
async function fixture() {
  const catalog = JSON.parse(await readFile('shared/motion-catalog.json', 'utf8'));
  const manifest = JSON.parse(await readFile('shared/bundled-assets.json', 'utf8'));
  const modelBytes = await readFile(join('assets/bundled', manifest.root, manifest.model.relativePath));
  assert.equal(sha(modelBytes), '0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37');
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js';
  const { MMDParser } = await import(parserModule);
  const data = new MMDParser.Parser().parsePmx(buffer(modelBytes), true);
  const loader = new MMDLoader() as any;
  loader.meshBuilder.materialBuilder.build = () => data.materials.map((value: { name: string }) => {
    const material = new MeshBasicMaterial(); material.name = value.name; return material;
  });
  const mesh = loader.meshBuilder.build(data, '') as SkinnedMesh;
  const animation = new LayeredMmdAnimation(mesh);
  const mixer = animation.helper.objects.get(mesh)!.mixer! as AnimationMixer & { _actions: AnimationAction[] };
  async function load(packId: string, motionId: string, expectedSha?: string) {
    const pack = catalog.packs.find((value: any) => value.id === packId);
    assert.ok(pack, packId);
    const entry = pack.motions.find((value: any) => value.id === motionId);
    assert.ok(entry, motionId);
    const bytes = await readFile(join('assets/bundled', pack.source, pack.id, pack.revision, entry.relativePath));
    assert.equal(sha(bytes), entry.sha256);
    if (expectedSha) assert.equal(sha(bytes), expectedSha);
    let frames = -1;
    const parser = createVmdParser(report => { frames = report.durationFrames; }) as { parseVmd(value: ArrayBuffer, convert: boolean): unknown };
    const clip = loader.animationBuilder.build(parser.parseVmd(buffer(bytes), true), mesh) as AnimationClip;
    assert.equal(frames, entry.durationFrames);
    clip.duration = Math.max(clip.duration, frames / 30);
    return clip;
  }
  function dispose() {
    animation.dispose(); mesh.geometry.dispose(); mesh.skeleton.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
  }
  return { mesh, animation, mixer, load, dispose };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function startStand(value: Fixture, withFace = false) {
  const stand = await value.load('gene', 'stand', '42080246b98aaa8a5b98d1ecd73994cf42b2587f9c04c3ed7435cf859fef83aa');
  const face = withFace ? await value.load('gene', 'happy', '8da8b93dfc2dba19535246126558f82238c915ff8a90b2d05dfba17a333f903e') : null;
  value.animation.setClips({ pose: stand, gesture: null, expression: face });
  const actions = [...value.mixer._actions];
  // The projection must follow the existing base phase/speed; it must not reset
  // it to its own 1x source clock. Identical reference helpers give an oracle.
  actions[0].setEffectiveTimeScale(0.75);
  if (actions[1]) actions[1].setEffectiveTimeScale(0.85);
  value.animation.helper.update(0.37);
  return { stand, face, actions };
}
function assertPoseEqual(left: SkinnedMesh, right: SkinnedMesh, context: string) {
  assert.equal(left.skeleton.bones.length, right.skeleton.bones.length);
  left.skeleton.bones.forEach((bone, index) => {
    const reference = right.skeleton.bones[index];
    assert.equal(bone.name, reference.name);
    assert.ok(bone.position.distanceTo(reference.position) < 1e-5, `${context}: ${bone.name} position`);
    assert.ok(rotationDifference(bone.quaternion, reference.quaternion) < 1e-5, `${context}: ${bone.name} rotation`);
  });
  const influences = left.morphTargetInfluences ?? [], reference = right.morphTargetInfluences ?? [];
  assert.equal(influences.length, reference.length);
  influences.forEach((value, index) => assert.ok(Math.abs(value - reference[index]) < 1e-7, `${context}: morph${index}`));
}
function assertUnaffectedFingersAndFace(left: SkinnedMesh, right: SkinnedMesh, context: string) {
  let fingers = 0;
  left.skeleton.bones.forEach((bone, index) => {
    if (!/(親指|人指|中指|薬指|小指)/.test(bone.name)) return;
    fingers++;
    const reference = right.skeleton.bones[index];
    assert.ok(bone.position.distanceTo(reference.position) < 1e-6, `${context}: ${bone.name} position`);
    assert.ok(rotationDifference(bone.quaternion, reference.quaternion) < 1e-6, `${context}: ${bone.name} rotation`);
  });
  assert.ok(fingers >= 20, 'The actual Gene finger properties are part of this reference check.');
  const influences = left.morphTargetInfluences ?? [], reference = right.morphTargetInfluences ?? [];
  assert.ok(influences.some(value => value > 0), 'The independent authored face must actually be active.');
  assert.equal(influences.length, reference.length);
  influences.forEach((value, index) => assert.ok(Math.abs(value - reference[index]) < 1e-7, `${context}: morph${index}`));
}

for (const candidate of cases) {
  test(`real Gene Stand rejects ${candidate.motionId} partial overlap without projection opt-in`, async () => {
    const value = await fixture();
    let player: BehaviorBodyPlayer | null = null;
    try {
      const { actions, stand } = await startStand(value);
      const source = await value.load(candidate.packId, candidate.motionId, candidate.sha256);
      const admitted = new Set(source.tracks.filter(track => isBehaviorBodyTrack(track.name, candidate.maskId)).map(track => track.name));
      const baseTracks = actions[0].getClip().tracks;
      assert.equal(stand.tracks.length, 84, 'Actual source inventory, not a cropped synthetic Stand.');
      assert.equal(baseTracks.filter(track => admitted.has(track.name)).length, candidate.overlap);
      assert.ok(baseTracks.some(track => !admitted.has(track.name) && /(親指|人指|中指|薬指|小指)/.test(track.name)));
      const before = actions.map(action => ({ action, time: action.time, timeScale: action.timeScale, weight: action.weight }));
      player = new BehaviorBodyPlayer(value.animation.getBehaviorBodyBindings());
      assert.equal(player.play({ id: `strict-${candidate.motionId}`, clip: source, maskId: candidate.maskId,
        durationMs: source.duration * 1_000, strength: 0.2 }), false);
      assert.equal(player.getState().reason, 'partial-base-overlap');
      assert.ok(player.getState().blockedBaseProperties.length > 0);
      assert.deepEqual(actions.map(action => ({ action, time: action.time, timeScale: action.timeScale, weight: action.weight })), before);
      assert.deepEqual(value.mixer._actions, actions, 'Rejected candidates create no temporary mixer Action.');
    } finally { player?.dispose(); value.dispose(); }
  });

  test(`real Gene Stand projects ${candidate.motionId} on its existing helper mixer and restores the continuing base`, async () => {
    const value = await fixture(), reference = await fixture();
    let player: BehaviorBodyPlayer | null = null;
    try {
      const setup = await startStand(value, true), originalActions = setup.actions;
      const baseline = await startStand(reference, true);
      const source = await value.load(candidate.packId, candidate.motionId, candidate.sha256);
      const originalSource = source.tracks.map(trackSnapshot), originalStand = setup.stand.tracks.map(trackSnapshot);
      const originalClips = originalActions.map(action => action.getClip());
      const originalSpeeds = originalActions.map(action => action.timeScale);
      const originalWeights = originalActions.map(action => action.weight);
      assertPoseEqual(value.mesh, reference.mesh, 'identical real starting pose');
      player = new BehaviorBodyPlayer(value.animation.getBehaviorBodyBindings({ allowBaseProjection: true }));
      assert.equal(player.play({ id: `projection-${candidate.motionId}`, clip: source, maskId: candidate.maskId,
        durationMs: source.duration * 1_000, strength: 0.2 }), true);
      assert.ok(value.mixer._actions.length > originalActions.length, 'Temporary Actions share the original mixer.');
      assert.equal(value.animation.helper.objects.get(value.mesh)!.mixer, value.mixer);
      let largestHeadDifference = 0, largestBoneDifference = 0, positiveWeightSamples = 0;
      const delta = 1 / 60;
      const frame = (label: string) => {
        const state = player!.beforeUpdate(delta, false);
        value.animation.helper.update(delta); reference.animation.helper.update(delta);
        assert.deepEqual(originalActions.map(action => action.getClip()), originalClips);
        originalActions.forEach((action, index) => {
          assert.equal(action.timeScale, originalSpeeds[index]);
          assert.ok(Math.abs(action.time - baseline.actions[index].time) < 1e-10, `${label}: original phase${index}`);
        });
        assertUnaffectedFingersAndFace(value.mesh, reference.mesh, label);
        if (state.weight > 0) {
          positiveWeightSamples++;
          value.mesh.skeleton.bones.forEach((bone, index) => {
            const difference = rotationDifference(bone.quaternion, reference.mesh.skeleton.bones[index].quaternion);
            largestBoneDifference = Math.max(largestBoneDifference, difference);
            if (bone.name === '首' || bone.name === '頭') largestHeadDifference = Math.max(largestHeadDifference, difference);
          });
        }
      };
      // Full original source pass, including real IK/grant after the existing
      // mixer. This is a numerical CPU acceptance, not a visual-use approval.
      for (let index = 0; index < Math.ceil(source.duration / delta) + 2; index++) frame(`source frame${index}`);
      assert.ok(positiveWeightSamples > 30);
      assert.ok(largestBoneDifference > 1e-5, 'Actual source produces an observable numeric pose difference.');
      if (candidate.maskId === 'candidate-head-v1') assert.ok(largestHeadDifference > 1e-4);
      assert.equal(player.getState().active, false);
      assert.deepEqual(new Set(value.mixer._actions), new Set(originalActions), 'Natural completion releases every owned Action.');
      assert.deepEqual(originalActions.map(action => action.weight), originalWeights);
      assertPoseEqual(value.mesh, reference.mesh, 'natural finish and pre-IK cache restoration');

      // Cancelling between helper updates must recover at the next advancing
      // base phase, rather than caching the displayed overlay as a new base.
      assert.equal(player.play({ id: `cancel-${candidate.motionId}`, clip: source, maskId: candidate.maskId,
        durationMs: source.duration * 1_000, strength: 0.2 }), true);
      for (let index = 0; index < 90; index++) frame(`cancel lead-in${index}`);
      const times = originalActions.map(action => action.time);
      player.stop();
      assert.deepEqual(originalActions.map(action => action.time), times, 'Cancellation never rewinds the base Action.');
      assert.deepEqual(originalActions.map(action => action.weight), originalWeights);
      assert.deepEqual(new Set(value.mixer._actions), new Set(originalActions));
      for (let index = 0; index < 4; index++) {
        value.animation.helper.update(delta); reference.animation.helper.update(delta);
        assertPoseEqual(value.mesh, reference.mesh, `cancelled continuation${index}`);
        assert.ok(Math.abs(originalActions[0].time - baseline.actions[0].time) < 1e-10);
      }
      assert.equal(player.play({ id: `cancel-${candidate.motionId}`, clip: source, maskId: candidate.maskId,
        durationMs: source.duration * 1_000, strength: 0.2 }), false, 'The cancelled identity cannot replay.');
      assert.deepEqual(source.tracks.map(trackSnapshot), originalSource, 'Original source values, timing and Bezier factories remain untouched.');
      assert.deepEqual(setup.stand.tracks.map(trackSnapshot), originalStand, 'Original full Stand tracks remain untouched.');
    } finally { player?.dispose(); value.dispose(); reference.dispose(); }
  });
}
