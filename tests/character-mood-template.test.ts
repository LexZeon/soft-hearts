import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../electron/character-cards';
import {
  CHARACTER_CARD_FORMAT, CHARACTER_CARD_VERSION, compileCharacterPersona,
  defaultCharacterMoodTemplate, effectiveCharacterMood, validateCharacterDraft, validateCharacterMoodTemplate,
  type CharacterDraft,
} from '../shared/character-cards';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';

const draft = (name: string, fields: Partial<CharacterDraft> = {}): CharacterDraft => ({ name, description: '', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '', ...fields });
async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-character-mood-test-'));
  try { await run(directory); }
  finally { assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('soft-character-mood-test-')); await rm(directory, { recursive: true, force: true }); }
}

test('portable v2 round-trip includes complete parameter templates but no identity, binding, current values or private records', async () => {
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'legacy persona'); await store.load();
    const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS);
    parameters.sensitivity.O = 1.3; parameters.longing.graceMs = 8 * 3_600_000;
    parameters.blush.intensity = 55;
    parameters.blush.size = 68;
    await store.save(draft('Warm', { systemPrompt: 'Keep this literal persona', mood: { version: 1, parameters } }));
    const original = store.publicState().cards.at(-1)!;
    const privatePath = path.join(directory, 'private-model', 'model.pmx');
    await store.bindModel(original.id, privatePath, 'Private model');
    const exported = store.export(original.id), parsed = JSON.parse(exported);
    assert.equal(parsed.format, CHARACTER_CARD_FORMAT); assert.equal(parsed.version, CHARACTER_CARD_VERSION);
    assert.deepEqual(parsed.card.mood, { version: 1, parameters });
    assert.equal(parsed.card.systemPrompt, 'Keep this literal persona');
    for (const forbidden of [original.id, privatePath, 'modelPath', 'modelName', 'lastInteractionAt', '"values"', 'longingSnapshot', 'memories'])
      assert.ok(!exported.includes(forbidden));
    const active = store.publicState().activeId;
    await store.import(exported);
    const imported = store.publicState().cards.at(-1)!;
    assert.notEqual(imported.id, original.id); assert.equal(store.publicState().activeId, active);
    assert.deepEqual(imported.mood, original.mood);
    await store.activate(imported.id); assert.equal(store.getActive().modelPath, undefined);
    assert.equal(compileCharacterPersona(imported), 'Keep this literal persona');
  });
});

test('legacy characters load without writing; missing templates migrate existing tuned parameters before Gene fallback', async () => {
  await withDirectory(async directory => {
    const tunedId = randomUUID(), ownId = randomUUID(), fallbackId = randomUUID();
    const own = structuredClone(DEFAULT_MOOD_PARAMETERS); own.sensitivity.D = 1.4;
    const privatePath = path.join(directory, 'private-model.pmx');
    const stored = { version: 1, revision: 7, activeId: tunedId, cards: [
      { id: tunedId, ...draft('Old', { systemPrompt: 'Original full persona' }), modelPath: privatePath, modelName: 'Model' },
      { id: ownId, ...draft('Already numeric', { mood: { version: 1, parameters: own } }) },
      { id: fallbackId, ...draft('Other old') },
    ] };
    const source = JSON.stringify(stored), file = path.join(directory, 'characters.json');
    await writeFile(file, source);
    const unrelated = new Map([['settings.json', 'UNCHANGED_SETTINGS_AND_KEYS'], ['mood-state.json', 'UNCHANGED_RUNTIME_VALUES_BM'], ['memories.jsonl', 'UNCHANGED_PRIVATE_EXPERIENCES']]);
    for (const [name, text] of unrelated) await writeFile(path.join(directory, name), text);
    const store = new CharacterCardStore(directory, 'must not replace legacy');
    const loaded = await store.load();
    assert.equal(loaded.cards[0].mood, undefined); assert.equal(loaded.cards[2].mood, undefined);
    assert.equal(await readFile(file, 'utf8'), source);
    assert.deepEqual(effectiveCharacterMood(loaded.cards[0]), DEFAULT_MOOD_PARAMETERS);
    const tuned = structuredClone(DEFAULT_MOOD_PARAMETERS); tuned.sensitivity.O = 1.25; tuned.blush.enabled = false;
    const resolved: string[] = [];
    const migrated = await store.ensureMoodTemplates(id => { resolved.push(id); return id === tunedId ? tuned : undefined; });
    assert.deepEqual(resolved, [tunedId, fallbackId]);
    assert.equal(migrated.activeId, tunedId); assert.equal(migrated.revision, 8);
    assert.deepEqual(migrated.cards[0].mood?.parameters, tuned);
    assert.deepEqual(migrated.cards[1].mood?.parameters, own);
    assert.deepEqual(migrated.cards[2].mood?.parameters, DEFAULT_MOOD_PARAMETERS);
    assert.equal(store.getActive().modelPath, privatePath);
    assert.equal(compileCharacterPersona(store.getActive()), 'Original full persona');
    for (const [name, text] of unrelated) assert.equal(await readFile(path.join(directory, name), 'utf8'), text);
    const once = await readFile(file, 'utf8');
    await store.ensureMoodTemplates(() => { throw new Error('already migrated templates must not be resolved'); });
    assert.equal(await readFile(file, 'utf8'), once);
  });
});

