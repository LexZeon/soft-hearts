// The experience journal's export surface golden (scripts/dev/journal-surface.mjs; docs/claude/2026-11-16-journal-split.md): every
// name shared/memory/journal.ts exports, with its kinds, doc comment and full type (unions as sorted constituents). Moving entry
// types into per-part slices must leave it unchanged; an intended change (a new journal entry type, a new word list) regenerates
// it and says why in the commit. The behaviour golden is tests/journal-behaviour.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSurface, SURFACE_FILE } from '../scripts/dev/journal-surface.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGENERATE = 'regenerate with `node scripts/dev/journal-surface.mjs --write` only if the change is intended, and say why in the commit';

const live = buildSurface(ROOT);

test('the journal export surface matches the golden (tests/fixtures/journal-surface.json)', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, SURFACE_FILE), 'utf8'));
  assert.deepEqual(Object.keys(live.exports), Object.keys(golden.exports), `exports added or removed; ${REGENERATE}`);
  for (const name of Object.keys(golden.exports)) {
    const now = live.exports[name], was = golden.exports[name];
    if (was.union) {
      assert.deepEqual(now.union?.map((c) => c.text), was.union.map((c) => c.text), `${name}: a constituent changed; ${REGENERATE}`);
    }
    assert.deepEqual(now, was, `export ${name} changed; ${REGENERATE}`);
  }
  assert.deepEqual(live.counts, golden.counts);
  assert.deepEqual(live, golden);
});

test('the golden is not empty where it matters', () => {
  assert.ok(live.counts.exports >= 84);
  assert.ok(live.counts.journalInputConstituents >= 63, 'JournalInput: one constituent per entry shape');
  const input = live.exports.JournalInput.union.map((c) => c.text);
  assert.ok(input.some((t) => t.startsWith('{ type: "mood-event"; characterId: string; source: ')));
  assert.deepEqual(live.exports.buildJournalEntry.signatures, ['(input: unknown, at: number) => JournalEntry | null']);
  assert.deepEqual(live.exports.readJournalLine.signatures, ['(line: string) => JournalEntry | null']);
  assert.match(live.exports.JOURNAL_TYPES.valueType, /^readonly \["mood-event", "mood-label", "boredom", /);
});
