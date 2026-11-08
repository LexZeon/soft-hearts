import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  AnimationClip, Bone, BufferGeometry, MeshBasicMaterial, NumberKeyframeTrack, Quaternion,
  QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Vector3, VectorKeyframeTrack, type AnimationAction,
  type AnimationMixer, type KeyframeTrack,
} from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { ChatGesturePlayer, isChatGestureTrack } from '../src/stage/chat-gesture';
import { LayeredMmdAnimation } from '../src/stage/motion-layers';
import { createVmdParser } from '../src/stage/vmd';

const AXIS = new Vector3(0, 0, 1);
const orientation = (angle: number) => new Quaternion().setFromAxisAngle(AXIS, angle);
function rotation(name: string, start: number, end = start, duration = 2) {
  return new QuaternionKeyframeTrack(`.bones[${name}].quaternion`, [0, duration], [...orientation(start).toArray(), ...orientation(end).toArray()]);
}
const clip = (tracks: KeyframeTrack[] = [rotation('左腕', 1.4)], duration = 2) => new AnimationClip('gesture-test', duration, tracks);
function fixture() {
  const geometry = new BufferGeometry(); geometry.userData.MMD = { iks: [], grants: [] };
  const material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material);
  const bones = Object.fromEntries(['上半身', '上半身2', '左肩', '右肩', '左腕', '右腕', '左ひじ', '右手首', '頭', '首', '左目', '顎', 'センター', '左足', '左足ＩＫ'].map(name => {
    const bone = new Bone(); bone.name = name; mesh.add(bone); return [name, bone];
  }));
  mesh.bind(new Skeleton(Object.values(bones))); mesh.morphTargetDictionary = { smile: 0 }; mesh.morphTargetInfluences = [0];
  const player = new ChatGesturePlayer(mesh);
  return { mesh, bones, player, dispose() { player.dispose(); mesh.skeleton.dispose(); geometry.dispose(); material.dispose(); } };
}
function expectRotation(bone: Bone, expected: Quaternion) {
  assert.ok(bone.quaternion.clone().normalize().angleTo(expected.clone().normalize()) < 1e-6, `${bone.name} orientation differs`);
}

test('only explicit chest/shoulder/arm/elbow/wrist quaternion properties may bind', () => {
  for (const name of ['上半身', '上半身2', '左肩', '右腕', '左ひじ', '右肘', '左手首', 'Chest', 'Spine2', 'mixamorig:LeftArm', 'UpperArm_R', 'hand.L'])
    assert.equal(isChatGestureTrack(`.bones[${name}].quaternion`), true, name);
  for (const name of ['頭', '首', 'Head', 'Neck', '左目', '顎', 'センター', '全ての親', '腰', '左足', '左足ＩＫ', '左腕IK', '左親指1', 'LeftHandIndex1', '髪', 'constructor', 'LeftArm][position'])
    assert.equal(isChatGestureTrack(`.bones[${name}].quaternion`), false, name);
  for (const name of ['.bones[左腕].position', '.bones[左腕].scale', '.bones[左腕].rotation', '.morphTargetInfluences[0]', '.material.opacity', '.position'])
    assert.equal(isChatGestureTrack(name), false, name);
  const f = fixture(); let unsafeFactoryCalls = 0;
  try {
    const unsafe = rotation('頭', 0.7); unsafe.createInterpolant = () => { unsafeFactoryCalls++; throw new Error('must not bind'); };
    const originalPositions = Object.values(f.bones).map(bone => bone.position.toArray());
    assert.equal(f.player.play({ id: 'allowed-only', clip: clip([rotation('左腕', 1), unsafe,
      new VectorKeyframeTrack('.bones[左腕].position', [0, 2], [9, 8, 7, 9, 8, 7]),
      new NumberKeyframeTrack('.morphTargetInfluences[0]', [0, 2], [1, 1])]), strength: 0.6 }), true);
    f.player.frame(0.5, { blocked: false });
    assert.equal(unsafeFactoryCalls, 0); assert.deepEqual(f.player.getState().trackNames, ['.bones[左腕].quaternion']);
    expectRotation(f.bones['頭'], orientation(0)); expectRotation(f.bones['左足'], orientation(0));
    assert.deepEqual(f.mesh.morphTargetInfluences, [0]);
    assert.deepEqual(Object.values(f.bones).map(bone => bone.position.toArray()), originalPositions);
  } finally { f.dispose(); }
});

