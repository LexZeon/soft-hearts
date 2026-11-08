// R26 (2026-11-03): start-soft-hearts.cmd never installed the development version or its desktop shortcut, because
// prepare() runs the unit tests in a frozen copy that holds only runtimeInputs, and tests read handbook/README.md,
// handbook/ideas.md and tools/bridge/scorer.html. These tests keep every repository file a test reads in that copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frozenCovers, repositoryReads, unfrozenTestReads } from '../scripts/lib/frozen-inputs.mjs';
import { runtimeInputs } from '../scripts/update-desktop.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('every repository file the unit tests read is in the frozen validation copy', async () => {
  const findings = await unfrozenTestReads(root, runtimeInputs);
  assert.deepEqual(findings.map(row => `${row.file}:${row.line} reads ${row.path}`), [],
    'add these to runtimeInputs in scripts/update-desktop.mjs, or the double-clicked development update fails in its frozen copy');
});

test('the frozen copy holds the two folders whose absence broke R26', () => {
  for (const file of ['handbook/README.md', 'handbook/ideas.md', 'tools/bridge/scorer.html']) assert.ok(frozenCovers(file, runtimeInputs), file);
  for (const file of ['docs/claude/x.md', 'tools/other.mts', 'README.md', 'CLAUDE.md']) assert.equal(frozenCovers(file, runtimeInputs), false, file);
  assert.ok(frozenCovers('assets', runtimeInputs), 'a folder above a frozen folder counts as present');
});

test('the scanner finds each way a test names a repository file, and nothing else', async () => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-frozen-inputs-')));
  try {
    for (const file of ['handbook/ideas.md', 'handbook/README.md', 'tools/bridge/scorer.html', 'docs/notes.md', 'docs/other.md', 'shared/x.ts', 'README.md'])
      { await mkdir(path.dirname(path.join(temporary, file)), { recursive: true }); await writeFile(path.join(temporary, file), 'synthetic'); }
    await mkdir(path.join(temporary, 'tests', 'helpers'), { recursive: true });
    await writeFile(path.join(temporary, 'tests', 'reads.test.ts'), [
      "// Comments are not reads: handbook/README.md, '../docs/notes.md'.",
      "import { helper } from '../shared/x.ts';",
      "const ideas = readFileSync(path.join(import.meta.dirname, '..', 'handbook', 'ideas.md'), 'utf8');",
      "const html = readFileSync(new URL('../tools/bridge/scorer.html', import.meta.url), 'utf8');",
      "const root = fileURLToPath(new URL('..', import.meta.url));",
      "const notes = readFileSync(path.join(root, 'docs', 'notes.md'), 'utf8');",
      "const other = await readFile('docs/other.md', 'utf8');",
      "const quoted = /['\"]handbook\\/ideas.md['\"]/;",
      "const method = 'tools/list';",
      "const temporaryLayout = path.join(os.tmpdir(), 'docs', 'notes.md');",
    ].join('\n'));
    await writeFile(path.join(temporary, 'tests', 'helpers', 'deep.mjs'),
      "export const readme = readFileSync(path.join(import.meta.dirname, '..', '..', 'README.md'), 'utf8');\n");
    const without = { fixed: ['package.json'], folders: ['shared', 'tests'] };
    const rows = (await unfrozenTestReads(temporary, without)).map(row => `${row.file}:${row.line} ${row.path}`);
    assert.deepEqual(rows, ['tests/helpers/deep.mjs:1 README.md', 'tests/reads.test.ts:3 handbook/ideas.md', 'tests/reads.test.ts:4 tools/bridge/scorer.html',
      'tests/reads.test.ts:6 docs/notes.md', 'tests/reads.test.ts:7 docs/other.md']);
    assert.deepEqual(await unfrozenTestReads(temporary, { fixed: ['README.md'], folders: ['shared', 'tests', 'handbook', 'tools/bridge', 'docs'] }), []);
  } finally {
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('soft-hearts-frozen-inputs-'));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a JavaScript test is parsed as JavaScript and reports its line', () => {
  const reads = repositoryReads("\n\nconst page = new URL('../../tools/bridge/scorer.html', import.meta.url);\n", 'x.mjs', new Set(['tools']));
  assert.deepEqual(reads, [{ path: 'tools/bridge/scorer.html', line: 3 }]);
});
