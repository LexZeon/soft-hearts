import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildModelProfile } from '../shared/model-profile';
import { MAX_MODEL_PROFILES, ModelProfileStore } from '../electron/model-profile-store';
import { profileInput, toyModel } from './helpers/model-fixtures';

const profile = JSON.parse(JSON.stringify(buildModelProfile(profileInput(toyModel()))));
const key = (n: number) => n.toString(16).padStart(64, '0');

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'soft-hearts-model-profile-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('profiles persist by content hash only, survive a reload and return copies', () => withDirectory(async directory => {
  const store = new ModelProfileStore(directory); await store.load();
  assert.equal(store.get(key(1)), null);
  assert.equal(await store.set(key(1), profile), true);
  const reloaded = new ModelProfileStore(directory); await reloaded.load();
  assert.deepEqual(reloaded.get(key(1)), profile);
  const copy = reloaded.get(key(1))!; copy.morphs.a.scale = 3;
  assert.equal(reloaded.get(key(1))!.morphs.a.scale, profile.morphs.a.scale);
  const text = await readFile(path.join(directory, 'model-profiles.json'), 'utf8');
  assert.ok(!text.includes(directory) && !/[A-Za-z]:\\|\/tmp\//.test(text), 'no local paths are stored');
  assert.equal(store.get(null), null); assert.equal(store.get('../model.pmx'), null);
}));

test('only the newest profiles are kept, invalid input is refused and a corrupt file costs only a recompute', () => withDirectory(async directory => {
  const store = new ModelProfileStore(directory); await store.load();
  for (let n = 0; n < MAX_MODEL_PROFILES + 3; n++) assert.equal(await store.set(key(n), profile), true);
  assert.equal(store.get(key(0)), null); assert.deepEqual(store.get(key(MAX_MODEL_PROFILES + 2)), profile);
  await assert.rejects(store.set('not-a-hash', profile));
  assert.throws(() => store.set(key(99), { version: 1 }));
  assert.throws(() => store.set(key(99), { ...profile, version: 0 }));
  await writeFile(path.join(directory, 'model-profiles.json'), '{not json');
  const broken = new ModelProfileStore(directory); await broken.load();
  assert.equal(broken.get(key(MAX_MODEL_PROFILES + 2)), null);
  assert.equal(await broken.set(key(5), profile), true);
  await writeFile(path.join(directory, 'model-profiles.json'), JSON.stringify({ version: 1, profiles: [
    { modelKey: key(7), profile: { ...profile, version: 99 } }, { modelKey: key(8), profile }] }));
  const mixed = new ModelProfileStore(directory); await mixed.load();
  assert.equal(mixed.get(key(7)), null, 'another algorithm version is recomputed'); assert.deepEqual(mixed.get(key(8)), profile);
}));
