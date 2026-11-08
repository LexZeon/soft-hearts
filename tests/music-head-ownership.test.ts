import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationClip, Bone, BufferGeometry, MeshBasicMaterial, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Vector3, VectorKeyframeTrack, type AnimationAction, type AnimationMixer } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { hasOwnedHeadTrack, hasOwnedLayeredHeadTrack } from '../src/stage/music-head-ownership';
import { LayeredMmdAnimation, type MotionLayerClips } from '../src/stage/motion-layers';

const clip = (...tracks: (QuaternionKeyframeTrack | VectorKeyframeTrack)[]) => new AnimationClip('manual', 1, tracks);
const quaternion = (name: string, values: number[]) => new QuaternionKeyframeTrack(`.bones[${name}].quaternion`, values.length === 4 ? [0] : [0, 1], values);
const vector = (name: string, property: 'position' | 'scale', values: number[]) =>
  new VectorKeyframeTrack(`.bones[${name}].${property}`, values.length === 3 ? [0] : [0, 1], values);

test('only the exact resolved head bone owns musical presentation', () => {
  assert.equal(hasOwnedHeadTrack(null, '頭'), false);
  assert.equal(hasOwnedHeadTrack(clip(quaternion('頭', [0, 0, 0, 1])), undefined), false);
  assert.equal(hasOwnedHeadTrack(clip(quaternion('左腕', [0.2, 0, 0, Math.sqrt(0.96)])), '頭'), false);
  assert.equal(hasOwnedHeadTrack(clip(quaternion('頭2', [0.2, 0, 0, Math.sqrt(0.96)])), '頭'), false);
  assert.equal(hasOwnedHeadTrack(clip(quaternion('Head', [0, 0, 0, 1, 0.2, 0, 0, Math.sqrt(0.96)])), '頭'), false);
  assert.equal(hasOwnedHeadTrack(clip(quaternion('Head', [0, 0, 0, 1, 0.2, 0, 0, Math.sqrt(0.96)])), 'Head'), true);
});

test('dynamic quaternion, translation and scale preserve the selected head owner', () => {
  assert.equal(hasOwnedHeadTrack(clip(quaternion('頭', [0, 0, 0, 1, 0.2, 0, 0, Math.sqrt(0.96)])), '頭'), true);
  assert.equal(hasOwnedHeadTrack(clip(vector('頭', 'position', [0, 0, 0, 0, 0.25, 0])), '頭'), true);
  assert.equal(hasOwnedHeadTrack(clip(vector('頭', 'scale', [1, 1, 1, 1, 1.1, 1])), '頭'), true);
});

test('non-default static quaternion, translation or scale still suppresses automatic head motion', () => {
  assert.equal(hasOwnedHeadTrack(clip(quaternion('頭', [0.2, 0, 0, Math.sqrt(0.96)])), '頭'), true);
  assert.equal(hasOwnedHeadTrack(clip(vector('頭', 'position', [0, 0.25, 0])), '頭'), true);
  assert.equal(hasOwnedHeadTrack(clip(vector('頭', 'scale', [1, 1.1, 1])), '頭'), true);
});

test('default identity and equivalent negative identity leave the head free', () => {
  for (const values of [[0, 0, 0, 1], [0, 0, 0, -1], [0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0, -1, 0, 0, 0, -1]])
    assert.equal(hasOwnedHeadTrack(clip(quaternion('頭', values)), '頭'), false);
  assert.equal(hasOwnedHeadTrack(clip(vector('頭', 'position', [0, 0, 0, 0, 0, 0])), '頭'), false);
  assert.equal(hasOwnedHeadTrack(clip(vector('頭', 'scale', [1, 1, 1, 1, 1, 1])), '頭'), false);
});

function loadedHead() {
  const geometry = new BufferGeometry(); geometry.userData.MMD = { iks: [], grants: [] };
  const material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material), head = new Bone();
  head.name = '頭'; head.position.set(1.2, 4.1234567, -2.5); mesh.add(head); mesh.bind(new Skeleton([head]));
  mesh.morphTargetDictionary = {}; mesh.morphTargetInfluences = [];
  const rest = head.position.clone();
  const loader = new MMDLoader() as unknown as { animationBuilder: { build(data: unknown, mesh: SkinnedMesh): AnimationClip } };
  const build = (keys: { position: number[]; rotation?: number[] }[]) => loader.animationBuilder.build({
    metadata: { motionCount: keys.length, morphCount: 0 }, morphs: [],
    motions: keys.map((key, index) => ({ boneName: '頭', frameNum: index * 30, position: key.position,
      rotation: key.rotation ?? [0, 0, 0, 1], interpolation: Array(64).fill(20) })),
  }, mesh);
  return { mesh, head, rest, build,
    dispose() { geometry.dispose(); material.dispose(); mesh.skeleton.dispose(); } };
}

function actualHeadTracks(animation: LayeredMmdAnimation, mesh: SkinnedMesh): string[] {
  const mixer = animation.helper.objects.get(mesh)!.mixer! as AnimationMixer & { _actions: AnimationAction[] };
  return mixer._actions.flatMap(action => action.getClip().tracks.map(track => `${action.getClip().name}:${track.name}`));
}

