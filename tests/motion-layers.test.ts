import assert from "node:assert/strict";
import test from "node:test";
import {
  AnimationClip,
  Bone,
  BufferGeometry,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  Quaternion,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Vector3,
  VectorKeyframeTrack,
  type AnimationAction,
  type AnimationMixer,
  type KeyframeTrack,
} from "three";
import { LayeredMmdAnimation, motionTrackChannel, type MotionLayerClips } from "../src/stage/motion-layers";

const AXIS = new Vector3(0, 0, 1);
const EMPTY: MotionLayerClips = { pose: null, gesture: null, expression: null };

function rotation(bone: string, angle: number, end = angle): QuaternionKeyframeTrack {
  const first = new Quaternion().setFromAxisAngle(AXIS, angle);
  const last = new Quaternion().setFromAxisAngle(AXIS, end);
  return new QuaternionKeyframeTrack(`.bones[${bone}].quaternion`, [0, 2], [...first.toArray(), ...last.toArray()]);
}

function morph(value: number, end = value): NumberKeyframeTrack {
  return new NumberKeyframeTrack(".morphTargetInfluences[0]", [0, 2], [value, end]);
}

function clip(name: string, tracks: KeyframeTrack[], duration = 2): AnimationClip {
  return new AnimationClip(name, duration, tracks);
}

function harness() {
  const geometry = new BufferGeometry();
  geometry.userData.MMD = { iks: [], grants: [] };
  const material = new MeshBasicMaterial();
  const mesh = new SkinnedMesh(geometry, material);
  const bones = Object.fromEntries(["センター", "左腕", "左足", "頭", "左目", "顎"].map(name => {
    const bone = new Bone();
    bone.name = name;
    mesh.add(bone);
    return [name, bone];
  }));
  mesh.bind(new Skeleton(Object.values(bones)));
  mesh.morphTargetDictionary = { smile: 0 };
  mesh.morphTargetInfluences = [0];
  const animation = new LayeredMmdAnimation(mesh);
  const mixer = animation.helper.objects.get(mesh)!.mixer!;
  const actions = () => (mixer as AnimationMixer & { _actions: AnimationAction[] })._actions;
  const action = (channel: string) => actions().find(value => value.getClip().name.endsWith(`:${channel}`))!;
  const dispose = () => { animation.dispose(); geometry.dispose(); material.dispose(); };
  return { mesh, bones, animation, action, actions, dispose };
}

function expectAngle(bone: Bone, angle: number): void {
  const expected = new Quaternion().setFromAxisAngle(AXIS, angle);
  assert.ok(bone.quaternion.clone().normalize().angleTo(expected) < 1e-6, `Expected ${bone.name} rotation ${angle}, got ${bone.quaternion.toArray()}`);
}

test("MMD property classification keeps face, common upper-body bones, and root/legs separate", () => {
  for (const name of ["両目", "左目", "右眼", "顎", "上唇", "左眉", "Eye_L", "mixamorig:Jaw"])
    assert.equal(motionTrackChannel(`.bones[${name}].quaternion`), "expression", name);
  for (const name of ["左腕", "右腕捩", "上半身2", "頭", "首", "左人指１", "mixamorig:LeftForeArm", "Spine2", "LeftHandIndex1"])
    assert.equal(motionTrackChannel(`.bones[${name}].quaternion`), "gesture", name);
  for (const name of ["センター", "全ての親", "左足ＩＫ", "左ひざ", "腰", "Hips", "LeftUpLeg", "RightFoot", "Root", "hair", "SpringHair", "HeadHair", "Surface", "頭髪", "首飾り"])
    assert.equal(motionTrackChannel(`.bones[${name}].position`), "pose", name);
  assert.equal(motionTrackChannel(".morphTargetInfluences[0]"), "expression");
  for (const name of [".position", ".material.opacity", ".bones[左腕].visible", ".morphTargetInfluences[bad]"])
    assert.equal(motionTrackChannel(name), null, name);
});

