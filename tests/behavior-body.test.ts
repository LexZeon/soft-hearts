import assert from 'node:assert/strict';
import test from 'node:test';
import { AdditiveAnimationBlendMode, AnimationClip, Bone, BufferGeometry, LoopOnce, LoopPingPong,
  MeshBasicMaterial, NumberKeyframeTrack, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh,
  Vector3, VectorKeyframeTrack, type AnimationAction, type AnimationMixer, type KeyframeTrack } from 'three';
import { BEHAVIOR_IDLE_BONES, BehaviorBodyPlayer, isBehaviorBodyTrack,
  type BehaviorBodyMaskId } from '../src/stage/behavior-body';
import { LayeredMmdAnimation } from '../src/stage/motion-layers';

const axis = new Vector3(0, 0, 1);
const orientation = (angle: number) => new Quaternion().setFromAxisAngle(axis, angle);
const rotation = (name: string, angle = 1, end = angle, duration = 2) =>
  new QuaternionKeyframeTrack(`.bones[${name}].quaternion`, [0, duration], [...orientation(angle).toArray(), ...orientation(end).toArray()]);
const position = (name: string, value: number, duration = 2) =>
  new VectorKeyframeTrack(`.bones[${name}].position`, [0, duration], [value, 0, 0, value, 0, 0]);
const expression = (value = 0.6, duration = 2) =>
  new NumberKeyframeTrack('.morphTargetInfluences[0]', [0, duration], [value, value]);
const clip = (name: string, tracks: KeyframeTrack[], duration = 2) => new AnimationClip(name, duration, tracks);

function fixture(allowBaseProjection = false) {
  const geometry = new BufferGeometry(); geometry.userData.MMD = { iks: [], grants: [] };
  const material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material);
  const bones = Object.fromEntries([...BEHAVIOR_IDLE_BONES, 'センター', '左目', '顎', '左人指１', '首飾り'].map(name => {
    const bone = new Bone(); bone.name = name; mesh.add(bone); return [name, bone];
  }));
  mesh.bind(new Skeleton(Object.values(bones)));
  mesh.morphTargetDictionary = { smile: 0 }; mesh.morphTargetInfluences = [0];
  const animation = new LayeredMmdAnimation(mesh), dependencies = animation.getBehaviorBodyBindings({ allowBaseProjection });
  const mixer = dependencies.mixer as AnimationMixer & { _actions: AnimationAction[] };
  const bases: AnimationAction[] = []; let guardCalls = 0;
  const guarded = <T>(mutation: () => T): T => { guardCalls++; return dependencies.withBoneBindings(mutation); };
  const player = new BehaviorBodyPlayer({ ...dependencies, baseActions: () => bases, withBoneBindings: guarded });
  const addBase = (source: AnimationClip, weight = 1) => guarded(() => {
    const action = mixer.clipAction(source).setEffectiveWeight(weight).play(); bases.push(action); return action;
  });
  const removeBase = (action: AnimationAction) => guarded(() => {
    bases.splice(bases.indexOf(action), 1); action.stop(); mixer.uncacheAction(action.getClip());
  });
  const step = (delta: number, blocked = false) => { const state = player.beforeUpdate(delta, blocked); animation.helper.update(delta); return state; };
  const play = (id: string, source: AnimationClip, maskId: BehaviorBodyMaskId = 'candidate-head-v1', strength?: number) =>
    player.play({ id, clip: source, maskId, durationMs: source.duration * 1_000, strength });
  const dispose = () => { player.dispose(); animation.dispose(); mesh.skeleton.dispose(); geometry.dispose(); material.dispose(); };
  return { animation, mesh, bones, mixer, bases, player, addBase, removeBase, step, play, dispose, guardCalls: () => guardCalls };
}
function expectAngle(bone: Bone, expected: number, tolerance = 1e-6): void {
  assert.ok(bone.quaternion.clone().normalize().angleTo(orientation(expected).normalize()) < tolerance,
    `${bone.name}: expected ${expected}, got ${bone.quaternion.toArray()}`);
}

