import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateSettings } from '../electron/validation';
import { SettingsStore } from '../electron/settings';
import { AssetRegistry } from '../electron/assets';
import { DEFAULT_SETTINGS } from '../shared/defaults';

test('the inner-loop switch defaults on, keeps an explicit off, and ignores non-boolean values', () => {
  assert.equal(DEFAULT_SETTINGS.innerLoop, true);
  const old = structuredClone(DEFAULT_SETTINGS) as Partial<typeof DEFAULT_SETTINGS>;
  delete old.innerLoop;
  assert.equal(validateSettings(old).innerLoop, true, 'a settings file from before the switch gets the default');
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, innerLoop: false }).innerLoop, false);
  for (const value of ['false', 0, null, {}, 'off']) assert.equal(validateSettings({ ...DEFAULT_SETTINGS, innerLoop: value }).innerLoop, true, String(value));
});

test('loading an older settings file adds the default; an explicit off survives a restart', async () => {
  const secret = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };
  for (const [stored, expected] of [[undefined, true], [false, false], [true, true]] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-inner-loop-settings-'));
    try {
      const file = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
      if (stored === undefined) delete file.innerLoop; else file.innerLoop = stored;
      await writeFile(path.join(directory, 'settings.json'), JSON.stringify(file), 'utf8');
      const store = new SettingsStore(directory, secret, new AssetRegistry());
      await store.load();
      assert.equal(store.current.innerLoop, expected, String(stored));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