test("pose, gesture and expression use independent real quaternion and morph tracks", () => {
  const h = harness();
  try {
    h.animation.setClips({
      pose: clip("pose", [rotation("左足", 0.4), rotation("左腕", 0.2), rotation("左目", 0.9), morph(0.9)]),
      gesture: clip("gesture", [rotation("左腕", 1), rotation("左足", 1.2), rotation("左目", 1.3), morph(0.7)]),
      expression: clip("expression", [rotation("左目", 0.3), rotation("顎", 0.15), rotation("左足", 1.4), rotation("頭", 1.5), morph(0.6)]),
    });
    h.animation.helper.update(0.5);
    expectAngle(h.bones["左足"], 0.4);
    expectAngle(h.bones["左腕"], 1); // An average with the pose would be 0.6.
    expectAngle(h.bones["左目"], 0.3);
    expectAngle(h.bones["顎"], 0.15);
    expectAngle(h.bones["頭"], 0);
    assert.ok(Math.abs(h.mesh.morphTargetInfluences![0] - 0.6) < 1e-6);
  } finally { h.dispose(); }
});

test("gesture overrides only matching property, leaving the pose's same-bone position intact", () => {
  const h = harness();
  try {
    h.animation.setClips({
      pose: clip("pose", [
        rotation("左腕", 0.2),
        new VectorKeyframeTrack(".bones[左腕].position", [0, 2], [1, 2, 3, 1, 2, 3]),
      ]),
      gesture: clip("gesture", [rotation("左腕", 1)]),
      expression: null,
    });
    h.animation.helper.update(0.5);
    expectAngle(h.bones["左腕"], 1);
    assert.deepEqual(h.bones["左腕"].position.toArray(), [1, 2, 3]);
  } finally { h.dispose(); }
});

test("changing expression preserves pose and gesture actions and their playback time", () => {
  const h = harness();
  try {
    const sources = {
      pose: clip("pose", [rotation("左足", 0, 0.8)]),
      gesture: clip("gesture", [rotation("左腕", 0, 1)]),
      expression: clip("expression", [morph(0, 1)]),
    };
    h.animation.setClips(sources);
    h.animation.helper.update(0.7);
    const pose = h.action("pose");
    const gesture = h.action("gesture");
    h.animation.setClips({ ...sources, expression: clip("second-face", [morph(0.25)]) });
    assert.equal(h.action("pose"), pose);
    assert.equal(h.action("gesture"), gesture);
    assert.equal(pose.time, 0.7);
    assert.equal(gesture.time, 0.7);
    assert.equal(h.action("expression").time, 0);
    h.animation.helper.update(0.1);
    expectAngle(h.bones["左足"], 0.32);
    expectAngle(h.bones["左腕"], 0.4);
  } finally { h.dispose(); }
});

test("changing gesture preserves pose phase and face action; clearing restores the underlying pose", () => {
  const h = harness();
  try {
    const pose = clip("pose", [rotation("左腕", 0, 1), rotation("左足", 0, 0.6)]);
    const expression = clip("face", [morph(0, 1)]);
    h.animation.setClips({ pose, gesture: null, expression });
    h.animation.helper.update(0.8);
    const faceAction = h.action("expression");
    const poseAction = h.action("pose");
    h.animation.setClips({ pose, gesture: clip("hand", [rotation("左腕", 1.2)]), expression });
    assert.notEqual(h.action("pose"), poseAction);
    assert.equal(h.action("pose").time, 0.8);
    assert.equal(h.action("expression"), faceAction);
    assert.equal(faceAction.time, 0.8);
    h.animation.helper.update(0.1);
    expectAngle(h.bones["左腕"], 1.2);
    h.animation.setClips({ pose, gesture: null, expression });
    assert.equal(h.action("pose").time, 0.9);
    assert.equal(h.action("expression"), faceAction);
    h.animation.helper.update(0);
    expectAngle(h.bones["左腕"], 0.45);
    expectAngle(h.bones["左足"], 0.27);
    assert.ok(Math.abs(h.mesh.morphTargetInfluences![0] - 0.45) < 1e-6);
  } finally { h.dispose(); }
});

test("changing pose leaves gesture and expression phase unchanged", () => {
  const h = harness();
  try {
    const gesture = clip("hand", [rotation("左腕", 0, 1)]);
    const expression = clip("face", [morph(0, 1)]);
    h.animation.setClips({ pose: clip("pose", [rotation("左足", 0.3)]), gesture, expression });
    h.animation.helper.update(0.6);
    const handAction = h.action("gesture");
    const faceAction = h.action("expression");
    h.animation.setClips({ pose: clip("other-pose", [rotation("左足", 0.9)]), gesture, expression });
    assert.equal(h.action("gesture"), handAction);
    assert.equal(h.action("expression"), faceAction);
    assert.equal(handAction.time, 0.6);
    assert.equal(faceAction.time, 0.6);
    assert.equal(h.action("pose").time, 0);
    h.animation.helper.update(0);
    expectAngle(h.bones["左腕"], 0.3);
    expectAngle(h.bones["左足"], 0.9);
    assert.ok(Math.abs(h.mesh.morphTargetInfluences![0] - 0.3) < 1e-6);
  } finally { h.dispose(); }
});

