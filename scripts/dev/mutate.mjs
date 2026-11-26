#!/usr/bin/env node
// Mutation checks as a repository tool (overhaul 2026-11-16, plan section 8 item 3). "Break each gate, see a test fail", for one part
// with one command. The overhaul found about 180 privacy / memory / initiative / mood gates no test caught; the lists in
// scripts/dev/mutations/<part>.json keep those checks so a later Claude can run them again after code moves.
//
//   node scripts/dev/mutate.mjs --list [--part senses]          what is in the lists
//   node scripts/dev/mutate.mjs --check [--part senses]         fast: each `find` must match its file exactly once; no tests run
//   node scripts/dev/mutate.mjs --part senses [--id a,b]        run: for each mutation apply, run the tests, restore
//   node scripts/dev/mutate.mjs --all                           every part (slow: tens of minutes; under the heavy gate use ops.mjs mutate)
//   --timeout-seconds N   limit per test file (default 180)
//
// One mutation (a JSON object in the list, an array):
//   id, part, file, find (exact text, must occur once in the file), replace, what (Chinese: what it breaks),
//   tests (optional: test files expected to catch it, tried in this order; default: the part's tests in scripts/dev/test-parts.json)
//   knownGap (optional, a Chinese line): a gap found and written down on purpose; the mutation may SURVIVE (shown as KNOWN, does not fail
//   the run) and when a test starts catching it the run fails with FIXED until the field is removed.
// A mutation file written with LF is also tried with CRLF (electron/main.ts and src/main.ts have mixed line endings).
//
// Result per mutation: CAUGHT (a test failed), SURVIVED (all tests passed: a gap), STALE (find missing or ambiguous, file or test
// missing: refresh the list). A test file that runs past the time limit counts as CAUGHT but is marked "timeout" (a hang is a
// failure, but check by hand that it was the mutation and not a slow machine). Exit code 1 on SURVIVED or STALE.
// Safety: the original bytes go to .local/mutate/pending.json before each edit and back after it (also on an exception); if the
// process is killed in between, the next run restores them first. `git diff` is empty when it ends.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIST_DIR = 'scripts/dev/mutations';
const PENDING = '.local/mutate/pending.json';
const norm = (p) => p.replace(/\\/g, '/');

export function listFiles(root = ROOT) {
  const dir = path.join(root, LIST_DIR);
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => f.slice(0, -5)); } catch { return []; }
}

export function loadList(root, part) {
  const list = JSON.parse(fs.readFileSync(path.join(root, LIST_DIR, `${part}.json`), 'utf8'));
  if (!Array.isArray(list)) throw new Error(`${LIST_DIR}/${part}.json must be an array`);
  return list;
}

/** The part's tests from the test ownership table, in table order. */
export function ownedTests(root, part) {
  try {
    const table = JSON.parse(fs.readFileSync(path.join(root, 'scripts/dev/test-parts.json'), 'utf8'));
    return Object.entries(table).filter(([, v]) => v.owner === part).map(([k]) => k).sort();
  } catch { return []; }
}

/** Where `find` occurs in the text: { text, find, replace, count } trying LF first, then CRLF. */
export function locate(text, m) {
  const tries = [[m.find, m.replace]];
  if (/\n/.test(m.find) && !/\r\n/.test(m.find)) tries.push([m.find.replace(/\n/g, '\r\n'), m.replace.replace(/\r?\n/g, '\r\n')]);
  let best = { find: m.find, replace: m.replace, count: 0 };
  for (const [find, replace] of tries) {
    if (!find) continue;
    const count = text.split(find).length - 1;
    if (count === 1) return { find, replace, count };
    if (count > best.count) best = { find, replace, count };
  }
  return best;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };

/**
 * Put back the original bytes of a mutation that was interrupted. Returns { restored: path }, { active: pid } when another live
 * process is in the middle of a mutation (its file must not be touched), or null when nothing is pending.
 */
