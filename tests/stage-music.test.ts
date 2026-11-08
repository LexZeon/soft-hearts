import assert from "node:assert/strict";
import test from "node:test";
import { AnimationClip, Bone, BufferGeometry, Euler, MeshBasicMaterial, Quaternion, QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, VectorKeyframeTrack, type AnimationAction, type AnimationMixer } from "three";
import { MmdStage } from "../src/stage/MmdStage";
import { MUSIC_DANCE_LIMITS, MUSIC_RELEASE_SECONDS, MUSIC_YIELD_SECONDS, MusicDance, musicReleaseGain, type MusicDancePose, type MusicEnergySample } from "../src/stage/music-dance";
import { LayeredMmdAnimation } from '../src/stage/motion-layers';
import { EMPTY_CONTACT, type MoodContact } from '../src/stage/mood-feedback';
import type { MusicSettings } from '../shared/music-settings';

interface MusicStageHarness {
  mesh: SkinnedMesh | null;
  musicDance: MusicDance;
  musicEnabled: boolean;
  disposed: boolean;
  height: number;
  center?: Bone;
  chest?: Bone;
  head?: Bone;
  arms: { bone: Bone; roll: number }[];
  boneLayers: unknown[];
  morphLayers: unknown[];
  musicSettings: MusicSettings;
  musicManualHeadBlocked: boolean;
  musicCameraEditing: boolean;
  musicSuppressed: boolean;
  musicBlockReason: string | null;
  musicPose: MusicDancePose;
  musicSignal: unknown;
  speaking: boolean;
  behaviorBlocked: boolean;
  moodContact: MoodContact;
  controls: { interacting: boolean };
  setMusicEnabled(enabled: boolean): void;
  setMusicSample(sample: MusicEnergySample): void;
  setMusicSettings(settings: Partial<MusicSettings>): void;
  setSpeaking(active: boolean): void;
  setBehaviorBlocked(blocked: boolean): void;
  setMoodContact(contact: MoodContact): void;
  animateMusic(delta: number): void;
  restoreLayers(): void;
}

function harness() {
  const geometry = new BufferGeometry();
  geometry.userData.MMD = { iks: [], grants: [] };
  const material = new MeshBasicMaterial();
  const mesh = new SkinnedMesh(geometry, material);
  const center = new Bone(), chest = new Bone(), head = new Bone();
  const hand = new Bone(), arm = new Bone(), eye = new Bone();
  mesh.add(center);
  center.add(chest);
  chest.add(head, arm);
  arm.add(hand);
  head.add(eye);
  const bones = [center, chest, head, arm, hand, eye];
  bones.forEach((bone, i) => { bone.name = ["センター", "上半身2", "頭", "左腕", "左手首", "左目"][i]; });
  mesh.bind(new Skeleton(bones));
  mesh.morphTargetDictionary = { smile: 0, blink: 1 };
  mesh.morphTargetInfluences = [0.3, 0.7];
  // Run the real stage methods without a canvas, renderer, or animation loop.
  const stage = Object.create(MmdStage.prototype) as MusicStageHarness;
  Object.assign(stage,{surprisePending:null,surprisePreview:null}); // Real constructor defaults for the inactive preview owner.
  Object.assign(stage, {
    mesh, center, chest, head,
    musicDance: new MusicDance(),
    musicEnabled: false,
    disposed: false,
    height: 20,
    arms: [{ bone: arm, roll: 0.2 }],
    boneLayers: [], morphLayers: [],
    rotation: new Euler(), offset: new Quaternion(),
    musicSettings: { strength: 0.7 }, musicSuppressed: false, musicBlockReason: null,
    musicManualHeadBlocked: false, musicCameraEditing: false,
    speaking: false, behaviorBlocked: false, moodContact: { ...EMPTY_CONTACT },
    hostVisible: true, controls: { interacting: false }, chatGestureGeneration: 0,
  });
  return { stage, mesh, center, chest, head, arm, hand, eye, bones,
    dispose: () => { geometry.dispose(); material.dispose(); } };
}

function sample(frame: number): MusicEnergySample {
  const kick = frame % 15 === 0;
  return { time: frame / 30, rms: kick ? 0.35 : 0.12, low: kick ? 0.7 : 0.08, mid: 0.18 + Math.sin(frame / 20) * 0.1, high: 0.1 };
}

