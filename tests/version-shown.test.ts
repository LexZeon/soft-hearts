// The version the control window shows is the package's version (it stayed at v0.1.0 through three releases, 2026-11-25).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the control window shows the package version, and the model line no longer says MMD only', () => {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
  const layout = readFileSync(path.join(root, 'src/settings/layout.ts'), 'utf8');
  const shown = /<span class="version"><b>v([0-9.]+)<\/b><\/span>/.exec(layout)?.[1];
  assert.equal(shown, version, 'src/settings/layout.ts shows the version from package.json');
  assert.ok(!/MMD ONLY/.test(layout), 'PMX/PMD and VRM models both load: no "MMD ONLY" label');
});