test('template-only updates and old text-only saves preserve binding, activation and private state', async () => {
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'Original'); await store.load();
    const initial = store.publicState().activeId, privatePath = path.join(directory, 'private.pmx');
    await store.bindModel(initial, privatePath);
    await store.save(draft('Inactive'));
    const inactive = store.publicState().cards.at(-1)!;
    await writeFile(path.join(directory, 'mood-state.json'), 'PRIVATE_CURRENT_VALUES');
    await writeFile(path.join(directory, 'memories.jsonl'), 'PRIVATE_CHAT');
    const tuned = structuredClone(DEFAULT_MOOD_PARAMETERS); tuned.sensitivity.E = 1.2;
    const previousRevision = store.publicState().revision!;
    const changed = await store.saveMoodParameters(inactive.id, tuned);
    assert.equal(changed.activeId, initial); assert.equal(changed.revision, previousRevision + 1);
    assert.equal(store.getActive().modelPath, privatePath);
    assert.deepEqual(changed.cards.find(card => card.id === inactive.id)?.mood?.parameters, tuned);
    await store.save(draft('Renamed inactive', { personality: 'Text-only client edit', mood: undefined }), inactive.id);
    assert.deepEqual(store.publicState().cards.find(card => card.id === inactive.id)?.mood?.parameters, tuned);
    assert.equal(await readFile(path.join(directory, 'mood-state.json'), 'utf8'), 'PRIVATE_CURRENT_VALUES');
    assert.equal(await readFile(path.join(directory, 'memories.jsonl'), 'utf8'), 'PRIVATE_CHAT');
    const restored = new CharacterCardStore(directory, 'unused'); await restored.load();
    assert.equal(restored.getActive().modelPath, privatePath);
    assert.deepEqual(restored.publicState().cards.find(card => card.id === inactive.id)?.mood?.parameters, tuned);
  });
});

test('new and copied cards carry detached Gene/template parameters without borrowing a live instance', async () => {
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'Persona'); await store.load();
    await store.save(draft('New without numeric fields'));
    const original = store.publicState().cards.at(-1)!;
    assert.deepEqual(original.mood, defaultCharacterMoodTemplate());
    await store.save(draft('Copy', { mood: original.mood }));
    const copied = store.publicState().cards.at(-1)!;
    assert.notEqual(original.id, copied.id); assert.deepEqual(original.mood, copied.mood);
    copied.mood!.parameters.sensitivity.D = 3;
    assert.equal(store.publicState().cards.at(-1)!.mood!.parameters.sensitivity.D, 1);
    const effective = effectiveCharacterMood(original); effective.blush.intensity = 0;
    assert.equal(original.mood!.parameters.blush.intensity, DEFAULT_MOOD_PARAMETERS.blush.intensity);
    assert.equal(Object.hasOwn(copied, 'state'), false);
  });
});

test('known legacy blush omissions migrate without admitting unknown or missing core parameters', () => {
  const old = structuredClone(DEFAULT_MOOD_PARAMETERS) as unknown as Record<string, unknown>;
  delete old.blush;
  const normalized = validateCharacterMoodTemplate({ version: 1, parameters: old });
  assert.deepEqual(normalized.parameters.blush, DEFAULT_MOOD_PARAMETERS.blush);
  assert.equal(Object.hasOwn(old, 'blush'), false);
  const missingOther = structuredClone(old); delete missingOther.sensitivity;
  assert.throws(() => validateCharacterMoodTemplate({ version: 1, parameters: missingOther }));
  assert.throws(() => validateCharacterMoodTemplate({ version: 1, parameters: { ...DEFAULT_MOOD_PARAMETERS, blush: { ...DEFAULT_MOOD_PARAMETERS.blush, privateState: 1 } } }));
  const oldBlush = structuredClone(DEFAULT_MOOD_PARAMETERS) as unknown as Record<string, Record<string, unknown>>;
  delete oldBlush.blush.size;
  assert.equal(validateCharacterMoodTemplate({ version: 1, parameters: oldBlush }).parameters.blush.size, 50);
  assert.equal(Object.hasOwn(oldBlush.blush, 'size'), false);
});