test('real MMDLoader default head translations equal the nonzero loaded bind position', () => {
  const h = loadedHead();
  try {
    const idle = h.build([{ position: [0, 0, 0] }, { position: [0, 0, 0] }]);
    const position = idle.tracks.find(track => track.name === '.bones[頭].position')!;
    assert.ok(position);
    assert.deepEqual(Array.from(position.values.slice(0, 3)), h.rest.toArray().map(Math.fround));
    assert.equal(hasOwnedHeadTrack(idle, '頭', h.rest), false, 'The actual default loader track leaves music available.');
    const staticOffset = h.build([{ position: [0, 0.25, 0] }, { position: [0, 0.25, 0] }]);
    assert.equal(hasOwnedHeadTrack(staticOffset, '頭', h.rest), true, 'A real non-default static displacement still owns the head.');
    const dynamic = h.build([{ position: [0, 0, 0] }, { position: [0, 0.25, 0] }]);
    assert.equal(hasOwnedHeadTrack(dynamic, '頭', h.rest), true);
  } finally { h.dispose(); }
});

test('real layered expression filtering discards raw head tracks rather than claiming music ownership', () => {
  const h = loadedHead(), animation = new LayeredMmdAnimation(h.mesh);
  try {
    const raw = h.build([{ position: [0, 0, 0] }, { position: [0, 0.2, 0], rotation: [0.2, 0, 0, Math.sqrt(0.96)] }]);
    const clips = { pose: null, gesture: null, expression: raw };
    assert.equal(hasOwnedHeadTrack(raw, '頭', h.rest), true, 'The raw source really contains authored head motion.');
    animation.setClips(clips); animation.helper.update(0.5);
    assert.deepEqual(actualHeadTracks(animation, h.mesh), [], 'The real expression action binds no head property.');
    assert.ok(h.head.position.distanceTo(h.rest) < 1e-6); assert.ok(h.head.quaternion.angleTo(h.head.quaternion.clone().identity()) < 1e-6);
    assert.equal(hasOwnedLayeredHeadTrack(clips, '頭', h.rest), false);
  } finally { animation.dispose(); h.dispose(); }
});

test('same-property gesture replacement is excluded from pose ownership using real selected tracks', () => {
  const h = loadedHead(), animation = new LayeredMmdAnimation(h.mesh);
  try {
    const pose = h.build([{ position: [0, 0, 0], rotation: [0.2, 0, 0, Math.sqrt(0.96)] },
      { position: [0, 0, 0], rotation: [0.2, 0, 0, Math.sqrt(0.96)] }]);
    const gesture = clip(quaternion('頭', [0, 0, 0, 1]));
    pose.name = 'authored-pose'; gesture.name = 'default-gesture';
    const clips = { pose, gesture, expression: null };
    animation.setClips(clips); animation.helper.update(0.4);
    const tracks = actualHeadTracks(animation, h.mesh);
    assert.ok(tracks.includes('default-gesture:gesture:.bones[頭].quaternion'));
    assert.ok(!tracks.includes('authored-pose:pose:.bones[頭].quaternion'));
    assert.ok(tracks.includes('authored-pose:pose:.bones[頭].position'), 'The real loader bind-position track remains in pose.');
    assert.ok(h.head.position.distanceTo(h.rest) < 1e-6);
    assert.ok(h.head.quaternion.angleTo(h.head.quaternion.clone().identity()) < 1e-6);
    assert.equal(hasOwnedLayeredHeadTrack(clips, '頭', h.rest), false, 'The hidden pose quaternion cannot suppress music.');
    const offset = clip(vector('頭', 'position', [h.rest.x, h.rest.y + 0.2, h.rest.z]));
    const separateProperties: MotionLayerClips = { pose: offset, gesture, expression: null };
    animation.setClips(separateProperties); animation.helper.update(0.2);
    assert.ok(actualHeadTracks(animation, h.mesh).includes('manual:pose:.bones[頭].position'));
    assert.ok(Math.abs(h.head.position.y - h.rest.y - 0.2) < 1e-6);
    assert.equal(hasOwnedLayeredHeadTrack(separateProperties, '頭', h.rest), true, 'A quaternion replacement cannot hide the pose position track.');
    const defaultPosition = clip(vector('頭', 'position', h.rest.toArray()));
    const replacedPosition = { pose: offset, gesture: defaultPosition, expression: null };
    animation.setClips(replacedPosition); animation.helper.update(0.2);
    assert.ok(!actualHeadTracks(animation, h.mesh).includes('manual:pose:.bones[頭].position'));
    assert.ok(h.head.position.distanceTo(h.rest) < 1e-6);
    assert.equal(hasOwnedLayeredHeadTrack(replacedPosition, '頭', h.rest), false, 'The same-property default gesture position masks the authored offset.');
  } finally { animation.dispose(); h.dispose(); }
});

test('actual legacy playback and reviewed backgrounds retain only their existing ownership exceptions', () => {
  const rest = new Vector3(0, 4, 0);
  const moving = clip(quaternion('頭', [0, 0, 0, 1, 0.2, 0, 0, Math.sqrt(0.96)]));
  const clips = { pose: moving, gesture: moving, expression: moving };
  assert.equal(hasOwnedLayeredHeadTrack(clips, '頭', rest, { legacy: true }), true);
  assert.equal(hasOwnedLayeredHeadTrack(clips, '頭', rest, { legacy: true, reviewedDefault: true }), false, 'Legacy mode actually ignores the extra gesture/expression sources.');
  assert.equal(hasOwnedLayeredHeadTrack({ ...clips, gesture: null }, '頭', rest, { reviewedDefault: true }), false, 'Reviewed background excludes only its pose; discarded expression head tracks add no owner.');
  assert.equal(hasOwnedLayeredHeadTrack(clips, '頭', rest, { reviewedDefault: true }), true, 'A real manual gesture head track still owns the head over a reviewed background.');
});
