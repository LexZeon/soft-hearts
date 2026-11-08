import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../electron/character-cards';
import { CharacterResponseService, CharacterResponseStore } from '../electron/character-response';
import { atomicWriteFile, type AtomicFileWriter } from '../electron/atomic-file';
import { defaultCharacterResponseProfile, defaultCharacterResponseRule } from '../shared/character-response';
import { exportCharacterWithResponse } from '../shared/character-response-portable';
import { defaultCharacterMoodTemplate, type CharacterDraft } from '../shared/character-cards';

const FILE = 'character-response-settings.json';
const draft = (name: string): CharacterDraft => ({
  name, description: 'Original description', personality: 'Original personality', scenario: '',
  greeting: '', examples: '', systemPrompt: 'Full original persona', mood: defaultCharacterMoodTemplate(),
});
function profile(scale = 1.3) {
  const rule = defaultCharacterResponseRule({ mood: 'content', phase: 'rua' });
  rule.tendencyScale.comfortable = scale; rule.intensityScale.posture = 0.6;
  return { version: 1 as const, rules: [rule] };
}
async function withDirectory(operation: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-character-response-'));
  try { await operation(directory); }
  finally {
    const resolved = path.resolve(directory), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('soft-character-response-'));
    await rm(resolved, { recursive: true, force: true });
  }
}
async function setup(directory: string, writer: AtomicFileWriter = atomicWriteFile) {
  const cards = new CharacterCardStore(directory, 'Existing original persona');
  await cards.load();
  const responses = new CharacterResponseStore(directory, () => cards.publicState().cards.map(card => card.id), writer);
  await responses.load();
  return { cards, responses, service: new CharacterResponseService(cards, responses) };
}
async function addCard(cards: CharacterCardStore, name: string) {
  const before = new Set(cards.publicState().cards.map(card => card.id));
  const state = await cards.save(draft(name));
  return state.cards.find(card => !before.has(card.id))!.id;
}

test('missing optional sidecar is a no-write common default; invalid or foreign IDs never acquire a profile', async () => {
  await withDirectory(async directory => {
    const { cards, responses } = await setup(directory);
    const id = cards.getActive().id;
    assert.deepEqual(responses.get(id), { characterId: id, revision: 0, profile: defaultCharacterResponseProfile() });
    await assert.rejects(stat(path.join(directory, FILE)), { code: 'ENOENT' });
    await responses.save(id, defaultCharacterResponseProfile(), 0);
    await assert.rejects(stat(path.join(directory, FILE)), { code: 'ENOENT' });
    assert.throws(() => responses.get(randomUUID()), /不存在/);
    assert.deepEqual(responses.effectiveProfile(randomUUID()), defaultCharacterResponseProfile());
    await assert.rejects(responses.save(randomUUID(), profile()), /不存在/);
    await assert.rejects(responses.save(id, profile(), -1), /修订号/);
  });
});

test('sidecar saves only pure profiles and leaves old card/mood/settings/private state bytes intact', async () => {
  await withDirectory(async directory => {
    const { cards, responses } = await setup(directory), id = cards.getActive().id;
    const files = ['characters.json', 'settings.json', 'mood-state.json', 'memories.jsonl', 'physics-settings.json'];
    for (const name of files.slice(1)) await writeFile(path.join(directory, name), `ORIGINAL ${name}`);
    const before = await Promise.all(files.map(name => readFile(path.join(directory, name), 'utf8')));
    const saved = await responses.save(id, profile(), 0);
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.profile, profile());
    assert.deepEqual(await Promise.all(files.map(name => readFile(path.join(directory, name), 'utf8'))), before);
    const disk = JSON.parse(await readFile(path.join(directory, FILE), 'utf8'));
    assert.deepEqual(disk, { version: 1, revision: 1, profiles: [{ characterId: id, profile: profile() }] });
    saved.profile.rules[0].tendencyScale.close = 3;
    assert.deepEqual(responses.get(id).profile, profile());
    const reloaded = new CharacterResponseStore(directory, () => [id]); await reloaded.load();
    assert.deepEqual(reloaded.get(id), responses.get(id));
    const legacy = new CharacterCardStore(directory, 'Do not replace');
    assert.deepEqual(await legacy.load(), cards.publicState(), 'old strict card shape remains readable');
  });
});