function snapshot(bone: Bone) {
  return { quaternion: bone.quaternion.clone(), position: bone.position.clone() };
}

function exactPose(bone: Bone, base: ReturnType<typeof snapshot>): void {
  // Multiplying an identity offset may turn IEEE -0 into +0; all numeric values must still match exactly.
  const values = (parts: number[]) => parts.map(value => value === 0 ? 0 : value);
  assert.deepEqual(values(bone.quaternion.toArray()), values(base.quaternion.toArray()), `${bone.name} quaternion restored exactly`);
  assert.deepEqual(values(bone.position.toArray()), values(base.position.toArray()), `${bone.name} position restored exactly`);
}

function localOffset(bone: Bone, base: ReturnType<typeof snapshot>): Euler {
  const delta = base.quaternion.clone().invert().multiply(bone.quaternion).normalize();
  return new Euler().setFromQuaternion(delta, "YXZ");
}

test("240 animated base poses keep music bounded, leave hand/face tracks intact, and restore without accumulation", () => {
  const h = harness();
  try {
    h.stage.setMusicEnabled(true);
    let sawCenter = false, sawChest = false, sawHead = false;
    for (let frame = 0; frame < 240; frame++) {
      h.stage.restoreLayers();
      // Stand in for each new VMD frame, including a moving non-default body pose.
      for (const [i, bone] of h.bones.entries()) {
        bone.quaternion.setFromEuler(new Euler(Math.sin(frame / 20 + i) * 0.3, Math.cos(frame / 25 + i) * 0.25, i * 0.12, "YXZ"));
        bone.position.set(i + Math.sin(frame / 30) * 0.2, i * 0.3 + Math.cos(frame / 20) * 0.1, i * -0.2);
      }
      h.mesh.morphTargetInfluences = [frame % 11 / 10, Math.sin(frame / 20) ** 2];
      const bases = h.bones.map(snapshot);
      const face = [...h.mesh.morphTargetInfluences];
      h.stage.setMusicSample(sample(frame));
      h.stage.animateMusic(1 / 30);

      const center = localOffset(h.center, bases[0]);
      const chest = localOffset(h.chest, bases[1]);
      const head = localOffset(h.head, bases[2]);
      assert.ok(Math.abs(center.x) < 1e-12 && Math.abs(center.y) < 1e-12);
      assert.ok(Math.abs(center.z) <= MUSIC_DANCE_LIMITS.sway + 1e-12);
      assert.ok(Math.abs(chest.x) < 1e-12 && Math.abs(chest.y) < 1e-12);
      assert.ok(Math.abs(chest.z) <= MUSIC_DANCE_LIMITS.chestRoll + 1e-12);
      assert.ok(Math.abs(head.x) <= MUSIC_DANCE_LIMITS.headPitch + 1e-12);
      assert.ok(Math.abs(head.y) < 1e-12);
      assert.ok(Math.abs(head.z) <= MUSIC_DANCE_LIMITS.headRoll + 1e-12);
      const bounce = h.center.position.y - bases[0].position.y;
      assert.ok(bounce >= 0 && bounce <= h.stage.height * MUSIC_DANCE_LIMITS.bounce + 1e-12);
      assert.equal(h.center.position.x, bases[0].position.x);
      assert.equal(h.center.position.z, bases[0].position.z);
      assert.deepEqual(h.chest.position.toArray(), bases[1].position.toArray());
      assert.deepEqual(h.head.position.toArray(), bases[2].position.toArray());
      for (const i of [3, 4, 5]) exactPose(h.bones[i], bases[i]);
      assert.deepEqual(h.mesh.morphTargetInfluences, face);
      assert.equal(h.stage.morphLayers.length, 0);
      assert.equal(h.stage.boneLayers.length, 3);
      sawCenter ||= Math.abs(center.z) > 1e-4 || bounce > 1e-4;
      sawChest ||= Math.abs(chest.z) > 1e-4;
      sawHead ||= Math.abs(head.x) > 1e-4 || Math.abs(head.z) > 1e-4;

      h.stage.restoreLayers();
      h.bones.forEach((bone, i) => exactPose(bone, bases[i]));
      assert.deepEqual(h.mesh.morphTargetInfluences, face);
      assert.equal(h.stage.boneLayers.length, 0);
    }
    assert.ok(sawCenter && sawChest && sawHead, "all supported body regions must actually move");
  } finally { h.dispose(); }
});

