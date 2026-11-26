// scripts/dev/test-affected.mjs: choosing the tests a change can affect. Pure parts only, on a small fixture graph.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fullRunReason, literalNames, loadGraph, rendererReaders, selectAffected, sourcePathLiterals, touchesPart, wiringReaders } from '../scripts/dev/test-affected.mjs';

const graph = {
  'shared/util.ts': [],
  'shared/foundation/mood.ts': ['shared/util.ts'],
  'electron/main.ts': ['shared/foundation/mood.ts'],
  'electron/lonely.ts': [],
  'src/ui.ts': ['shared/util.ts'],
  'tests/mood.test.ts': ['shared/foundation/mood.ts'],
  'tests/ui.test.ts': ['src/ui.ts'],
  'tests/slice.test.ts': [],
  'tests/join.test.ts': [],
  'tests/other.test.ts': [],
};
const literals = {
  'tests/slice.test.ts': ['electron/main.ts'],
  'tests/join.test.ts': ['electron/lonely.ts'],
};
const tests = Object.keys(graph).filter((f) => f.startsWith('tests/'));
const partOf = (f) => ({ 'shared/foundation/mood.ts': 'mood', 'src/ui.ts': 'stage', 'electron/main.ts': 'core' }[f] ?? null);

test('a shared util reaches every test that imports it, directly or through other files', () => {
  const r = selectAffected({ graph, literals, tests, changed: ['shared/util.ts'] });
  assert.equal(r.full, false);
  // slice.test.ts reads electron/main.ts, which imports shared/foundation/mood.ts, which imports the util: reached through a literal plus imports
  assert.deepEqual([...r.selected.keys()].sort(), ['tests/mood.test.ts', 'tests/slice.test.ts', 'tests/ui.test.ts']);
  assert.deepEqual(r.selected.get('tests/mood.test.ts'), ['shared/util.ts']);
});

test('a test that only slices a source file by its path is chosen when that file changes', () => {
  const r = selectAffected({ graph, literals, tests, changed: ['electron/main.ts'] });
  assert.deepEqual([...r.selected.keys()].sort(), ['tests/slice.test.ts']);
  const none = selectAffected({ graph, literals, tests, changed: ['docs/readme.md'] });
  assert.equal(none.selected.size, 0);
  assert.deepEqual(none.unmatched, ['docs/readme.md']);
});

test('a changed test file runs itself; a changed file nobody uses is reported, not silently dropped', () => {
  const r = selectAffected({ graph, literals, tests, changed: ['tests/other.test.ts', 'src\\ui.ts'] });
  assert.deepEqual([...r.selected.keys()].sort(), ['tests/other.test.ts', 'tests/ui.test.ts']);
  assert.deepEqual(selectAffected({ graph, literals, tests, changed: ['shared/orphan.ts'] }).unmatched, ['shared/orphan.ts']);
});

test('changes that can touch every test run everything and say why', () => {
  for (const f of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.node.json', 'scripts/dev/test-all.mjs', 'tests/helpers/x.ts', 'tests/fixtures/y.json']) {
    assert.ok(fullRunReason([f]).includes(f), f);
    const r = selectAffected({ graph, literals, tests, changed: [f, 'shared/util.ts'] });
    assert.equal(r.full, true);
    assert.equal(r.selected.size, tests.length);
  }
  assert.equal(fullRunReason(['electron/main.ts', 'docs/a.md', 'scripts/dev/heavy.mjs']), null);
});

test('source path literals: plain, with ../, joined pieces; not URLs, absolute paths or templates', () => {
  const text = [
    "readFileSync('electron/main.ts')",
    "readFile(new URL('../src/main.ts', import.meta.url))",
    "path.join(root, 'shared', 'mood', 'core.ts')",
    "path.resolve(here, '..', 'electron')",
    "const a = 'https://example.com/a/b.ts'; const b = '/etc/x/y'; const c = `src/${name}/z.ts`; const d = 'just words'",
  ].join('\n');
  const found = sourcePathLiterals(text);
  assert.ok(found.includes('electron/main.ts'));
  assert.ok(found.includes('src/main.ts'));
  assert.ok(found.includes('shared/mood/core.ts'));
  assert.ok(!found.some((l) => l.includes('example.com') || l.startsWith('/') || l.includes('$')));
  assert.ok(!found.includes('just words'));
});

