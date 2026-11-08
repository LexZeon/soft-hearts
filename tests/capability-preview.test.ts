import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityPreviews, NO_CAPABILITY_PREVIEW, capabilityPreviewSeconds, isModelCapabilityId, previewEnvelope } from '../src/stage/capability-preview';
import { MODEL_CAPABILITY_IDS } from '../shared/model-capability';

test('every preview envelope starts and ends at exactly 0 and never jumps', () => {
  for (const id of MODEL_CAPABILITY_IDS) {
    const end = capabilityPreviewSeconds(id);
    assert.equal(previewEnvelope(id, -0.01), 0); assert.equal(previewEnvelope(id, end), 0); assert.equal(previewEnvelope(id, end + 1), 0);
    if (id === 'gesture' || id === 'drowsyFace') continue; // a cue / a phase override, no amount of their own
    assert.equal(previewEnvelope(id, 0), 0, id);
    let last = 0, step = 0;
    for (let t = 0; t <= end + 0.05; t += 1 / 60) { const v = previewEnvelope(id, t); step = Math.max(step, Math.abs(v - last)); last = v; }
    assert.ok(step < 0.16, `${id} changes smoothly (${step})`);
  }
  assert.ok(previewEnvelope('closeEyes', 0.8) === 1, 'closed in the middle');
  assert.ok(Math.abs(capabilityPreviewSeconds('closeEyes') - 1.5) < 1e-9 && Math.abs(capabilityPreviewSeconds('blush') - 2) < 1e-9);
  assert.ok(Math.abs(capabilityPreviewSeconds('mouth') - 0.6) < 1e-9);
  assert.ok(previewEnvelope('mouth', 0.3) > 0.6, 'mouth open on あ');
});

test('previews overlap, do not restart while showing, end by themselves and drop on a model change', () => {
  const owner = {}, previews = new CapabilityPreviews();
  assert.deepEqual(previews.frame(0, owner), NO_CAPABILITY_PREVIEW);
  assert.equal(previews.start('closeEyes', 0, owner), true);
  assert.equal(previews.start('blush', 0.2, owner), true);
  assert.equal(previews.start('closeEyes', 0.7, owner), false, 'already showing: it keeps going');
  const mid = previews.frame(0.8, owner);
  assert.equal(mid.closure, 1); assert.ok(mid.blush > 0.7);
  assert.ok(previews.frame(1.6, owner).closure === 0 && !previews.showing('closeEyes'), 'over at 1.5 s');
  assert.equal(previews.frame(2.3, owner).blush, 0);
  assert.equal(previews.active, false);
  previews.start('sleepPose', 3, owner);
  assert.equal(previews.frame(4, owner).sleep, true);
  assert.equal(previews.frame(6.1, owner).sleep, false, 'the sleep override ends after 3 s; the real phase wakes her');
  previews.start('gesture', 7, owner, 1234);
  const wave = previews.frame(7.1, owner).wave;
  assert.ok(wave && wave.at === 1234 && /^capability-preview-\d+$/.test(wave.id));
  assert.deepEqual(previews.frame(7.2, {}), NO_CAPABILITY_PREVIEW, 'another model: nothing carried over');
  previews.start('tears', 8, owner); previews.start('drowsyFace', 8, owner);
  const late = previews.frame(9, owner);
  assert.ok(late.tears > 0.8 && Math.abs(late.tearsMs - 1000) < 1e-6 && late.drowsy, 'tears grow on their own clock; the drowsy face holds its phase');
  assert.equal(previews.frame(10.6, owner).drowsy, false);
  assert.equal(isModelCapabilityId('blush'), true); assert.equal(isModelCapabilityId('tears'), true); assert.equal(isModelCapabilityId('wings'), false); assert.equal(isModelCapabilityId(null), false);
});
