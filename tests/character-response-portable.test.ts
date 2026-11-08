import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCharacterMoodTemplate, CHARACTER_CARD_FORMAT } from '../shared/character-cards';
import { defaultCharacterResponseProfile, defaultCharacterResponseRule } from '../shared/character-response';
import { exportCharacterWithResponse, parseCharacterResponseImport } from '../shared/character-response-portable';

const draft = () => ({
  name: 'Original fictional role', description: '<b>Literal text only</b>', personality: 'Patient',
  scenario: '', greeting: '', examples: '', systemPrompt: 'Original instructions', mood: defaultCharacterMoodTemplate(),
});
const v2 = () => JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 2, card: draft() }, null, 2);
function profile() {
  const rule = defaultCharacterResponseRule({ mood: 'content', phase: 'rua' });
  rule.tendencyScale.comfortable = 1.25; rule.intensityScale.posture = 0.6;
  return { version: 1 as const, rules: [rule] };
}

test('an empty response keeps the exact v2 export bytes and legacy imports do not gain rules', () => {
  const text = v2();
  assert.equal(exportCharacterWithResponse(text, defaultCharacterResponseProfile()), text);
  for (const source of [text, JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 1, card: { name: 'Legacy' } }), JSON.stringify({ name: 'Tavern text' })]) {
    assert.deepEqual(parseCharacterResponseImport(source), { baseText: source, profile: defaultCharacterResponseProfile() });
  }
});

test('explicit v3 round-trip splits validated response from the unchanged strict v2 base', () => {
  const text = exportCharacterWithResponse(v2(), profile());
  const value = JSON.parse(text);
  assert.equal(value.version, 3);
  assert.deepEqual(value.card.responseProfile, profile());
  const split = parseCharacterResponseImport(text);
  assert.deepEqual(JSON.parse(split.baseText), JSON.parse(v2()));
  assert.deepEqual(split.profile, profile());
  split.profile.rules[0].intensityScale.posture = 2;
  assert.equal(value.card.responseProfile.rules[0].intensityScale.posture, 0.6);
});

test('v3 rejects unrecognized outer/card/template fields, paths and runtime data before card creation', () => {
  const base = JSON.parse(exportCharacterWithResponse(v2(), profile()));
  const unsafeFields: [string, unknown][] = [['id', 'private-id'], ['modelPath', 'C:/private/model.pmx'], ['permissions', { write: true }], ['history', []], ['values', { O: 80 }]];
  for (const [key, value] of unsafeFields) {
    const source = structuredClone(base); source.card[key] = value;
    assert.throws(() => parseCharacterResponseImport(JSON.stringify(source)), /未支持|不能导入/);
  }
  const outer = structuredClone(base); outer.provider = { apiKey: 'NEVER_ALLOWED' };
  assert.throws(() => parseCharacterResponseImport(JSON.stringify(outer)), /未支持|不能导入/);
  const noMood = structuredClone(base); delete noMood.card.mood;
  assert.throws(() => parseCharacterResponseImport(JSON.stringify(noMood)), /心情模板/);
  const noProfile = structuredClone(base); delete noProfile.card.responseProfile;
  assert.throws(() => parseCharacterResponseImport(JSON.stringify(noProfile)), /缺少/);
  const unknown = structuredClone(base); unknown.card.responseProfile.paths = ['model.pmx'];
  assert.throws(() => parseCharacterResponseImport(JSON.stringify(unknown)));
  const alteredMood = structuredClone(base); alteredMood.card.mood.parameters.values = { D: 99 };
  assert.throws(() => parseCharacterResponseImport(JSON.stringify(alteredMood)));
});

test('portable bounds and input shape fail closed without relabeling old unsupported documents', () => {
  assert.throws(() => parseCharacterResponseImport('x'.repeat(1_000_001)), /1 MB/);
  assert.throws(() => parseCharacterResponseImport('[]'), /无法解析/);
  assert.throws(() => parseCharacterResponseImport('{broken'), /无法解析/);
  const wrong = JSON.stringify({ format: 'other-format', version: 3, card: { responseProfile: profile() } });
  assert.equal(parseCharacterResponseImport(wrong).baseText, wrong, 'existing strict card importer rejects unsupported formats');
  assert.throws(() => exportCharacterWithResponse(JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 1, card: draft() }), profile()), /version 2/);
  const unsafe = JSON.parse(v2()); unsafe.card.modelPath = 'C:/private/file.pmx';
  assert.throws(() => exportCharacterWithResponse(JSON.stringify(unsafe), profile()));
  const invalid = profile(); invalid.rules[0].tendencyScale.close = Number.NaN;
  assert.throws(() => exportCharacterWithResponse(v2(), invalid));
});