export function recoverPending(root) {
  const file = path.join(root, PENDING);
  let pending;
  try { pending = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (pending.pid && pending.pid !== process.pid && alive(pending.pid)) return { active: pending.pid };
  try { fs.writeFileSync(path.join(root, pending.file), Buffer.from(pending.base64, 'base64')); } finally { fs.rmSync(file, { force: true }); }
  return { restored: pending.file };
}

/**
 * Apply one mutation: remember the original bytes (pending file), write the mutated text.
 * Returns { ok: true, restore() } or { ok: false, reason } (STALE).
 */
export function applyMutation(root, m) {
  const abs = path.join(root, m.file);
  let original;
  try { original = fs.readFileSync(abs); } catch { return { ok: false, reason: `文件不存在：${m.file}` }; }
  const text = original.toString('utf8');
  const hit = locate(text, m);
  if (hit.count !== 1) return { ok: false, reason: hit.count === 0 ? `在 ${m.file} 里找不到 find 文字` : `find 文字在 ${m.file} 里出现了 ${hit.count} 次（要正好 1 次）` };
  if (hit.find === hit.replace) return { ok: false, reason: 'find 和 replace 一样，什么也没改' };
  const mutated = text.replace(hit.find, () => hit.replace);
  const pendingFile = path.join(root, PENDING);
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(pendingFile, JSON.stringify({ pid: process.pid, file: norm(m.file), base64: original.toString('base64') }));
  fs.writeFileSync(abs, mutated, 'utf8');
  return { ok: true, restore() { fs.writeFileSync(abs, original); fs.rmSync(pendingFile, { force: true }); } };
}

function runnerArgs(root, file) {
  const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs');
  return fs.existsSync(tsx) ? [tsx, '--test', file] : ['--test', file];
}

/** Run one test file with a time limit; resolves { status: 'pass'|'fail'|'timeout', seconds }. */
export function runTestFile(root, file, timeoutSeconds) {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; // when the runner itself runs inside a test, the child must not report to that parent
    const child = spawn(process.execPath, runnerArgs(root, file), { cwd: root, env, stdio: 'ignore', windowsHide: true });
    let done = false;
    const finish = (status) => { if (done) return; done = true; clearTimeout(timer); resolve({ status, seconds: Math.round((Date.now() - started) / 100) / 10 }); };
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      finish('timeout');
    }, timeoutSeconds * 1000);
    child.on('error', () => finish('fail'));
    child.on('exit', (code) => finish(code === 0 ? 'pass' : 'fail'));
  });
}

/** Tests for a mutation: its own list, else the part's owned tests. */
export function testsFor(root, m) {
  return Array.isArray(m.tests) && m.tests.length ? m.tests.map(norm) : ownedTests(root, m.part);
}

/** Fast check of one mutation without running tests: null when fine, else a reason. */
export function checkMutation(root, m) {
  for (const key of ['id', 'part', 'file', 'find', 'replace', 'what']) if (typeof m[key] !== 'string' || (key !== 'replace' && !m[key])) return `缺字段 ${key}`;
  let text;
  try { text = fs.readFileSync(path.join(root, m.file), 'utf8'); } catch { return `文件不存在：${m.file}`; }
  const hit = locate(text, m);
  if (hit.count === 0) return `在 ${m.file} 里找不到 find 文字`;
  if (hit.count > 1) return `find 文字在 ${m.file} 里出现了 ${hit.count} 次（要正好 1 次）`;
  if (hit.find === hit.replace) return 'find 和 replace 一样';
  const tests = testsFor(root, m);
  if (!tests.length) return `没有可跑的测试（列表里没写 tests，测试归属表里 ${m.part} 也没有）`;
  const missing = tests.filter((t) => !fs.existsSync(path.join(root, t)));
  if (missing.length) return `测试文件不存在：${missing.join('、')}`;
  return null;
}

/** Run one mutation: { status: 'CAUGHT'|'SURVIVED'|'STALE', by?, note?, reason?, seconds }. */
export async function runMutation(root, m, timeoutSeconds) {
  const stale = checkMutation(root, m);
  if (stale) return { status: 'STALE', reason: stale, seconds: 0 };
  const applied = applyMutation(root, m);
  if (!applied.ok) return { status: 'STALE', reason: applied.reason, seconds: 0 };
  const started = Date.now();
  try {
    for (const test of testsFor(root, m)) {
      const r = await runTestFile(root, test, timeoutSeconds);
      if (r.status !== 'pass') return { status: 'CAUGHT', by: test, note: r.status === 'timeout' ? 'timeout' : '', seconds: Math.round((Date.now() - started) / 100) / 10 };
    }
    return { status: 'SURVIVED', seconds: Math.round((Date.now() - started) / 100) / 10 };
  } finally {
    applied.restore();
  }
}