test('candidate masks are exact properties and exactly the reviewed 23 idle bones', () => {
  assert.equal(BEHAVIOR_IDLE_BONES.length, 23); assert.equal(new Set(BEHAVIOR_IDLE_BONES).size, 23);
  for (const bone of BEHAVIOR_IDLE_BONES) {
    assert.equal(isBehaviorBodyTrack(`.bones[${bone}].quaternion`, 'candidate-pose-v1'), true);
    assert.equal(isBehaviorBodyTrack(`.bones[${bone}].position`, 'candidate-pose-v1'), true);
    assert.equal(isBehaviorBodyTrack(`.bones[${bone}].scale`, 'candidate-pose-v1'), false);
  }
  for (const name of ['.bones[首].quaternion', '.bones[頭].quaternion'])
    assert.equal(isBehaviorBodyTrack(name, 'candidate-head-v1'), true);
  for (const name of ['.bones[首].position', '.bones[head].quaternion', '.bones[頭髪].quaternion',
    '.bones[両目].quaternion', '.bones[センター].position', '.bones[左人指１].quaternion',
    '.bones[首飾り].quaternion', '.morphTargetInfluences[0]', '.position']) {
    assert.equal(isBehaviorBodyTrack(name, 'candidate-head-v1'), false, name);
    if (!name.startsWith('.bones[首].')) assert.equal(isBehaviorBodyTrack(name, 'candidate-pose-v1'), false, name);
  }
});

test('one temporary Action uses the existing mixer, preserves source objects/factories and complete duration', () => {
  const h = fixture();
  try {
    const source = clip('source', [rotation('頭'), rotation('首'), rotation('左腕'), position('頭', 2), expression()], 10);
    const tracks = [...source.tracks], factories = source.tracks.map(track => track.createInterpolant);
    const before = h.mixer._actions.length;
    assert.equal(h.play('head-once', source), true);
    assert.equal(h.mixer._actions.length, before + 1);
    const action = h.mixer._actions.at(-1)!;
    assert.equal(action.getMixer(), h.mixer); assert.equal(action.getClip().duration, 10);
    assert.equal(action.loop, LoopOnce); assert.equal(action.clampWhenFinished, false);
    assert.deepEqual(action.getClip().tracks, tracks.slice(0, 2));
    assert.equal(action.getClip().tracks[0], tracks[0]);
    assert.deepEqual(source.tracks, tracks); assert.deepEqual(source.tracks.map(track => track.createInterpolant), factories);
    h.step(0.5); expectAngle(h.bones['頭'], 0.2); expectAngle(h.bones['左腕'], 0);
    assert.equal(h.bones['頭'].position.x, 0); assert.equal(h.mesh.morphTargetInfluences![0], 0);
    h.player.stop(); assert.equal(h.mixer._actions.length, before);
  } finally { h.dispose(); }
});

test('an entirely covered base blends by 1-w while original phase/timeScale and independent face continue', () => {
  const h = fixture();
  try {
    const base = h.addBase(clip('base', [rotation('頭', 0.4)], 8)); base.setEffectiveTimeScale(0.5);
    const face = h.addBase(clip('face', [expression(0.65)], 8));
    h.animation.helper.update(0.5);
    assert.equal(h.play('head-base', clip('head', [rotation('頭', 1)])), true);
    h.step(0.5);
    assert.equal(base.time, 0.5); assert.equal(base.timeScale, 0.5); assert.equal(face.time, 1);
    assert.ok(Math.abs(base.getEffectiveWeight() - 0.8) < 1e-10);
    assert.equal(face.getEffectiveWeight(), 1); assert.ok(Math.abs(h.mesh.morphTargetInfluences![0] - 0.65) < 1e-6);
    expectAngle(h.bones['頭'], 0.52);
    h.player.stop(); assert.equal(base.getEffectiveWeight(), 1);
    h.animation.helper.update(0.1); expectAngle(h.bones['頭'], 0.4);
    assert.equal(base.timeScale, 0.5); assert.ok(Math.abs(base.time - 0.55) < 1e-9);
  } finally { h.dispose(); }
});

