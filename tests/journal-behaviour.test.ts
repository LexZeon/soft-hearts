// The experience journal's behaviour golden (scripts/dev/journal-behaviour.ts; docs/claude/2026-11-16-journal-split.md). The
// journal is the format of the user's real 体验记录: the lines written and how old lines read back must stay exactly the same when
// the code moves. For every journal type this tries its valid inputs, every closed value on every field, junk, and every other
// type (tests/helpers/journal-behaviour.ts makes them; none comes from a real journal), and compares the line written (or refused),
// the panel text and the read-back with the golden. A new journal entry type must add its valid inputs to BASES and regenerate.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as journal from '../shared/memory/journal';
import { BASES, examples, exportedData, helperCases, lineCases, sweep, AT, type JournalApi, type Pools } from './helpers/journal-behaviour';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/journal-behaviour.json'), 'utf8')) as {
  at: number; data: Record<string, unknown>; pools: Pools; examples: Record<string, unknown>; sweep: Record<string, unknown>;
  lines: unknown; helpers: unknown;
};
const api = journal as unknown as JournalApi;
const REGENERATE = 'regenerate with `node node_modules/tsx/dist/cli.mjs scripts/dev/journal-behaviour.ts --write` only for an intended change, and say why in the commit';

test('every journal type has valid inputs in the golden, and every one is accepted', () => {
  assert.equal(golden.at, AT);
  assert.deepEqual(Object.keys(BASES).sort(), [...journal.JOURNAL_TYPES].sort(), 'a new journal entry type adds its valid inputs to BASES (tests/helpers/journal-behaviour.ts)');
  for (const type of journal.JOURNAL_TYPES) {
    assert.ok(golden.pools[type], `${type}: the golden has no field pools; ${REGENERATE}`);
    for (const input of BASES[type]!) assert.notEqual(journal.buildJournalEntry(input, AT), null, `${type}: a base input is refused: ${JSON.stringify(input)}`);
  }
});

test('the exported lists, tables and numbers are the same, in the same order', () => {
  const live = exportedData(journal as unknown as Record<string, unknown>);
  assert.deepEqual(Object.keys(live), Object.keys(golden.data), `exported values added or removed; ${REGENERATE}`);
  for (const name of Object.keys(golden.data)) {
    assert.deepEqual(live[name], golden.data[name], `${name} changed; ${REGENERATE}`);
    assert.equal(JSON.stringify(live[name]), JSON.stringify(golden.data[name]), `${name}: the order changed; ${REGENERATE}`);
  }
});

test('the base inputs write the same lines and panel text', () => {
  for (const type of journal.JOURNAL_TYPES) assert.deepEqual(examples(api, type), golden.examples[type], `${type}; ${REGENERATE}`);
});

test('every input of the sweep gives the same result (one hash per type)', () => {
  for (const type of journal.JOURNAL_TYPES) assert.deepEqual(sweep(api, type, golden.pools), golden.sweep[type], `${type}: some input now gives another line, text or read-back; ${REGENERATE}`);
});

test('damaged, foreign and tampered lines read back the same', () => {
  assert.deepEqual(lineCases(api), golden.lines);
});

test('the mood source, the delta text, the clock and the durations are the same', () => {
  assert.deepEqual(helperCases(api), golden.helpers);
});