test("clearing a channel restores unbound skeleton and morph properties without stale helper snapshots", () => {
  const h = harness();
  try {
    const face = clip("face", [morph(0.7), rotation("左目", 0.5)]);
    h.animation.setClips({ pose: clip("pose", [rotation("左足", 0.8)]), gesture: null, expression: face });
    h.animation.helper.update(0.4);
    h.animation.setClips({ ...EMPTY, expression: face });
    h.animation.helper.update(0);
    expectAngle(h.bones["左足"], 0);
    expectAngle(h.bones["左目"], 0.5);
    h.animation.setClips(EMPTY);
    h.animation.helper.update(0.1);
    expectAngle(h.bones["左目"], 0);
    assert.equal(h.mesh.morphTargetInfluences![0], 0);
    assert.equal(h.actions().length, 0);
  } finally { h.dispose(); }
});

test("repeated identical source references are a no-op and do not grow mixer actions", () => {
  const h = harness();
  try {
    const sources = { pose: clip("pose", [rotation("左足", 0.2)]), gesture: null, expression: clip("face", [morph(0.5)]) };
    h.animation.setClips(sources);
    h.animation.helper.update(1.3);
    const original = [...h.actions()];
    for (let i = 0; i < 20; i++) h.animation.setClips({ ...sources });
    assert.deepEqual(h.actions(), original);
    assert.equal(h.action("pose").time, 1.3);
    assert.equal(h.action("expression").time, 1.3);
  } finally { h.dispose(); }
});

test("legacy full VMD remains combined; switching to separated layers preserves body phase", () => {
  const h = harness();
  try {
    const combined = clip("old", [rotation("左足", 0, 1), rotation("左目", 0.4), morph(0.8)]);
    const sources = { pose: combined, gesture: null, expression: null };
    h.animation.setClips(sources, { legacy: true });
    h.animation.helper.update(0.6);
    expectAngle(h.bones["左目"], 0.4);
    assert.ok(Math.abs(h.mesh.morphTargetInfluences![0] - 0.8) < 1e-6);
    h.animation.setClips({ ...sources, expression: clip("face", [morph(0.2)]) });
    assert.equal(h.action("pose").time, 0.6);
    h.animation.helper.update(0);
    expectAngle(h.bones["左足"], 0.3);
    expectAngle(h.bones["左目"], 0);
    assert.ok(Math.abs(h.mesh.morphTargetInfluences![0] - 0.2) < 1e-6);
  } finally { h.dispose(); }
});

test("first gesture split continues the legacy dynamic face while a different face source starts at zero", () => {
  const h = harness();
  try {
    const combined = clip("old", [rotation("左足", 0, 1), rotation("左目", 0, 0.6), morph(0, 1)]);
    const gesture = clip("new-hand", [rotation("左腕", 1.2)]);
    h.animation.setClips({ pose: combined, gesture: null, expression: null }, { legacy: true });
    h.animation.helper.update(0.8);
    assert.ok(Math.abs(h.mesh.morphTargetInfluences![0] - 0.4) < 1e-6);
    h.animation.setClips({ pose: combined, gesture, expression: combined });
    assert.equal(h.action("pose").time, 0.8);
    assert.equal(h.action("expression").time, 0.8);
    assert.equal(h.action("gesture").time, 0);
    h.animation.helper.update(0.2);
    expectAngle(h.bones["左足"], 0.5);
    expectAngle(h.bones["左目"], 0.3);
    expectAngle(h.bones["左腕"], 1.2);
    assert.ok(Math.abs(h.mesh.morphTargetInfluences![0] - 0.5) < 1e-6);

    const handAction = h.action("gesture");
    const otherFace = clip("different-face", [morph(0.2, 0.8)]);
    h.animation.setClips({ pose: combined, gesture, expression: otherFace });
    assert.equal(h.action("expression").time, 0);
    assert.equal(h.action("pose").time, 1);
    assert.equal(h.action("gesture"), handAction);
    assert.equal(handAction.time, 0.2);
    h.animation.helper.update(0.1);
    assert.ok(Math.abs(h.mesh.morphTargetInfluences![0] - 0.23) < 1e-6);
  } finally { h.dispose(); }
});

