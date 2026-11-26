// no-pet-ok-file: the settings field holding click-through is named pet (shared/foundation/settings.ts), so its name has to be written here
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../electron/settings/settings';
import { clickThroughChange, noteClickThrough, rescueFromTray, toggledVisibility, trayRescue, type ClickThroughVia } from '../electron/settings/click-through';
import { AssetRegistry } from '../electron/foundation/assets';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { AppSettings } from '../shared/foundation/settings';
import { buildJournalEntry } from '../shared/memory/journal';

// I-223: click-through is on at the first install, then keeps what the user chose. Showing or hiding her (tray item, Ctrl+Alt+P, the
// companion window's close) used to write it off every time; now only the user's own choices change it, and each leaves a journal row.
const secret = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };
const withClickThrough = (value: boolean, visible = true): AppSettings => ({ ...structuredClone(DEFAULT_SETTINGS), pet: { ...DEFAULT_SETTINGS.pet, clickThrough: value, visible } });

async function inProfile<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'click-through-keeps-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const reopen = async (directory: string) => { const store = new SettingsStore(directory, secret, new AssetRegistry()); await store.load(); return store; };

for (const clickThrough of [true, false]) {
  test(`hide then show keeps click-through ${clickThrough ? 'on' : 'off'}, in memory and on disk`, async () => inProfile(async directory => {
    const store = await reopen(directory);
    await store.persist(withClickThrough(clickThrough));
    await store.persist(toggledVisibility(store.current)); // tray item / Ctrl+Alt+P / window close: hide
    assert.equal(store.current.pet.visible, false);
    assert.equal(store.current.pet.clickThrough, clickThrough);
    await store.persist(toggledVisibility(store.current)); // and show again
    assert.equal(store.current.pet.visible, true);
    assert.equal(store.current.pet.clickThrough, clickThrough);
    const next = await reopen(directory); // the next launch still sees the user's choice
    assert.equal(next.current.pet.clickThrough, clickThrough);
  }));
}

test('Ctrl+Alt+P is a plain toggle: hidden shows, shown hides, nothing else changes', () => {
  const hidden = withClickThrough(true, false);
  assert.deepEqual(toggledVisibility(hidden), { ...hidden, pet: { ...hidden.pet, visible: true } });
  const shown = withClickThrough(true, true);
  assert.deepEqual(toggledVisibility(shown), { ...shown, pet: { ...shown.pet, visible: false } });
});

test('the tray rescue (恢复鼠标交互) shows her and turns click-through off', () => {
  const rescued = trayRescue(withClickThrough(true, false));
  assert.equal(rescued.pet.visible, true);
  assert.equal(rescued.pet.clickThrough, false);
  assert.equal(trayRescue(withClickThrough(false, true)).pet.clickThrough, false);
});

test('the tray rescue as one step: saved off, shown, and one journal row "tray"; nothing extra when it was already off', async () => inProfile(async directory => {
  const rows: unknown[][] = [];
  const journal = { setting: (...args: unknown[]) => { rows.push(args); } };
  const store = await reopen(directory);
  await store.persist(withClickThrough(true, false));
  await rescueFromTray(store, journal, 'gene');
  assert.deepEqual(store.current.pet, { ...DEFAULT_SETTINGS.pet, visible: true, clickThrough: false });
  assert.deepEqual(rows, [['click_through', true, false, 'tray', 'gene']]);
  assert.equal((await reopen(directory)).current.pet.clickThrough, false, 'kept on disk');
  rows.length = 0;
  await rescueFromTray(store, journal, 'gene');
  assert.deepEqual(rows, []);
}));

test('a fresh profile starts with click-through on; a profile saved with it off starts with it off', async () => inProfile(async directory => {
  assert.equal((await reopen(directory)).current.pet.clickThrough, true);
  const store = await reopen(directory);
  await store.persist(withClickThrough(false));
  assert.equal((await reopen(directory)).current.pet.clickThrough, false);
}));

test('a journal row for every change of click-through, with how it happened; none when the value stayed', () => {
  const rows: unknown[][] = [];
  const journal = { setting: (...args: unknown[]) => { rows.push(args); } };
  for (const via of ['settings', 'tray', 'recover', 'reset'] as ClickThroughVia[]) noteClickThrough(journal, 'gene', withClickThrough(true), withClickThrough(false), via);
  assert.deepEqual(rows.map(row => [row[0], row[1], row[2], row[3], row[4]]), ['settings', 'tray', 'recover', 'reset'].map(via => ['click_through', true, false, via, 'gene']));
  rows.length = 0;
  noteClickThrough(journal, 'gene', withClickThrough(false), withClickThrough(false), 'settings');
  noteClickThrough(journal, 'gene', withClickThrough(true, true), withClickThrough(true, false), 'tray'); // only visibility changed
  assert.deepEqual(rows, []);
  assert.deepEqual(clickThroughChange(withClickThrough(false), withClickThrough(true)), { previous: false, value: true });
  assert.doesNotThrow(() => noteClickThrough({ setting: () => { throw new Error('disk'); } }, null, withClickThrough(true), withClickThrough(false), 'tray'));
});

test('the journal accepts each way as a setting row and says it in plain words; text is still refused', () => {
  const AT = new Date('2026-11-26T10:00:00Z').getTime();
  const reasons = new Set<string>();
  for (const via of ['agent', 'chat', 'settings', 'tray', 'recover', 'reset']) {
    const entry = buildJournalEntry({ type: 'setting', characterId: null, id: 'click_through', previous: true, value: false, via }, AT);
    assert.ok(entry, via);
    reasons.add(entry.reason);
  }
  assert.equal(reasons.size, 6, 'each way has its own words');
  assert.equal(buildJournalEntry({ type: 'setting', characterId: null, id: 'click_through', previous: true, value: false, via: 'some text' }, AT), null);
});