test('original custom interpolation is used and weight has bounded, independent in/out envelopes', () => {
  const f = fixture(); let factoryCalls = 0, evaluations = 0;
  try {
    const track = rotation('左腕', 0, 1.5), sourceFactory = track.createInterpolant;
    track.createInterpolant = () => {
      factoryCalls++;
      return { evaluate(time: number) { evaluations++; return orientation(time * time).toArray(); } } as any;
    };
    const factory = track.createInterpolant, source = clip([track]);
    assert.equal(f.player.play({ id: 'custom-curve', clip: source, strength: 4 }), true);
    const first = f.player.frame(0.125, { blocked: false });
    assert.equal(first.weight, 0.35); expectRotation(f.bones['左腕'], orientation(0.125 ** 2 * 0.35));
    f.player.restore(); const full = f.player.frame(0.125, { blocked: false });
    assert.equal(full.weight, 0.7); expectRotation(f.bones['左腕'], orientation(0.25 ** 2 * 0.7));
    f.player.restore(); const fading = f.player.frame(1.6, { blocked: false });
    assert.equal(fading.phase, 'fading'); assert.ok(fading.weight > 0 && fading.weight < full.weight);
    // R29f: 3 frames, plus the first and last sample that size the fades on the first frame.
    assert.equal(factoryCalls, 1); assert.equal(evaluations, 5); assert.equal(track.createInterpolant, factory);
    assert.notEqual(factory, sourceFactory); assert.equal(source.tracks[0], track); assert.equal(source.duration, 2);
    f.player.frame(0.15, { blocked: false }); assert.equal(f.player.getState().active, false); expectRotation(f.bones['左腕'], orientation(0));
  } finally { f.dispose(); }
});

test('real layered base and face actions keep identity, phase and properties through a one-shot gesture', () => {
  const f = fixture(), animation = new LayeredMmdAnimation(f.mesh);
  try {
    const pose = clip([rotation('左腕', 0, 0.8, 8), rotation('左足', 0, 0.4, 8), rotation('頭', 0.2, 0.5, 8)], 8);
    const face = clip([new NumberKeyframeTrack('.morphTargetInfluences[0]', [0, 8], [0, 0.8])], 8);
    animation.setClips({ pose, gesture: null, expression: face });
    const mixer = animation.helper.objects.get(f.mesh)!.mixer! as AnimationMixer & { _actions: AnimationAction[] };
    const actions = [...mixer._actions]; let sawArmChange = false;
    assert.equal(f.player.play({ id: 'base-continues', clip: clip(), strength: 0.6 }), true);
    for (let frame = 0; frame < 75; frame++) {
      f.player.restore(); animation.helper.update(1 / 30);
      const base = f.bones['左腕'].quaternion.clone(), head = f.bones['頭'].quaternion.clone(), leg = f.bones['左足'].quaternion.clone(), mouth = [...f.mesh.morphTargetInfluences!];
      const state = f.player.frame(1 / 30, { blocked: false });
      if (state.active && state.weight > 0.1 && f.bones['左腕'].quaternion.angleTo(base) > 0.1) sawArmChange = true;
      expectRotation(f.bones['頭'], head); expectRotation(f.bones['左足'], leg); assert.deepEqual(f.mesh.morphTargetInfluences, mouth);
      if (!state.active) expectRotation(f.bones['左腕'], base);
    }
    assert.equal(sawArmChange, true); assert.equal(f.player.getState().active, false);
    assert.deepEqual(mixer._actions, actions, 'neither action gets rebuilt');
    for (const action of actions) assert.ok(Math.abs(action.time - 2.5) < 1e-9);
    expectRotation(f.bones['左腕'], orientation(0.25));
    assert.equal(f.player.play({ id: 'base-continues', clip: clip(), strength: 0.6 }), false, 'completed IDs cannot replay');
  } finally { f.dispose(); animation.dispose(); }
});

test('manual blocking restores the exact first base, consumes its cue and never queues a replay', () => {
  const f = fixture();
  try {
    f.bones['左腕'].quaternion.copy(orientation(0.37)); const base = f.bones['左腕'].quaternion.clone();
    assert.equal(f.player.play({ id: 'blocked-cue', clip: clip(), strength: 0.7 }), true);
    f.player.frame(0.5, { blocked: false }); assert.ok(f.bones['左腕'].quaternion.angleTo(base) > 0.4);
    assert.equal(f.player.frame(0.1, { blocked: true }).active, false); assert.deepEqual(f.bones['左腕'].quaternion.toArray(), base.toArray());
    f.player.frame(10, { blocked: false }); assert.equal(f.player.getState().active, false);
    assert.equal(f.player.play({ id: 'blocked-cue', clip: clip(), strength: 0.7 }), false);
  } finally { f.dispose(); }
});

