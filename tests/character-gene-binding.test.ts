import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../electron/character-cards';
import {
  BUNDLED_CHARACTER_MODEL,
  defaultCharacterMoodTemplate,
  type CharacterDraft,
} from '../shared/character-cards';

function draft(name: string): CharacterDraft {
  const mood = defaultCharacterMoodTemplate();
  mood.parameters.sensitivity.O = 1.25;
  mood.parameters.blush.size = 63;
  return {
    name, description: 'Existing description', personality: 'Existing personality',
    scenario: 'Existing scenario', greeting: 'Existing greeting', examples: 'Existing examples',
    systemPrompt: 'Existing instructions', mood,
  };
}

async function withDirectory(operation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-gene-binding-'));
  try { await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function legacyCards(directory: string): {
  version: 1;
  revision: number;
  activeId: string;
  cards: (CharacterDraft & { id: string; modelPath?: string; modelName?: string })[];
} {
  const privateId = randomUUID(), defaultId = randomUUID(), otherId = randomUUID();
  return {
    version: 1 as const, revision: 7, activeId: privateId,
    cards: [
      { id: privateId, ...draft('默认伙伴'), modelPath: path.join(directory, 'own.pmx'), modelName: 'own.pmx' },
      { id: defaultId, ...draft('Default renamed by user') },
      { id: otherId, ...draft('默认伙伴') },
    ],
  };
}

test('legacy persona migration is an unbound private default, not the new preinstalled Gene; saved settings are untouched', async () => {
  await withDirectory(async directory => {
    const settings = '{"model":{"path":"PRIVATE_STAGE_MODEL"},"provider":{"apiKeyEncrypted":"OPAQUE"}}';
    await writeFile(path.join(directory, 'settings.json'), settings);
    const store = new CharacterCardStore(directory, 'Full original persona');
    const state = await store.load();
    assert.equal(store.getActive().modelPath, undefined);
    assert.equal(state.cards[0].modelName, undefined);
    assert.equal(state.cards[0].systemPrompt, 'Full original persona');
    assert.equal(Object.hasOwn(state.cards[0], 'modelPath'), false);
    assert.equal(await readFile(path.join(directory, 'settings.json'), 'utf8'), settings);
    await store.save(draft('Another card'));
    const other = store.publicState().cards.at(-1)!;
    await store.activate(other.id);
    assert.equal(store.getActive().modelPath, undefined);
    assert.ok(!store.export(state.activeId).includes(BUNDLED_CHARACTER_MODEL));
  });
});

test('legacy load never guesses default identity from names, order, active card or the current model', async () => {
  await withDirectory(async directory => {
    const stored = legacyCards(directory);
    stored.activeId = stored.cards[2].id;
    const source = JSON.stringify(stored);
    const file = path.join(directory, 'characters.json');
    await writeFile(file, source);
    const store = new CharacterCardStore(directory, 'Fallback must not replace existing persona');
    const state = await store.load();
    assert.equal(await readFile(file, 'utf8'), source);
    assert.equal(state.activeId, stored.activeId);
    assert.equal(store.getActive().modelPath, undefined);
    assert.equal(state.cards[1].modelName, undefined);
  });
});

test('an explicitly verified legacy ID gains only its missing Gene binding and preserves all other data', async () => {
  await withDirectory(async directory => {
    const stored = legacyCards(directory);
    const defaultId = stored.cards[1].id;
    const file = path.join(directory, 'characters.json');
    await writeFile(file, JSON.stringify(stored));
    const unrelated = new Map([
      ['settings.json', 'ORIGINAL_STAGE_VOICE_PROVIDER_AND_ENCRYPTED_KEYS'],
      ['mood-state.json', 'ORIGINAL_VALUES_B_M_AND_INTERACTION_PROGRESS'],
      ['memories.jsonl', 'ORIGINAL_PRIVATE_MEMORY_AND_HISTORY'],
      ['physics-settings.json', 'ORIGINAL_MODEL_PHYSICS'],
    ]);
    for (const [name, text] of unrelated) await writeFile(path.join(directory, name), text);
    const store = new CharacterCardStore(directory, 'unused');
    await store.load();
    const repaired = await store.ensureBundledGeneBinding(defaultId);
    assert.equal(repaired.changed, true);
    assert.equal(repaired.state.activeId, stored.activeId);
    assert.equal(store.getActive().modelPath, stored.cards[0].modelPath);
    const actual = JSON.parse(await readFile(file, 'utf8'));
    const expected = structuredClone(stored);
    expected.revision++;
    Object.assign(expected.cards[1], { modelPath: BUNDLED_CHARACTER_MODEL, modelName: 'Gene' });
    assert.deepEqual(actual, expected);
    for (const [name, text] of unrelated)
      assert.equal(await readFile(path.join(directory, name), 'utf8'), text);
    for (const omitted of ['modelPath', 'modelName', BUNDLED_CHARACTER_MODEL, defaultId])
      assert.ok(!store.export(defaultId).includes(omitted));
    const once = await readFile(file, 'utf8');
    const again = await store.ensureBundledGeneBinding(defaultId);
    assert.equal(again.changed, false);
    assert.equal(again.state.revision, repaired.state.revision);
    assert.equal(await readFile(file, 'utf8'), once);
    const restored = new CharacterCardStore(directory, 'unused');
    await restored.load();
    assert.deepEqual(restored.publicState(), repaired.state);
  });
});

test('every nonempty binding is preserved without a write, including a private target and existing Gene', async () => {
  await withDirectory(async directory => {
    const stored = legacyCards(directory);
    Object.assign(stored.cards[1], { modelPath: BUNDLED_CHARACTER_MODEL, modelName: 'Existing display name' });
    const source = JSON.stringify(stored);
    const file = path.join(directory, 'characters.json');
    await writeFile(file, source);
    let writes = 0;
    const store = new CharacterCardStore(directory, 'unused', async () => { writes++; throw new Error('must not write'); });
    await store.load();
    assert.equal((await store.ensureBundledGeneBinding(stored.cards[0].id)).changed, false);
    assert.equal((await store.ensureBundledGeneBinding(stored.cards[1].id)).changed, false);
    assert.equal(writes, 0);
    assert.equal(await readFile(file, 'utf8'), source);
  });
});

test('serialized repair checks the binding after a queued user edit and never overwrites it', async () => {
  await withDirectory(async directory => {
    const stored = legacyCards(directory);
    const target = stored.cards[1].id, selected = path.join(directory, 'new-own.pmx');
    await writeFile(path.join(directory, 'characters.json'), JSON.stringify(stored));
    const store = new CharacterCardStore(directory, 'unused');
    await store.load();
    const userEdit = store.bindModel(target, selected);
    const repair = store.ensureBundledGeneBinding(target);
    await userEdit;
    assert.equal((await repair).changed, false);
    const saved = JSON.parse(await readFile(path.join(directory, 'characters.json'), 'utf8'));
    assert.equal(saved.cards[1].modelPath, selected);
    assert.equal(saved.revision, stored.revision + 1);
  });
});

test('missing and concurrently deleted target IDs fail without selecting another default', async () => {
  await withDirectory(async directory => {
    const stored = legacyCards(directory);
    const file = path.join(directory, 'characters.json');
    const source = JSON.stringify(stored);
    await writeFile(file, source);
    const store = new CharacterCardStore(directory, 'unused');
    await store.load();
    await assert.rejects(store.ensureBundledGeneBinding(randomUUID()), /不存在/);
    assert.equal(await readFile(file, 'utf8'), source);
    const deletion = store.remove(stored.cards[1].id);
    const repair = store.ensureBundledGeneBinding(stored.cards[1].id);
    await deletion;
    await assert.rejects(repair, /不存在/);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.cards.length, 2);
    assert.equal(saved.cards[1].modelPath, undefined);
    assert.equal(saved.activeId, stored.activeId);
    assert.equal(saved.revision, stored.revision + 1);
  });
});

test('a failed repair preserves original disk bytes and in-memory state, then the queue can retry', async () => {
  await withDirectory(async directory => {
    const stored = legacyCards(directory);
    const file = path.join(directory, 'characters.json'), source = JSON.stringify(stored);
    await writeFile(file, source);
    let fail = true;
    const store = new CharacterCardStore(directory, 'unused', async (target, text) => {
      if (fail) throw new Error('Synthetic write failure');
      await writeFile(target, text);
    });
    const original = await store.load();
    await assert.rejects(store.ensureBundledGeneBinding(stored.cards[1].id), /Synthetic write failure/);
    assert.deepEqual(store.publicState(), original);
    assert.equal(await readFile(file, 'utf8'), source);
    fail = false;
    assert.equal((await store.ensureBundledGeneBinding(stored.cards[1].id)).changed, true);
  });
});
