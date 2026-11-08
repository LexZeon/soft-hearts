import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EmojiSettingsStore } from '../electron/single-emoji-settings';
import { atomicWriteFile } from '../electron/atomic-file';
import { DEFAULT_EMOJI_SETTINGS, EMOJI_CATALOG, getEmoji, readEmojiSettings } from '../shared/single-emoji';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-emoji-settings-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('soft-hearts-emoji-settings-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return { directory, file: path.join(directory, 'single-emoji-settings.json') };
}

test('system emoji settings reject untrusted shape, unknown content and empty or duplicate selections', () => {
  const valid = readEmojiSettings(DEFAULT_EMOJI_SETTINGS);
  assert.equal(valid.enabled, false);
  assert.equal(valid.selected.length, 12);
  valid.selected.pop();
  assert.equal(DEFAULT_EMOJI_SETTINGS.selected.length, 12);
  for (const value of [undefined, null, [], true, {}, Object.create(DEFAULT_EMOJI_SETTINGS),
    { ...DEFAULT_EMOJI_SETTINGS, enabled: 1 }, { ...DEFAULT_EMOJI_SETTINGS, version: 2 },
    { ...DEFAULT_EMOJI_SETTINGS, source: 'custom' }, { ...DEFAULT_EMOJI_SETTINGS, path: 'file:///x' },
    { ...DEFAULT_EMOJI_SETTINGS, selected: [] }, { ...DEFAULT_EMOJI_SETTINGS, selected: ['wave', 'wave'] },
    { ...DEFAULT_EMOJI_SETTINGS, selected: ['😊'] }, { ...DEFAULT_EMOJI_SETTINGS, selected: [false] },
    { ...DEFAULT_EMOJI_SETTINGS, selected: Array(1) },
    { ...DEFAULT_EMOJI_SETTINGS, selected: Array(13).fill('wave') },
    { ...DEFAULT_EMOJI_SETTINGS, selected: ['<img src=x>'] }])
    assert.throws(() => readEmojiSettings(value));
  assert.equal(getEmoji('heart')?.glyph, '❤️');
  assert.equal(getEmoji('file:///x'), undefined);
  assert.equal(new Set(EMOJI_CATALOG.map(entry => entry.id)).size, 12);
  assert.deepEqual(getEmoji('sleepy')?.hints, []);
});

test('missing sidecar loads disabled defaults without writing or touching other profile data', async t => {
  const { directory } = await fixture(t);
  await writeFile(path.join(directory, 'settings.json'), 'preserve legacy bytes');
  const store = new EmojiSettingsStore(directory);
  const value = await store.load();
  assert.deepEqual(value, DEFAULT_EMOJI_SETTINGS);
  value.selected.length = 0;
  assert.equal(store.current.selected.length, 12);
  assert.deepEqual(await readdir(directory), ['settings.json']);
  assert.equal(await readFile(path.join(directory, 'settings.json'), 'utf8'), 'preserve legacy bytes');
});

test('valid sidecar round-trips and malformed or unreadable input does not replace committed state or bytes', async t => {
  const { directory, file } = await fixture(t);
  const store = new EmojiSettingsStore(directory);
  const value = { version: 1 as const, enabled: true, source: 'system' as const, selected: ['heart' as const] };
  await writeFile(file, JSON.stringify(value));
  assert.deepEqual(await store.load(), value);
  for (const malformed of ['{', JSON.stringify({ ...value, selected: [] }), JSON.stringify({ ...value, arbitrary: true })]) {
    await writeFile(file, malformed);
    await assert.rejects(store.load());
    assert.deepEqual(store.current, value);
    assert.equal(await readFile(file, 'utf8'), malformed);
  }
  await rm(file);
  await mkdir(file);
  await assert.rejects(store.load());
  assert.deepEqual(store.current, value);
});

test('serialized saves snapshot caller data, return their own state, and do not poison later saves on failure', async t => {
  const { directory, file } = await fixture(t);
  let writes = 0;
  const store = new EmojiSettingsStore(directory, async (target, text) => {
    if (++writes === 1) throw new Error('synthetic write failure');
    await atomicWriteFile(target, text);
  });
  const first = store.save({ ...DEFAULT_EMOJI_SETTINGS, enabled: true, selected: ['wave'] });
  const input = { ...DEFAULT_EMOJI_SETTINGS, enabled: true, selected: ['heart'] };
  const second = store.save(input);
  input.selected[0] = 'sad';
  const third = store.save({ ...DEFAULT_EMOJI_SETTINGS, enabled: false, selected: ['smile'] });
  await assert.rejects(first, /synthetic write failure/);
  assert.deepEqual(await second, { version: 1, enabled: true, source: 'system', selected: ['heart'] });
  assert.deepEqual(await third, { version: 1, enabled: false, source: 'system', selected: ['smile'] });
  const returned = store.current;
  returned.selected[0] = 'upset';
  assert.deepEqual(store.current, { version: 1, enabled: false, source: 'system', selected: ['smile'] });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), store.current);
  await assert.rejects(store.save({ ...store.current, selected: [] }));
  assert.equal(writes, 3);
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});