test('a new cue restores the old base before replacing it; cancellation and disposal are idempotent', () => {
  const f = fixture();
  try {
    f.bones['左腕'].quaternion.copy(orientation(-0.2)); const base = f.bones['左腕'].quaternion.clone();
    f.player.play({ id: 'replace-1', clip: clip(), strength: 0.6 }); f.player.frame(0.5, { blocked: false });
    assert.equal(f.player.play({ id: 'replace-2', clip: clip([rotation('左腕', -1)]), strength: 0.5 }), true);
    assert.deepEqual(f.bones['左腕'].quaternion.toArray(), base.toArray());
    f.player.frame(0.5, { blocked: false }); f.player.cancel(); f.player.cancel();
    assert.deepEqual(f.bones['左腕'].quaternion.toArray(), base.toArray());
    f.player.play({ id: 'dispose-active', clip: clip(), strength: 0.7 }); f.player.frame(0.5, { blocked: false });
    f.player.dispose(); f.player.dispose(); assert.deepEqual(f.bones['左腕'].quaternion.toArray(), base.toArray());
    assert.equal(f.player.play({ id: 'disposed', clip: clip(), strength: 0.5 }), false); assert.equal(f.player.frame(1, { blocked: false }).active, false);
  } finally { f.dispose(); }
});

test('a requested short fade is monotonic and fully restores the base without holding the last arm pose', () => {
  const f = fixture();
  try {
    f.player.play({ id: 'soft-cancel', clip: clip(), strength: 0.6 }); f.player.frame(0.5, { blocked: false });
    f.player.cancel({ immediate: false }); let previous = f.player.getState().weight;
    for (let frame = 0; frame < 6; frame++) {
      const state = f.player.frame(0.025, { blocked: false }); assert.ok(state.weight <= previous); previous = state.weight;
    }
    assert.equal(f.player.getState().active, false); expectRotation(f.bones['左腕'], orientation(0));
  } finally { f.dispose(); }
});

test('zero/nonfinite strengths, invalid tracks and bad time cannot poison state or accumulate rotations', () => {
  const f = fixture();
  try {
    for (const [index, strength] of [0, -1, NaN, Infinity].entries()) {
      const id = `invalid-${index}`; assert.equal(f.player.play({ id, clip: clip(), strength }), false);
      assert.equal(f.player.play({ id, clip: clip(), strength: 0.5 }), false, 'invalid attempts are consumed');
    }
    const invalid = rotation('左腕', 1); invalid.values[2] = NaN;
    assert.equal(f.player.play({ id: 'invalid-track', clip: clip([invalid]), strength: 0.5 }), false);
    assert.equal(f.player.play({ id: 'no-allowed-track', clip: clip([rotation('頭', 1)]), strength: 0.5 }), false);
    const source = clip(); source.duration = NaN;
    assert.equal(f.player.play({ id: 'invalid-duration', clip: source, strength: 0.5 }), false);
    f.player.play({ id: 'finite', clip: clip(), strength: 0.6, fadeInMs: NaN, fadeOutMs: -4 });
    for (const delta of [NaN, -1, Infinity]) assert.equal(f.player.frame(delta, { blocked: false }).elapsedMs, 0);
    f.player.frame(0.5, { blocked: false }); const once = f.bones['左腕'].quaternion.clone();
    for (let frame = 0; frame < 10; frame++) f.player.frame(0, { blocked: false });
    expectRotation(f.bones['左腕'], once); f.player.frame(1_000_000, { blocked: false });
    assert.equal(f.player.getState().active, false); expectRotation(f.bones['左腕'], orientation(0));
  } finally { f.dispose(); }
});

test('consumed IDs are bounded and externally returned state cannot mutate the player', () => {
  const f = fixture();
  try {
    for (let id = 0; id < 129; id++) assert.equal(f.player.play({ id: `bounded-${id}`, clip: clip(), strength: 0 }), false);
    assert.equal(f.player.play({ id: 'bounded-128', clip: clip(), strength: 0.6 }), false);
    assert.equal(f.player.play({ id: 'bounded-0', clip: clip(), strength: 0.6 }), true, 'old identities leave the bounded cache');
    const state = f.player.getState(); state.trackNames.length = 0; state.weight = 99;
    assert.equal(f.player.getState().trackNames.length, 1); assert.equal(f.player.getState().weight, 0);
  } finally { f.dispose(); }
});

