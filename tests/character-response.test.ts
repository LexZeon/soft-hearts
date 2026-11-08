import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARACTER_RESPONSE_CONTEXTS, CHARACTER_RESPONSE_INTENSITIES, CHARACTER_RESPONSE_MOODS,
  CHARACTER_RESPONSE_PHASES, CHARACTER_RESPONSE_TENDENCIES, MAX_CHARACTER_RESPONSE_RULES,
  applyMoodResponse, characterResponseRuleKey, defaultCharacterResponseProfile,
  defaultCharacterResponseRule, matchCharacterResponseRule, validateCharacterResponseProfile,
  type CharacterResponseProfile, type CharacterResponseRule, type CharacterResponseSnapshot,
  type CharacterResponseWhen,
} from '../shared/character-response';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../shared/mood';
import { MOOD_LABELS } from '../shared/mood-runtime';

const now = 1_800_000_000_000;
function baseSnapshot(parameters = structuredClone(DEFAULT_MOOD_PARAMETERS)) {
  const state = createMoodState(now, parameters);
  state.values = { D: 65, O: 65, E: 65, N: 50, C: 45 };
  state.reason = { text: 'Existing accepted event', at: now, context: 'positive', eventId: 'original-event' };
  state.trend = [{ at: now, delta: { D: 1, O: 0, E: 0, N: 0, C: 0 }, id: 'original-event', context: 'positive' }];
  state.lastInteractionAt = now;
  state.cue = { id: 'original-cue', kind: 'satisfied', at: now, until: now + 4_000 };
  return getMoodSnapshot(state, now, parameters);
}
function profile(...rules: CharacterResponseRule[]): CharacterResponseProfile {
  return validateCharacterResponseProfile({ version: 1, rules });
}
function rule(when: CharacterResponseWhen, expressionScale = 1): CharacterResponseRule {
  const result = defaultCharacterResponseRule(when);
  result.intensityScale.expression = expressionScale;
  return result;
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test('response selectors use the actual twelve labels and only finite host phases and contexts', () => {
  assert.equal(CHARACTER_RESPONSE_MOODS.length, 12);
  assert.deepEqual(new Set(CHARACTER_RESPONSE_MOODS), new Set(Object.keys(MOOD_LABELS)));
  assert.deepEqual(CHARACTER_RESPONSE_PHASES, ['idle', 'rua', 'food-wait', 'food-ready', 'food-eating', 'cheek']);
  assert.deepEqual(CHARACTER_RESPONSE_CONTEXTS, ['neutral', 'positive', 'support', 'concern', 'disappointment', 'offense']);
  assert.equal(CHARACTER_RESPONSE_TENDENCIES.length, 4);
  assert.equal(CHARACTER_RESPONSE_INTENSITIES.length, 5);
});

test('default profiles and full nine-scale rules are detached and do not retain caller conditions', () => {
  const empty = defaultCharacterResponseProfile();
  assert.deepEqual(empty, { version: 1, rules: [] });
  const when: CharacterResponseWhen = { mood: 'happy', phase: 'rua' };
  const first = defaultCharacterResponseRule(when);
  when.phase = 'idle';
  assert.equal(first.when.phase, 'rua');
  assert.equal(Object.values(first.tendencyScale).length + Object.values(first.intensityScale).length, 9);
  assert.ok([...Object.values(first.tendencyScale), ...Object.values(first.intensityScale)].every(value => value === 1));
  first.tendencyScale.playful = 3;
  assert.equal(defaultCharacterResponseRule({ mood: 'happy' }).tendencyScale.playful, 1);
  empty.rules.push(first);
  assert.deepEqual(defaultCharacterResponseProfile(), { version: 1, rules: [] });
});

test('empty, absent, unmatched and neutral response profiles preserve every original snapshot value', () => {
  const snapshot = freezeDeep(baseSnapshot());
  for (const response of [undefined, null, defaultCharacterResponseProfile(),
    profile(rule({ mood: 'sad' })), profile(rule({ mood: 'happy', phase: 'food-eating' })),
    profile(rule({ mood: 'happy', context: 'offense' })), profile(rule({ mood: 'happy' }))]) {
    assert.strictEqual(applyMoodResponse(snapshot, response), snapshot);
    assert.deepEqual(applyMoodResponse(snapshot, response), snapshot);
  }
});

test('scales change supported tendencies and intensities while leaving primary, channels, events and clocks unchanged', () => {
  const snapshot = freezeDeep(baseSnapshot());
  const original = structuredClone(snapshot);
  const selected = rule({ mood: 'happy' });
  selected.tendencyScale.close = 4;
  selected.intensityScale = { expression: 2, gaze: 0.25, posture: 0.5, playful: 1.5, text: 0 };
  const response = freezeDeep(profile(selected));
  const transformed = applyMoodResponse(snapshot, response);
  assert.notStrictEqual(transformed, snapshot);
  assert.equal(transformed.tendencies.close, snapshot.tendencies.close * 4);
  assert.equal(transformed.tendencies.playful, snapshot.tendencies.playful);
  assert.equal(transformed.companion, 'close');
  assert.deepEqual(transformed.intensity, { expression: 100, gaze: 12.5, posture: 25, playful: 75, text: 0 });
  const { tendencies: _oldT, intensity: _oldI, companion: _oldC, ...unchanged } = snapshot;
  const { tendencies: _newT, intensity: _newI, companion: _newC, ...actual } = transformed;
  assert.deepEqual(actual, unchanged);
  assert.deepEqual(snapshot, original);
  assert.equal(response.rules[0].tendencyScale.close, 4);
});

test('one most-specific matching rule wins without stacking or depending on array order', () => {
  const snapshot = { ...baseSnapshot(), phase: 'rua' as const };
  const general = rule({ mood: 'happy' }, 1.1);
  const phase = rule({ mood: 'happy', phase: 'rua' }, 1.2);
  const context = rule({ mood: 'happy', context: 'positive' }, 1.3);
  const both = rule({ mood: 'happy', phase: 'rua', context: 'positive' }, 1.4);
  for (const rules of [[both, phase, general, context], [context, general, phase, both]]) {
    const response = profile(...rules);
    assert.deepEqual(matchCharacterResponseRule(snapshot, response), both);
    assert.equal(applyMoodResponse(snapshot, response).intensity.expression, 70);
  }
  assert.deepEqual(matchCharacterResponseRule(snapshot, profile(general, phase)), phase);
  assert.deepEqual(matchCharacterResponseRule(snapshot, profile(general)), general);
});

test('a context-specific rule wins a phase-specific tie and never multiplies the two', () => {
  const snapshot = { ...baseSnapshot(), phase: 'rua' as const };
  const phase = rule({ mood: 'happy', phase: 'rua' }, 1.2);
  const context = rule({ mood: 'happy', context: 'positive' }, 1.3);
  for (const rules of [[phase, context], [context, phase]]) {
    const response = profile(...rules);
    assert.deepEqual(matchCharacterResponseRule(snapshot, response), context);
    assert.equal(applyMoodResponse(snapshot, response).intensity.expression, 65);
  }
});

test('the implemented cheek phase can match while renderer hover cannot become a host selector', () => {
  const snapshot: CharacterResponseSnapshot = { ...baseSnapshot(), phase: 'cheek' };
  const response = profile(rule({ mood: 'happy', phase: 'cheek' }, 0.5));
  assert.equal(applyMoodResponse(snapshot, response).intensity.expression, 25);
  assert.equal(applyMoodResponse(snapshot, response).phase, 'cheek');
  assert.throws(() => validateCharacterResponseProfile({ version: 1, rules: [
    { ...response.rules[0], when: { mood: 'happy', phase: 'cheek-hover' } },
  ] }), /phase/);
});

test('common zero weights, absent evidence and zero intensities stay closed under maximum scales', () => {
  const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS);
  parameters.weights.playful = 0;
  parameters.intensity.expression = 0;
  parameters.intensity.posture = 0;
  const snapshot = baseSnapshot(parameters);
  const selected = rule({ mood: snapshot.primary });
  for (const key of CHARACTER_RESPONSE_TENDENCIES) selected.tendencyScale[key] = 4;
  for (const key of CHARACTER_RESPONSE_INTENSITIES) selected.intensityScale[key] = 2;
  const changed = applyMoodResponse(snapshot, profile(selected));
  assert.equal(changed.tendencies.playful, 0);
  assert.equal(changed.tendencies.cautious, 0);
  assert.equal(changed.intensity.expression, 0);
  assert.equal(changed.intensity.posture, 0);
  assert.equal(changed.primary, snapshot.primary);
});