test('unknown, nonfinite and private fields cannot enter a numeric card through saves or any portable import version', async () => {
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'Persona'); await store.load();
    const before = store.publicState();
    const envelope = (card: unknown) => JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 2, card });
    const valid = draft('Valid', { mood: defaultCharacterMoodTemplate() });
    for (const field of ['modelPath', 'modelName', 'provider', 'apiKey', 'permissions', 'state', 'history', '__proto__']) {
      const bad = { ...valid, [field]: field === 'modelPath' ? 'C:/private.pmx' : { value: 'PRIVATE' } };
      await assert.rejects(store.import(envelope(bad)));
      assert.throws(() => validateCharacterDraft(bad));
    }
    for (const bad of [
      { ...valid, mood: { ...defaultCharacterMoodTemplate(), values: { D: 100 } } },
      { ...valid, mood: { version: 2, parameters: DEFAULT_MOOD_PARAMETERS } },
      { ...valid, mood: { version: 1, parameters: { ...DEFAULT_MOOD_PARAMETERS, lastInteractionAt: 1000 } } },
      { ...valid, mood: { version: 1, parameters: { ...DEFAULT_MOOD_PARAMETERS, sensitivity: { ...DEFAULT_MOOD_PARAMETERS.sensitivity, D: null } } } },
    ]) await assert.rejects(store.import(envelope(bad)));
    const nonfinite = defaultCharacterMoodTemplate(); nonfinite.parameters.sensitivity.O = NaN;
    assert.throws(() => validateCharacterDraft({ ...valid, mood: nonfinite }));
    nonfinite.parameters.sensitivity.O = Infinity;
    assert.throws(() => validateCharacterMoodTemplate(nonfinite));
    await assert.rejects(store.import(JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 2, card: draft('Missing template') })));
    await assert.rejects(store.import(JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 1, card: valid })));
    await assert.rejects(store.import(JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 2, card: valid, memories: [] })));
    await assert.rejects(store.import(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Extension', extensions: { provider: 'NO' } } })));
    assert.deepEqual(store.publicState(), before);
  });
});

test('failed legacy-template resolution does not partially migrate or overwrite original storage', async () => {
  await withDirectory(async directory => {
    const first = randomUUID(), second = randomUUID();
    const source = JSON.stringify({ version: 1, activeId: first, cards: [{ id: first, ...draft('First') }, { id: second, ...draft('Second') }] });
    const file = path.join(directory, 'characters.json'); await writeFile(file, source);
    const store = new CharacterCardStore(directory, 'unused'); await store.load();
    await assert.rejects(store.ensureMoodTemplates(id => id === first ? DEFAULT_MOOD_PARAMETERS : { ...DEFAULT_MOOD_PARAMETERS, runtimeValues: {} } as typeof DEFAULT_MOOD_PARAMETERS));
    assert.equal(await readFile(file, 'utf8'), source);
    assert.ok(store.publicState().cards.every(card => card.mood === undefined));
  });
});

test('native version 1 and Tavern text imports inherit explicit Gene templates without activating or overwriting old cards', async () => {
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'Existing persona'); await store.load();
    const active = store.publicState().activeId;
    await store.import(JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 1, card: draft('Native old', { systemPrompt: 'Original native v1 persona' }) }));
    const native = store.publicState().cards.at(-1)!;
    assert.equal(compileCharacterPersona(native), 'Original native v1 persona');
    assert.deepEqual(native.mood, defaultCharacterMoodTemplate());
    await store.import(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Tavern old', first_mes: 'Original greeting', creator_notes: 'Ignored metadata', extensions: {} } }));
    const tavern = store.publicState().cards.at(-1)!;
    assert.deepEqual(tavern.mood, defaultCharacterMoodTemplate());
    assert.equal(tavern.greeting, 'Original greeting');
    assert.equal(store.publicState().activeId, active);
    assert.equal(compileCharacterPersona(store.getActive()), 'Existing persona');
  });
});
