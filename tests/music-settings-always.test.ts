/** M1: "让她一直跟着跳" (advanced, default off) is a stored own boolean; a partial change keeps the other field. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MusicSettingsStore } from '../electron/music-settings';
import { DEFAULT_MUSIC_SETTINGS, normalizeMusicSettings } from '../shared/music-settings';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-music-store-'));
  t.after(async () => { await rm(path.resolve(directory), { recursive: true, force: true }); });
  return { directory, file: path.join(directory, 'music-settings.json') };
}

test('M1 setting: off by default, only an own boolean counts, and a change keeps the other field', () => {
  assert.equal(DEFAULT_MUSIC_SETTINGS.alwaysDance, false);
  for (const value of ['true', 1, null, {}, { alwaysDance: 'yes' }, Object.create({ alwaysDance: true })])
    assert.equal(normalizeMusicSettings(value).alwaysDance, false);
  assert.deepEqual(normalizeMusicSettings({ alwaysDance: true }), { strength: 0.7, alwaysDance: true });
  assert.deepEqual(normalizeMusicSettings({ strength: 0.2 }, { strength: 0.9, alwaysDance: true }), { strength: 0.2, alwaysDance: true });
  assert.deepEqual(normalizeMusicSettings({ alwaysDance: false }, { strength: 0.9, alwaysDance: true }), { strength: 0.9, alwaysDance: false });
});

test('M1 setting: it is stored in the music sidecar, survives a restart, and an old sidecar loads as off', async t => {
  const { file } = await fixture(t);
  const store = new MusicSettingsStore(file);
  await store.persist({ strength: 0.4 });
  assert.deepEqual(await store.persist({ alwaysDance: true }), { strength: 0.4, alwaysDance: true }, 'only the toggle changed');
  assert.deepEqual(await store.persist({ strength: 0.5 }), { strength: 0.5, alwaysDance: true }, 'only the strength changed');
  assert.deepEqual(await store.persist({ alwaysDance: 'on' }), { strength: 0.5, alwaysDance: true }, 'a non-boolean is ignored');
  assert.deepEqual(await new MusicSettingsStore(file).load(), { strength: 0.5, alwaysDance: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, settings: { strength: 0.5, alwaysDance: true } });
  await writeFile(file, JSON.stringify({ version: 1, settings: { strength: 0.3 } }), 'utf8');
  assert.deepEqual(await new MusicSettingsStore(file).load(), { strength: 0.3, alwaysDance: false });
});
