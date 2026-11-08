import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MusicSettingsStore } from '../electron/music-settings';
import { normalizeMusicSettings, DEFAULT_MUSIC_SETTINGS } from '../shared/music-settings';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-music-store-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('soft-hearts-music-store-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return { directory, file: path.join(directory, 'music-settings.json') };
}

test('music strength accepts only own finite numbers, clamps, and never grants capture consent', () => {
  for (const value of [undefined, null, [], {}, false, '0.3', { strength: NaN }, { strength: Infinity }, Object.create({ strength: 1 })])
    assert.deepEqual(normalizeMusicSettings(value), DEFAULT_MUSIC_SETTINGS);
  assert.deepEqual(normalizeMusicSettings({ strength: 0, enabled: true, sharing: true }), { strength: 0, alwaysDance: false });
  assert.deepEqual(normalizeMusicSettings({ strength: -2 }), { strength: 0, alwaysDance: false });
  assert.deepEqual(normalizeMusicSettings({ strength: 2 }), { strength: 1, alwaysDance: false });
  assert.deepEqual(normalizeMusicSettings({}, { strength: 0.35 }), { strength: 0.35, alwaysDance: false });
  const output = normalizeMusicSettings(undefined); output.strength = 1;
  assert.equal(DEFAULT_MUSIC_SETTINGS.strength, 0.7);
});

test('missing or malformed sidecars remain untouched and a read never creates a file', async t => {
  const { file, directory } = await fixture(t);
  assert.deepEqual(await new MusicSettingsStore(file).load(), DEFAULT_MUSIC_SETTINGS);
  assert.deepEqual(await readdir(directory), []);
  for (const raw of ['{broken', 'null', '[]', '{"version":2,"settings":{"strength":1}}', '{"version":1,"settings":[]}']) {
    await writeFile(file, raw, 'utf8');
    assert.deepEqual(await new MusicSettingsStore(file).load(), DEFAULT_MUSIC_SETTINGS);
    assert.equal(await readFile(file, 'utf8'), raw);
  }
});

test('independent sidecar survives a legacy settings rewrite and a host restart without touching cards/history', async t => {
  const { file, directory } = await fixture(t);
  const names = ['settings.json', 'characters.json', 'memory.json'];
  for (const name of names) await writeFile(path.join(directory, name), `synthetic ${name}`, 'utf8');
  const store = new MusicSettingsStore(file);
  await store.persist({ strength: 0.35, enabled: true, modelPath: 'ignored' });
  const bytes = await readFile(file, 'utf8');
  // This covers file independence. Actual fixed-app roundtrip remains native QA.
  await writeFile(path.join(directory, 'settings.json'), '{"legacy":"rewritten"}', 'utf8');
  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.deepEqual(await new MusicSettingsStore(file).load(), { strength: 0.35, alwaysDance: false });
  assert.equal(await readFile(path.join(directory, 'characters.json'), 'utf8'), 'synthetic characters.json');
  assert.equal(await readFile(path.join(directory, 'memory.json'), 'utf8'), 'synthetic memory.json');
  assert.deepEqual(JSON.parse(bytes), { version: 1, settings: { strength: 0.35, alwaysDance: false } });
});

test('queued commits capture primitives, preserve zero and reject neither later writes nor state after a failure', async t => {
  const { file } = await fixture(t);
  let calls = 0;
  const store = new MusicSettingsStore(file, async (_file, data) => {
    if (++calls === 1) throw new Error('synthetic failure');
    await writeFile(file, data, 'utf8');
  });
  await assert.rejects(store.persist({ strength: 1 }), /synthetic failure/);
  assert.deepEqual(store.current, DEFAULT_MUSIC_SETTINGS);
  const patch = { strength: 0 };
  const first = store.persist(patch);
  patch.strength = 1;
  const second = store.persist({ unrelated: true });
  assert.deepEqual(await first, { strength: 0, alwaysDance: false });
  assert.deepEqual(await second, { strength: 0, alwaysDance: false });
  assert.deepEqual(store.current, { strength: 0, alwaysDance: false });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, settings: { strength: 0, alwaysDance: false } });
  const returned = store.current; returned.strength = 1;
  assert.equal(store.current.strength, 0);
});
