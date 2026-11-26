// The pages the app ships and its Claude reads (shared/safety/user-manuals.json): one list, three readers that must agree, and pages written
// for the person who uses the app. docs/claude/2026-11-25-export-clean.md ("the user handbook in the public snapshot").
//   1. read_handbook lists exactly these pages (tests/assistant-handbook.test.ts has the reader side).
//   2. package.json bundles exactly these pages as assistant-docs, nothing from handbook/.
//   3. the public snapshot keeps exactly these (plus its own few docs), and drops the project handbook.
//   4. none of them carries development process: no records, ids, dated decisions, user quotes or local paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_MANUALS } from '../shared/safety/handbook-docs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The exporter is maintainer tooling and is not in the public snapshot, so that side is only checked where it exists (an untyped script, loaded by name).
const exporterFile = '../scripts/release/export-public.mjs';
const hasExporter = existsSync(path.join(root, 'scripts', 'release', 'export-public.mjs'));

test('every page on the list exists, is a markdown file directly under docs/, and has a title', async () => {
  assert.ok(USER_MANUALS.size >= 6);
  for (const [file, kind] of USER_MANUALS) {
    assert.match(file, /^docs\/(?:release-notes\/)?[A-Za-z0-9._-]+\.md$/, file);
    assert.equal(kind, 'guide', `${file}: the shipped pages are guides`);
    const text = await readFile(path.join(root, file), 'utf8');
    assert.match(text, /^#\s+\S/m, `${file} has a title`);
  }
});

test('the public snapshot keeps every listed page, and the project handbook stays out', { skip: hasExporter ? false : 'the exporter is not in the public snapshot' }, async () => {
  const exporter = await import(exporterFile) as { KEEP_DOCS: readonly string[]; USER_MANUAL_FILES: readonly string[]; isExcluded(rel: string): boolean };
  assert.deepEqual([...exporter.USER_MANUAL_FILES].sort(), [...USER_MANUALS.keys()].sort(), 'the exporter reads the same list');
  for (const file of USER_MANUALS.keys()) {
    assert.ok(exporter.KEEP_DOCS.includes(file), `${file} is kept`);
    assert.equal(exporter.isExcluded(file), false, `${file} is not excluded`);
  }
  for (const file of ['handbook/README.md', 'handbook/features.md', 'handbook/ideas.md', 'handbook/how-we-work.md', 'handbook/roadmap.md', 'handbook/data-map.md'])
    assert.equal(exporter.isExcluded(file), true, `${file} is development only`);
});

test('the packaged app bundles the listed pages and no handbook folder', async () => {
  const build = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).build;
  const bundled = build.extraResources.filter((entry: { from: string; to: string }) => entry.to.startsWith('assistant-docs'));
  assert.ok(bundled.every((entry: { from: string }) => entry.from === 'docs'), 'only docs/ is bundled as assistant-docs');
  assert.deepEqual(bundled.flatMap((entry: { filter: string[] }) => entry.filter.map(name => `docs/${name}`)).sort(), [...USER_MANUALS.keys()].sort());
});

test('a listed page carries no development process: no records, issue ids, dated decisions, user quotes or local paths', async () => {
  const patterns: Array<[RegExp, string]> = [
    [/docs\/claude|docs\/archive|handbook\//, 'a path into the development records or the project handbook'],
    [/\b[IT]-\d{2,3}\b/, 'an issue id'],
    [/\b20\d\d-\d\d-\d\d\b/, 'a date'],
    [/用户 ?20\d\d|user 20\d\d/i, 'a dated quote of the user'],
    [/[A-Za-z]:[\\/]Users[\\/]|%APPDATA%\\soft-hearts/, 'a local path'],
    [/\b(?:Codex|Co-Authored-By)\b/, 'a development tool or commit trailer'],
  ];
  for (const file of USER_MANUALS.keys()) {
    const lines = (await readFile(path.join(root, file), 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const [pattern, what] of patterns) assert.ok(!pattern.test(line), `${file}:${index + 1} has ${what}`);
    });
  }
});