test("turning music off preserves the shown frame and fades over the same advancing real base action", () => {
  const h = harness();
  const animation = new LayeredMmdAnimation(h.mesh);
  try {
    const source = new AnimationClip('advancing-base', 10, [
      new VectorKeyframeTrack('.bones[センター].position', [0, 10], [0, 0.4, 0, 0, 0.8, 0]),
      new QuaternionKeyframeTrack('.bones[左腕].quaternion', [0, 10], [0, 0, 0, 1, 0.2, 0, 0, Math.sqrt(0.96)]),
    ]);
    animation.setClips({ pose: source, gesture: null, expression: null });
    const mixer = animation.helper.objects.get(h.mesh)!.mixer! as AnimationMixer & { _actions: AnimationAction[] };
    const action = mixer._actions.find(value => value.getClip().name.endsWith(':pose'))!;
    const step = (delta: number, input?: MusicEnergySample) => {
      h.stage.restoreLayers(); animation.helper.update(delta);
      const base = h.bones.map(snapshot);
      if (input) h.stage.setMusicSample(input);
      h.stage.animateMusic(delta);
      return base;
    };
    const face = [...h.mesh.morphTargetInfluences!];
    h.stage.setMusicEnabled(true);
    for (let frame = 0; frame < 64; frame++) step(1 / 30, sample(frame));
    const shown = h.bones.map(snapshot), pitch = h.stage.musicPose.headPitch;
    assert.ok(pitch > 0.01, 'the music layer really had a visible offset before stop');
    const time = action.time;
    h.stage.setMusicEnabled(false);
    h.bones.forEach((bone, i) => exactPose(bone, shown[i]));
    assert.equal(action.time, time, 'the off event does not advance or reset the base clock');
    assert.equal(h.stage.musicDance.getState().active, false);
    assert.equal(h.stage.musicBlockReason, 'disabled');
    h.stage.setMusicSample(sample(90));
    assert.equal(h.stage.musicDance.getState().pulse, false, 'a late captured sample is rejected immediately');
    // R15: the dance keeps moving and eases out over the still-advancing base.
    const frames = Math.ceil(MUSIC_RELEASE_SECONDS * 60) + 2;
    let previous = pitch, lastBase = shown, later = 0;
    for (let frame = 0; frame < frames; frame++) {
      lastBase = step(1 / 60);
      const offset = localOffset(h.head, lastBase[2]).x, seconds = (frame + 1) / 60;
      if (frame === 0) assert.ok(Math.abs(offset - pitch) < 0.025, 'the first post-off frame continues from the displayed offset');
      assert.ok(offset >= -1e-9 && offset <= MUSIC_DANCE_LIMITS.headPitch * 0.7 * musicReleaseGain(seconds / MUSIC_RELEASE_SECONDS) + 1e-9,
        'the additive head offset eases out under the release envelope');
      assert.ok(Math.abs(offset - previous) < 0.03, 'no jump between display frames');
      previous = offset;
      if (frame >= 6 && frame < 15) later = Math.max(later, offset);
    }
    assert.ok(later > 1e-4, 'the exit does not disappear within a few frames');
    h.bones.forEach((bone, i) => exactPose(bone, lastBase[i]));
    assert.equal(h.stage.musicDance.getState().releasing, false);
    assert.equal(mixer._actions.find(value => value.getClip().name.endsWith(':pose')), action);
    assert.ok(Math.abs(action.time - time - frames / 60) < 1e-10, 'the original base Action advances for the whole exit');
    assert.deepEqual(h.mesh.morphTargetInfluences, face);
    assert.equal(h.stage.boneLayers.length, 0);
    h.stage.setMusicEnabled(true);
    for (let frame = 0; frame < 10; frame++) {
      const base = step(1 / 30); h.bones.forEach((bone, i) => exactPose(bone, base[i]));
    }
    step(1 / 30, sample(120));
    assert.ok(h.stage.musicPose.headPitch > 0, 'a fresh input can start the layer again');
  } finally { animation.dispose(); h.dispose(); }
});

