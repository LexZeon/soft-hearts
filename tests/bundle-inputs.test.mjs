// The bundle comparison used when parts move into folders (scripts/dev/bundle-inputs.mjs; docs/claude/2026-11-16-overhaul-parts-2.md):
// a move must not pull new source files into a separately bundled entry; renamed files count as the same file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compareBundles, parseElectronBuild, parseRenames, splitInputs } from '../scripts/dev/bundle-inputs.mjs';

test('a moved file is the same file; a new input and a dropped input are reported per bundle', () => {
  const before = {
    'electron:preload': { bytes: 100, sources: ['electron/safety/preload.ts', 'shared/a.ts'], packages: 0 },
    'electron:main': { bytes: 500, sources: ['electron/main.ts', 'electron/x.ts'], packages: 1 },
    'vite:old': { bytes: 5, sources: [], packages: 0 },
  };
  const after = {
    'electron:preload': { bytes: 100, sources: ['electron/safety/preload.ts', 'shared/part/a.ts'], packages: 0 },
    'electron:main': { bytes: 540, sources: ['electron/main.ts', 'electron/part/index.ts'], packages: 1 },
    'vite:new': { bytes: 7, sources: [], packages: 0 },
  };
  const rows = compareBundles(before, after, { 'shared/a.ts': 'shared/part/a.ts' });
  assert.deepEqual(rows.map((r) => r.name), ['electron:main', 'vite:new', 'vite:old']);
  const main = rows[0];
  assert.deepEqual(main.added, ['electron/part/index.ts']);
  assert.deepEqual(main.removed, ['electron/x.ts']);
  assert.equal(main.bytesDelta, 40);
  assert.equal(rows[1].only, 'after');
  assert.equal(rows[2].only, 'before');
});

test('without the rename the moved file shows as added and removed', () => {
  const rows = compareBundles({ p: { bytes: 1, sources: ['a.ts'], packages: 0 } }, { p: { bytes: 1, sources: ['b/a.ts'], packages: 0 } });
  assert.deepEqual(rows[0].added, ['b/a.ts']);
  assert.deepEqual(rows[0].removed, ['a.ts']);
});

test('git renames and inputs are read as repo paths', () => {
  assert.deepEqual(parseRenames('R100\telectron/a.ts\telectron/p/a.ts\nM\tsrc/x.ts\nR087\tshared/b.ts\tshared/p/b.ts\n'), { 'electron/a.ts': 'electron/p/a.ts', 'shared/b.ts': 'shared/p/b.ts' });
  const root = path.resolve('/repo');
  const { sources, packages } = splitInputs([path.join(root, 'src', 'x.ts'), 'electron/y.ts', 'node_modules/three/build/three.module.js', '\0vite/preload', path.join(root, 'src', 'x.ts') + '?raw'], root);
  assert.deepEqual(sources, ['electron/y.ts', 'src/x.ts']);
  assert.equal(packages, 1);
});

test('the electron entries are read from scripts/build-electron.mjs', () => {
  const text = fs.readFileSync(new URL('../scripts/build-electron.mjs', import.meta.url), 'utf8');
  const { entries, external } = parseElectronBuild(text);
  assert.equal(entries.main, 'electron/desktop-entry.ts');
  assert.equal(entries.preload, 'electron/safety/preload.ts');
  assert.ok(entries['unbound-input-preload']);
  for (const file of Object.values(entries)) assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), file);
  assert.ok(external.includes('electron'));
});