test('a partially overlapping base rejects by default and leaves all original bindings and weights unchanged', () => {
  const h = fixture();
  try {
    const base = h.addBase(clip('mixed', [rotation('頭', 0.4), rotation('左腕', 0.3), expression()], 8), 0.7);
    h.animation.helper.update(0.4); const before = [...h.mixer._actions];
    assert.equal(h.play('reject-partial', clip('head', [rotation('頭')])), false);
    assert.equal(h.player.getState().reason, 'partial-base-overlap');
    assert.deepEqual(new Set(h.player.getState().blockedBaseProperties), new Set(['.bones[左腕].quaternion', '.morphTargetInfluences[0]']));
    assert.deepEqual(h.mixer._actions, before); assert.equal(base.getEffectiveWeight(), 0.7); assert.equal(base.time, 0.4);
  } finally { h.dispose(); }
});

test('opt-in projection keeps original clock at weight zero and unrelated base properties at original weight', () => {
  const h = fixture(true);
  try {
    const source = clip('mixed', [rotation('頭', 0.4), rotation('左腕', 0.3), rotation('左人指１', 0.45), expression(0.7)], 8);
    const base = h.addBase(source); base.setEffectiveTimeScale(0.75);
    const sourceTracks = [...source.tracks], factories = source.tracks.map(track => track.createInterpolant);
    h.animation.helper.update(0.4);
    assert.equal(h.play('project-partial', clip('head', [rotation('頭')])), true);
    assert.equal(h.mixer._actions.length, 4); assert.equal(base.weight, 0); assert.equal(base.enabled, true); assert.equal(base.paused, false);
    for (let frame = 0; frame < 20; frame++) h.step(1 / 30);
    assert.ok(Math.abs(base.time - 0.8) < 1e-9); assert.equal(base.timeScale, 0.75);
    expectAngle(h.bones['頭'], 0.52); expectAngle(h.bones['左腕'], 0.3); expectAngle(h.bones['左人指１'], 0.45);
    assert.ok(Math.abs(h.mesh.morphTargetInfluences![0] - 0.7) < 1e-6);
    const projections = h.mixer._actions.filter(action => action !== base && action.getClip().name.startsWith('behavior-base:'));
    assert.equal(projections.length, 2);
    for (const action of projections) {
      assert.equal(action.getMixer(), h.mixer); assert.equal(action.getClip().duration, source.duration);
      assert.equal(action.timeScale, 0.75); assert.ok(Math.abs(action.time - base.time) < 1e-9);
      assert.ok(action.getClip().tracks.every(track => sourceTracks.includes(track)));
    }
    h.player.stop(); assert.deepEqual(h.mixer._actions, [base]); assert.equal(base.weight, 1);
    h.animation.helper.update(0); expectAngle(h.bones['頭'], 0.4); expectAngle(h.bones['左人指１'], 0.45);
    assert.deepEqual(source.tracks, sourceTracks); assert.deepEqual(source.tracks.map(track => track.createInterpolant), factories);
  } finally { h.dispose(); }
});

test('idle foot/IK properties are already mixed at the original helper IK entry', () => {
  const h = fixture();
  try {
    let observed = NaN; const solver = h.animation.helper.objects.get(h.mesh)!.ikSolver!;
    solver.update = () => { observed = h.bones['左足ＩＫ'].position.x; return solver; };
    assert.equal(h.play('idle-ik', clip('idle', [position('左足ＩＫ', 2), rotation('左ひざ', 0.4)]), 'candidate-pose-v1'), true);
    h.step(0.5);
    assert.ok(Math.abs(observed - 0.4) < 1e-6); expectAngle(h.bones['左ひざ'], 0.08);
    h.player.stop(); h.animation.helper.update(0); assert.equal(h.bones['左足ＩＫ'].position.x, 0);
  } finally { h.dispose(); }
});

