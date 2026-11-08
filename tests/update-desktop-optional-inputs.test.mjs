// The public source snapshot has no handbook/ and no tools/bridge/. `pnpm desktop:update` fingerprints the runtime inputs of the
// workspace; a missing optional folder must count as empty there, while a present one still counts and a missing required one still fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runtimeInputs, workspaceSourceHash } from '../scripts/update-desktop.mjs';

function makeWorkspace(extraFolders = []) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shdesk-'));
  for (const file of runtimeInputs.fixed) fs.writeFileSync(path.join(base, file), file);
  for (const folder of ['electron', 'shared', 'src', 'scripts', 'tests', 'assets/bundled', ...extraFolders]) {
    fs.mkdirSync(path.join(base, folder), { recursive: true });
    fs.writeFileSync(path.join(base, folder, 'a.txt'), folder);
  }
  return base;
}

test('a workspace without handbook/ and tools/bridge/ (the public snapshot) still has a source fingerprint', async () => {
  const base = makeWorkspace();
  try {
    assert.match(await workspaceSourceHash(base), /^[a-f0-9]{64}$/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('optional folders that exist still count in the fingerprint', async () => {
  const without = makeWorkspace();
  const withBoth = makeWorkspace(['handbook', 'tools/bridge']);
  try {
    assert.notEqual(await workspaceSourceHash(without), await workspaceSourceHash(withBoth));
    const before = await workspaceSourceHash(withBoth);
    fs.writeFileSync(path.join(withBoth, 'handbook', 'a.txt'), 'changed');
    assert.notEqual(await workspaceSourceHash(withBoth), before, 'a change inside handbook/ changes the fingerprint');
  } finally { for (const base of [without, withBoth]) fs.rmSync(base, { recursive: true, force: true }); }
});

test('a missing required folder is still an error', async () => {
  const base = makeWorkspace();
  try {
    fs.rmSync(path.join(base, 'src'), { recursive: true });
    await assert.rejects(() => workspaceSourceHash(base), { code: 'ENOENT' });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