test('zero conditional scales remove only extra tendencies and expression categories', () => {
  const snapshot = baseSnapshot();
  const selected = rule({ mood: snapshot.primary });
  for (const key of CHARACTER_RESPONSE_TENDENCIES) selected.tendencyScale[key] = 0;
  for (const key of CHARACTER_RESPONSE_INTENSITIES) selected.intensityScale[key] = 0;
  const changed = applyMoodResponse(snapshot, profile(selected));
  assert.equal(changed.companion, null);
  assert.ok(Object.values(changed.tendencies).every(value => value === 0));
  assert.ok(Object.values(changed.intensity).every(value => value === 0));
  assert.deepEqual(changed.event, snapshot.event);
  assert.deepEqual(changed.cue, snapshot.cue);
  assert.deepEqual(changed.values, snapshot.values);
  assert.equal(changed.primary, snapshot.primary);
});

test('wistful reunion priority is preserved even when conditional tendencies are all disabled', () => {
  const state = createMoodState(now);
  state.reunion = { id: 'original-reunion', at: now, longing: 80, crying: true };
  const snapshot = getMoodSnapshot(state, now);
  assert.equal(snapshot.companion, 'wistful');
  const selected = rule({ mood: snapshot.primary });
  for (const key of CHARACTER_RESPONSE_TENDENCIES) selected.tendencyScale[key] = 0;
  selected.intensityScale.text = 0.5;
  const transformed = applyMoodResponse(snapshot, profile(selected));
  assert.equal(transformed.companion, 'wistful');
  assert.deepEqual(transformed.reunion, snapshot.reunion);
  assert.equal(transformed.cryingCandidate, snapshot.cryingCandidate);
});