test('a literal names a file, a file ending, or a folder holding it', () => {
  assert.equal(literalNames('electron/main.ts', 'electron/main.ts'), true);
  assert.equal(literalNames('src/main.ts', 'electron/main.ts'), false);
  assert.equal(literalNames('electron/mood', 'electron/mood/a.ts'), true);
  assert.equal(literalNames('electron/moo', 'electron/mood/a.ts'), false);
});

test('--part: tests that import a file of the part, alone or overlapped with a change', () => {
  assert.equal(touchesPart('tests/mood.test.ts', 'mood', { graph, literals, partOf }), true);
  assert.equal(touchesPart('tests/ui.test.ts', 'mood', { graph, literals, partOf }), false);
  assert.equal(touchesPart('tests/slice.test.ts', 'core', { graph, literals, partOf }), true, 'by literal');
  const r = selectAffected({ graph, literals, tests, changed: ['shared/util.ts'], part: 'stage', partOf });
  assert.deepEqual([...r.selected.keys()], ['tests/ui.test.ts']);
});

test('a test that reads the wiring through tests/helpers/wiring-source.ts is chosen when main.ts or any wiring file changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-readers-'));
  const files = {
    'electron/main.ts': 'export const main = 1;\n',
    'electron/wiring/x-wiring.ts': 'export const x = 1;\n',
    'electron/other.ts': 'export const o = 1;\n',
    'tests/helpers/wiring-source.ts': 'export const wiringSource = () => "";\n',
    'tests/helpers/indirect.ts': "import { wiringSource } from './wiring-source';\nexport const i = wiringSource;\n",
    'tests/reads.test.ts': "import { wiringSource } from './helpers/wiring-source';\nwiringSource();\n",
    'tests/reads-indirect.test.ts': "import { i } from './helpers/indirect';\ni();\n",
    'tests/plain.test.ts': "import '../electron/other';\n",
  };
  for (const [p, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), t); }
  const g = await loadGraph(root);
  assert.deepEqual(Object.keys(wiringReaders(g.graph, g.tests)).sort(), ['tests/reads-indirect.test.ts', 'tests/reads.test.ts']);
  const pick = (changed) => [...selectAffected({ graph: g.graph, literals: g.literals, tests: g.tests, changed }).selected.keys()].sort();
  assert.deepEqual(pick(['electron/wiring/x-wiring.ts']), ['tests/reads-indirect.test.ts', 'tests/reads.test.ts']);
  assert.deepEqual(pick(['electron/main.ts']), ['tests/reads-indirect.test.ts', 'tests/reads.test.ts']);
  assert.deepEqual(pick(['electron/other.ts']), ['tests/plain.test.ts'], 'an unrelated file does not select them');
});

test('a test that reads the renderer through tests/helpers/renderer-source.ts is chosen when src/main.ts or any src/wiring file changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-readers-'));
  const files = {
    'src/main.ts': 'export const main = 1;\n',
    'src/wiring/x-wiring.ts': 'export const x = 1;\n',
    'src/other.ts': 'export const o = 1;\n',
    'tests/helpers/renderer-source.ts': 'export const rendererSource = () => "";\n',
    'tests/reads.test.ts': "import { rendererSource } from './helpers/renderer-source';\nrendererSource();\n",
    'tests/plain.test.ts': "import '../src/other';\n",
  };
  for (const [p, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), t); }
  const g = await loadGraph(root);
  assert.deepEqual(Object.keys(rendererReaders(g.graph, g.tests)), ['tests/reads.test.ts']);
  const pick = (changed) => [...selectAffected({ graph: g.graph, literals: g.literals, tests: g.tests, changed }).selected.keys()].sort();
  assert.deepEqual(pick(['src/wiring/x-wiring.ts']), ['tests/reads.test.ts']);
  assert.deepEqual(pick(['src/main.ts']), ['tests/reads.test.ts']);
  assert.deepEqual(pick(['src/other.ts']), ['tests/plain.test.ts'], 'an unrelated file does not select it');
});

