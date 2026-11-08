import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VisualBehaviorStore } from '../electron/visual-behavior-store';
import { atomicWriteFile } from '../electron/atomic-file';
import { CharacterCardStore } from '../electron/character-cards';
import { emptyVisualBehavior, validateVisualBehavior, VISUAL_GENE_SHA,
  type VisualBehaviorProfile } from '../shared/personalize-visual';

// Synthetic recipe identity only: no model, image or renderer is loaded.
const profile = (label = '轻微眉眼', enabled = true): VisualBehaviorProfile => ({
  enabled, targetModelSha: VISUAL_GENE_SHA, semantic: 'mood.content',
  bindingId: 'face.smile', label, strength: 0.34,
});
const ownedRoot = path.resolve('.local/personalize-visual-main-v1/evidence/store-owned-temp');
async function fixture(run: (directory: string) => Promise<void>) {
  await mkdir(ownedRoot, { recursive: true });
  const directory = await mkdtemp(path.join(ownedRoot, 'case-'));
  try { await run(directory); }
  finally {
    assert.equal(path.dirname(path.resolve(directory)), ownedRoot);
    assert.ok(path.basename(directory).startsWith('case-'));
    await rm(directory, { recursive: true, force: true });
  }
}
const storageFile = (directory: string) => path.join(directory, 'personalize-visual.json');

test('visual storage is optional and accepts only the six-field reviewed semantic profile', async () => fixture(async directory => {
  const id = randomUUID();
  const store = new VisualBehaviorStore(directory, () => [id]);
  await store.load();
  assert.deepEqual(store.get(id), { characterId: id, revision: 0, profile: emptyVisualBehavior() });
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await store.save(id, emptyVisualBehavior(), 0)).revision, 0);
  assert.deepEqual(await readdir(directory), []);
  for (const key of ['image', 'path', 'materialHash', 'analysis', 'permissions']) {
    assert.throws(() => store.save(id, { ...profile(), [key]: 'not allowed' }, 0));
  }
  assert.throws(() => store.save(id, { ...profile(), bindingId: 'face.convinced' }, 0));
  assert.throws(() => store.save(id, { ...profile(), targetModelSha: '0'.repeat(64) }, 0));
  assert.throws(() => store.save(id, { ...profile(), strength: 0.71 }, 0));
  assert.throws(() => store.save(id, { ...profile(), label: 'C:\\private\\image.jpg' }, 0));
  assert.deepEqual(validateVisualBehavior({ ...profile(), semantic: 'cue.motion', bindingId: 'face.convinced' }),
    { ...profile(), semantic: 'cue.motion', bindingId: 'face.convinced' });
  await store.save(id, profile(), 0);
  const raw = JSON.parse(await readFile(storageFile(directory), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['entries', 'version']);
  assert.equal(raw.version, 1);
  assert.deepEqual(Object.keys(raw.entries[0]).sort(), ['characterId', 'previous', 'profile', 'revision']);
  assert.deepEqual(Object.keys(raw.entries[0].profile).sort(),
    ['bindingId', 'enabled', 'label', 'semantic', 'strength', 'targetModelSha']);
  assert.deepEqual(Object.keys(raw.entries[0].previous).sort(), ['profile', 'revision']);
  assert.deepEqual(raw.entries[0].profile, profile());
}));

test('two cards isolate revisions and aliases; a same-revision race cannot overwrite the winner', async () => fixture(async directory => {
  const a = randomUUID(), b = randomUUID(), newId = randomUUID();
  const ids = [a, b];
  const store = new VisualBehaviorStore(directory, () => ids);
  await store.load();
  const draft = profile('A');
  const saved = await store.save(a, draft, 0);
  draft.label = 'mutated input'; saved.profile.label = 'mutated output';
  assert.equal(store.get(a).profile.label, 'A');
  await store.save(b, profile('B'), 0);
  const competing = await Promise.allSettled([store.save(a, profile('winner'), 1), store.save(a, profile('stale'), 1)]);
  assert.equal(competing[0].status, 'fulfilled');
  assert.equal(competing[1].status, 'rejected');
  assert.equal(store.get(a).revision, 2);
  assert.equal(store.get(a).profile.label, 'winner');
  assert.equal(store.get(b).revision, 1);
  assert.equal(store.get(b).profile.label, 'B');
  ids.splice(ids.indexOf(a), 1); ids.push(newId);
  assert.deepEqual(store.effectiveProfile(a), emptyVisualBehavior());
  assert.throws(() => store.get(a), /不存在/);
  assert.deepEqual(store.get(newId).profile, emptyVisualBehavior());
  await store.save(b, profile('B2'), 1);
  const raw = JSON.parse(await readFile(storageFile(directory), 'utf8'));
  assert.equal(raw.entries.find((entry: { characterId: string }) => entry.characterId === a).profile.label, 'winner');
  const reopened = new VisualBehaviorStore(directory, () => ids); await reopened.load();
  assert.deepEqual(reopened.get(newId).profile, emptyVisualBehavior());
  assert.equal(reopened.get(b).profile.label, 'B2');
}));