test('serialized writes detach drafts, preserve distinct roles and reject stale editor revisions before writing', async () => {
  await withDirectory(async directory => {
    let writes = 0;
    const { cards, responses, service } = await setup(directory, async (file, text) => { writes++; await atomicWriteFile(file, text); });
    const first = cards.getActive().id, second = await addCard(cards, 'Second');
    const input = profile();
    const saveFirst = service.save(first, input);
    input.rules[0].intensityScale.posture = 2;
    const saveSecond = responses.save(second, profile(1.7));
    await Promise.all([saveFirst, saveSecond]);
    assert.equal(responses.get(first).profile.rules[0].intensityScale.posture, 0.6);
    assert.equal(responses.get(second).profile.rules[0].tendencyScale.comfortable, 1.7);
    const before = await readFile(path.join(directory, FILE), 'utf8');
    await assert.rejects(responses.save(first, profile(1.9), 0), /新修改/);
    assert.equal(writes, 2);
    assert.equal(await readFile(path.join(directory, FILE), 'utf8'), before);
    const cleared = await responses.save(first, defaultCharacterResponseProfile(), 2);
    assert.equal(cleared.revision, 3);
    assert.deepEqual(responses.get(first).profile, defaultCharacterResponseProfile());
    assert.deepEqual(responses.get(second).profile, profile(1.7));
  });
});

test('failed atomic write retains previous disk/in-memory revision and allows the same draft retry', async () => {
  await withDirectory(async directory => {
    let fail = false;
    const { cards, responses } = await setup(directory, async (file, text) => {
      if (fail) throw Error('Synthetic sidecar failure'); await atomicWriteFile(file, text);
    });
    const id = cards.getActive().id;
    await responses.save(id, profile());
    const bytes = await readFile(path.join(directory, FILE), 'utf8'), before = responses.get(id);
    fail = true;
    await assert.rejects(responses.save(id, profile(2), before.revision), /Synthetic/);
    assert.deepEqual(responses.get(id), before);
    assert.equal(await readFile(path.join(directory, FILE), 'utf8'), bytes);
    fail = false;
    assert.equal((await responses.save(id, profile(2), before.revision)).revision, before.revision + 1);
  });
});

test('damaged optional storage is preserved and read-only while presentation uses the common default', async () => {
  await withDirectory(async directory => {
    const { cards } = await setup(directory), id = cards.getActive().id;
    for (const text of ['{broken', JSON.stringify({ version: 1, revision: 0, profiles: [], permissions: true }), JSON.stringify({ version: 1, profiles: [{ characterId: id, profile: { version: 1, rules: [], values: { D: 80 } } }] })]) {
      await writeFile(path.join(directory, FILE), text);
      const responses = new CharacterResponseStore(directory, () => [id]);
      await responses.load();
      assert.match(responses.get(id).storageError!, /已保留/);
      assert.deepEqual(responses.effectiveProfile(id), defaultCharacterResponseProfile());
      await assert.rejects(responses.save(id, profile()), /已保留/);
      assert.equal(await readFile(path.join(directory, FILE), 'utf8'), text);
    }
  });
});

test('ordinary old-version card saves and subsequent loads never clear independent response profiles', async () => {
  await withDirectory(async directory => {
    const { cards, responses } = await setup(directory), id = cards.getActive().id;
    await responses.save(id, profile());
    const bytes = await readFile(path.join(directory, FILE), 'utf8');
    const oldApp = new CharacterCardStore(directory, 'unused'); await oldApp.load();
    await oldApp.save(draft('Edited by old app'), id);
    const newApp = new CharacterResponseStore(directory, () => oldApp.publicState().cards.map(card => card.id));
    await newApp.load();
    assert.equal(await readFile(path.join(directory, FILE), 'utf8'), bytes);
    assert.deepEqual(newApp.get(id).profile, profile());
  });
});