test('beforeUpdate sets a bounded upcoming-time envelope without advancing any Action', () => {
  const h = fixture();
  try {
    const base = h.addBase(clip('base', [rotation('頭', 0.2)], 8));
    assert.equal(h.play('timing', clip('head', [rotation('頭')])), true);
    const temporary = h.mixer._actions.find(action => action !== base)!;
    const first = h.player.beforeUpdate(0.125, false);
    assert.equal(first.weight, 0.1); assert.equal(first.nextTimeMs, 125); assert.equal(first.elapsedMs, 0);
    assert.equal(base.time, 0); assert.equal(temporary.time, 0);
    assert.equal(h.player.beforeUpdate(0.125, false).weight, 0.1, 'predicting twice cannot advance the source');
    h.animation.helper.update(0.125);
    assert.equal(temporary.time, 0.125); assert.equal(base.time, 0.125);
    h.step(0.125); assert.equal(h.player.getState().weight, 0.2);
    h.step(1.525); assert.ok(Math.abs(h.player.getState().weight - 0.1) < 1e-9);
    const actionsBefore = h.mixer._actions.length;
    const boundary = h.player.beforeUpdate(0.225, false);
    assert.equal(boundary.active, false); assert.equal(h.mixer._actions.length, actionsBefore - 1);
    assert.equal(base.getEffectiveWeight(), 1); assert.ok(Math.abs(base.time - 1.775) < 1e-9);
    h.animation.helper.update(0.225); assert.ok(Math.abs(base.time - 2) < 1e-9);
  } finally { h.dispose(); }
});

test('cancel and uncache update helper bone snapshots so unbound poses never return on later ticks', () => {
  const h = fixture();
  try {
    assert.equal(h.play('snapshot', clip('idle', [position('左足ＩＫ', 2), rotation('頭')]), 'candidate-pose-v1'), true);
    h.step(0.5); expectAngle(h.bones['頭'], 0.2); assert.ok(h.bones['左足ＩＫ'].position.x > 0);
    const calls = h.guardCalls(); h.player.stop(); assert.ok(h.guardCalls() > calls);
    for (let frame = 0; frame < 5; frame++) { h.animation.helper.update(0.1); expectAngle(h.bones['頭'], 0); assert.equal(h.bones['左足ＩＫ'].position.x, 0); }
    assert.equal(h.mixer._actions.length, 0);
  } finally { h.dispose(); }
});

test('repeated overlays and cancels do not accumulate pose drift or cached Actions', () => {
  const h = fixture(true);
  try {
    const base = h.addBase(clip('mixed', [rotation('頭', 0.35), rotation('左人指１', 0.2)], 8));
    for (let cycle = 0; cycle < 12; cycle++) {
      assert.equal(h.play(`cycle-${cycle}`, clip('head', [rotation('頭')])), true);
      for (let frame = 0; frame < 3; frame++) h.step(0.1);
      expectAngle(h.bones['左人指１'], 0.2); h.player.stop(); h.animation.helper.update(0);
      expectAngle(h.bones['頭'], 0.35); expectAngle(h.bones['左人指１'], 0.2);
      assert.deepEqual(h.mixer._actions, [base]); assert.equal(base.weight, 1);
    }
    assert.ok(Math.abs(base.time - 3.6) < 1e-8);
  } finally { h.dispose(); }
});

