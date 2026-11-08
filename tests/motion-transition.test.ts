import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationClip, Bone, BufferGeometry, MeshBasicMaterial, NumberKeyframeTrack, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { captureMotionPose, HANDOFF_ACCELERATION, HANDOFF_MAX_MS, HANDOFF_MIN_MS, handOffToBase, handoffDurationMs, MotionTransition, withDerivedBones } from '../src/stage/motion-transition';
import { LayeredMmdAnimation } from '../src/stage/motion-layers';

const axis = new Vector3(0, 0, 1);
const ARM = '.bones[左腕].quaternion';
const HAND = '.bones[右腕].quaternion';
const MORPH = '.morphTargetInfluences[0]';
const rotation = (angle: number) => new Quaternion().setFromAxisAngle(axis, angle);
const close = (value: number, expected: number) => assert.ok(Math.abs(value - expected) < 1e-7, `${value} != ${expected}`);
function harness() {
  const geometry = new BufferGeometry(); geometry.userData.MMD = { iks: [], grants: [] };
  const material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material);
  const bones = Object.fromEntries(['左腕', '右腕', '左足', '頭'].map(name => { const bone = new Bone(); bone.name = name; mesh.add(bone); return [name, bone]; }));
  mesh.bind(new Skeleton(Object.values(bones))); mesh.morphTargetDictionary = { mouth: 0, smile: 1 }; mesh.morphTargetInfluences = [0, 0];
  const bridge = new MotionTransition(mesh);
  return { mesh, bones, bridge, dispose() { bridge.dispose(); geometry.dispose(); material.dispose(); } };
}

test('affected quaternion, position, scale and morph start continuously and follow a live target', () => {
  const h = harness();
  try {
    const arm = h.bones['左腕']; arm.quaternion.copy(rotation(0.2)); arm.position.set(1, 2, 3); arm.scale.set(1, 1, 1);
    h.mesh.morphTargetInfluences![0] = -0.15;
    const snapshot = captureMotionPose(h.mesh);
    arm.quaternion.copy(rotation(1.2)); arm.position.set(5, 6, 7); arm.scale.set(2, 2, 2); h.mesh.morphTargetInfluences![0] = 0.85;
    h.bones['左足'].quaternion.copy(rotation(0.8)); h.mesh.morphTargetInfluences![1] = 0.7;
    assert.equal(h.bridge.start(snapshot, [ARM, '.bones[左腕].position', '.bones[左腕].scale', MORPH]), true);
    h.bridge.frame(0);
    assert.deepEqual(arm.quaternion.toArray(), rotation(0.2).toArray()); assert.deepEqual(arm.position.toArray(), [1, 2, 3]);
    close(h.mesh.morphTargetInfluences![0], -0.15); assert.equal(h.mesh.morphTargetInfluences![1], 0.7);
    h.bridge.restore(); close(arm.quaternion.angleTo(rotation(1.2)), 0); assert.deepEqual(arm.position.toArray(), [5, 6, 7]);
    for (let frame = 1; frame <= 4; frame++) {
      h.bridge.restore();
      // The new animation continues to move while the old display fades away.
      arm.quaternion.copy(rotation(1.2 + frame * 0.1)); arm.position.set(5 + frame, 6, 7); arm.scale.set(2, 2, 2);
      h.mesh.morphTargetInfluences![0] = 0.85;
      h.bridge.frame(0.1);
      if (frame === 2) {
        close(h.bridge.getState().weight, 0.5); close(arm.quaternion.angleTo(rotation(0.8)), 0);
        close(arm.position.x, 4); close(arm.scale.x, 1.5); close(h.mesh.morphTargetInfluences![0], 0.35);
      }
      close(h.bones['左足'].quaternion.angleTo(rotation(0.8)), 0); assert.equal(h.mesh.morphTargetInfluences![1], 0.7);
    }
    assert.equal(h.bridge.getState().active, false); close(arm.quaternion.angleTo(rotation(1.6)), 0);
    h.bridge.restore(); close(arm.position.x, 9); close(h.mesh.morphTargetInfluences![0], 0.85);
  } finally { h.dispose(); }
});