test('equal tendency evidence keeps the existing deterministic order and intensity output is bounded', () => {
  const snapshot = { ...baseSnapshot(),
    tendencies: { cautious: 2, comfortable: 2, close: 2, playful: 2 },
    intensity: { expression: 80, gaze: 0, posture: 75, playful: 20, text: 50 },
  };
  const selected = rule({ mood: snapshot.primary });
  for (const key of CHARACTER_RESPONSE_TENDENCIES) selected.tendencyScale[key] = 2;
  for (const key of CHARACTER_RESPONSE_INTENSITIES) selected.intensityScale[key] = 2;
  const changed = applyMoodResponse(snapshot, profile(selected));
  assert.equal(changed.companion, 'playful');
  assert.deepEqual(changed.intensity, { expression: 100, gaze: 0, posture: 100, playful: 40, text: 100 });
});

test('the complete bounded profile is cloned and preserves JSON round-trips without caller aliases', () => {
  const source = { version: 1, rules: [rule({ mood: 'happy', phase: 'rua', context: 'support' }, 2)] };
  source.rules[0].tendencyScale.playful = 4;
  const validated = validateCharacterResponseProfile(source);
  assert.deepEqual(validated, source);
  assert.deepEqual(validateCharacterResponseProfile(JSON.parse(JSON.stringify(validated))), validated);
  assert.notStrictEqual(validated.rules[0].when, source.rules[0].when);
  source.rules[0].intensityScale.expression = 0;
  assert.equal(validated.rules[0].intensityScale.expression, 2);
  validated.rules[0].tendencyScale.close = 0;
  assert.equal(source.rules[0].tendencyScale.close, 1);
});

test('selector identity ignores object property order but distinguishes mood, phase and context', () => {
  assert.equal(characterResponseRuleKey({ mood: 'happy', phase: 'rua', context: 'support' }),
    characterResponseRuleKey({ context: 'support', phase: 'rua', mood: 'happy' }));
  const selectors: CharacterResponseWhen[] = [
    { mood: 'happy' }, { mood: 'happy', phase: 'rua' }, { mood: 'happy', context: 'support' },
    { mood: 'happy', phase: 'rua', context: 'support' }, { mood: 'sad' },
  ];
  assert.equal(new Set(selectors.map(characterResponseRuleKey)).size, selectors.length);
  assert.throws(() => profile(rule(selectors[3]), rule({ context: 'support', phase: 'rua', mood: 'happy' })), /Duplicate/);
});

