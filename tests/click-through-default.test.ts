import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../electron/settings';
import { AssetRegistry } from '../electron/assets';
import { DEFAULT_SETTINGS } from '../shared/defaults';

// 穿透模式默认开启 (only the default; the user's own choice is kept across launches). Her body and the visible
// controls stay clickable in click-through (src/ui/pointer-passthrough.ts); the tray and Ctrl+Alt+P bring the window back.
test('click-through: on in a fresh profile; a saved choice (off or on) is kept at the next launch', async () => {
  assert.equal(DEFAULT_SETTINGS.pet.clickThrough, true);
  const secret = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'click-through-'));
  try {
    const fresh = new SettingsStore(directory, secret, new AssetRegistry());
    await fresh.load();
    assert.equal(fresh.current.pet.clickThrough, true, 'fresh profile');
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, pet: { ...DEFAULT_SETTINGS.pet, clickThrough: false } }));
    const saved = new SettingsStore(directory, secret, new AssetRegistry());
    await saved.load();
    assert.equal(saved.current.pet.clickThrough, false, 'the user turned it off: it stays off');
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, pet: { ...DEFAULT_SETTINGS.pet, clickThrough: true } }));
    const on = new SettingsStore(directory, secret, new AssetRegistry());
    await on.load();
    assert.equal(on.current.pet.clickThrough, true, 'on stays on');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