test('copy writes only an existing empty target, never activates it or overwrites a nonempty target', async () => {
  await withDirectory(async directory => {
    const { cards, responses, service } = await setup(directory), source = cards.getActive().id;
    const target = await addCard(cards, 'Copied base role'), custom = await addCard(cards, 'Custom target');
    await responses.save(source, profile()); await responses.save(custom, profile(2));
    const baseBytes = await readFile(path.join(directory, 'characters.json'), 'utf8');
    const copied = await service.copy(source, target);
    assert.deepEqual(copied.profile, profile());
    assert.equal(cards.publicState().activeId, source);
    assert.equal(await readFile(path.join(directory, 'characters.json'), 'utf8'), baseBytes);
    assert.deepEqual(await service.copy(source, target), copied, 'equal copy is an idempotent no-write');
    await assert.rejects(service.copy(source, custom), /原模板已保留/);
    assert.deepEqual(responses.get(custom).profile, profile(2));
    await assert.rejects(service.copy(source, randomUUID()), /不存在/);
  });
});

test('v3 import maps parameters to one new inactive ID without importing binding, state or touching old roles', async () => {
  await withDirectory(async directory => {
    const { cards, responses, service } = await setup(directory), oldId = cards.getActive().id;
    await responses.save(oldId, profile());
    const original = cards.publicState();
    const text = service.export(oldId);
    assert.equal(JSON.parse(text).version, 3);
    const result = await service.import(text);
    assert.equal(result.responseSaved, true);
    assert.notEqual(result.characterId, oldId);
    assert.equal(result.state.cards.length, original.cards.length + 1);
    assert.equal(result.state.activeId, oldId);
    assert.deepEqual(responses.get(result.characterId).profile, profile());
    assert.deepEqual(responses.get(oldId).profile, profile());
    assert.deepEqual(result.state.cards[0], original.cards[0]);
    const stored = JSON.parse(await readFile(path.join(directory, 'characters.json'), 'utf8'));
    assert.equal(stored.cards.at(-1).responseProfile, undefined);
    assert.equal(stored.cards.at(-1).modelPath, undefined);
    assert.equal(stored.cards.at(-1).mood.parameters.responseProfile, undefined);
    const unsafe = JSON.parse(text); unsafe.card.modelPath = 'C:/never-import.pmx';
    await assert.rejects(service.import(JSON.stringify(unsafe)));
    assert.equal(cards.publicState().cards.length, original.cards.length + 1);
  });
});

test('an imported base card survives response failure with its exact ID and validated retry draft', async () => {
  await withDirectory(async directory => {
    let fail = true;
    const { cards, responses, service } = await setup(directory, async (file, text) => {
      if (fail) throw Error('Synthetic response failure'); await atomicWriteFile(file, text);
    });
    const originalId = cards.getActive().id;
    const text = exportCharacterWithResponse(cards.export(originalId), profile());
    const result = await service.import(text);
    assert.equal(result.responseSaved, false);
    assert.ok(result.notice && result.state.notice);
    assert.deepEqual(result.retryProfile, profile());
    assert.equal(cards.publicState().cards.length, 2);
    assert.deepEqual(responses.get(result.characterId).profile, defaultCharacterResponseProfile());
    fail = false;
    await service.save(result.characterId, result.retryProfile, responses.get(result.characterId).revision);
    assert.equal(cards.publicState().cards.length, 2, 'retry does not import or create a second role');
    assert.deepEqual(responses.get(result.characterId).profile, profile());
  });
});

test('deletion commits base first; failed cleanup leaves an inert orphan and never deletes another profile', async () => {
  await withDirectory(async directory => {
    let fail = false;
    const { cards, responses, service } = await setup(directory, async (file, text) => {
      if (fail) throw Error('Synthetic cleanup failure'); await atomicWriteFile(file, text);
    });
    const first = cards.getActive().id, second = await addCard(cards, 'Second');
    await responses.save(first, profile()); await responses.save(second, profile(2));
    fail = true;
    const result = await service.remove(second);
    assert.match(result.notice!, /已删除/);
    assert.equal(result.cards.length, 1);
    assert.deepEqual(responses.effectiveProfile(second), defaultCharacterResponseProfile());
    assert.deepEqual(responses.get(first).profile, profile());
    const before = await readFile(path.join(directory, FILE), 'utf8');
    await assert.rejects(service.remove(first), /至少保留/);
    assert.equal(await readFile(path.join(directory, FILE), 'utf8'), before);
    const reload = new CharacterResponseStore(directory, () => cards.publicState().cards.map(card => card.id));
    await reload.load();
    assert.equal(await readFile(path.join(directory, FILE), 'utf8'), before, 'load never prunes from an old or partial card snapshot');
    assert.deepEqual(reload.effectiveProfile(second), defaultCharacterResponseProfile());
    fail = false; await responses.remove(second);
    assert.equal(JSON.parse(await readFile(path.join(directory, FILE), 'utf8')).profiles.length, 1);
  });
});