test('rapid reselect continues from the displayed intermediate pose, including old-only properties', () => {
  const h = harness();
  try {
    const first = captureMotionPose(h.mesh);
    h.bones['左腕'].quaternion.copy(rotation(1)); h.bones['右腕'].quaternion.copy(rotation(-1));
    h.bridge.start(first, [ARM, HAND]); h.bridge.frame(0.1);
    const visible = captureMotionPose(h.mesh), before = h.bones['左腕'].quaternion.toArray(), oldOnly = h.bones['右腕'].quaternion.toArray();
    h.bridge.restore();
    h.bones['左腕'].quaternion.copy(rotation(2)); h.bones['右腕'].quaternion.copy(rotation(-0.4));
    h.bridge.start(visible, [ARM]); h.bridge.frame(0);
    assert.deepEqual(h.bones['左腕'].quaternion.toArray(), before);
    assert.deepEqual(h.bones['右腕'].quaternion.toArray(), oldOnly);
    for (let index = 0; index < 4; index++) {
      h.bridge.restore(); h.bones['左腕'].quaternion.copy(rotation(2)); h.bones['右腕'].quaternion.copy(rotation(-0.4)); h.bridge.frame(0.1);
    }
    close(h.bones['左腕'].quaternion.angleTo(rotation(2)), 0); close(h.bones['右腕'].quaternion.angleTo(rotation(-0.4)), 0);
    assert.equal(h.bridge.getState().active, false);
  } finally { h.dispose(); }
});

test('clearing all clips bridges old-only values into the actual relaxed idle without accumulating', () => {
  const h = harness(), animation = new LayeredMmdAnimation(h.mesh);
  try {
    const q = rotation(1.3).toArray();
    animation.setClips({ pose: new AnimationClip('old', 2, [new QuaternionKeyframeTrack(ARM, [0, 2], [...q, ...q])]), gesture: null,
      expression: new AnimationClip('face', 2, [new NumberKeyframeTrack(MORPH, [0, 2], [0.8, 0.8])]) });
    animation.helper.update(0.7);
    const snapshot = captureMotionPose(h.mesh), mixer = animation.helper.objects.get(h.mesh)!.mixer!, previousTime = mixer.time;
    h.bridge.restore(); const affected = animation.setClips({ pose: null, gesture: null, expression: null });
    assert.deepEqual(new Set(affected), new Set([ARM, MORPH]));
    h.bridge.start(snapshot, affected);
    for (let frame = 0; frame <= 240; frame++) {
      h.bridge.restore(); animation.helper.update(frame ? 1 / 60 : 0);
      // This is the real final idle target, after the stage's relaxed-arm layer.
      h.bones['左腕'].quaternion.copy(rotation(0.4)); h.mesh.morphTargetInfluences![0] = 0;
      h.bridge.frame(frame ? 1 / 60 : 0);
      if (!frame) { close(h.bones['左腕'].quaternion.angleTo(rotation(1.3)), 0); close(h.mesh.morphTargetInfluences![0], 0.8); }
    }
    close(h.bones['左腕'].quaternion.angleTo(rotation(0.4)), 0); close(h.mesh.morphTargetInfluences![0], 0);
    assert.ok(mixer.time > previousTime + 3.9); assert.deepEqual(animation.getLayerTimes(), { pose: null, gesture: null, expression: null });
  } finally { animation.dispose(); h.dispose(); }
});

test('frame restore preserves every newly evaluated value through repeated transitions', () => {
  const h = harness();
  try {
    for (let run = 0; run < 20; run++) {
      h.bridge.restore(); const snapshot = captureMotionPose(h.mesh); h.bridge.start(snapshot, [ARM, MORPH]);
      for (let frame = 0; frame < 26; frame++) {
        h.bridge.restore(); const angle = (run % 3) * 0.1 + frame * 0.003;
        const value = frame * 0.01; h.bones['左腕'].quaternion.copy(rotation(angle)); h.mesh.morphTargetInfluences![0] = value;
        h.bridge.frame(1 / 60); h.bridge.restore();
        assert.deepEqual(h.bones['左腕'].quaternion.toArray(), rotation(angle).toArray()); close(h.mesh.morphTargetInfluences![0], value);
      }
    }
  } finally { h.dispose(); }
});

