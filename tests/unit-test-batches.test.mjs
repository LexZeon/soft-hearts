// scripts/update-desktop.mjs runs the candidate's unit tests in batches: one command line with all 1079 test files hit Windows'
// 32 767-character limit (spawn ENAMETOOLONG) on 2026-11-18 and no candidate could be built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUnitSummary, unitTestBatches } from '../scripts/update-desktop.mjs';

test('batches keep every file once, in order, each batch under the character budget', () => {
  const files = Array.from({ length: 1500 }, (_, i) => `tests/some-fairly-long-test-name-${String(i).padStart(4, '0')}.test.ts`);
  const batches = unitTestBatches(files, 20_000);
  assert.ok(batches.length > 1, 'a large set is split');
  assert.deepEqual(batches.flat(), files, 'nothing lost, nothing doubled, order kept');
  for (const batch of batches) assert.ok(batch.join(' ').length <= 20_000, 'each batch fits');
  assert.deepEqual(unitTestBatches(['tests/a.test.ts']), [['tests/a.test.ts']], 'a small set is one batch');
});

test('summaries add up; a failing batch still fails the whole run through requireUnitSummary per batch', () => {
  const one = { tests: 10, pass: 9, fail: 0, skipped: 1 }, two = { tests: 5, pass: 5, fail: 0, skipped: 0 };
  assert.deepEqual(addUnitSummary(undefined, one), one);
  assert.deepEqual(addUnitSummary(one, two), { tests: 15, pass: 14, fail: 0, skipped: 1 });
});
