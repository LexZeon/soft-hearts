import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_CONTACT, MoodFeedback, type StageMoodState } from '../src/stage/mood-feedback';
import { DEFAULT_MOOD_PARAMETERS, applyMoodEvent, createMoodState, getMoodSnapshot, type MoodEventSnapshot } from '../shared/mood';
const mood: StageMoodState = { mood: '满足', phase: 'rua', expressive: true, face: 50, posture: 50, playful: 50, responding: true };

test('two-second local attention approaches contact continuously and leaves without a snap', () => {
  const layer = new MoodFeedback();
  const quiet = { ...mood, responding: false };
  const heights: number[] = [];
  for (let frame = 0; frame <= 60; frame++) heights.push(layer.frame(1 / 30,
    { ...EMPTY_CONTACT, hover: frame / 60, x: 0.6 }, quiet).headY);
  assert.ok(heights[15] > 0 && heights[50] > heights[15] * 3);
  const before = heights.at(-1)!;
  const active = layer.frame(1 / 30, { ...EMPTY_CONTACT, contact: true, hover: 1, x: 0.6 }, quiet);
  assert.ok(Math.abs(active.headY - before) < 0.003, 'the threshold changes accounting, not the displayed target');
  const exit = layer.frame(1 / 30, EMPTY_CONTACT, quiet);
  assert.ok(exit.headY > before * 0.8, 'early return is continuous');
  for (let frame = 0; frame < 200; frame++) layer.frame(1 / 30, EMPTY_CONTACT, quiet);
  assert.ok(layer.attentionWeight < 1e-8);
});

test('enjoyed eyelids stay stable across the former instantaneous speed threshold', () => {
  const layer = new MoodFeedback();
  for (let frame = 0; frame < 180; frame++) layer.frame(1 / 30, { ...EMPTY_CONTACT, contact: true }, mood);
  const lids: number[] = [];
  for (let frame = 0; frame < 240; frame++) lids.push(layer.frame(1 / 30,
    { ...EMPTY_CONTACT, contact: true, speed: frame % 2 ? 3 : 0.1 }, mood).eyelids);
  assert.ok(Math.max(...lids) - Math.min(...lids) < 1e-5);
  assert.ok(lids.every(value => value > 0.37 && value < 0.39));
});

test('feeding uses a bounded larger mouth envelope and closes after acceptance or leaving', () => {
  const layer = new MoodFeedback(), input = { ...EMPTY_CONTACT, feeding: true, prepared: true };
  const original = structuredClone(mood);
  const first = layer.frame(1 / 30, input, mood);
  assert.ok(first.mouth > 0 && first.mouth < 0.3);
  let peak = first;
  for (let frame = 0; frame < 35; frame++) peak = layer.frame(1 / 30, input, mood);
  assert.ok(peak.mouth > 0.8 && peak.mouth <= 0.85);
  const accepted = layer.frame(1 / 30, input, { ...mood, phase: 'food-eating' });
  assert.ok(accepted.mouth > 0.5 && accepted.mouth < peak.mouth);
  for (let frame = 0; frame < 90; frame++) peak = layer.frame(1 / 30, EMPTY_CONTACT, mood);
  assert.ok(peak.mouth < 1e-6);
  assert.deepEqual(mood, original, 'rendering cannot change the source mood');
  const independent = new MoodFeedback();
  for (let frame = 0; frame < 40; frame++) peak = independent.frame(1 / 30, input, mood, true, true, false);
  assert.ok(peak.mouth > 0.8 && peak.smile === 0 && peak.eyelids === 0, 'manual eye/face selection does not own an unrelated mouth');
});
test('rua total offset is bounded under diagonal rapid input and never injects NaN', () => {
  const layer = new MoodFeedback();
  for (let n = 0; n < 500; n++) {
    const result = layer.frame(1 / 30, { ...EMPTY_CONTACT, contact: true, x: 1, y: 1, velocityX: n % 2 ? 100 : -100, velocityY: 100, speed: 100 }, mood);
    assert.ok(Math.hypot(result.headX, result.headY, result.headZ) <= Math.PI / 15 + 1e-12);
  }
  const safe = layer.frame(NaN, { ...EMPTY_CONTACT, contact: true, x: NaN }, mood);
  assert.ok(Number.isFinite(safe.headX));
});
test('ending contact returns head to rest; manual expression blocks automatic face', () => {
  const layer = new MoodFeedback();
  for (let n = 0; n < 90; n++) layer.frame(1 / 30, { ...EMPTY_CONTACT, contact: true, x: 0.8, speed: 0.5 }, mood);
  let result;
  for (let n = 0; n < 300; n++) result = layer.frame(1 / 30, EMPTY_CONTACT, { ...mood, responding: false }, true);
  assert.ok(Math.abs(result!.headY) < 1e-6);
  assert.ok(result!.smile < 1e-6);
  assert.ok(result!.eyelids < 1e-6);
});
test('feeding preparation opens mouth without channel changes and reset clears offsets', () => {
  const layer = new MoodFeedback();
  let result;
  for (let n = 0; n < 30; n++) result = layer.frame(1 / 30, { ...EMPTY_CONTACT, feeding: true, prepared: true }, mood);
  assert.ok(result!.mouth > 0.4);
  layer.reset();
  result = layer.frame(0, EMPTY_CONTACT, { ...mood, expressive: false });
  assert.deepEqual([result.headX, result.headY, result.headZ, result.mouth, result.smile], [0, 0, 0, 0, 0]);
});