test('invalid bindings, ambiguous bones and snapshots from another mesh cannot affect the model', () => {
  const h = harness(), other = harness();
  try {
    assert.equal(h.bridge.start(captureMotionPose(other.mesh), [ARM]), false);
    const snapshot = captureMotionPose(h.mesh);
    assert.equal(h.bridge.start(snapshot, ['.material.opacity', '.bones[左腕].visible', '.bones[missing].position', '.morphTargetInfluences[9]']), false);
    const corrupt = { mesh: h.mesh, values: new Map([[ARM, [0, 0, 0, 0]], [MORPH, [Number.NaN]]]) };
    assert.equal(h.bridge.start(corrupt, [ARM, MORPH]), false);
    const duplicate = new Bone(); duplicate.name = '左腕'; h.mesh.add(duplicate); h.mesh.skeleton.bones.push(duplicate);
    const ambiguous = new MotionTransition(h.mesh);
    assert.equal(ambiguous.start(captureMotionPose(h.mesh), [ARM]), false); ambiguous.dispose();
  } finally { h.dispose(); other.dispose(); }
});

test('non-finite deltas do not advance and disposal restores targets and invalidates later starts', () => {
  const h = harness();
  try {
    const snapshot = captureMotionPose(h.mesh); h.bones['左腕'].quaternion.copy(rotation(1)); h.bridge.start(snapshot, [ARM]);
    h.bridge.frame(Number.NaN); assert.equal(h.bridge.getState().elapsedMs, 0);
    h.bridge.restore(); h.bridge.frame(-1); assert.equal(h.bridge.getState().elapsedMs, 0);
    h.bridge.restore(); h.bridge.frame(0.1); assert.ok(h.bridge.getState().weight > 0);
    h.bridge.dispose(); h.bridge.dispose(); close(h.bones['左腕'].quaternion.angleTo(rotation(1)), 0);
    assert.equal(h.bridge.getState().active, false); assert.equal(h.bridge.start(snapshot, [ARM]), false);
  } finally { h.dispose(); }
});

test('zero-duration and empty switches retain the current target without a display bridge', () => {
  const h = harness();
  try {
    const snapshot = captureMotionPose(h.mesh); h.bones['左腕'].quaternion.copy(rotation(1));
    assert.equal(h.bridge.start(snapshot, [ARM], 0), false); h.bridge.frame(0.1); close(h.bones['左腕'].quaternion.angleTo(rotation(1)), 0);
    assert.equal(h.bridge.start(snapshot, []), false); assert.equal(h.bridge.getState().weight, 1);
  } finally { h.dispose(); }
});

// R29c: cancel hand-off helpers (the Stage scenarios are in tests/r29c-continuity.test.ts).

function rig() {
  // root -> spine -> neck -> head; spine -> arm -> elbowTwist (a grant child of arm);
  // root -> ikTarget; root -> chainRoot -> link (IK link toward ikTarget) -> strap (a grant child of link), effector.
  const geometry = new BufferGeometry(), material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material);
  const names = ['root', 'spine', 'neck', 'head', 'arm', 'elbowTwist', 'ikTarget', 'chainRoot', 'link', 'strap', 'effector'];
  const bones = names.map(name => { const value = new Bone(); value.name = name; return value; });
  const by = Object.fromEntries(bones.map(value => [value.name, value])) as Record<string, Bone>;
  mesh.add(by.root);
  for (const [child, parent] of [['spine', 'root'], ['neck', 'spine'], ['head', 'neck'], ['arm', 'spine'], ['elbowTwist', 'arm'],
    ['ikTarget', 'root'], ['chainRoot', 'root'], ['link', 'chainRoot'], ['strap', 'link'], ['effector', 'link']] as const) by[parent].add(by[child]);
  mesh.bind(new Skeleton(bones));
  const index = (name: string) => names.indexOf(name);
  geometry.userData.MMD = {
    grants: [{ index: index('elbowTwist'), parentIndex: index('arm'), ratio: 1, affectRotation: true, affectPosition: false },
      { index: index('strap'), parentIndex: index('link'), ratio: 1, affectRotation: true, affectPosition: false }],
    iks: [{ target: index('ikTarget'), effector: index('effector'), links: [{ index: index('link') }] }],
  };
  mesh.morphTargetInfluences = []; mesh.morphTargetDictionary = {};
  return { mesh, by, dispose() { geometry.dispose(); material.dispose(); mesh.skeleton.dispose(); } };
}
const q = (name: string) => `.bones[${name}].quaternion`;
const turn = (degrees: number) => new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), degrees * Math.PI / 180);

