import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion } from 'three';
import { fatigueStageFixture } from './helpers/fatigue-stage-fixture';
import { EMPTY_CONTACT } from '../src/stage/mood-feedback';
import type { MusicEnergySample } from '../src/stage/music-dance';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../shared/mood';

const DEG = Math.PI / 180;
const sample = (frame: number): MusicEnergySample => {
  const kick = frame % 15 === 0;
  return { time: frame / 30, rms: kick ? 0.4 : 0.14, low: kick ? 0.8 : 0.1, mid: 0.2 + Math.sin(frame / 20) * 0.1, high: 0.1 };
};

/**
 * Real Stage frameTick (R24 fixture), music dancing, then a head pat in the
 * middle of the dance. Contact suppresses music, whose presentation is reset in
 * one step: without a display bridge the head teleports by the live nod.
 */
function patMidDance(bridge: boolean) {
  const h = fatigueStageFixture(), s = h.stage, head = s.mesh.skeleton.bones[3], hair = s.mesh.skeleton.bones[4];
  if (!bridge) s.continuity = { base() {}, apply() {}, remove() {}, reset() {}, release() {}, getState: () => null };
  const shown: Quaternion[] = [], hairShown: Quaternion[] = [];
  const render = s.renderer.render;
  s.renderer.render = (...args: unknown[]) => { shown.push(head.quaternion.clone()); hairShown.push(hair.quaternion.clone()); render(...args); };
  let now = 1000, frame = 0;
  const tick = () => { s.setMusicSample(sample(frame++)); now += 1000 / 30; s.tick(now); };
  s.setMusicEnabled(true);
  for (let i = 0; i < 90; i++) tick();
  // Pat when the live nod is clearly visible, as a user would mid-beat.
  for (let i = 0; i < 120 && Math.abs(s.musicPose.headPitch) < 0.05; i++) tick();
  const nod = Math.hypot(s.musicPose.headPitch, s.musicPose.headRoll);
  assert.ok(nod >= 0.05, `the dance is visibly nodding before the pat (${(nod / DEG).toFixed(1)} deg)`);
  const before = shown.length;
  const dancing = JSON.parse(s.renderer.domElement.dataset.poseContinuity ?? 'null');
  s.setMoodContact({ ...EMPTY_CONTACT, contact: true, hover: 1, x: 0, y: -0.3 });
  assert.equal(s.musicBlockReason, 'direct-interaction');
  for (let i = 0; i < 30; i++) tick();
  const steps = shown.slice(1).map((q, i) => q.angleTo(shown[i]) / DEG);
  const dance = Math.max(...steps.slice(before - 30, before - 1));
  const handoff = Math.max(...steps.slice(before - 1, before + 3));
  const state = JSON.parse(s.renderer.domElement.dataset.poseContinuity ?? 'null');
  h.close();
  return { nod: nod / DEG, dance, handoff, steps: steps.slice(before - 1, before + 8), state, dancing, hairShown };
}

test('R29: patting mid-dance is a hand-off, not a teleport (real Stage frame loop)', () => {
  // R29b: the dance now yields by its own fade (music-dance.ts presence), so even WITHOUT the display
  // bridge no frame jumps; on main the same loop snapped by the live nod (> 2.5 deg in one frame).
  const control = patMidDance(false);
  assert.ok(control.handoff <= Math.max(control.dance * 1.25, 1.5),
    `without the bridge the source itself hands over (${control.handoff.toFixed(2)} vs dance ${control.dance.toFixed(2)} deg)`);
  const guarded = patMidDance(true);
  assert.ok(guarded.handoff <= Math.max(guarded.dance * 1.25, 1.5),
    `with the bridge no frame moves more than the dance itself (${guarded.handoff.toFixed(2)} vs ${guarded.dance.toFixed(2)} deg; ${guarded.steps.map(v => v.toFixed(2)).join(' ')})`);
  assert.equal(guarded.dancing.jumps, 0, 'the music nod itself (steady motion) never triggered the guard');
  assert.equal(guarded.state.jumps, 0, 'the safety net had nothing to catch: the hand-off is continuous at its source');
  assert.ok(guarded.state.properties > 0, 'the guard still watches the pose and reports on the canvas');
  if (process.env.R29_REPORT) console.log(JSON.stringify({ control: control.handoff, guarded: guarded.handoff, dance: guarded.dance, nod: guarded.nod, steps: guarded.steps }));
});