test("static non-default pose and full authored duration survive filtering without mutating source tracks", () => {
  const h = harness();
  try {
    const source = clip("static", [rotation("左足", 0.45), morph(0.8)], 9);
    const originalTracks = [...source.tracks];
    h.animation.setClips({ pose: source, gesture: clip("empty-hand", [rotation("左足", 1)], 7), expression: null });
    assert.equal(h.action("pose").getClip().duration, 9);
    assert.equal(h.action("gesture").getClip().duration, 7);
    assert.equal(h.action("gesture").getClip().tracks.length, 0);
    h.animation.helper.update(5);
    expectAngle(h.bones["左足"], 0.45);
    assert.equal(h.action("pose").time, 5);
    assert.deepEqual(source.tracks, originalTracks);
    assert.equal(source.duration, 9);
    assert.equal(h.mesh.morphTargetInfluences![0], 0);
  } finally { h.dispose(); }
});

test("dispose is idempotent, restores controlled properties, and releases the helper mesh", () => {
  const h = harness();
  h.animation.setClips({ pose: clip("pose", [rotation("左足", 0.8)]), gesture: null, expression: clip("face", [morph(0.7)]) });
  h.animation.helper.update(0.3);
  h.animation.dispose();
  h.animation.dispose();
  expectAngle(h.bones["左足"], 0);
  assert.equal(h.mesh.morphTargetInfluences![0], 0);
  assert.equal(h.animation.helper.meshes.length, 0);
  assert.equal(h.actions().length, 0);
  h.animation.setClips({ ...EMPTY });
  h.dispose();
});

test("repeated gesture replacement releases old actions and clearing pose keeps the other layers running", () => {
  const h = harness();
  try {
    const pose = clip("pose", [rotation("左腕", 0.2), rotation("左足", 0.3)]);
    const expression = clip("face", [morph(0.4)]);
    for (let i = 0; i < 40; i++) {
      h.animation.setClips({ pose, expression, gesture: clip(`hand-${i}`, [rotation("左腕", i % 2 ? 0.8 : 1.1)]) });
      h.animation.helper.update(0.01);
      assert.equal(h.actions().length, 3);
    }
    const gesture = clip("last-hand", [rotation("左腕", 1)]);
    h.animation.setClips({ pose, expression, gesture });
    h.animation.helper.update(0.1);
    const handAction = h.action("gesture");
    const faceAction = h.action("expression");
    h.animation.setClips({ pose: null, expression, gesture });
    h.animation.helper.update(0);
    expectAngle(h.bones["左足"], 0);
    expectAngle(h.bones["左腕"], 1);
    assert.equal(h.action("gesture"), handAction);
    assert.equal(h.action("expression"), faceAction);
    assert.ok(Math.abs(h.mesh.morphTargetInfluences![0] - 0.4) < 1e-6);
  } finally { h.dispose(); }
});

test("transition properties exclude retained pose tracks and retain read-only layer phases", () => {
  const h = harness();
  try {
    const pose = clip('pose', [rotation('左腕', 0, 1), rotation('左足', 0, 0.6)]);
    const expression = clip('face', [morph(0, 1)]);
    assert.deepEqual(new Set(h.animation.setClips({ pose, gesture: null, expression })),
      new Set(['.bones[左腕].quaternion', '.bones[左足].quaternion', '.morphTargetInfluences[0]']));
    h.animation.helper.update(0.8);
    const faceAction = h.action('expression');
    const hand = clip('hand', [rotation('左腕', 1.2)]);
    assert.deepEqual(h.animation.setClips({ pose, gesture: hand, expression }), ['.bones[左腕].quaternion']);
    assert.deepEqual(h.animation.getLayerTimes(), { pose: 0.8, gesture: 0, expression: 0.8 });
    const phases = h.animation.getLayerTimes(); phases.pose = 99;
    assert.equal(h.animation.getLayerTimes().pose, 0.8); assert.equal(h.action('expression'), faceAction);
    h.animation.helper.update(0.1);
    assert.deepEqual(h.animation.setClips({ pose, gesture: null, expression }), ['.bones[左腕].quaternion']);
    assert.ok(Math.abs(h.animation.getLayerTimes().pose! - 0.9) < 1e-9);
    assert.deepEqual(h.animation.setClips({ pose, gesture: null, expression }), []);
    assert.deepEqual(h.animation.setClips({ pose, gesture: null, expression: null }), ['.morphTargetInfluences[0]']);
  } finally { h.dispose(); }
});