test('twenty-four sparse rules are accepted and a twenty-fifth is rejected', () => {
  const rules = CHARACTER_RESPONSE_MOODS.flatMap(mood => [rule({ mood }), rule({ mood, phase: 'rua' })]);
  assert.equal(rules.length, MAX_CHARACTER_RESPONSE_RULES);
  assert.equal(profile(...rules).rules.length, 24);
  assert.throws(() => profile(...rules, rule({ mood: 'calm', context: 'positive' })), /at most 24/);
});

test('profile, rule, selector and scale objects reject unknown capabilities or missing fields', () => {
  const valid = profile(rule({ mood: 'happy' }));
  const invalid: unknown[] = [
    null, [], 'profile', { version: 1 }, { rules: [] }, { version: 2, rules: [] },
    { version: 1, rules: null }, { version: 1, rules: [null] },
    { ...valid, values: { D: 100 } }, { ...valid, history: ['PRIVATE'] },
    { version: 1, rules: [{ ...valid.rules[0], modelPath: 'C:/private/model.pmx' }] },
    { version: 1, rules: [{ ...valid.rules[0], when: { mood: 'happy', script: 'run()' } }] },
    { version: 1, rules: [{ ...valid.rules[0], when: {} }] },
    { version: 1, rules: [{ ...valid.rules[0], intensityScale: { expression: 1 } }] },
    { version: 1, rules: [{ ...valid.rules[0], tendencyScale: { ...valid.rules[0].tendencyScale, permission: 1 } }] },
    JSON.parse('{"version":1,"rules":[],"__proto__":{"permission":true}}'),
  ];
  for (const value of invalid) assert.throws(() => validateCharacterResponseProfile(value));
  const missingRuleField = structuredClone(valid) as { version: number; rules: Partial<CharacterResponseRule>[] };
  delete missingRuleField.rules[0].tendencyScale;
  assert.throws(() => validateCharacterResponseProfile(missingRuleField));
});

test('every condition rejects invented, null, undefined and wildcard values', () => {
  const selected = rule({ mood: 'happy' });
  for (const when of [
    { mood: 'invented' }, { mood: '__proto__' }, { mood: 'toString' }, { mood: null }, { mood: '*' },
    { mood: 'happy', phase: '*' }, { mood: 'happy', phase: null }, { mood: 'happy', phase: undefined },
    { mood: 'happy', context: 'unknown' }, { mood: 'happy', context: null }, { mood: 'happy', context: undefined },
  ]) assert.throws(() => validateCharacterResponseProfile({ version: 1, rules: [{ ...selected, when }] }));
});

test('all nine scales require finite numbers within their distinct bounds', () => {
  const original = profile(rule({ mood: 'happy' }));
  for (const key of CHARACTER_RESPONSE_TENDENCIES) {
    for (const value of [-0.01, 4.01, Infinity, -Infinity, NaN, '1', null]) {
      const candidate = structuredClone(original);
      (candidate.rules[0].tendencyScale as Record<string, unknown>)[key] = value;
      assert.throws(() => validateCharacterResponseProfile(candidate), /range/);
    }
  }
  for (const key of CHARACTER_RESPONSE_INTENSITIES) {
    for (const value of [-0.01, 2.01, Infinity, -Infinity, NaN, '1', null]) {
      const candidate = structuredClone(original);
      (candidate.rules[0].intensityScale as Record<string, unknown>)[key] = value;
      assert.throws(() => validateCharacterResponseProfile(candidate), /range/);
    }
  }
});

test('sparse arrays, accessors and custom prototypes never enter the validated data contract', () => {
  const sparse = Array<CharacterResponseRule>(1);
  assert.throws(() => validateCharacterResponseProfile({ version: 1, rules: sparse }));
  const custom = Object.create({ version: 1 }); custom.rules = [];
  assert.throws(() => validateCharacterResponseProfile(custom));
  const getter = { version: 1, get rules(): never { throw new Error('getter must not execute'); } };
  assert.throws(() => validateCharacterResponseProfile(getter), /data only/);
  const symbol = { version: 1, rules: [], [Symbol('hidden')]: 'not JSON' };
  assert.throws(() => validateCharacterResponseProfile(symbol));
});
