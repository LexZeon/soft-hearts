import assert from 'node:assert/strict';
import test from 'node:test';
import { createFatigue, fatigueSnapshot, type FatiguePhase } from '../shared/fatigue';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../shared/mood';
import { EMPTY_CONTACT } from '../src/stage/mood-feedback';
import { fatigueStageFixture } from './helpers/fatigue-stage-fixture';

const makeFixture = fatigueStageFixture;
const fatigue = (phase: FatiguePhase) => ({ ...fatigueSnapshot(createFatigue({ monotonicMs: 0, localMinute: 900 }, { A: .9, F: .8, phase })), sleepEntryReady: true });
const setView = (h: any, phase: FatiguePhase) => {
  h.stage.tearsVerifiedGene = true; // Synthetic identity port only, not a real Gene admission claim.
  h.stage.mesh.morphTargetInfluences.push(0); h.stage.blinkIndex = 1; h.stage.moodFaceBlocked = false;
  h.stage.setMood({ characterId: 'synthetic', token: 'synthetic_token', revision: 1, developerMode: false,
    expressions: true, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), snapshot: getMoodSnapshot(createMoodState(0)),
    gesture: null, fatigue: fatigue(phase) });
};

test('new actual Stage tick stops sleep gaze but keeps manual clocks, head hit projection and contact input alive', () => {
  const h = makeFixture();
  try {
    setView(h, 'asleep'); h.advance(); assert.equal(h.stage.gaze.x, 0); assert.equal(h.stage.eyeGaze.x, 0);
    const region = h.stage.getInteractionRegion(); assert.ok(region); assert.ok(Number.isFinite(region.x));
    const host = h.stage.moodView.fatigue;
    h.stage.setPointer({ x: -.9, y: .8 }); h.stage.setMoodContact({ ...EMPTY_CONTACT, contact: true }); h.advance();
    assert.equal(h.stage.gaze.x, 0); assert.equal(h.stage.eyeGaze.x, 0);
    assert.equal(h.stage.moodContact.contact, true); assert.equal(h.stage.moodView.fatigue, host); assert.equal(host.W, 0);
    assert.equal(JSON.parse(h.stage.renderer.domElement.dataset.fatigue).gazeAllowed, false);
    assert.ok(h.stage.mesh.morphTargetInfluences[1] > 0);
    assert.ok(h.events.filter((event: string) => event === 'input').length >= h.renders());
  } finally { h.close(); }
});

test('new actual Stage keeps cursor response while drowsy and suppresses it again during micro-awake', () => {
  const h = makeFixture();
  try {
    setView(h, 'drowsy'); h.advance(); const previous = h.stage.gaze.x;
    h.stage.setPointer({ x: -.8, y: .4 }); h.advance(); assert.notEqual(h.stage.gaze.x, previous);
    assert.equal(JSON.parse(h.stage.renderer.domElement.dataset.fatigue).gazeAllowed, true);
    h.stage.moodView.fatigue = fatigue('micro-awake'); const before = Math.abs(h.stage.gaze.x); h.advance();
    assert.ok(Math.abs(h.stage.gaze.x) < before); assert.equal(JSON.parse(h.stage.renderer.domElement.dataset.fatigue).gazeAllowed, false);
    assert.ok(h.stage.getInteractionRegion());
  } finally { h.close(); }
});
