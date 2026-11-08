import assert from 'node:assert/strict';
import test from 'node:test';
import { selectChatGesture, type ChatGestureAppraisal } from '../shared/chat-gesture';
import { createMoodState, getMoodSnapshot, type MoodSnapshot } from '../shared/mood';

const snapshot = (): MoodSnapshot => getMoodSnapshot(createMoodState(1_000), 1_000);
const appraisal = (gesture: ChatGestureAppraisal['gesture'] = 'explain'): ChatGestureAppraisal => ({
  gesture, context: 'neutral', delta: {}, reason: '说明当前话题',
});
const strength = (value: ChatGestureAppraisal, mood = snapshot()) => {
  const result = selectChatGesture(value, mood);
  assert.ok(result, 'an eligible explicit performance intention should have a selection');
  return result.strength;
};

test('a plain or unknown intention never invents a performance or resource capability', () => {
  const mood = snapshot();
  assert.equal(selectChatGesture(null, mood), null);
  const plain = appraisal(); delete plain.gesture;
  assert.equal(selectChatGesture(plain, mood), null);
  for (const gesture of ['none', 'dance', '../motion.vmd', 'https://example.test/motion.vmd', null, { path: 'motion.vmd' }]) {
    assert.equal(selectChatGesture({ ...appraisal(), gesture } as unknown as ChatGestureAppraisal, mood), null);
  }
});

test('serious subject matter restrains upbeat performance even with a comfortable companion', () => {
  const concern = { ...appraisal('upbeat'), context: 'concern' as const };
  const mood = snapshot(); mood.companion = 'comfortable';
  const result = selectChatGesture(concern, mood);
  assert.equal(result?.intent, 'consider');
  assert.ok(result!.strength < strength(appraisal('upbeat'), mood));
  for (const context of ['concern', 'disappointment'] as const) {
    const seriousMood = snapshot(); seriousMood.context = context;
    assert.equal(selectChatGesture(appraisal('upbeat'), seriousMood)?.intent, 'consider');
  }
  for (const primary of ['concerned', 'disappointed', 'upset', 'sad', 'tense-expectation'] as const) {
    const seriousMood = snapshot(); seriousMood.primary = primary;
    assert.equal(selectChatGesture(appraisal('upbeat'), seriousMood)?.intent, 'consider');
  }
  const offended = snapshot(); offended.context = 'offense';
  assert.equal(selectChatGesture(appraisal('upbeat'), offended), null);
  assert.equal(selectChatGesture({ ...appraisal('upbeat'), context: 'offense' }, snapshot()), null);
});

test('explanation and consideration produce distinct restrained strengths in the same state', () => {
  const explain = selectChatGesture(appraisal('explain'), snapshot());
  const consider = selectChatGesture(appraisal('consider'), snapshot());
  assert.equal(explain?.intent, 'explain');
  assert.equal(consider?.intent, 'consider');
  assert.ok(explain!.strength > consider!.strength);
  assert.ok(consider!.strength > 0);
});

test('role posture intensity gates performance, scales it and always caps strength', () => {
  for (const posture of [0, -1, NaN, Infinity]) {
    const mood = snapshot(); mood.intensity.posture = posture;
    assert.equal(selectChatGesture(appraisal(), mood), null);
  }
  const subtle = snapshot(); subtle.intensity.posture = 10;
  assert.ok(strength(appraisal(), subtle) < strength(appraisal()));
  const expressive = snapshot(); expressive.intensity.posture = 100;
  expressive.trend.D = 12; expressive.trend.E = 12; expressive.tendencies.playful = 10;
  for (const gesture of ['explain', 'consider', 'upbeat'] as const) {
    const selected = strength(appraisal(gesture), expressive);
    assert.ok(selected > 0 && selected <= 0.7);
  }
  for (const phase of ['rua', 'food-wait', 'food-ready', 'food-eating'] as const) {
    const busy = snapshot(); busy.phase = phase;
    assert.equal(selectChatGesture(appraisal(), busy), null);
  }
});

test('mixed companion and cautious role tendencies change the same explanation', () => {
  const neutral = strength(appraisal());
  for (const companion of ['cautious', 'wistful'] as const) {
    const mood = snapshot(); mood.companion = companion;
    assert.ok(strength(appraisal(), mood) < neutral);
  }
  const close = snapshot(); close.companion = 'close';
  assert.ok(strength(appraisal(), close) > neutral);
  const cautious = snapshot(); cautious.tendencies.cautious = 10;
  assert.ok(strength(appraisal(), cautious) < neutral);
  const pressured = snapshot(); pressured.values.C = 90;
  assert.ok(strength(appraisal(), pressured) < neutral);
});

test('positive and stress trends change emphasis without requiring a new reward', () => {
  const stable = snapshot();
  const rising = snapshot(); rising.trend.D = 10; rising.trend.E = 8;
  const falling = snapshot(); falling.trend.D = -10; falling.trend.E = -8;
  assert.ok(strength(appraisal('upbeat'), rising) > strength(appraisal('upbeat'), stable));
  assert.ok(strength(appraisal('upbeat'), stable) > strength(appraisal('upbeat'), falling));
  const playful = snapshot(); playful.tendencies.playful = 10;
  assert.ok(strength(appraisal('upbeat'), playful) > strength(appraisal('upbeat'), stable));
  const stressed = snapshot(); stressed.trend.C = 8;
  assert.ok(strength(appraisal('consider'), stressed) > strength(appraisal('consider'), stable));
  const invalidTrend = snapshot(); invalidTrend.trend.C = NaN; invalidTrend.trend.D = Infinity;
  assert.ok(Number.isFinite(strength(appraisal('upbeat'), invalidTrend)));
});

test('selection leaves accepted semantic values and the host snapshot unchanged', () => {
  const semantic = appraisal('explain'); semantic.delta = { O: 2, C: -1 };
  const mood = snapshot(); mood.companion = 'comfortable'; mood.trend.O = 3;
  const before = structuredClone({ semantic, mood });
  Object.freeze(semantic.delta); Object.freeze(semantic);
  Object.freeze(mood.values); Object.freeze(mood.trend); Object.freeze(mood.tendencies);
  Object.freeze(mood.intensity); Object.freeze(mood);
  assert.ok(selectChatGesture(semantic, mood));
  assert.deepEqual({ semantic, mood }, before);
});