function parseArgs(argv) {
  const a = { part: null, ids: null, list: false, check: false, all: false, timeout: 180 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--part') a.part = argv[++i];
    else if (x === '--id') a.ids = argv[++i].split(',');
    else if (x === '--list') a.list = true;
    else if (x === '--check') a.check = true;
    else if (x === '--all') a.all = true;
    else if (x === '--timeout-seconds') a.timeout = Number(argv[++i]);
  }
  return a;
}

export async function main(argv, root = ROOT) {
  const args = parseArgs(argv);
  const pending = args.list ? null : recoverPending(root);
  if (pending?.active) { console.error(`另一个变异检查（pid ${pending.active}）正在改文件，等它跑完再用（--list 不受影响）`); return 3; }
  if (pending?.restored) console.log(`上次没跑完，已先把 ${pending.restored} 恢复成原样`);
  const parts = args.part ? args.part.split(',') : args.ids || args.check || args.list || args.all ? listFiles(root) : null;
  if (!parts) { console.error('用法：--list | --check | --part <部分> [--id a,b] | --all（见文件开头的说明）'); return 2; }
  const known = listFiles(root);
  for (const p of parts) if (!known.includes(p)) { console.error(`没有 ${LIST_DIR}/${p}.json（有：${known.join('、') || '无'}）`); return 2; }
  let mutations = parts.flatMap((p) => loadList(root, p));
  if (args.ids) {
    const have = new Set(mutations.map((m) => m.id));
    const unknown = args.ids.filter((id) => !have.has(id));
    if (unknown.length) { console.error(`找不到这些 id：${unknown.join('、')}`); return 2; }
    mutations = mutations.filter((m) => args.ids.includes(m.id));
  }
  const dupes = mutations.map((m) => m.id).filter((id, i, all) => all.indexOf(id) !== i);
  if (dupes.length) { console.error(`id 重复：${[...new Set(dupes)].join('、')}`); return 2; }
  if (args.list) {
    for (const p of parts) {
      const list = mutations.filter((m) => m.part === p);
      console.log(`${p}：${list.length} 个`);
      for (const m of list) console.log(`  ${m.id}  ${m.file}  ${m.what}`);
    }
    return 0;
  }
  const tally = { CAUGHT: 0, SURVIVED: 0, STALE: 0, KNOWN: 0 };
  const bad = [];
  for (const m of mutations) {
    if (args.check) {
      const reason = checkMutation(root, m);
      if (!reason) continue;
      tally.STALE++;
      bad.push(`STALE ${m.id}：${reason}`); console.log(`STALE    ${m.id}  ${reason}`);
      continue;
    }
    const r = await runMutation(root, m, args.timeout);
    // knownGap: a gap found and written down on purpose (no test notices it yet). Still survived: listed, does not fail the run.
    // Caught now: the list is out of date, remove the field (fails the run so it does not stay forever).
    if (m.knownGap && r.status === 'SURVIVED') r.status = 'KNOWN';
    else if (m.knownGap && r.status === 'CAUGHT') r.status = 'FIXED';
    tally[r.status] = (tally[r.status] ?? 0) + 1;
    const detail = r.status === 'CAUGHT' ? `${r.by}${r.note ? ` (${r.note})` : ''}` : r.status === 'STALE' ? r.reason : r.status === 'FIXED' ? `${r.by}：现在有测试抓住了，删掉清单里的 knownGap` : r.status === 'KNOWN' ? `已知缺口：${m.knownGap}` : m.what;
    console.log(`${r.status.padEnd(8)} ${m.id}  ${detail}  ${r.seconds}s`);
    if (r.status === 'FIXED') bad.push(`FIXED ${m.id}：删掉 knownGap`);
    else if (r.status !== 'CAUGHT' && r.status !== 'KNOWN') bad.push(`${r.status} ${m.id}：${r.status === 'STALE' ? r.reason : m.what}`);
  }
  if (args.check) console.log(`检查了 ${mutations.length} 个：${tally.STALE} 个对不上（find 要正好出现 1 次，测试文件要在）`);
  else console.log(`共 ${mutations.length} 个：被抓住 ${tally.CAUGHT}，已知缺口 ${tally.KNOWN}，没被抓住 ${tally.SURVIVED}，对不上 ${tally.STALE}${tally.FIXED ? `，已补上还挂着 knownGap ${tally.FIXED}` : ''}`);
  if (bad.length) { console.log('\n要处理的：'); for (const b of bad) console.log(`  ${b}`); }
  return bad.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
}