test("a model without center/head uses a bounded chest fallback and restores safely", () => {
  const h = harness();
  try {
    h.stage.center = undefined;
    h.stage.head = undefined;
    h.chest.quaternion.setFromEuler(new Euler(0.2, 0.3, 0.4));
    const bases = h.bones.map(snapshot);
    h.stage.setMusicEnabled(true);
    let moved = false;
    for (let frame = 0; frame < 60; frame++) {
      h.stage.setMusicSample(sample(frame));
      h.stage.animateMusic(1 / 30);
      const chest = localOffset(h.chest, bases[1]);
      assert.ok(Math.abs(chest.z) <= MUSIC_DANCE_LIMITS.chestRoll + MUSIC_DANCE_LIMITS.sway + 1e-12);
      assert.ok(Math.abs(chest.x) < 1e-12 && Math.abs(chest.y) < 1e-12);
      assert.equal(h.stage.boneLayers.length, 1);
      moved ||= Math.abs(chest.z) > 1e-4;
      for (const i of [0, 2, 3, 4, 5]) exactPose(h.bones[i], bases[i]);
      h.stage.restoreLayers();
      exactPose(h.chest, bases[1]);
    }
    assert.ok(moved);
    h.stage.chest = undefined;
    assert.doesNotThrow(() => h.stage.animateMusic(1 / 30));
    assert.equal(h.stage.boneLayers.length, 0);
    h.stage.mesh = null;
    assert.doesNotThrow(() => h.stage.animateMusic(1 / 30));
    assert.doesNotThrow(() => h.stage.setMusicEnabled(false));
  } finally { h.dispose(); }
});

test("late music samples after disposal cannot prime the dance", () => {
  const h = harness();
  try {
    const bases = h.bones.map(snapshot);
    h.stage.setMusicEnabled(true);
    h.stage.disposed = true;
    h.stage.setMusicSample(sample(0));
    h.stage.disposed = false;
    h.stage.animateMusic(1 / 30);
    h.bones.forEach((bone, i) => exactPose(bone, bases[i]));
  } finally { h.dispose(); }
});

test('host-owned music settings scale the actual stage head and center without changing the base pose', () => {
  function run(strength: number) {
    const h = harness();
    try {
      h.stage.setMusicSettings({ strength, alwaysDance: true });
      h.stage.setMusicEnabled(true);
      const poses: { head: number; center: number; bounce: number }[] = [];
      for (let frame = 0; frame < 180; frame++) {
        h.stage.restoreLayers();
        h.stage.setMusicSample(sample(frame));
        h.stage.animateMusic(1 / 30);
        poses.push({ head: new Euler().setFromQuaternion(h.head.quaternion, 'YXZ').x,
          center: new Euler().setFromQuaternion(h.center.quaternion, 'YXZ').z,
          bounce: h.center.position.y });
      }
      h.stage.restoreLayers();
      assert.deepEqual(h.head.quaternion.toArray(), [0, 0, 0, 1]);
      assert.deepEqual(h.center.position.toArray(), [0, 0, 0]);
      return poses;
    } finally { h.dispose(); }
  }
  const zero = run(0), half = run(0.35), full = run(0.7);
  assert.ok(zero.every(pose => Object.values(pose).every(value => value === 0)));
  assert.ok(Math.max(...full.map(pose => pose.head)) > 2 * Math.PI / 180, 'the real head has a visible bounded nod');
  for (let frame = 0; frame < full.length; frame++) {
    for (const key of ['head', 'center', 'bounce'] as const)
      assert.ok(Math.abs(full[frame][key] - half[frame][key] * 2) < 1e-6, `${key} frame ${frame}`);
  }
});