test('copy response failure retains the one created target and retries only that same profile', async () => {
  await withDirectory(async directory => {
    let fail = false;
    const { cards, responses, service } = await setup(directory, async (file, text) => {
      if (fail) throw Error('Synthetic copy failure'); await atomicWriteFile(file, text);
    });
    const source = cards.getActive().id, target = await addCard(cards, 'Copied once');
    await responses.save(source, profile());
    const baseBytes = await readFile(path.join(directory, 'characters.json'), 'utf8');
    const sidecarBytes = await readFile(path.join(directory, FILE), 'utf8');
    fail = true; await assert.rejects(service.copy(source, target), /Synthetic/);
    assert.equal(await readFile(path.join(directory, FILE), 'utf8'), sidecarBytes);
    assert.deepEqual(responses.get(source).profile, profile());
    assert.deepEqual(responses.get(target).profile, defaultCharacterResponseProfile());
    fail = false; await service.copy(source, target);
    assert.equal(cards.publicState().cards.length, 2);
    assert.equal(await readFile(path.join(directory, 'characters.json'), 'utf8'), baseBytes);
    assert.deepEqual(responses.get(target).profile, profile());
  });
});

test('base-card persistence failure cannot create response data or change any existing profile', async () => {
  await withDirectory(async directory => {
    let fail = false;
    const cards = new CharacterCardStore(directory, 'Original', async (file, text) => {
      if (fail) throw Error('Synthetic card write failure'); await atomicWriteFile(file, text);
    });
    await cards.load();
    const id = cards.getActive().id;
    const responses = new CharacterResponseStore(directory, () => cards.publicState().cards.map(card => card.id));
    await responses.load(); await responses.save(id, profile());
    const service = new CharacterResponseService(cards, responses), text = service.export(id);
    const baseBytes = await readFile(path.join(directory, 'characters.json'), 'utf8');
    const sidecarBytes = await readFile(path.join(directory, FILE), 'utf8');
    fail = true; await assert.rejects(service.import(text), /Synthetic card/);
    assert.equal(cards.publicState().cards.length, 1);
    assert.equal(await readFile(path.join(directory, 'characters.json'), 'utf8'), baseBytes);
    assert.equal(await readFile(path.join(directory, FILE), 'utf8'), sidecarBytes);
    assert.deepEqual(responses.get(id).profile, profile());
  });
});

test('only an explicit response save reclaims missing IDs when capacity is needed, preserving every existing role', async () => {
  await withDirectory(async directory => {
    const { cards } = await setup(directory), existing = cards.getActive().id;
    const rows = [{ characterId: existing, profile: profile() },
      ...Array.from({ length: 127 }, () => ({ characterId: randomUUID(), profile: profile(2) }))];
    const original = JSON.stringify({ version: 1, revision: 4, profiles: rows });
    await writeFile(path.join(directory, FILE), original);
    const responses = new CharacterResponseStore(directory, () => cards.publicState().cards.map(card => card.id));
    await responses.load();
    assert.equal(await readFile(path.join(directory, FILE), 'utf8'), original, 'load keeps all original bytes');
    const added = await addCard(cards, 'New role');
    assert.equal(await readFile(path.join(directory, FILE), 'utf8'), original, 'ordinary base save cannot prune');
    await responses.save(added, profile(1.8), 4);
    assert.deepEqual(responses.get(existing).profile, profile());
    assert.deepEqual(responses.get(added).profile, profile(1.8));
    const stored = JSON.parse(await readFile(path.join(directory, FILE), 'utf8'));
    assert.deepEqual(new Set(stored.profiles.map((row: { characterId: string }) => row.characterId)), new Set([existing, added]));
  });
});
