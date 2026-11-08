import assert from 'node:assert/strict';
import test from 'node:test';
import { createFatigue, fatigueSnapshot, type FatiguePhase } from '../shared/fatigue';
import { FatiguePresentation } from '../src/stage/fatigue-presentation';

const view = (phase: FatiguePhase) => ({ ...fatigueSnapshot(createFatigue({ monotonicMs: 0, localMinute: 900 }, { A: .9, F: .8, phase })), sleepEntryReady: true });
const gates = { verifiedGene: true, expressions: true, faceBlocked: false, contact: false };

test('drowsy awake states keep bounded gaze while asleep/micro-awake stop cursor following', () => {
  const layer = new FatiguePresentation();
  for (const phase of ['light-drowsy', 'drowsy', 'falling-asleep'] as const) {
    const frame = layer.frame(view(phase), .1, gates); assert.equal(frame.gazeAllowed, true); assert.ok(frame.gazeStrength > 0 && frame.gazeStrength < 1);
  }
  for (const phase of ['asleep', 'micro-awake'] as const) {
    const frame = layer.frame(view(phase), .1, gates); assert.equal(frame.gazeAllowed, false); assert.equal(frame.gazeStrength, 0);
  }
});

test('sleep contact changes a small display response without mutating or waking the host snapshot', () => {
  const snapshot = view('asleep'), normal = new FatiguePresentation(), touched = new FatiguePresentation();
  const a = normal.frame(snapshot, .1, gates), b = touched.frame(snapshot, .1, { ...gates, contact: true });
  assert.ok(a.eyelids > b.eyelids); assert.ok(a.eyelids - b.eyelids < .04); assert.equal(snapshot.phase, 'asleep'); assert.equal(snapshot.W, 0);
  assert.equal(b.gazeAllowed, false);
});

test('unverified model or manual face ownership prevents the new eye layer', () => {
  assert.equal(new FatiguePresentation().frame(view('asleep'), .1, { ...gates, verifiedGene: false }).eyelids, 0);
  assert.equal(new FatiguePresentation().frame(view('asleep'), .1, { ...gates, faceBlocked: true }).eyelids, 0);
  const layer = new FatiguePresentation(); layer.frame(view('asleep'), .1, gates);
  assert.deepEqual(layer.frame(undefined, .1, gates), { gazeAllowed: true, gazeStrength: 1, gazeResponse: 1, eyelids: 0, reason: 'inactive' });
});