// R29b: an owner takes the music over by the dance's own yield fade (from the shown share, the dance still
// moving underneath), never by a one-frame cut; its samples are rejected and never replayed afterwards.
test('speech, window adjusting, direct interaction and selected head tracks take the music over by a fade, not a cut', () => {
  const owners: { name: string; reason: string; enter: (stage: MusicStageHarness) => void; leave: (stage: MusicStageHarness) => void }[] = [
    { name: 'speech', reason: 'speech', enter: stage => stage.setSpeaking(true), leave: stage => stage.setSpeaking(false) },
    { name: 'window/input', reason: 'window-or-input', enter: stage => stage.setBehaviorBlocked(true), leave: stage => stage.setBehaviorBlocked(false) },
    ...(['contact', 'hover', 'feeding', 'prepared'] as const).map(name => ({
      name, reason: 'direct-interaction',
      enter: (stage: MusicStageHarness) => stage.setMoodContact({ ...EMPTY_CONTACT, [name]: name === 'hover' ? 0.15 : true }),
      leave: (stage: MusicStageHarness) => stage.setMoodContact({ ...EMPTY_CONTACT }),
    })),
    { name: 'M006-pinch', reason: 'direct-interaction',
      enter: stage => { const contact = { ...EMPTY_CONTACT, pinch: { hover: false, pinching: true, side: null, x: 0, y: 0 } }; stage.setMoodContact(contact); },
      leave: stage => stage.setMoodContact({ ...EMPTY_CONTACT }) },
    { name: 'manual-head', reason: 'manual-head', enter: stage => { stage.musicManualHeadBlocked = true; }, leave: stage => { stage.musicManualHeadBlocked = false; } },
    { name: 'camera-edit', reason: 'camera', enter: stage => { stage.musicCameraEditing = true; }, leave: stage => { stage.musicCameraEditing = false; } },
    { name: 'camera-drag', reason: 'camera', enter: stage => { stage.controls.interacting = true; }, leave: stage => { stage.controls.interacting = false; } },
  ];
  for (const owner of owners) {
    const h = harness();
    try {
      h.bones.forEach((bone, index) => {
        bone.quaternion.setFromEuler(new Euler(0.05 * index, 0.03, -0.04));
        bone.position.set(index * 0.2, 0.1, -0.2);
      });
      const bases = h.bones.map(snapshot);
      h.stage.setMusicEnabled(true);
      // First prove that this exact harness really was applying music.
      for (let frame = 0; frame < 45; frame++) {
        h.stage.restoreLayers(); h.stage.setMusicSample(sample(frame)); h.stage.animateMusic(1 / 30);
      }
      assert.ok(h.head.quaternion.angleTo(bases[2].quaternion) > 1e-4, `${owner.name}: prior music is active`);
      const shownBefore = h.head.quaternion.angleTo(bases[2].quaternion);
      // Production restores temporary layers before each display frame.
      h.stage.restoreLayers();
      owner.enter(h.stage);
      // Ownership may change between capture samples; the display path must
      // check it again instead of relying on setMusicSample to mute the pose.
      h.stage.animateMusic(1 / 60);
      assert.equal(h.stage.musicBlockReason, owner.reason, owner.name);
      let previous = h.head.quaternion.angleTo(bases[2].quaternion);
      assert.ok(Math.abs(previous - shownBefore) < 0.01, `${owner.name}: the first owned frame continues from the shown offset`);
      const frames = Math.ceil(MUSIC_YIELD_SECONDS * 30) + 1;
      for (let frame = 45; frame < 45 + frames; frame++) {
        h.stage.restoreLayers(); h.stage.setMusicSample(sample(frame)); h.stage.animateMusic(1 / 30);
        assert.equal(h.stage.musicBlockReason, owner.reason, owner.name);
        assert.equal(h.stage.musicSuppressed, true, owner.name);
        assert.equal(h.stage.musicSignal, null, `${owner.name}: owned samples are rejected`);
        const offset = h.head.quaternion.angleTo(bases[2].quaternion);
        assert.ok(Math.abs(offset - previous) < 0.03, `${owner.name}: no jump between display frames`);
        previous = offset;
        for (const i of [3, 4, 5]) exactPose(h.bones[i], bases[i]);
      }
      // Fully handed over: nothing is written while the owner holds.
      h.stage.restoreLayers(); h.stage.setMusicSample(sample(60)); h.stage.animateMusic(1 / 30);
      h.bones.forEach((bone, index) => exactPose(bone, bases[index]));
      assert.equal(h.stage.boneLayers.length, 0, owner.name);
      owner.leave(h.stage);
      // All loud samples from the priority owner were rejected, never replayed.
      for (let frame = 0; frame < 20; frame++) {
        h.stage.restoreLayers(); h.stage.animateMusic(1 / 30);
        h.bones.forEach((bone, index) => exactPose(bone, bases[index]));
      }
      assert.equal(h.stage.musicSuppressed, false);
      assert.equal(h.stage.musicBlockReason, null);
      // Fresh music brings the dance back in gradually, from nothing shown.
      const back: number[] = [];
      for (let frame = 120; frame < 150; frame++) {
        h.stage.restoreLayers(); h.stage.setMusicSample(sample(frame)); h.stage.animateMusic(1 / 30);
        back.push(h.head.quaternion.angleTo(bases[2].quaternion));
      }
      assert.ok(back[0] < 0.005 && Math.max(...back) > 1e-3, `${owner.name}: fresh samples bring the dance back in`);
      assert.ok(back.slice(1).every((value, i) => Math.abs(value - back[i]) < 0.03), `${owner.name}: the return has no jump`);
      h.stage.restoreLayers();
      h.bones.forEach((bone, index) => exactPose(bone, bases[index]));
    } finally { h.dispose(); }
  }
});

