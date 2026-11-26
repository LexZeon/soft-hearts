// The mutation runner (scripts/dev/mutate.mjs) on a throw-away fake repo: caught, survived, stale, restore after a failing test and
// after a simulated crash, CRLF files, and that the checked-in lists are well-formed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMutation, checkMutation, listFiles, loadList, locate, main, ownedTests, recoverPending, runMutation } from '../scripts/dev/mutate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = "export const gate = (on) => {\n  if (!on) return 'closed';\n  return 'open';\n};\nexport const twin = 1;\nexport const twin2 = 1;\n";

function fakeRepo({ crlf = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-'));
  const put = (p, content) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), content); };
  put('src/gate.mjs', crlf ? SRC.replace(/\n/g, '\r\n') : SRC);
  put('tests/gate.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { gate } from '../src/gate.mjs';\ntest('closed when off', () => assert.equal(gate(false), 'closed'));\n");
  put('tests/loose.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { gate } from '../src/gate.mjs';\ntest('open when on', () => assert.equal(gate(true), 'open'));\n");
  put('tests/other.test.mjs', "import { test } from 'node:test';\ntest('unrelated', () => {});\n");
  put('scripts/dev/test-parts.json', JSON.stringify({ 'tests/gate.test.mjs': { owner: 'demo', parts: ['demo'] }, 'tests/loose.test.mjs': { owner: 'demo', parts: ['demo'] }, 'tests/other.test.mjs': { owner: 'none', parts: [] } }));
  return { dir, put, srcBytes: () => fs.readFileSync(path.join(dir, 'src/gate.mjs')) };
}
const mutation = (extra = {}) => ({ id: 'm1', part: 'demo', file: 'src/gate.mjs', find: "if (!on) return 'closed';", replace: "if (false) return 'closed';", what: '关着时也开', tests: ['tests/gate.test.mjs'], ...extra });
const quiet = async (f) => { const log = console.log, err = console.error; console.log = () => {}; console.error = () => {}; try { return await f(); } finally { console.log = log; console.error = err; } };

test('a mutation the test catches is CAUGHT, the file is back to the same bytes, and the pending note is gone', async () => {
  const r = fakeRepo();
  const before = r.srcBytes();
  const result = await runMutation(r.dir, mutation(), 60);
  assert.equal(result.status, 'CAUGHT');
  assert.equal(result.by, 'tests/gate.test.mjs');
  assert.ok(before.equals(r.srcBytes()));
  assert.ok(!fs.existsSync(path.join(r.dir, '.local/mutate/pending.json')));
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('a mutation no test notices is SURVIVED; later tests in the list are tried in order', async () => {
  const r = fakeRepo();
  const m = mutation({ tests: ['tests/loose.test.mjs', 'tests/other.test.mjs'] });
  assert.equal((await runMutation(r.dir, m, 60)).status, 'SURVIVED');
  const both = mutation({ tests: ['tests/loose.test.mjs', 'tests/gate.test.mjs'] });
  assert.equal((await runMutation(r.dir, both, 60)).by, 'tests/gate.test.mjs');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('without tests in the entry the part is run with its owned tests from test-parts.json', async () => {
  const r = fakeRepo();
  assert.deepEqual(ownedTests(r.dir, 'demo'), ['tests/gate.test.mjs', 'tests/loose.test.mjs']);
  const { tests, ...m } = mutation();
  assert.equal((await runMutation(r.dir, m, 60)).status, 'CAUGHT');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('STALE: find missing, find ambiguous, file missing, test file missing, find equal to replace', async () => {
  const r = fakeRepo();
  const cases = [
    mutation({ find: 'no such text' }),
    mutation({ find: 'export const twin', replace: 'export const twinX' }),
    mutation({ file: 'src/none.mjs' }),
    mutation({ tests: ['tests/none.test.mjs'] }),
    mutation({ replace: "if (!on) return 'closed';" }),
  ];
  for (const m of cases) {
    const result = await runMutation(r.dir, m, 60);
    assert.equal(result.status, 'STALE', JSON.stringify(m));
    assert.ok(result.reason);
  }
  assert.ok(r.srcBytes().equals(Buffer.from(SRC)));
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('a CRLF file is found with an LF find, and restored byte for byte', async () => {
  const r = fakeRepo({ crlf: true });
  const before = r.srcBytes();
  const m = mutation({ find: "  if (!on) return 'closed';\n  return 'open';", replace: "  return 'open';" });
  assert.equal(locate(before.toString('utf8'), m).count, 1);
  assert.equal((await runMutation(r.dir, m, 60)).status, 'CAUGHT');
  assert.ok(before.equals(r.srcBytes()));
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('a test that runs past the time limit counts as CAUGHT with a timeout note, and the file is still restored', async () => {
  const r = fakeRepo();
  r.put('tests/hang.test.mjs', "import { test } from 'node:test';\ntest('hang', async () => { await new Promise(() => setInterval(() => {}, 1000)); });\n");
  const before = r.srcBytes();
  const result = await runMutation(r.dir, mutation({ tests: ['tests/hang.test.mjs'] }), 2);
  assert.equal(result.status, 'CAUGHT');
  assert.equal(result.note, 'timeout');
  assert.ok(before.equals(r.srcBytes()));
  fs.rmSync(r.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 } /* the killed hung test may still hold its folder for a moment on Windows */);
});

test('a crash between the edit and the restore is undone on the next run', async () => {
  const r = fakeRepo();
  const before = r.srcBytes();
  const applied = applyMutation(r.dir, mutation());
  assert.ok(applied.ok);
  assert.ok(!before.equals(r.srcBytes()), 'the file is mutated now (simulated crash: restore() never runs)');
  fs.mkdirSync(path.join(r.dir, 'scripts/dev/mutations'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'scripts/dev/mutations/demo.json'), JSON.stringify([mutation()]));
  assert.equal(await quiet(() => main(['--check'], r.dir)), 0);
  assert.ok(before.equals(r.srcBytes()), 'restored before anything else ran');
  assert.equal(recoverPending(r.dir), null);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('a mutation in progress in another live process is left alone: a second run refuses instead of restoring under it', async () => {
  const r = fakeRepo();
  const original = r.srcBytes();
  const applied = applyMutation(r.dir, mutation());
  const pendingPath = path.join(r.dir, '.local/mutate/pending.json');
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  fs.writeFileSync(pendingPath, JSON.stringify({ ...pending, pid: process.ppid })); // a live process that is not us
  fs.mkdirSync(path.join(r.dir, 'scripts/dev/mutations'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'scripts/dev/mutations/demo.json'), JSON.stringify([mutation()]));
  const mutated = r.srcBytes();
  assert.equal(await quiet(() => main(['--check'], r.dir)), 3);
  assert.ok(mutated.equals(r.srcBytes()), 'not touched');
  assert.equal(await quiet(() => main(['--list'], r.dir)), 0, '--list does not need the files');
  fs.writeFileSync(pendingPath, JSON.stringify({ ...pending, pid: 2 ** 22 + 12345 })); // a pid nobody has: the run died
  assert.equal(await quiet(() => main(['--check'], r.dir)), 0);
  assert.ok(original.equals(r.srcBytes()), 'restored once its owner is gone');
  assert.ok(applied.ok);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('main: exit 0 when everything is caught, 1 on SURVIVED, 1 on STALE; --check runs no tests; --list prints the entries', async () => {
  const r = fakeRepo();
  fs.mkdirSync(path.join(r.dir, 'scripts/dev/mutations'), { recursive: true });
  const write = (list) => fs.writeFileSync(path.join(r.dir, 'scripts/dev/mutations/demo.json'), JSON.stringify(list));
  write([mutation()]);
  assert.deepEqual(listFiles(r.dir), ['demo']);
  assert.equal(loadList(r.dir, 'demo').length, 1);
  assert.equal(await quiet(() => main(['--part', 'demo', '--timeout-seconds', '60'], r.dir)), 0);
  write([mutation(), mutation({ id: 'm2', tests: ['tests/loose.test.mjs'] })]);
  assert.equal(await quiet(() => main(['--part', 'demo', '--timeout-seconds', '60'], r.dir)), 1, 'm2 survives');
  assert.equal(await quiet(() => main(['--part', 'demo', '--id', 'm1', '--timeout-seconds', '60'], r.dir)), 0, 'only m1');
  write([mutation({ find: 'gone' })]);
  assert.equal(await quiet(() => main(['--check'], r.dir)), 1);
  assert.equal(await quiet(() => main(['--part', 'demo'], r.dir)), 1, 'stale');
  assert.equal(await quiet(() => main(['--list'], r.dir)), 0);
  assert.equal(checkMutation(r.dir, mutation()), null);
  assert.equal(await quiet(() => main(['--part', 'nope'], r.dir)), 2);
  assert.ok(r.srcBytes().equals(Buffer.from(SRC)), 'nothing left changed');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('knownGap: a survivor that is written down does not fail the run; once a test catches it the run fails until the field is removed', async () => {
  const r = fakeRepo();
  fs.mkdirSync(path.join(r.dir, 'scripts/dev/mutations'), { recursive: true });
  const write = (list) => fs.writeFileSync(path.join(r.dir, 'scripts/dev/mutations/demo.json'), JSON.stringify(list));
  write([mutation({ id: 'gap', tests: ['tests/loose.test.mjs'], knownGap: '没有测试看这一行' })]);
  assert.equal(await quiet(() => main(['--part', 'demo', '--timeout-seconds', '60'], r.dir)), 0, 'known gap, survived: fine');
  write([mutation({ id: 'gap', knownGap: '没有测试看这一行' })]);
  assert.equal(await quiet(() => main(['--part', 'demo', '--timeout-seconds', '60'], r.dir)), 1, 'caught now: remove knownGap');
  assert.ok(r.srcBytes().equals(Buffer.from(SRC)));
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('the checked-in lists are arrays of well-formed, uniquely named mutations for their own part', () => {
  const seen = new Set();
  for (const part of listFiles(REPO)) {
    const list = loadList(REPO, part);
    for (const m of list) {
      assert.equal(m.part, part, `${part}/${m.id}: part field`);
      for (const key of ['id', 'file', 'find', 'what']) assert.ok(typeof m[key] === 'string' && m[key], `${part}/${m.id}: ${key}`);
      assert.equal(typeof m.replace, 'string', `${part}/${m.id}: replace`);
      assert.ok(!seen.has(m.id), `duplicate id ${m.id}`);
      seen.add(m.id);
    }
  }
});

// 2026-11-17: an edit that rewrote a guarded line left S-U3-wake-name pointing at text that no longer existed, and nothing failed until
// `mutate.mjs --check` was run by hand after the merge. This is that check (no mutation is run, so it is fast): every checked-in entry
// still finds its text exactly once, its file and test files exist. When it fails, point the entry at the new line (or remove it with
// the guard), never just delete it.
// The public snapshot (scripts/release/export-public.mjs) leaves out tests and tools this list names; the lists are the maintainer's, so the checks run in the development repository only.
const IN_SNAPSHOT = !fs.existsSync(path.join(REPO, 'scripts', 'pretrial'));
test('the checked-in lists still match the code (mutate.mjs --check on this repository)', { skip: IN_SNAPSHOT }, () => {
  const stale = [];
  for (const part of listFiles(REPO)) for (const m of loadList(REPO, part)) {
    const problem = checkMutation(REPO, m);
    if (problem) stale.push(`${part}/${m.id}: ${problem}`);
  }
  assert.deepEqual(stale, []);
});