const event = (id: string, delta: Partial<MoodEventSnapshot['delta']>, context: MoodEventSnapshot['context'] = 'positive'): MoodEventSnapshot => ({ id, at: 0, ageMs: 0, context, delta: { D: 0, O: 0, E: 0, N: 0, C: 0, ...delta } });
const settle = (layer: MoodFeedback, state: StageMoodState, frames = 60) => {
  let output = layer.frame(0, EMPTY_CONTACT, state);
  for (let n = 0; n < frames; n++) output = layer.frame(1 / 60, EMPTY_CONTACT, state);
  return output;
};

test('a comfortable companion cannot cover concern with a responding smile or playful movement', () => {
  const layer = new MoodFeedback();
  const happy = settle(layer, { ...mood, mood: 'happy', phase: 'idle' });
  assert.ok(happy.smile > 0.2);
  const concern = layer.frame(1 / 30, { ...EMPTY_CONTACT, contact: true, x: 0.7, speed: 1 }, { ...mood, mood: 'concerned', companion: 'comfortable', context: 'concern', event: event('work', { C: 8, N: 8 }, 'concern') });
  assert.equal(concern.smile, 0);
  assert.ok(concern.eyelids <= 0.05);
  assert.equal(concern.playful, 0);
  assert.ok(concern.eventNegative > 0);
  assert.ok(Math.abs(concern.headY) > 0, 'the actual direct touch still moves the head');
});

test('responding without positive meaning does not imply smiling', () => {
  const plain = settle(new MoodFeedback(), { ...mood, mood: 'calm', phase: 'idle', context: 'neutral' });
  assert.equal(plain.smile, 0);
  const sad = settle(new MoodFeedback(), { ...mood, mood: 'disappointed', companion: 'close', context: 'disappointment' });
  assert.equal(sad.smile, 0); assert.ok(sad.sadness > 0);
});

test('same main mood distinguishes fast rise, slow rise, stable and a signed event drop', () => {
  const base: StageMoodState = { ...mood, mood: 'happy', phase: 'idle', responding: false };
  const rising = settle(new MoodFeedback(), { ...base, trend: { D: 8 }, fast: { D: 'up' }, event: event('fast', { D: 8 }) }, 30);
  const slow = settle(new MoodFeedback(), { ...base, trend: { D: 0.5 }, fast: { D: 'steady' }, event: event('slow', { D: 0.5 }) }, 30);
  const stable = settle(new MoodFeedback(), base, 30);
  const falling = settle(new MoodFeedback(), { ...base, trend: { D: -8 }, fast: { D: 'down' }, event: event('fall', { D: -8 }, 'disappointment') }, 30);
  assert.ok(rising.smile > slow.smile); assert.ok(slow.smile > stable.smile); assert.ok(stable.smile > falling.smile);
  assert.ok(falling.eventNegative > 0);
  const natural = settle(new MoodFeedback(), { ...base, trend: { D: -8 }, fast: { D: 'down' }, event: null }, 30);
  assert.equal(natural.eventNegative, 0, 'a value drifting to baseline is not a new disappointment event');
  assert.equal(natural.smile, stable.smile);
});