// R29b: a contact for a single frame mid-dance neither cuts nor restarts the dance; without fresh music it
// then dies down like any silence (no old beat is replayed), and fresh music continues it.
test('a one-frame contact mid-dance is continuous both ways and replays nothing', () => {
  const h = harness();
  try {
    const bases = h.bones.map(snapshot);
    h.stage.setMusicEnabled(true);
    for (let frame = 0; frame < 64; frame++) {
      h.stage.restoreLayers(); h.stage.setMusicSample(sample(frame)); h.stage.animateMusic(1 / 30);
    }
    let previous = h.head.quaternion.angleTo(bases[2].quaternion);
    assert.ok(previous > 1e-4);
    h.stage.restoreLayers();
    h.stage.setMoodContact({ ...EMPTY_CONTACT, contact: true });
    h.stage.animateMusic(1 / 60);
    const touched = h.head.quaternion.angleTo(bases[2].quaternion);
    assert.ok(Math.abs(touched - previous) < 0.01, 'the contact frame continues from the shown dance');
    h.stage.setMoodContact({ ...EMPTY_CONTACT });
    previous = touched;
    const offsets: number[] = [];
    for (let frame = 0; frame < 90; frame++) {
      h.stage.restoreLayers(); h.stage.animateMusic(1 / 60);
      const offset = h.head.quaternion.angleTo(bases[2].quaternion);
      assert.ok(Math.abs(offset - previous) < 0.03, 'no jump between display frames');
      previous = offset; offsets.push(offset);
    }
    assert.ok(offsets.at(-1)! < Math.max(...offsets) * 0.2, 'without fresh samples the dance dies down like any silence');
    assert.equal(h.stage.musicDance.getState().pulse, false, 'no old beat is replayed');
    h.stage.restoreLayers(); h.stage.setMusicSample(sample(150)); h.stage.animateMusic(1 / 30);
    assert.ok(Math.abs(h.head.quaternion.angleTo(bases[2].quaternion) - previous) < 0.03, 'fresh music continues it without a jump');
    h.stage.restoreLayers();
    h.bones.forEach((bone, index) => exactPose(bone, bases[index]));
  } finally { h.dispose(); }
});

test('releasing contact cannot override another active presentation owner', () => {
  const h = harness();
  try {
    const bases = h.bones.map(snapshot);
    h.stage.setMusicEnabled(true);
    h.stage.setSpeaking(true);
    h.stage.setMoodContact({ ...EMPTY_CONTACT, feeding: true });
    h.stage.setMusicSample(sample(0)); h.stage.animateMusic(1 / 30);
    assert.equal(h.stage.musicBlockReason, 'speech');
    h.stage.setMoodContact({ ...EMPTY_CONTACT });
    h.stage.setMusicSample(sample(15)); h.stage.animateMusic(1 / 30);
    assert.equal(h.stage.musicBlockReason, 'speech');
    h.bones.forEach((bone, index) => exactPose(bone, bases[index]));
    h.stage.setSpeaking(false);
    h.stage.animateMusic(1 / 30);
    assert.equal(h.stage.musicBlockReason, null);
    h.bones.forEach((bone, index) => exactPose(bone, bases[index]));
  } finally { h.dispose(); }
});