test('failed atomic confirmation keeps disk and undo; same card retries, disables and undoes once', async () => fixture(async directory => {
  const id = randomUUID(); let fail = false;
  const store = new VisualBehaviorStore(directory, () => [id], async (file, data) => {
    if (fail) throw Error('synthetic atomic failure');
    await atomicWriteFile(file, data);
  });
  await store.load(); await store.save(id, profile('first'), 0);
  const before = await readFile(storageFile(directory)); const state = store.get(id);
  fail = true;
  await assert.rejects(store.save(id, profile('second'), 1), /synthetic atomic failure/);
  assert.deepEqual(store.get(id), state);
  assert.deepEqual(await readFile(storageFile(directory)), before);
  fail = false;
  assert.equal((await store.save(id, profile('second'), 1)).revision, 2);
  assert.equal((await store.save(id, profile('second', false), 2)).revision, 3);
  const undo = await store.undo(id, 3);
  assert.equal(undo.revision, 4); assert.equal(undo.profile.enabled, true);
  assert.equal(undo.profile.label, 'second'); assert.equal(undo.previous, undefined);
  await assert.rejects(store.undo(id, 4), /没有可恢复/);
  assert.equal(store.get(id).revision, 4);
  assert.deepEqual((await readdir(directory)).sort(), ['personalize-visual.json']);
}));

test('corrupt or widened v1 sidecars keep their original bytes and block writes', async () => fixture(async directory => {
  const id = randomUUID();
  const entry = { characterId: id, revision: 1, profile: profile() };
  const invalid = [
    '{truncated', JSON.stringify({ version: 2, entries: [entry] }),
    JSON.stringify({ version: 1, entries: [entry], analysis: 'forbidden' }),
    JSON.stringify({ version: 1, entries: [{ ...entry, permissions: true }] }),
    JSON.stringify({ version: 1, entries: [{ ...entry, profile: { ...profile(), image: 'forbidden' } }] }),
    JSON.stringify({ version: 1, entries: [{ ...entry, profile: { ...profile(), bindingId: 'face.convinced' } }] }),
  ];
  for (const text of invalid) {
    const bytes = Buffer.from(text); await writeFile(storageFile(directory), bytes);
    const store = new VisualBehaviorStore(directory, () => [id]); await store.load();
    assert.ok(store.get(id).storageError);
    assert.deepEqual(store.effectiveProfile(id), emptyVisualBehavior());
    await assert.rejects(store.save(id, profile(), 0), /原.*已保留/);
    assert.deepEqual(await readFile(storageFile(directory)), bytes);
  }
}));

test('visual confirmation does not alter legacy cards, mood or language files; imported card IDs start empty', async () => fixture(async directory => {
  const cards = new CharacterCardStore(directory, 'Synthetic legacy persona'); await cards.load();
  const a = cards.getActive().id; const portable = cards.export(a);
  await writeFile(path.join(directory, 'mood-state.json'), '{"synthetic":"mood"}\n');
  await writeFile(path.join(directory, 'personalize-language.json'), '{"synthetic":"language"}\n');
  const protectedNames = ['characters.json', 'mood-state.json', 'personalize-language.json'];
  const before = await Promise.all(protectedNames.map(name => readFile(path.join(directory, name))));
  const store = new VisualBehaviorStore(directory, () => cards.publicState().cards.map(card => card.id));
  await store.load(); await store.save(a, profile('confirmed'), 0);
  for (let i = 0; i < protectedNames.length; i++) assert.deepEqual(await readFile(path.join(directory, protectedNames[i])), before[i]);
  assert.equal(cards.export(a), portable); assert.ok(!portable.includes('personalize'));
  const imported = await cards.import(portable);
  const b = imported.cards.find(card => card.id !== a)!.id;
  assert.notEqual(b, a); assert.deepEqual(store.get(b).profile, emptyVisualBehavior());
  const reopened = new VisualBehaviorStore(directory, () => cards.publicState().cards.map(card => card.id));
  await reopened.load(); assert.equal(reopened.get(a).profile.label, 'confirmed');
  assert.deepEqual(reopened.get(b).profile, emptyVisualBehavior());
  const oldReader = new CharacterCardStore(directory, 'Fallback'); await oldReader.load();
  assert.equal(oldReader.getActive().id, cards.getActive().id);
  assert.ok(!JSON.stringify(oldReader.publicState()).includes('personalize-visual'));
}));