test('an omitted or invalid blocked value cancels instead of granting playback', () => {
  for (const blocked of [true, undefined, null, 0, 'false']) {
    const h = fixture();
    try {
      assert.equal(h.play('fail-closed', clip('head', [rotation('頭')])), true); h.step(0.5);
      assert.equal(h.player.beforeUpdate(0.1, blocked as boolean).active, false);
      h.animation.helper.update(0); expectAngle(h.bones['頭'], 0);
      assert.equal(h.play('fail-closed', clip('head', [rotation('頭')])), false);
    } finally { h.dispose(); }
  }
});

test('changed base identity removes owned projections without restoring an obsolete original', () => {
  const h = fixture(true);
  try {
    const old = h.addBase(clip('mixed', [rotation('頭', 0.4), rotation('左人指１', 0.2)], 8));
    assert.equal(h.play('rebind', clip('head', [rotation('頭')])), true); h.step(0.5);
    assert.equal(old.weight, 0); h.removeBase(old);
    const next = h.addBase(clip('replacement', [rotation('頭', 0.6), rotation('左人指１', 0.1)], 8));
    const result = h.player.beforeUpdate(0.1, false);
    assert.equal(result.reason, 'base-rebound'); assert.equal(result.active, false);
    assert.equal(old.weight, 0); assert.equal(old.isScheduled(), false);
    assert.deepEqual(h.mixer._actions, [next]); assert.equal(next.weight, 1);
    h.animation.helper.update(0); expectAngle(h.bones['頭'], 0.6);
  } finally { h.dispose(); }
});

test('external base pause/timeScale/weight edits are not undone during cancellation', () => {
  for (const change of ['paused', 'timeScale', 'weight'] as const) {
    const h = fixture(true);
    try {
      const base = h.addBase(clip('mixed', [rotation('頭'), rotation('左人指１')], 8));
      assert.equal(h.play('external-edit', clip('head', [rotation('頭')])), true); h.step(0.5);
      if (change === 'paused') base.paused = true;
      else if (change === 'timeScale') base.setEffectiveTimeScale(0.25);
      else base.setEffectiveWeight(0.6);
      assert.equal(h.player.beforeUpdate(0.1, false).active, false);
      if (change === 'paused') assert.equal(base.paused, true);
      else if (change === 'timeScale') assert.equal(base.timeScale, 0.25);
      else assert.equal(base.weight, 0.6);
      assert.deepEqual(h.mixer._actions, [base]);
    } finally { h.dispose(); }
  }
});

test('a newly scheduled base fade is rejected without cancelling that external fade', () => {
  const h = fixture(true);
  try {
    const base = h.addBase(clip('mixed', [rotation('頭'), rotation('左人指１')], 8));
    base.fadeOut(1);
    assert.equal(base.getEffectiveWeight(), base.weight, 'a just-scheduled fade has not affected effective weight yet');
    assert.equal(h.play('pending-fade', clip('head', [rotation('頭')])), false);
    assert.equal(h.player.getState().reason, 'base-fade');
    const fading = (base as AnimationAction & { _weightInterpolant: unknown })._weightInterpolant;
    assert.ok(fading); base.stopFading();
    assert.equal(h.play('later-fade', clip('head', [rotation('頭')])), true); h.step(0.5);
    base.fadeOut(1); const newer = (base as AnimationAction & { _weightInterpolant: unknown })._weightInterpolant;
    assert.equal(h.player.beforeUpdate(0.1, false).active, false);
    assert.equal((base as AnimationAction & { _weightInterpolant: unknown })._weightInterpolant, newer);
    assert.equal(base.weight, 1);
  } finally { h.dispose(); }
});