test('R29c withDerivedBones: grant children and IK links the helper derives from moved bones are bridged too', () => {
  const r = rig();
  try {
    assert.deepEqual(withDerivedBones(r.mesh, [q('arm')]).sort(), [q('arm'), q('elbowTwist')].sort(), 'a grant child follows its source');
    assert.deepEqual(withDerivedBones(r.mesh, [q('head')]), [q('head')], 'nothing hangs off the head');
    // Moving the root moves the IK target: the link re-solves, and its grant child follows.
    assert.deepEqual(withDerivedBones(r.mesh, [q('root')]).sort(), [q('root'), q('link'), q('strap')].sort());
    const plainGeometry = new BufferGeometry(), plainMaterial = new MeshBasicMaterial(), plain = new SkinnedMesh(plainGeometry, plainMaterial);
    const lone = new Bone(); lone.name = 'root'; plain.add(lone); plain.bind(new Skeleton([lone]));
    assert.deepEqual(withDerivedBones(plain, [q('root')]), [q('root')], 'no MMD metadata adds nothing');
    plainGeometry.dispose(); plainMaterial.dispose();
  } finally { r.dispose(); }
});

test('R29c hand-off duration: sized on the first composed frame from the correction summed down bridged chains; bounded acceleration', () => {
  assert.equal(handoffDurationMs(0), HANDOFF_MIN_MS); assert.equal(handoffDurationMs(1e6), HANDOFF_MAX_MS); assert.equal(handoffDurationMs(NaN), HANDOFF_MIN_MS);
  for (const degrees of [5, 10, 20, 30]) {
    const seconds = handoffDurationMs(degrees) / 1000;
    if (seconds > HANDOFF_MIN_MS / 1000 && seconds < HANDOFF_MAX_MS / 1000)
      assert.ok(Math.abs(6 * degrees / seconds ** 2 - HANDOFF_ACCELERATION) < 1e-6, `${degrees} deg: smoothstep peak acceleration stays at the bound`);
  }
  const r = rig();
  try {
    const snapshot = captureMotionPose(r.mesh), sizes: number[] = [];
    const bridge = new MotionTransition(r.mesh);
    // The owner left: neck and head both turn back (10 + 5 deg on screen).
    r.by.neck.quaternion.copy(turn(10)); r.by.head.quaternion.copy(turn(5));
    assert.equal(bridge.start(snapshot, [q('neck'), q('head')], degrees => { sizes.push(degrees); return 500; }), true);
    bridge.frame(0);
    assert.deepEqual(sizes, [], 'an event-time rebuild (dt 0) does not size it');
    assert.ok(r.by.head.quaternion.angleTo(new Quaternion()) < 1e-6, 'dt 0 shows the captured pose');
    bridge.restore(); bridge.frame(1 / 60);
    assert.equal(sizes.length, 1); assert.ok(Math.abs(sizes[0] - 15) < 1e-4, `chain sum ${sizes[0]}`);
    assert.equal(bridge.getState().durationMs, 500);
    bridge.restore(); bridge.frame(1 / 60);
    assert.equal(sizes.length, 1, 'sized once');
    bridge.dispose();
  } finally { r.dispose(); }
});

test('R29c handOffToBase: captures before physics, stops exactly once, restores outer layers, bridges from the shown pose', () => {
  const r = rig();
  try {
    const order: string[] = [];
    const physics = { restore: () => { order.push('physics.restore'); }, frame: (dt: number) => { order.push(`physics.frame:${dt}`); } };
    r.by.arm.quaternion.copy(turn(12)); // shown: the body motion's arm
    const stop = () => { order.push('stop'); r.by.arm.quaternion.identity(); }; // the base, rebuilt at dt 0
    const bridge = handOffToBase(r.mesh, true, null, physics, [q('arm')], stop);
    assert.ok(bridge && bridge.getState().active);
    assert.deepEqual(order, ['physics.restore', 'stop', 'physics.restore', 'physics.frame:0']);
    assert.ok(r.by.arm.quaternion.angleTo(turn(12)) < 1e-6, 'the shown pose stays on screen at event time');
    assert.equal(bridge!.ownsProperty(q('elbowTwist')), true, 'the grant child is bridged with it');
    bridge!.restore(); assert.ok(r.by.arm.quaternion.angleTo(new Quaternion()) < 1e-6, 'restore gives the base back');
    const calls: string[] = [];
    assert.equal(handOffToBase(r.mesh, false, null, null, [q('arm')], () => { calls.push('stop'); }), null, 'never rendered: nothing to hand off');
    assert.deepEqual(calls, ['stop']);
    bridge!.dispose();
  } finally { r.dispose(); }
});