test('quick off/on/off keeps the original exit deadline and never restores the old beat', () => {
  const h = harness();
  try {
    const base = h.bones.map(snapshot);
    h.stage.setMusicEnabled(true);
    for (let frame = 0; frame < 64; frame++) {
      h.stage.restoreLayers(); h.stage.setMusicSample(sample(frame)); h.stage.animateMusic(1 / 30);
    }
    h.stage.setMusicEnabled(false);
    for (let frame = 0; frame < 4; frame++) { h.stage.restoreLayers(); h.stage.animateMusic(1 / 60); }
    const remaining = h.stage.musicDance.getState().releaseRemainingMs, shown = h.bones.map(snapshot);
    h.stage.setMusicEnabled(true);
    h.bones.forEach((bone, index) => exactPose(bone, shown[index]));
    h.stage.setMusicSample({ time: 100, rms: 0, low: 0, mid: 0, high: 0 });
    h.stage.setMusicEnabled(false);
    assert.equal(h.stage.musicDance.getState().releaseRemainingMs, remaining, 'Toggling without new music cannot renew an old tail.');
    assert.equal(h.stage.musicDance.getState().pulse, false);
    for (let frame = 0; frame < Math.ceil(MUSIC_RELEASE_SECONDS * 60); frame++) { h.stage.restoreLayers(); h.stage.animateMusic(1 / 60); }
    assert.equal(h.stage.musicDance.getState().releasing, false);
    h.bones.forEach((bone, index) => exactPose(bone, base[index]));
    h.stage.setMusicEnabled(true);
    h.stage.restoreLayers(); h.stage.animateMusic(1 / 30);
    h.bones.forEach((bone, index) => exactPose(bone, base[index]));
    h.stage.setMusicSample(sample(130)); h.stage.animateMusic(1 / 30);
    assert.ok(h.stage.musicPose.headPitch > 0, 'Only a new effective sample can create another dance.');
  } finally { h.dispose(); }
});

test('an off event preserves the between-ticks physics display and a priority owner takes its tail over by a fade', () => {
  const h = harness();
  try {
    h.stage.setMusicEnabled(true);
    for (let frame = 0; frame < 64; frame++) {
      h.stage.restoreLayers(); h.stage.setMusicSample(sample(frame)); h.stage.animateMusic(1 / 30);
    }
    const events: string[] = [], physicsOffset = new Quaternion().setFromEuler(new Euler(0, 0.03, 0));
    let target: ReturnType<typeof snapshot> | null = null;
    const physics = {
      restore() { events.push('physics-restore'); if (target) { h.head.quaternion.copy(target.quaternion); h.head.position.copy(target.position); target = null; } },
      frame() { events.push('physics-frame'); target = snapshot(h.head); h.head.quaternion.multiply(physicsOffset); },
    };
    Object.assign(h.stage, { localPhysics: physics });
    const reset = h.stage.musicDance.reset.bind(h.stage.musicDance);
    h.stage.musicDance.reset = () => { events.push('music-reset'); reset(); };
    physics.frame(); events.length = 0;
    const shown = h.bones.map(snapshot);
    h.stage.setMusicEnabled(false);
    assert.equal(events.length, 0, 'Disabling input does not tear down the visible outer/inner layers between ticks.');
    h.bones.forEach((bone, index) => exactPose(bone, shown[index]));
    assert.equal(h.stage.musicDance.getState().releasing, true);
    h.stage.setSpeaking(true);
    // R29b: an owner arriving during the exit takes the tail over by a fade as well; nothing is torn down between ticks.
    assert.equal(events.length, 0, 'No event-time teardown or music reset for a priority owner.');
    h.bones.forEach((bone, index) => exactPose(bone, shown[index]));
    assert.equal(h.stage.musicBlockReason, 'speech', 'Disabled tails cannot take precedence over an active owner.');
    physics.restore(); h.stage.restoreLayers();
    const base = h.bones.map(snapshot);
    let previous = shown[2].quaternion.angleTo(base[2].quaternion);
    for (let frame = 0; frame < Math.ceil(MUSIC_RELEASE_SECONDS * 30) + 1; frame++) {
      h.stage.restoreLayers(); h.stage.animateMusic(1 / 30);
      const offset = h.head.quaternion.angleTo(base[2].quaternion);
      assert.ok(Math.abs(offset - previous) < 0.03, 'the tail eases out under the owner without a jump');
      previous = offset;
    }
    h.bones.forEach((bone, index) => exactPose(bone, base[index]));
    assert.equal(h.stage.musicDance.getState().releasing, false, 'The exit keeps its original deadline.');
    h.stage.setSpeaking(false); h.stage.restoreLayers(); h.stage.animateMusic(1 / 30);
    h.bones.forEach((bone, index) => exactPose(bone, base[index]));
    assert.equal(h.stage.musicDance.getState().releasing, false, 'Releasing the priority owner cannot bring the finished tail back.');
    events.length = 0; h.stage.musicManualHeadBlocked = true;
    h.stage.animateMusic(1 / 30);
    assert.ok(!events.includes('physics-restore') && !events.includes('physics-frame'), 'In-frame ownership checks cannot reinsert outer physics before the remaining inner layers.');
    h.bones.forEach((bone, index) => exactPose(bone, base[index]));
  } finally { h.dispose(); }
});