test('R29: authored playback and steady layers pass the real frame loop untouched', () => {
  const h = fatigueStageFixture(), s = h.stage;
  try {
    const head = s.mesh.skeleton.bones[3], targets: Quaternion[] = [], shown: Quaternion[] = [];
    const render = s.renderer.render;
    s.renderer.render = (...args: unknown[]) => { shown.push(head.quaternion.clone()); render(...args); };
    h.advance(45);
    // Each frame ends with the exact composed target back on the bone (bridge withdrawn after render).
    for (let i = 0; i < 20; i++) { h.advance(1); targets.push(head.quaternion.clone()); }
    const state = JSON.parse(s.renderer.domElement.dataset.poseContinuity);
    assert.equal(state.jumps, 0, 'pose clip, breathing and gaze never trigger the guard');
    assert.equal(state.active, 0);
    assert.equal(state.baseTrusted, true, 'unchanged mixer playback is trusted authored motion');
    targets.forEach((q, i) => assert.ok(q.angleTo(shown[45 + i]) < 1e-9, 'shown == composed target'));
    assert.ok(state.properties > 0);
  } finally { h.close(); }
});

test('R29: physics-owned hair bones are excluded and hide/not-rendering resets the bridge', () => {
  const guarded = patMidDance(true);
  // Hair is a dynamic-body bone in the fixture: the guard never writes it (physics owns it after the bridge).
  assert.ok(guarded.state.properties < 2 * 10 + 1, 'fewer guarded bones than the skeleton');
  const h = fatigueStageFixture(), s = h.stage;
  try {
    h.advance(3);
    s.hostVisible = false; s.tick(5000);
    s.hostVisible = true; s.tick(5100); s.tick(5134);
    const state = JSON.parse(s.renderer.domElement.dataset.poseContinuity);
    assert.equal(state.lastReset, 'not-rendering');
    assert.equal(state.active, 0);
  } finally { h.close(); }
});

function moodStage() {
  const h = fatigueStageFixture(), s = h.stage;
  s.mesh.morphTargetInfluences.push(0, 0); s.blinkIndex = 1; s.mouthIndex = 2; s.moodFaceBlocked = false; s.moodMouthBlocked = false;
  const snapshot = { ...getMoodSnapshot(createMoodState(0)), primary: '满足' };
  s.setMood({ characterId: 'synthetic', token: 'synthetic_token', revision: 1, developerMode: false, expressions: true,
    parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), snapshot, gesture: null });
  const shown: number[][] = [], render = s.renderer.render;
  s.renderer.render = (...args: unknown[]) => { shown.push([...s.mesh.morphTargetInfluences]); render(...args); };
  let now = 1000;
  const tick = (frames = 1) => { for (let i = 0; i < frames; i++) { now += 1000 / 30; s.tick(now); } };
  return { h, s, shown, tick };
}

test('B05 at the real Stage: patting with strokes that leave the scalp keeps one steady eyelid value', () => {
  const { h, s, shown, tick } = moodStage();
  try {
    tick(10);
    for (let frame = 0; frame < 150; frame++) {
      const t = frame / 30, outside = t > 1.5 && (t % 0.5) > 0.37;
      s.setMoodContact(outside ? EMPTY_CONTACT : { ...EMPTY_CONTACT, contact: true, hover: 1, x: Math.sin(t * 10) * 0.5, y: -0.2, speed: 1 });
      tick();
    }
    const lids = shown.slice(-60).map(row => row[1]);
    assert.ok(Math.min(...lids) > 0.2, `the enjoyed closure is shown (${Math.min(...lids).toFixed(3)})`);
    assert.ok(Math.max(...lids) - Math.min(...lids) < 0.01, `no eyelid tremble (${Math.min(...lids).toFixed(3)}..${Math.max(...lids).toFixed(3)})`);
  } finally { h.close(); }
});

test('B06 at the real Stage: a snack at the mouth holds it clearly open even while she is speaking', () => {
  const { h, s, shown, tick } = moodStage();
  try {
    s.speaking = true; tick(30);
    const talking = shown.slice(-20).map(row => row[2]);
    assert.ok(Math.max(...talking) - Math.min(...talking) > 0.1, 'lip-sync is moving before the snack arrives');
    s.setMoodContact({ ...EMPTY_CONTACT, feeding: true, prepared: false, near: 1 }); tick(25);
    const waiting = shown.at(-1)![2];
    s.setMoodContact({ ...EMPTY_CONTACT, feeding: true, prepared: true, near: 1 }); tick(30);
    const fed = shown.slice(-15).map(row => row[2]);
    assert.ok(waiting > 0.4, `the mouth already waits open before the dwell completes (${waiting.toFixed(2)})`);
    assert.ok(Math.min(...fed) > 0.8 && Math.max(...fed) - Math.min(...fed) < 0.05, `fully open and steady over speech (${Math.min(...fed).toFixed(2)}..${Math.max(...fed).toFixed(2)})`);
    s.setMoodContact(EMPTY_CONTACT); tick(45);
    const after = shown.slice(-20).map(row => row[2]);
    assert.ok(Math.max(...after) - Math.min(...after) > 0.1, 'speech takes the mouth back afterwards');
    const steps = shown.slice(1).map((row, i) => Math.abs(row[2] - shown[i][2]));
    assert.ok(Math.max(...steps) < 0.2, `no mouth snap at any hand-off (${Math.max(...steps).toFixed(3)})`);
  } finally { h.close(); }
});
