// The "only gets smaller" size check (scripts/dev/size-check.mjs): the rules on fake numbers, the repin/lower commands on a
// throw-away folder, and the real repository against scripts/dev/size-debt.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSizes, countHandlers, currentHandlers, loadDebt, lowerPins, main, scanSizes } from '../scripts/dev/size-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = 1024;

const debtOf = () => ({
  limit: 40 * KB, slack: 4 * KB,
  hotspots: { 'electron/main.ts': { bytes: 100 * KB, reason: 'r' } },
  handlers: { file: 'electron/main.ts', count: 10, reason: 'r' },
  pinned: { 'src/big.ts': { bytes: 60 * KB, reason: 'r' } },
});
const filesOf = (o) => new Map(Object.entries(o));

test('the real repository passes the size check (scripts/dev/size-debt.json is the ceiling; --repin raises one on purpose)', () => {
  const debt = loadDebt(ROOT);
  const result = checkSizes({ files: scanSizes(ROOT), handlers: currentHandlers(ROOT, debt), debt });
  assert.deepEqual(result.failures.map((f) => f.message), []);
});

test('a hotspot may shrink but not grow by a single byte', () => {
  const debt = debtOf();
  const ok = checkSizes({ files: filesOf({ 'electron/main.ts': 100 * KB - 1, 'src/big.ts': 60 * KB }), handlers: 10, debt });
  assert.deepEqual(ok.failures, []);
  assert.deepEqual(ok.shrunk, [{ path: 'electron/main.ts', was: 100 * KB, now: 100 * KB - 1 }]);
  const bad = checkSizes({ files: filesOf({ 'electron/main.ts': 100 * KB + 1, 'src/big.ts': 60 * KB }), handlers: 10, debt });
  assert.equal(bad.failures.length, 1);
  assert.equal(bad.failures[0].kind, 'hotspot');
});

test('the handler count may only go down', () => {
  const debt = debtOf();
  const files = filesOf({ 'electron/main.ts': 90 * KB, 'src/big.ts': 60 * KB });
  assert.deepEqual(checkSizes({ files, handlers: 9, debt }).failures, []);
  const bad = checkSizes({ files, handlers: 11, debt });
  assert.deepEqual(bad.failures.map((f) => f.kind), ['handlers']);
});

test('a pinned big file may grow by the slack, not beyond; shrinking is reported', () => {
  const debt = debtOf();
  const at = (n) => checkSizes({ files: filesOf({ 'electron/main.ts': 90 * KB, 'src/big.ts': n }), handlers: 10, debt });
  assert.deepEqual(at(64 * KB).failures, []);
  assert.deepEqual(at(64 * KB + 1).failures.map((f) => f.kind), ['pinned']);
  assert.match(at(64 * KB + 1).failures[0].message, /先拆/);
  assert.deepEqual(at(50 * KB).shrunk.filter((s) => s.path === 'src/big.ts'), [{ path: 'src/big.ts', was: 60 * KB, now: 50 * KB }]);
});

test('a new file, or a small file that grows past the limit, fails; a merge that only adds small files passes', () => {
  const debt = debtOf();
  const base = { 'electron/main.ts': 90 * KB, 'src/big.ts': 60 * KB };
  assert.deepEqual(checkSizes({ files: filesOf({ ...base, 'electron/wiring/stage-wiring.ts': 40 * KB }), handlers: 10, debt }).failures, []);
  const bad = checkSizes({ files: filesOf({ ...base, 'electron/new.ts': 40 * KB + 1 }), handlers: 10, debt });
  assert.deepEqual(bad.failures.map((f) => [f.path, f.kind]), [['electron/new.ts', 'over-limit']]);
});

test('a pin whose file moved away is stale, not a failure; lowerPins drops it and lowers the shrunk ones', () => {
  const debt = debtOf();
  const files = filesOf({ 'electron/main.ts': 80 * KB });
  const result = checkSizes({ files, handlers: 8, debt });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.stale, ['src/big.ts']);
  lowerPins(debt, files, 8);
  assert.equal(debt.hotspots['electron/main.ts'].bytes, 80 * KB);
  assert.equal(debt.handlers.count, 8);
  assert.deepEqual(debt.pinned, {});
});

test('countHandlers counts host( and scopedHost( registrations at line start only', () => {
  assert.equal(countHandlers("  host('a', () => 1);\n  scopedHost('b', x => x);\nconst y = ghost('c');\n  // host(\n  foo.host(1)\n"), 2);
});

function fakeRepo(sizes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'size-check-'));
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const [p, content] of Object.entries(sizes)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), content); }
  fs.mkdirSync(path.join(dir, 'scripts/dev'), { recursive: true });
  return dir;
}

test('repin needs a reason and writes it; a later shrink lowers the pin on the next run (fake repo)', () => {
  const dir = fakeRepo({ 'electron/main.ts': "host('a');\n", 'electron/big.ts': 'x'.repeat(50 * KB) });
  const dataFile = path.join(dir, 'scripts/dev/size-debt.json');
  fs.writeFileSync(dataFile, JSON.stringify({ limit: 40 * KB, slack: 4 * KB, hotspots: {}, handlers: { file: 'electron/main.ts', count: 5 }, pinned: {} }));
  const quiet = (f) => { const log = console.log, err = console.error; console.log = () => {}; console.error = () => {}; try { return f(); } finally { console.log = log; console.error = err; } };
  const read = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  try {
    assert.equal(quiet(() => main(['--no-write'], dir)), 1, 'electron/big.ts is a new file over the limit');
    assert.equal(quiet(() => main(['--repin', 'electron/big.ts'], dir)), 2, 'no reason');
    assert.equal(quiet(() => main(['--repin', 'electron/big.ts', '--reason', 'one table, cannot split yet'], dir)), 0);
    assert.equal(read().pinned['electron/big.ts'].bytes, 50 * KB);
    assert.match(read().pinned['electron/big.ts'].reason, /one table, cannot split yet/);
    fs.writeFileSync(path.join(dir, 'electron/big.ts'), 'x'.repeat(45 * KB));
    assert.equal(quiet(() => main([], dir)), 0);
    assert.equal(read().pinned['electron/big.ts'].bytes, 45 * KB);
    assert.equal(read().handlers.count, 1, 'the handler count came down with it');
    fs.writeFileSync(path.join(dir, 'electron/big.ts'), 'x'.repeat(50 * KB));
    assert.equal(quiet(() => main([], dir)), 1, 'growing back past pin + slack fails');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
