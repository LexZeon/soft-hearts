/**
 * U-012 ("M1 需要能有测试通道换心情"): the table behind "测试：开心 / 难过 / 困了 / 兴奋 / 平静 / 低落 …" and "测试：恢复心情".
 * Pure part: every row really gives its label under the real label rule (default card and a card with other baselines),
 * the channels then decay at their own speeds, and the hold is what keeps a context-dependent label alive.
 * The host part (MoodHost.setTestMood, the temporary drowsy look) is in test-command-features.test.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MOOD_PARAMETERS, MOOD_CHANNELS, advanceMood, createMoodState, getMoodSnapshot, type MoodLabel, type MoodParameters } from '../shared/mood';
import { MOOD_LABELS } from '../shared/mood-runtime';
import {
  FATIGUE_TEST_F, MOOD_PRESETS, MOOD_TEST_HOLD_MS, heldMoodState, moodPresetValues, moodValueForLevel, withBaselineMood, withMoodPresetValues,
} from '../shared/mood-presets';

const MINUTE = 60_000;
const LABELS = Object.keys(MOOD_LABELS) as MoodLabel[];
const cards: [string, MoodParameters][] = [
  ['default card', structuredClone(DEFAULT_MOOD_PARAMETERS)],
  ['a card with other baselines and stronger evidence', {
    ...structuredClone(DEFAULT_MOOD_PARAMETERS),
    baseline: { D: 40, O: 62, E: 55, N: 35, C: 30 }, evidence: { level: 1.4, trend: 1 },
  }],
];

function shown(label: MoodLabel, p: MoodParameters, afterMs = 0) {
  const preset = MOOD_PRESETS[label];
  let state = withMoodPresetValues(createMoodState(0, p), moodPresetValues(preset, p));
  if (afterMs) state = advanceMood(state, afterMs, { online: true }, p);
  return getMoodSnapshot(heldMoodState(state, preset, afterMs, 'test'), afterMs, p).primary;
}

test('the table has a row for every mood label, and each row is for its own label', () => {
  assert.deepEqual(Object.keys(MOOD_PRESETS).sort(), [...LABELS].sort());
  for (const label of LABELS) assert.equal(MOOD_PRESETS[label].label, label);
});

test('every row gives exactly its label under the real label rule, on the default card and on a card with other baselines', () => {
  for (const [name, p] of cards) for (const label of LABELS) assert.equal(shown(label, p), label, `${name}: ${label}`);
});

test('the channels then decay on their own, so the label gives way at the speed of the channels; two minutes in it is still there', () => {
  for (const [name, p] of cards) {
    for (const label of LABELS) assert.equal(shown(label, p, 2 * MINUTE), label, `${name}: ${label} after 2 minutes`);
    // Excited needs a fast channel (N, half-life 3 minutes) and a big D (8 minutes): it is over within minutes, as the real model has it.
    assert.notEqual(shown('excited', p, 8 * MINUTE), 'excited', name);
    assert.notEqual(shown('happy', p, 40 * MINUTE), 'happy', name);
  }
});

test('without the hold the context-dependent labels would be gone after the event\'s 30 seconds: that is what the hold is for', () => {
  const p = DEFAULT_MOOD_PARAMETERS;
  // (concerned also follows from high C and N alone, so it would stay without the hold while those channels last.)
  for (const label of ['happy', 'excited', 'disappointed', 'upset', 'tense-expectation'] as const) {
    const preset = MOOD_PRESETS[label];
    assert.notEqual(preset.context, 'neutral', label);
    // A real afterglow: the event that set it happened at 0.
    let state = withMoodPresetValues(createMoodState(0, p), moodPresetValues(preset, p));
    state = { ...state, reason: { text: preset.reason, at: 0, context: preset.context, eventId: 'e' } };
    assert.equal(getMoodSnapshot(state, 1_000, p).primary, label, `${label} right after the event`);
    assert.notEqual(getMoodSnapshot(state, 31_000, p).primary, label, `${label} 31 seconds later, no hold`);
  }
  for (const label of ['calm', 'content', 'close', 'longing', 'sad', 'relieved'] as const) assert.equal(MOOD_PRESETS[label].context, 'neutral', label);
  assert.equal(MOOD_TEST_HOLD_MS, 10 * MINUTE);
});

test('the held copy only changes the view: the stored state keeps its own reason, longing and reunion', () => {
  const p = DEFAULT_MOOD_PARAMETERS;
  const stored = withMoodPresetValues(createMoodState(0, p), moodPresetValues(MOOD_PRESETS.sad, p));
  const before = JSON.stringify(stored);
  const held = heldMoodState(stored, MOOD_PRESETS.sad, 5_000, 'x');
  assert.equal(held.longing, 70);
  assert.equal(JSON.stringify(stored), before);
  assert.equal(stored.longing, 0);
});

test('"恢复心情": the channels go back to the card\'s baseline, whatever they were', () => {
  for (const [, p] of cards) {
    const high = withMoodPresetValues(createMoodState(0, p), moodPresetValues(MOOD_PRESETS.excited, p));
    assert.notDeepEqual(high.values, p.baseline);
    const back = withBaselineMood(high, p);
    assert.deepEqual(back.values, p.baseline);
    assert.equal(getMoodSnapshot(back, 0, p).primary, 'calm');
  }
});

test('level to value is the inverse of the label rule\'s reading, and stays inside 0..100', () => {
  assert.equal(moodValueForLevel(50, 40, 1), 40);
  assert.equal(moodValueForLevel(100, 40, 1), 100);
  assert.equal(moodValueForLevel(0, 40, 1), 0);
  assert.ok(Math.abs(moodValueForLevel(75, 50, 1) - 75) < 1e-9);
  assert.ok(Math.abs(moodValueForLevel(75, 40, 1.5) - (40 + (1 / 3) * 60)) < 1e-9);
  for (const channel of MOOD_CHANNELS) for (const level of [0, 30, 50, 85, 100]) {
    const value = moodValueForLevel(level, 40, 2);
    assert.ok(value >= 0 && value <= 100, `${channel} ${level}`);
  }
});

test('the temporary drowsy look uses F values inside the fatigue model\'s own bands', () => {
  assert.ok(FATIGUE_TEST_F['light-drowsy'] >= 0.38 && FATIGUE_TEST_F['light-drowsy'] < 0.58);
  assert.ok(FATIGUE_TEST_F.drowsy >= 0.58 && FATIGUE_TEST_F.drowsy < 0.72, 'below the fall-asleep threshold');
});