test('the two curated public VMDs keep Bezier factories, visibly move arms once, and release to an advancing Gene base', async () => {
  const catalog = JSON.parse(await readFile('shared/motion-catalog.json', 'utf8'));
  const manifest = JSON.parse(await readFile('shared/bundled-assets.json', 'utf8'));
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js';
  const { MMDParser } = await import(parserModule);
  const bytes = await readFile(join('assets/bundled', manifest.root, manifest.model.relativePath));
  const data = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
  const loader = new MMDLoader() as any;
  loader.meshBuilder.materialBuilder.build = () => data.materials.map((value: { name: string }) => {
    const material = new MeshBasicMaterial(); material.name = value.name; return material;
  });
  const mesh = loader.meshBuilder.build(data, '') as SkinnedMesh, player = new ChatGesturePlayer(mesh), animation = new LayeredMmdAnimation(mesh);
  const loadClip = async (packId: string, motionId: string, expectedHash?: string) => {
    const pack = catalog.packs.find((value: any) => value.id === packId), entry = pack.motions.find((value: any) => value.id === motionId);
    const bytes = await readFile(join('assets/bundled', pack.source, pack.id, pack.revision, entry.relativePath));
    const hash = createHash('sha256').update(bytes).digest('hex'); assert.equal(hash, entry.sha256); if (expectedHash) assert.equal(hash, expectedHash);
    let frames = 0;
    const parser = createVmdParser(report => { frames = report.durationFrames; }) as { parseVmd(buffer: ArrayBuffer, leftToRight: boolean): unknown };
    const vmd = parser.parseVmd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
    const value = loader.animationBuilder.build(vmd, mesh) as AnimationClip; value.duration = Math.max(value.duration, frames / 30);
    return { value, frames };
  };
  try {
    const { value: stand } = await loadClip('gene', 'stand');
    animation.setClips({ pose: stand, gesture: null, expression: null });
    const mixer = animation.helper.objects.get(mesh)!.mixer! as AnimationMixer & { _actions: AnimationAction[] }, baseActions = [...mixer._actions];
    for (const candidate of [
      { pack: 'genea-2022-gestures', id: 'speaking-gesture-2', frames: 180, hash: '6abec61bc8fde28e6d340c9c7cdd00e08edd2340c3939efc3ab041fdf327748d' },
      { pack: 'mpi-embm-gestures', id: 'conversation-joy', frames: 88, hash: '027860a2db2891277a36e723dc69300b16828a701e33169ec29edd3397db710b' },
    ]) {
      const { value: source, frames } = await loadClip(candidate.pack, candidate.id, candidate.hash);
      assert.equal(frames, candidate.frames); assert.ok(Math.abs(source.duration - frames / 30) < 1e-6);
      const factories = source.tracks.map(track => track.createInterpolant), beforeTracks = [...source.tracks];
      assert.ok(factories.some(factory => factory.name === 'InterpolantFactoryMethodCubicBezier'));
      assert.equal(player.play({ id: candidate.id, clip: source, strength: 0.65 }), true);
      assert.equal(player.getState().trackNames.length, 10); assert.ok(player.getState().trackNames.every(isChatGestureTrack));
      let armChange = 0, previousWeight = 0, sawFade = false;
      for (let frame = 0; frame < Math.ceil(source.duration * 30) + 18; frame++) {
        player.restore(); animation.helper.update(1 / 30);
        const base = mesh.skeleton.bones.map(bone => bone.quaternion.clone()), face = [...mesh.morphTargetInfluences!];
        const state = player.frame(1 / 30, { blocked: false });
        for (let index = 0; index < mesh.skeleton.bones.length; index++) {
          const bone = mesh.skeleton.bones[index];
          if (/^(左|右)(腕|ひじ|手首)$/.test(bone.name)) armChange = Math.max(armChange, bone.quaternion.angleTo(base[index]));
          if (!isChatGestureTrack(`.bones[${bone.name}].quaternion`) || !state.active) expectRotation(bone, base[index]);
        }
        assert.deepEqual(mesh.morphTargetInfluences, face);
        if (state.phase === 'fading' && state.weight < previousWeight) sawFade = true;
        previousWeight = state.weight;
      }
      assert.ok(armChange > 0.2, `${candidate.id} must move an actual arm, not only head/face`); assert.equal(sawFade, true);
      assert.equal(player.getState().active, false); assert.deepEqual(mixer._actions, baseActions);
      assert.equal(player.play({ id: candidate.id, clip: source, strength: 0.65 }), false);
      assert.deepEqual(source.tracks, beforeTracks); assert.deepEqual(source.tracks.map(track => track.createInterpolant), factories);
    }
    assert.ok(baseActions[0].time > 0, 'the original base remains in progress');
  } finally {
    player.dispose(); animation.dispose(); mesh.geometry.dispose(); mesh.skeleton.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
  }
});