test('unsupported additive, ping-pong, paused, finite or scheduled bases fail closed', () => {
  for (const kind of ['additive', 'pingpong', 'paused', 'finite', 'scheduled', 'warped'] as const) {
    const h = fixture(true);
    try {
      const source = clip('base', [rotation('頭'), rotation('左人指１')], 8);
      if (kind === 'additive') source.blendMode = AdditiveAnimationBlendMode;
      const base = h.addBase(source);
      if (kind === 'pingpong') base.setLoop(LoopPingPong, Infinity);
      if (kind === 'paused') base.paused = true;
      if (kind === 'finite') base.setLoop(LoopOnce, 1);
      if (kind === 'scheduled') base.startAt(10);
      if (kind === 'warped') base.warp(1, 2, 1);
      const before = [...h.mixer._actions];
      assert.equal(h.play(`reject-${kind}`, clip('head', [rotation('頭')])), false, kind);
      assert.equal(h.player.getState().reason, 'unsupported-base-blend', kind); assert.deepEqual(h.mixer._actions, before);
    } finally { h.dispose(); }
  }
});

test('invalid duration, strength, duplicate properties and broken tracks cannot create a partial binding', () => {
  const h = fixture();
  try {
    const invalid = rotation('頭'); invalid.values[0] = NaN;
    const cases = [clip('empty', [expression()]), clip('duplicate', [rotation('頭'), rotation('頭')]), clip('invalid', [invalid])];
    for (const [index, source] of cases.entries()) {
      assert.equal(h.play(`invalid-${index}`, source), false); assert.equal(h.mixer._actions.length, 0);
    }
    for (const strength of [0, -1, NaN, Infinity, 0.31]) assert.equal(h.play(`strength-${String(strength).replace('-', '_')}`, clip('head', [rotation('頭')]), 'candidate-head-v1', strength), false);
    assert.equal(h.player.play({ id: 'cropped', clip: clip('head', [rotation('頭')]), maskId: 'candidate-head-v1', durationMs: 1_000 }), false);
    assert.equal(h.mixer._actions.length, 0);
  } finally { h.dispose(); }
});

test('consumed cue IDs cannot replay after cancellation and dispose releases every owned Action', () => {
  const h = fixture(true);
  try {
    const base = h.addBase(clip('mixed', [rotation('頭', 0.4), rotation('左人指１', 0.2)], 8));
    const source = clip('head', [rotation('頭')]);
    assert.equal(h.play('consumed', source), true); h.step(0.5); h.player.stop();
    assert.equal(h.play('consumed', source), false);
    assert.equal(h.play('next', source), true); h.step(0.5); const phase = base.time;
    h.player.dispose(); assert.deepEqual(h.mixer._actions, [base]); assert.equal(base.weight, 1); assert.equal(base.time, phase);
    assert.equal(h.play('after-dispose', source), false); assert.equal(h.player.beforeUpdate(0.1, false).reason, 'disposed');
  } finally { h.dispose(); }
});

test('an unavailable teardown guard still drops owned Actions and refs without reviving a base', () => {
  const h = fixture(true); let guardUnavailable = false;
  const dependencies = h.animation.getBehaviorBodyBindings({ allowBaseProjection: true });
  const player = new BehaviorBodyPlayer({ ...dependencies, baseActions: () => h.bases,
    withBoneBindings: <T>(mutation: () => T): T => {
      if (guardUnavailable) throw new Error('Layered owner already unavailable');
      return dependencies.withBoneBindings(mutation);
    } });
  try {
    const base = h.addBase(clip('mixed', [rotation('頭', 0.4), rotation('左人指１', 0.2)], 8));
    const source = clip('head', [rotation('頭')]);
    assert.equal(player.play({ id: 'teardown', clip: source, maskId: 'candidate-head-v1', durationMs: 2_000 }), true);
    player.beforeUpdate(0.5, false); h.animation.helper.update(0.5);
    guardUnavailable = true; player.dispose();
    assert.equal(player.getState().active, false); assert.equal(player.getState().reason, 'binding-error');
    assert.deepEqual(h.mixer._actions, [base]); assert.equal(base.weight, 1); assert.equal(base.time, 0.5);
    assert.equal(player.play({ id: 'no-reentry', clip: source, maskId: 'candidate-head-v1', durationMs: 2_000 }), false);
  } finally { player.dispose(); h.dispose(); }
});