test('event animation settles instead of replaying on each unchanged host snapshot', () => {
  const state: StageMoodState = { ...mood, mood: 'happy', phase: 'idle', responding: false, event: event('once', { D: 10 }), trend: { D: 10 }, fast: { D: 'up' } };
  const layer = new MoodFeedback();
  const later = settle(layer, state, 600);
  const stable = settle(new MoodFeedback(), { ...state, event: null }, 600);
  assert.equal(later.eventPositive, 0);
  assert.ok(Math.abs(later.smile - stable.smile) < 0.001);
});

test('expectation and pressure stay simultaneously visible, while reunion may retain wistful softness', () => {
  const tense = settle(new MoodFeedback(), { ...mood, mood: 'tense-expectation', phase: 'idle', context: 'positive', event: event('result', { D: 10, C: 10, N: 10 }), trend: { D: 10, C: 10, N: 10 } }, 15);
  assert.ok(tense.eventPositive > 0 && tense.eventNegative > 0); assert.equal(tense.smile, 0);
  const relieved = settle(new MoodFeedback(), { ...mood, mood: 'relieved', phase: 'idle', companion: 'wistful' });
  const pure = settle(new MoodFeedback(), { ...mood, mood: 'relieved', phase: 'idle' });
  assert.ok(relieved.smile < pure.smile); assert.ok(relieved.sadness > 0);
});

function blush() {
  const state = applyMoodEvent(createMoodState(0), { type: 'chat', id: 'closeness', context: 'support', delta: { O: 10 } }, 0);
  return getMoodSnapshot(state).blush!;
}
test('a causal blush has its own smooth clock and never forces a smile or edits its source', () => {
  const cue = blush(), before = structuredClone(cue);
  const state: StageMoodState = { ...mood, mood: 'calm', phase: 'idle', responding: false, blush: cue };
  const layer = new MoodFeedback();
  assert.equal(layer.frame(0, EMPTY_CONTACT, state).blush, 0);
  const risen = settle(layer, state, 30);
  assert.ok(risen.blush > 0.3 && risen.blush <= 0.35); assert.equal(risen.smile, 0);
  const ended = settle(layer, state, 240);
  assert.equal(ended.blush, 0, 'an unchanged old snapshot cannot restart the envelope');
  assert.deepEqual(cue, before);
});

test('pause, face conflict and zero intensity remove blush and never replay the suppressed cue', () => {
  for (const mode of ['pause', 'face', 'zero'] as const) {
    const cue = { ...blush(), ageMs: 500 };
    const layer = new MoodFeedback();
    const state: StageMoodState = { ...mood, mood: 'concerned', phase: 'idle', blush: cue };
    assert.ok(layer.frame(0, EMPTY_CONTACT, state).blush > 0);
    const muted = layer.frame(1 / 30, EMPTY_CONTACT, mode === 'pause' ? { ...state, expressive: false } : mode === 'zero' ? { ...state, blush: { ...cue, profile: { ...cue.profile, intensity: 0 } } } : state, mode === 'face');
    assert.equal(muted.blush, 0, mode);
    assert.equal(layer.frame(1 / 30, EMPTY_CONTACT, state).blush, 0, `${mode} does not replay`);
    const fresh = layer.frame(1 / 30, EMPTY_CONTACT, { ...state, blush: { ...cue, id: 'new-event' } });
    assert.ok(fresh.blush > 0); assert.equal(fresh.smile, 0);
  }
});

test('reset clears expression clocks and malformed blush data cannot inject NaN', () => {
  const layer = new MoodFeedback(); const state = { ...mood, blush: { ...blush(), ageMs: 500 } };
  assert.ok(layer.frame(0, EMPTY_CONTACT, state).blush > 0);
  layer.reset(); assert.equal(layer.frame(0, EMPTY_CONTACT, { ...mood, blush: null }).blush, 0);
  assert.equal(layer.frame(0, EMPTY_CONTACT, { ...state, blush: { ...state.blush, ageMs: NaN } }).blush, 0);
  assert.equal(layer.frame(0, EMPTY_CONTACT, { ...state, blush: { ...state.blush, profile: { ...DEFAULT_MOOD_PARAMETERS.blush, fadeMs: 0 } } }).blush, 0);
});