test('actual hide, model removal and teardown hard-cancel an unfinished exit after releasing outer physics', () => {
  const keys = ['document', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const original = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: { hidden: false, removeEventListener() {} } },
    requestAnimationFrame: { configurable: true, value: () => 1 },
    cancelAnimationFrame: { configurable: true, value: () => {} },
  });
  try {
    for (const kind of ['hide', 'model', 'teardown'] as const) {
      const h = harness();
      try {
        const events: string[] = [];
        const physics = { restore() { events.push('physics-restore'); }, frame() {},
          setVisible(visible: boolean) { if (!visible) this.restore(); },
          dispose() { this.restore(); }, getState: () => ({ liveObjects: 0 }) };
        const scene = new Scene(); scene.add(h.mesh);
        const dom = { dataset: {} as Record<string, string>, removeEventListener() {}, remove() {} };
        Object.assign(h.stage, { localPhysics: physics, scene,
          options: { transparent: true }, container: { clientWidth: 480, clientHeight: 640 },
          physicsGeneration: 0, physicsPending: null, physicsError: '',
          renderer: { domElement: dom, dispose() {}, forceContextLoss() {} }, resizeObserver: { disconnect() {} },
          controls: { interacting: false, setEnabled() {}, dispose() {} },
          ensureLocalPhysics: async () => {}, renderPhysicsDiagnostics() {},
          restPose: h.bones.map(snapshot).map((value, index) => ({ bone: h.bones[index], ...value })),
          motionClips: new Map(), chatGestureClips: new Map(), moodFeedback: { reset() {} },
          gaze: { x: 0, y: 0 }, eyeGaze: { x: 0, y: 0 }, grid: null,
        });
        h.stage.setMusicEnabled(true);
        for (let frame = 0; frame < 64; frame++) {
          h.stage.restoreLayers(); h.stage.setMusicSample(sample(frame)); h.stage.animateMusic(1 / 30);
        }
        h.stage.setMusicEnabled(false);
        const reset = h.stage.musicDance.reset.bind(h.stage.musicDance);
        h.stage.musicDance.reset = () => { events.push('music-reset'); reset(); };
        assert.equal(h.stage.musicDance.getState().releasing, true);
        const lifecycle = h.stage as MusicStageHarness & { setVisible(value: boolean): void; clearModel(): void; dispose(): void };
        if (kind === 'hide') lifecycle.setVisible(false);
        else if (kind === 'model') lifecycle.clearModel();
        else lifecycle.dispose();
        assert.ok(events.indexOf('physics-restore') >= 0 && events.indexOf('physics-restore') < events.indexOf('music-reset'), kind);
        assert.equal(h.stage.musicDance.getState().releasing, false, kind);
        assert.ok(Object.values(h.stage.musicPose).every(value => value === 0), kind);
        if (kind === 'hide') {
          lifecycle.setVisible(true); h.stage.restoreLayers(); const base = h.bones.map(snapshot);
          h.stage.animateMusic(1 / 30); h.bones.forEach((bone, index) => exactPose(bone, base[index]));
        }
        if (kind === 'teardown') {
          h.stage.setMusicEnabled(true); h.stage.setMusicSample(sample(200));
          assert.equal(h.stage.musicDance.getState().active, false, 'Late callbacks cannot restart a disposed stage.');
        }
      } finally { h.dispose(); }
    }
  } finally {
    keys.forEach((key, index) => { const descriptor = original[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
});
