import assert from 'node:assert/strict';
import test from 'node:test';
import { Bone, Euler, PerspectiveCamera, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { MmdStage } from '../src/stage/MmdStage';
import { EMPTY_CONTACT, MoodFeedback } from '../src/stage/mood-feedback';
import { createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodSnapshot } from '../shared/mood';

function harness() {
  const stage = Object.create(MmdStage.prototype) as any;
  Object.assign(stage,{surprisePending:null,surprisePreview:null}); // Real constructor defaults for the inactive preview owner.
  const head = new Bone(); head.name = '頭'; head.position.set(0, 15, 0);
  const mesh = new SkinnedMesh(); mesh.add(head); mesh.morphTargetInfluences = [0.1, 0.2, 0.05, 0, 0.07];
  const camera = new PerspectiveCamera(32, 400 / 560, 0.1, 3000);
  camera.position.set(0, 10, 35); camera.lookAt(0, 10, 0); camera.updateMatrixWorld(true);
  Object.assign(stage, { mesh, head, eyes: [], camera, controls: { interacting: false }, hostVisible: true,
    renderer: { domElement: { dataset: {} } }, container: { clientWidth: 400, clientHeight: 560 }, height: 20,
    moodFeedback: new MoodFeedback(), moodContact: { ...EMPTY_CONTACT }, moodFaceBlocked: false, moodHeadBlocked: false,
    moodView: { expressions: true, snapshot: getMoodSnapshot(createMoodState(0)), parameters: DEFAULT_MOOD_PARAMETERS },
    boneLayers: [], morphLayers: [], rotation: new Euler(), offset: new Quaternion(),
    blinkIndex: 0, smileIndex: 1, mouthIndex: 2, sadIndex: 3, blushChannel: { index: 4, name: '赤み' }, speaking: false,
  });
  return stage;
}
test('idle blink and mood eyelid layers restore the same original morph once', () => {
  const stage = harness();
  stage.applyMorph(0, 0.5); stage.applyMorph(0, 0.8);
  assert.equal(stage.mesh.morphTargetInfluences[0], 0.8);
  stage.restoreLayers();
  assert.equal(stage.mesh.morphTargetInfluences[0], 0.1);
  assert.equal(stage.morphLayers.length, 0);
});

test('concern remains the main expression when accompanied by comfort and an acknowledgement', () => {
  const stage = harness();
  Object.assign(stage.moodView.snapshot, { primary: 'concerned', companion: 'comfortable', context: 'concern', cue: { id: 'ack', kind: 'satisfied', at: 0, until: 4000 } });
  stage.animateMood(1 / 30);
  const frame = JSON.parse(stage.renderer.domElement.dataset.moodFeedback);
  assert.equal(frame.primary, 'concerned'); assert.equal(frame.companion, 'comfortable');
  assert.equal(frame.smile, 0);
  assert.equal(stage.mesh.morphTargetInfluences[1], 0.2, 'authored base is preserved without adding an automatic smile');
});

test('one local blush channel respects authored base, manual expressions, pause and role changes', () => {
  const stage = harness();
  const snapshot = stage.moodView.snapshot;
  snapshot.blush = { id: 'affection', at: 0, until: 3450, strength: 1, reason: 'semantic', ageMs: 700, amount: 0.35, profile: DEFAULT_MOOD_PARAMETERS.blush };
  stage.animateMood(1 / 30);
  assert.ok(stage.mesh.morphTargetInfluences[4] > 0.3);
  assert.equal(stage.morphLayers.filter((layer: any) => layer.index === 4).length, 1);
  stage.restoreLayers(); assert.equal(stage.mesh.morphTargetInfluences[4], 0.07);
  stage.moodFaceBlocked = true; stage.animateMood(1 / 30);
  assert.equal(stage.mesh.morphTargetInfluences[4], 0.07);
  stage.moodFaceBlocked = false; stage.animateMood(1 / 30);
  assert.equal(stage.mesh.morphTargetInfluences[4], 0.07, 'a blocked cue cannot resume late');
  snapshot.blush.id = 'new-affection'; stage.animateMood(1 / 30);
  assert.ok(stage.mesh.morphTargetInfluences[4] > 0.3);
  stage.setMood({ ...stage.moodView, expressions: false });
  assert.equal(stage.mesh.morphTargetInfluences[4], 0.07, 'pause restores the first base immediately');
  stage.setMood({ ...stage.moodView, characterId: 'new-role', token: 'new', expressions: true, snapshot: { ...snapshot, blush: null } });
  stage.animateMood(1 / 30); stage.restoreLayers();
  assert.equal(stage.mesh.morphTargetInfluences[4], 0.07);
});
test('hundreds of local mood frames preserve the moving base quaternion and every face value', () => {
  const stage = harness();
  stage.moodContact = { ...EMPTY_CONTACT, contact: true, x: 0.8, velocityX: 1, speed: 1 };
  const influences = [...stage.mesh.morphTargetInfluences];
  for (let i = 0; i < 240; i++) {
    stage.head.rotation.set(Math.sin(i * 0.03) * 0.2, 0.07, -0.04);
    const base = stage.head.quaternion.clone();
    stage.animateMood(1 / 30);
    stage.restoreLayers();
    assert.deepEqual(stage.head.quaternion.toArray(), base.toArray());
    assert.deepEqual(stage.mesh.morphTargetInfluences, influences);
  }
});
test('explicit head and expression animation keeps priority while interaction remains observable', () => {
  const stage = harness();
  stage.moodHeadBlocked = stage.moodFaceBlocked = true;
  stage.moodContact = { ...EMPTY_CONTACT, contact: true, x: 1, feeding: true, prepared: true };
  const original = stage.head.quaternion.toArray();
  const face = [...stage.mesh.morphTargetInfluences];
  for (let i = 0; i < 60; i++) { stage.restoreLayers(); stage.animateMood(1 / 30); }
  assert.deepEqual(stage.head.quaternion.toArray(), original);
  assert.deepEqual(stage.mesh.morphTargetInfluences, face);
  assert.match(stage.getMoodDegradation(), /手选表情优先/);
});
test('interaction target projects the actual head and mouth within the current camera', () => {
  const stage = harness();
  const region = stage.getInteractionRegion();
  assert.ok(region);
  const { cheeks, ...headGeometry } = region;
  assert.ok(Object.values(headGeometry).every(Number.isFinite));
  assert.ok(Array.isArray(cheeks));
  assert.ok(region.y < 280 && region.mouthY > region.y);
  assert.ok(region.radius >= 12 && region.radius < 120);
  stage.head.position.x = 3; stage.mesh.updateMatrixWorld(true);
  const moved = stage.getInteractionRegion(); assert.ok(moved.x > region.x);
  stage.hostVisible = false; assert.equal(stage.getInteractionRegion(), null);
});

test('cheek follow moves head and body in the screen plane and restores authored poses without drift', () => {
  const stage = harness();
  const center = new Bone(); stage.mesh.add(center); center.add(stage.head); stage.center = center;
  stage.mesh.rotation.y = 0.6;
  stage.moodHeadBlocked = true;
  stage.moodContact = { ...EMPTY_CONTACT, contact: true, pinch: { hover: false, pinching: true, side: 'left', x: 1.2, y: 0.25 } };
  const headPosition = stage.head.position.clone();
  for (let i = 0; i < 300; i++) {
    stage.restoreLayers();
    const base = new Quaternion().setFromEuler(new Euler(0, Math.sin(i / 80) * 0.08, 0));
    center.quaternion.copy(base); center.position.set(0.01 * i, 0, 0);
    const position = center.position.clone();
    stage.animateMood(1 / 30);
    assert.ok(center.quaternion.angleTo(base) <= Math.PI / 30 + 1e-8);
    assert.ok(center.position.distanceTo(position) <= stage.height * 0.02 + 1e-8);
    assert.ok(stage.head.position.distanceTo(headPosition) <= stage.height * 0.025 + 1e-8);
    if (i > 180) assert.ok(center.position.distanceTo(position) > 0.1, 'far drag visibly shares movement with the body');
    stage.restoreLayers();
    assert.deepEqual(center.quaternion.toArray(), base.toArray());
    assert.deepEqual(center.position.toArray(), position.toArray());
    assert.deepEqual(stage.head.position.toArray(), headPosition.toArray());
  }
  stage.moodContact = { ...EMPTY_CONTACT };
  stage.animateMood(1 / 30);
  assert.ok(stage.head.position.distanceTo(headPosition) > 0.01, 'release eases from the displayed movement');
  for (let i = 0; i < 180; i++) { stage.restoreLayers(); stage.animateMood(1 / 30); }
  assert.ok(stage.head.position.distanceTo(headPosition) < 1e-6);
});

test('cheek eyelids compose once with natural blinking and manual face selection keeps priority', () => {
  const stage = harness(); stage.moodView.snapshot.primary = 'happy';
  stage.moodContact = { ...EMPTY_CONTACT, contact: true, pinch: { hover: false, pinching: true, side: 'right', x: 0.2, y: 0 } };
  const lids: number[] = [];
  for (let i = 0; i < 300; i++) {
    stage.restoreLayers(); stage.naturalBlink = i % 30 < 3 ? 1 : 0; stage.animateMood(1 / 30);
    if (i > 180) lids.push(stage.mesh.morphTargetInfluences[0]);
  }
  assert.ok(Math.max(...lids) - Math.min(...lids) < 1e-5);
  stage.restoreLayers(); stage.moodFaceBlocked = true;
  const face = [...stage.mesh.morphTargetInfluences]; stage.animateMood(1 / 30);
  assert.deepEqual(stage.mesh.morphTargetInfluences, face);
  stage.restoreLayers(); stage.moodView.expressions = false; stage.animateMood(1 / 30);
  assert.ok(stage.head.quaternion.angleTo(new Quaternion()) > 0.01, 'direct held response remains while automatic expressions are paused');
});
test('direct rua follows over a manual head track and eases back without changing its base', () => {
  const stage = harness(); stage.moodHeadBlocked = true;
  const base = new Quaternion().setFromEuler(new Euler(0.06, -0.1, 0.04));
  stage.moodContact = { ...EMPTY_CONTACT, contact: true, x: 0.8, velocityX: 0.8, speed: 0.8 };
  for (let i = 0; i < 60; i++) {
    stage.restoreLayers(); stage.head.quaternion.copy(base); stage.animateMood(1 / 30);
  }
  const during = stage.head.quaternion.angleTo(base);
  assert.ok(during > 0.03 && during <= Math.PI / 15 + 1e-8);
  stage.moodContact = { ...EMPTY_CONTACT };
  stage.restoreLayers(); stage.head.quaternion.copy(base); stage.animateMood(1 / 30);
  assert.ok(stage.head.quaternion.angleTo(base) > 0.02, 'leaving preserves a smooth physical return');
  for (let i = 0; i < 180; i++) { stage.restoreLayers(); stage.head.quaternion.copy(base); stage.animateMood(1 / 30); }
  assert.ok(stage.head.quaternion.angleTo(base) < 1e-6);
  stage.restoreLayers(); assert.deepEqual(stage.head.quaternion.toArray(), base.toArray());
});

test('enjoyment and natural blinking share one lid output, then normal blinking returns', () => {
  const stage = harness();
  stage.moodView.snapshot.primary = 'comfortable';
  stage.moodContact = { ...EMPTY_CONTACT, contact: true, hover: 1 };
  const lids: number[] = [];
  for (let frame = 0; frame < 300; frame++) {
    stage.restoreLayers(); stage.naturalBlink = frame % 30 < 3 ? 1 : 0;
    stage.animateMood(1 / 30);
    if (frame > 180) lids.push(stage.mesh.morphTargetInfluences[0]);
  }
  assert.ok(Math.max(...lids) - Math.min(...lids) < 1e-5, 'scheduled natural blinks cannot flutter enjoyed lids');
  stage.moodContact = { ...EMPTY_CONTACT };
  for (let frame = 0; frame < 180; frame++) { stage.restoreLayers(); stage.naturalBlink = 0; stage.animateMood(1 / 30); }
  stage.restoreLayers(); stage.naturalBlink = 1; stage.animateMood(1 / 30);
  assert.ok(stage.mesh.morphTargetInfluences[0] > 0.99, 'normal blinking is available after the contact has settled');
  stage.restoreLayers(); stage.moodFaceBlocked = true; stage.animateMood(1 / 30);
  assert.equal(stage.mesh.morphTargetInfluences[0], 0.1, 'manual expression keeps priority');
});

test('feeding can use an unselected mouth beside a manual face without changing speech amplitude', () => {
  const stage = harness();
  stage.moodFaceBlocked = true; stage.moodMouthBlocked = false;
  stage.moodContact = { ...EMPTY_CONTACT, feeding: true, prepared: true };
  for (let frame = 0; frame < 35; frame++) { stage.restoreLayers(); stage.animateMood(1 / 30); }
  assert.ok(stage.mesh.morphTargetInfluences[2] > 0.8);
  assert.equal(stage.mesh.morphTargetInfluences[1], 0.2);
  // R29/B06 (user: the mouth opened too little): a snack held at the mouth now owns
  // it over speech by a cross-fade; it is never added on top of the lip-sync value.
  stage.restoreLayers(); stage.speaking = true; stage.mouth = 0.6; stage.animateMood(1 / 30);
  assert.ok(stage.mesh.morphTargetInfluences[2] > 0.8 && stage.mesh.morphTargetInfluences[2] <= 0.85, 'feeding wins over speech without adding to it');
  // X-089 (R29d): a selected mouth stays authoritative over feeding and speech, now by a short eased
  // hand-over (MANUAL_MOUTH_SECONDS) instead of a one-frame cut; it is written by max, so they step aside.
  stage.speaking = false; stage.mouth = 0; stage.moodMouthBlocked = true;
  const shown: number[] = [];
  for (let frame = 0; frame < 10; frame++) { stage.restoreLayers(); stage.animateMood(1 / 30); shown.push(stage.mesh.morphTargetInfluences[2]); }
  assert.ok(shown[0] > 0.6, 'the snack mouth does not vanish in one frame');
  assert.ok(shown.slice(1).every((value, i) => value <= shown[i] && shown[i] - value <= 0.25), `it steps aside smoothly: ${shown.map(v => v.toFixed(3)).join(' ')}`);
  assert.equal(shown.at(-1), 0.05, 'an authored mouth remains authoritative');
});
