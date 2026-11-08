// I-024 模型体检卡: what the stage may turn on for a model, from its profile, haiku's matches and the user's choice.
import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityEnabled, deriveModelCapabilities, MODEL_CAPABILITY_IDS } from '../shared/model-capability';
import type { ModelProfile, MorphSlot, StandardBone } from '../shared/model-profile';

/** Only the parts the card reads: which slots and bones the profile found. */
function profile(morphs: MorphSlot[], bones: StandardBone[]): ModelProfile {
  const slots: Record<string, { index: number }> = {};
  morphs.forEach((slot, index) => { slots[slot] = { index }; });
  const map: Record<string, { index: number; name: string }> = {};
  bones.forEach((bone, index) => { map[bone] = { index, name: bone }; });
  return { morphs: slots, bones: { map } } as unknown as ModelProfile;
}
const ARMS: StandardBone[] = ['armLeft', 'armRight', 'elbowLeft', 'elbowRight', 'wristLeft', 'wristRight'];

test('a model with blink, blush, mouth, half lids, neck/head, eyes and both arms can do everything, found by name', () => {
  const card = deriveModelCapabilities(profile(['blink', 'shy', 'a', 'jitome'], ['neck', 'head', 'eyeLeft', 'eyeRight', ...ARMS]));
  for (const id of MODEL_CAPABILITY_IDS) assert.deepEqual([card[id].detected, card[id].source, card[id].enabled], [true, 'name', true], id);
});

test('per-eye blinks count only as a pair; お stands in for あ; a missing bone keeps the pose off', () => {
  const card = deriveModelCapabilities(profile(['blinkLeft', 'o'], ['head', ...ARMS]));
  assert.equal(card.closeEyes.detected, false, 'one eye only');
  assert.equal(card.mouth.detected, true);
  assert.equal(card.sleepPose.detected, false, 'no neck');
  assert.equal(deriveModelCapabilities(profile(['blinkLeft', 'blinkRight'], [])).closeEyes.detected, true);
});

test('haiku fills what the names missed, and says so; the profile wins when both have it', () => {
  const card = deriveModelCapabilities(profile(['a'], ['head']), {}, { morphs: { blink: 7, shy: 9 }, bones: { neck: 3 } });
  assert.deepEqual([card.closeEyes.detected, card.closeEyes.source], [true, 'haiku']);
  assert.deepEqual([card.blush.source, card.sleepPose.source, card.mouth.source], ['haiku', 'haiku', 'name']);
  assert.equal(deriveModelCapabilities(profile(['a'], []), {}, { morphs: { blink: -1 } }).closeEyes.detected, false, 'a -1 match is no match');
});

test("the user's choice wins: off turns a detected feature off; on cannot turn on what the model lacks", () => {
  const card = deriveModelCapabilities(profile(['blink'], []), { closeEyes: 'off', blush: 'on', mouth: 'bogus' as never });
  assert.deepEqual([card.closeEyes.detected, card.closeEyes.choice, card.closeEyes.enabled], [true, 'off', false]);
  assert.deepEqual([card.blush.detected, card.blush.choice, card.blush.enabled], [false, 'on', false]);
  assert.equal(card.mouth.choice, null, 'an unknown choice is ignored');
  assert.equal(capabilityEnabled(card, 'closeEyes'), false);
  assert.equal(capabilityEnabled(null, 'closeEyes'), false, 'no card yet: nothing is turned on');
});

test('no profile (not loaded yet): nothing is detected or enabled', () => {
  const card = deriveModelCapabilities(null);
  for (const id of MODEL_CAPABILITY_IDS) assert.deepEqual([card[id].detected, card[id].enabled, card[id].source], [false, false, 'none'], id);
});

test('the drowsy face needs half lids or troubled brows and a head; tears need both eye bones and a head', () => {
  assert.equal(deriveModelCapabilities(profile(['sad'], ['head'])).drowsyFace.detected, true, 'brows alone are enough');
  assert.equal(deriveModelCapabilities(profile(['jitome'], ['head'])).drowsyFace.detected, true, 'half lids alone are enough');
  assert.equal(deriveModelCapabilities(profile(['blink'], ['head'])).drowsyFace.detected, false, 'a blink is not a drowsy face');
  assert.equal(deriveModelCapabilities(profile(['sad'], [])).drowsyFace.detected, false, 'no head');
  assert.equal(deriveModelCapabilities(profile([], ['head', 'eyeLeft', 'eyeRight'])).tears.detected, true);
  assert.equal(deriveModelCapabilities(profile([], ['head', 'eyeLeft'])).tears.detected, false, 'one eye bone only');
  const haiku = deriveModelCapabilities(profile([], ['head', 'eyeLeft']), {}, { bones: { eyeRight: 4 } });
  assert.deepEqual([haiku.tears.detected, haiku.tears.source], [true, 'haiku']);
  assert.equal(deriveModelCapabilities(profile(['jitome'], ['head']), { drowsyFace: 'off' }).drowsyFace.enabled, false);
});