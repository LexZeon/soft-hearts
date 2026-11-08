import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesMotionTrackFilter, passesMotionTrackExclusion, type MotionTrackCoverage, type MotionTrackProperty } from '../shared/motion-track-coverage';
import { motionTrackFacts } from '../electron/motion-track-coverage';
import { stripDefaultVmdTracks } from '../src/stage/vmd-tracks';

const row = (target: string, kind: MotionTrackProperty['kind'] = 'quaternion', part: MotionTrackProperty['part'] = 'right-arm'): MotionTrackProperty =>
  ({ target, kind, part, modelIndex: 27, keyframes: 1, state: 'static-nondefault' });
const fact = (properties: MotionTrackProperty[]): MotionTrackCoverage => ({
  asset: { packId: 'gene', motionId: 'synthetic' }, sha256: 'f'.repeat(64), properties,
  durationFrames: 30, removedDefaultBones: 0, removedZeroMorphs: 0,
  modelMapping: 'verified-public-gene', modelSha256: '0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37',
});

test('exclusion default preserves prior all behavior and unread coverage never proves an active exclusion', () => {
  assert.equal(passesMotionTrackExclusion(undefined, { kind: 'none' }), true);
  assert.equal(passesMotionTrackExclusion(undefined, { kind: 'target', target: '頭', channel: 'bone' }), false);
  assert.equal(passesMotionTrackExclusion(undefined, { kind: 'part', part: 'head' }), false);
  assert.equal(matchesMotionTrackFilter(fact([]), { kind: 'all' }), true);
});

test('exact bone and morph exclusions are distinct and retained static properties remain occupied', () => {
  const f = fact([row('same', 'position'), row('same', 'quaternion'), row('face', 'morph', null)]), before = structuredClone(f);
  assert.equal(passesMotionTrackExclusion(f, { kind: 'target', target: 'same', channel: 'bone' }), false);
  assert.equal(passesMotionTrackExclusion(f, { kind: 'target', target: 'same', channel: 'morph' }), true);
  assert.equal(passesMotionTrackExclusion(f, { kind: 'target', target: 'face', channel: 'morph' }), false);
  assert.equal(passesMotionTrackExclusion(f, { kind: 'target', target: 'face', channel: 'bone' }), true);
  f.properties[0].state = 'static-default';
  assert.equal(passesMotionTrackExclusion(f, { kind: 'target', target: 'same', channel: 'bone' }), false);
  assert.deepEqual({ ...f, properties: before.properties }, before);
});

test('exclusion examines the complete retained property set beyond the 256-row detail window', () => {
  const f = fact(Array.from({ length: 300 }, (_, i) => row('bone' + i)));
  assert.equal(passesMotionTrackExclusion(f, { kind: 'target', target: 'bone299', channel: 'bone' }), false);
  assert.equal(passesMotionTrackExclusion(f, { kind: 'target', target: 'absent', channel: 'bone' }), true);
});

test('part absence requires every retained binding known; unknown model, morph or source index cannot pass', () => {
  const f = fact([row('右腕')]);
  assert.equal(passesMotionTrackExclusion(f, { kind: 'part', part: 'head' }), true);
  assert.equal(passesMotionTrackExclusion(f, { kind: 'part', part: 'right-arm' }), false);
  for (const changed of [
    { ...f, modelMapping: 'unknown' as const }, { ...f, modelSha256: null },
    fact([{ ...row('unknown'), part: null }]), fact([{ ...row('unbound'), modelIndex: null }]),
    fact([row('右腕'), row('face', 'morph', null)]),
  ]) assert.equal(passesMotionTrackExclusion(changed, { kind: 'part', part: 'head' }), false);
  // Unknown anatomy does not erase an already assessed literal VMD target record.
  assert.equal(passesMotionTrackExclusion({ ...f, modelMapping: 'unknown' }, { kind: 'target', target: '頭', channel: 'bone' }), true);
});

test('hard exclusion intersects the original positive filter and never grants combination or playback', () => {
  const f = fact([row('右腕'), row('頭', 'quaternion', 'head')]);
  assert.equal(matchesMotionTrackFilter(f, { kind: 'part', part: 'right-arm' }), true);
  assert.equal(passesMotionTrackExclusion(f, { kind: 'part', part: 'head' }), false);
  assert.equal(matchesMotionTrackFilter(f, { kind: 'part', part: 'right-arm' })
    && passesMotionTrackExclusion(f, { kind: 'target', target: '頭', channel: 'bone' }), false);
  assert.equal('canPlay' in f, false); assert.equal('combination' in f, false);
});

test('absence refers to actual normalized retained tracks without trimming original VMD data', () => {
  const data = { metadata: { motionCount: 2, morphCount: 1 }, motions: [
    { boneName: 'defaultHead', frameNum: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    { boneName: '右腕', frameNum: 0, position: [0, 0, 0], rotation: [0, 0, .2, Math.sqrt(.96)] },
  ], morphs: [{ morphName: 'zero', frameNum: 0, weight: 0 }] }, before = structuredClone(data);
  const cleaned = stripDefaultVmdTracks(data), f = fact(motionTrackFacts(cleaned.vmd));
  assert.equal(cleaned.report.removedBoneNames.length, 1); assert.equal(cleaned.report.removedMorphNames.length, 1);
  assert.equal(passesMotionTrackExclusion(f, { kind: 'target', target: 'defaultHead', channel: 'bone' }), true);
  assert.equal(passesMotionTrackExclusion(f, { kind: 'target', target: '右腕', channel: 'bone' }), false);
  assert.deepEqual(data, before);
});
