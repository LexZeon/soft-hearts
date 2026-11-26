#!/usr/bin/env node
// Run only the tests a change can affect (docs/claude/2026-11-16-test-affected.md). The full suite (scripts/dev/test-all.mjs) stays
// the gate before builds and merges of big work; this is for small fixes.
//   node scripts/dev/test-affected.mjs                 changes of this branch vs its merge-base with main (plus the working tree)
//   node scripts/dev/test-affected.mjs --base <ref>    changes vs <ref> (working tree included)
//   node scripts/dev/test-affected.mjs --files a,b     exactly these changed files
//   node scripts/dev/test-affected.mjs --part <id>     tests that touch a part (ids in structure-parts.mjs); with a change input, the overlap
//   node scripts/dev/test-affected.mjs --owned <part>[,<part>]  tests owned by those parts (scripts/dev/test-parts.json); with a change input, the overlap
//   node scripts/dev/test-affected.mjs --list         only print the selection, run nothing
// How a test is chosen: it imports (transitively) a changed file, or a string literal in it names a changed source path (tests that
// slice electron/main.ts, read a file by path). Changes that can touch every test run everything.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildInventory, resolveImport } from './structure-inventory.mjs';
import { GROUP_IDS as PART_IDS, PARTS } from './structure-parts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TEST_FILE = /^tests\/[^/]+\.test\.(?:ts|mjs)$/;

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** A reason (Chinese) when this change can touch every test, else null. */
export function fullRunReason(changed) {
  for (const raw of changed) {
    const f = norm(raw);
    if (f === 'package.json' || f === 'pnpm-lock.yaml') return `${f} 变了（依赖或脚本）`;
    if (/^tsconfig[^/]*$/.test(f)) return `${f} 变了（编译设置）`;
    if (f === 'scripts/dev/test-all.mjs') return '测试入口 scripts/dev/test-all.mjs 变了';
    if (f.startsWith('tests/helpers/')) return `${f} 变了（共用测试工具）`;
    if (f.startsWith('tests/fixtures/')) return `${f} 变了（共用测试夹具）`;
  }
  return null;
}

const LITERAL_RE = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const JOIN_RE = /\b(?:join|resolve)\(([^()]*)\)/g;
const PATHISH = /^[\w@.\-/\\]+$/;

/** Path-like string literals in a test file's text, normalised (no leading ./ or ../, forward slashes, no trailing /). Literals with
 *  a "/" only; the pieces of path.join(root, 'electron', 'main.ts') are joined into 'electron/main.ts'. */
export function sourcePathLiterals(text) {
  const out = new Set();
  const clean = (s) => norm(s).replace(/^(?:\.\.\/)+/, '').replace(/^\.\//, '').replace(/\/+$/, '');
  const add = (s) => { const c = clean(s); if (c.includes('/') && PATHISH.test(c) && !c.startsWith('/') && !/^[A-Za-z]:/.test(c)) out.add(c); };
  for (const m of text.matchAll(LITERAL_RE)) { if (m[1] !== '`' || !m[2].includes('${')) add(m[2]); }
  for (const m of text.matchAll(JOIN_RE)) {
    const parts = [...m[1].matchAll(LITERAL_RE)].map((l) => l[2]);
    if (parts.length >= 2) add(parts.join('/'));
  }
  return [...out];
}

export const WIRING_SOURCE_HELPER = 'tests/helpers/wiring-source.ts';

/** Pure: tests that reach tests/helpers/wiring-source.ts by imports read the wiring through it, so they read electron/main.ts and every
 *  electron/wiring/*.ts file without naming them. Returns { test: [those files] } for such tests only. */
export function wiringReaders(graph, tests) {
  const wiring = ['electron/main.ts', ...Object.keys(graph).filter((f) => /^electron\/wiring\/[^/]+\.ts$/.test(f)).sort()];
  return readersThrough(graph, tests, WIRING_SOURCE_HELPER, wiring);
}

export const RENDERER_SOURCE_HELPER = 'tests/helpers/renderer-source.ts';

/** The same for the renderer (overhaul step 5): tests that reach tests/helpers/renderer-source.ts read src/main.ts and src/wiring/*.ts. */
export function rendererReaders(graph, tests) {
  const wiring = ['src/main.ts', ...Object.keys(graph).filter((f) => /^src\/wiring\/[^/]+\.ts$/.test(f)).sort()];
  return readersThrough(graph, tests, RENDERER_SOURCE_HELPER, wiring);
}

function readersThrough(graph, tests, helper, files) {
  const out = {};
  for (const test of tests) {
    const seen = new Set([test]);
    const queue = [test];
    let reads = false;
    while (queue.length && !reads) for (const to of graph[queue.pop()] ?? []) { if (to === helper) { reads = true; break; } if (!seen.has(to)) { seen.add(to); queue.push(to); } }
    if (reads) out[test] = files;
  }
  return out;
}

/** Does a literal name this repo-relative path, or a folder holding it? */
export function literalNames(literal, file) {
  return file === literal || file.endsWith(`/${literal}`) || file.startsWith(`${literal}/`) || file.includes(`/${literal}/`);
}

/** Does this test import a file of the part directly, or name one by a string literal? */
export function touchesPart(test, part, { graph, literals = {}, partOf }) {
  if ((graph[test] ?? []).some((t) => partOf(t) === part)) return true;
  const files = Object.keys(graph).filter((f) => partOf(f) === part);
  return (literals[test] ?? []).some((l) => files.some((f) => literalNames(l, f)));
}

/**
 * The pure selection. graph: {file: [imported files]} for every source, script and test file; literals: {test: [literals]};
 * tests: the test files that can run; changed: repo-relative changed paths; partOf: file -> part id (source files only).
 * Returns { full, reason, selected: Map(test -> [changed files that reach it]), unmatched: [changed files no test reaches] }.
 */
export function selectAffected({ graph, literals = {}, tests, changed, part = null, partOf = () => null }) {
  const files = [...new Set(changed.map(norm))];
  const reason = fullRunReason(files);
  const inPart = (test) => !part || touchesPart(test, part, { graph, literals, partOf });
  if (reason) {
    const all = tests.filter(inPart);
    return { full: true, reason, selected: new Map(all.map((t) => [t, ['*']])), unmatched: [] };
  }
  const reverse = new Map();
  for (const [from, tos] of Object.entries(graph)) for (const to of tos) { if (!reverse.has(to)) reverse.set(to, []); reverse.get(to).push(from); }
  const testSet = new Set(tests);
  const selected = new Map();
  const unmatched = [];
  const hit = (test, file) => { if (!selected.has(test)) selected.set(test, []); const list = selected.get(test); if (!list.includes(file)) list.push(file); };
  for (const file of files) {
    // everything that reaches the changed file by imports
    const reach = new Set([file]);
    const queue = [file];
    while (queue.length) { for (const up of reverse.get(queue.pop()) ?? []) if (!reach.has(up)) { reach.add(up); queue.push(up); } }
    const before = selected.size;
    let any = false;
    for (const t of reach) if (testSet.has(t)) { hit(t, file); any = true; }
    // tests whose string literals name the changed file or anything that reaches it (source slicing, readFile by path)
    for (const test of tests) {
      const lits = literals[test];
      if (!lits?.length) continue;
      if (lits.some((l) => [...reach].some((r) => literalNames(l, r)))) { hit(test, file); any = true; }
    }
    if (!any && selected.size === before) unmatched.push(file);
  }
  if (part) for (const t of [...selected.keys()]) if (!inPart(t)) selected.delete(t);
  return { full: false, reason: null, selected, unmatched };
}

/** Pure: the tests (sorted) whose owner is one of `owners`, from the test-parts.json map { test: { owner, parts } }. */
export function ownedTests(map, owners) {
  return Object.keys(map).filter((t) => owners.includes(map[t].owner)).sort();
}

function readTestParts() {
  const file = path.join(HERE, 'test-parts.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.error('没有 scripts/dev/test-parts.json，先生成：node scripts/dev/test-parts.mjs --write'); process.exit(2); }
}

// ---------------------------------------------------------------------------------------------------------------------------

function git(args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }

/** Changed files: vs `base` (default: the merge-base with main on a branch, else HEAD), working tree and untracked files included. */
export function changedFiles(base) {
  let ref = base;
  if (!ref) {
    let branch = '';
    try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { /* not a repo */ }
    ref = 'HEAD';
    if (branch && branch !== 'main' && branch !== 'HEAD') { try { ref = git(['merge-base', 'HEAD', 'main']); } catch { ref = 'HEAD'; } }
  }
  const names = new Set();
  for (const line of git(['diff', '--name-only', ref]).split('\n')) if (line.trim()) names.add(line.trim());
  for (const line of git(['ls-files', '--others', '--exclude-standard']).split('\n')) if (line.trim()) names.add(line.trim());
  return { files: [...names], ref };
}

function parseArgs(argv) {
  const o = { base: null, files: null, part: null, owned: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') o.list = true;
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--files') o.files = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--part') o.part = argv[++i];
    else if (a === '--owned') o.owned = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else { console.error(`不认识的参数 ${a}`); process.exit(2); }
  }
  if (o.part && !PART_IDS.includes(o.part)) { console.error(`没有这个部分 ${o.part}，可选：${PART_IDS.join(' ')}`); process.exit(2); }
  const bad = (o.owned ?? []).filter((id) => ![...PART_IDS, 'none'].includes(id));
  if (o.owned && (!o.owned.length || bad.length)) { console.error(`没有这个部分 ${bad.join(',') || '(空)'}，可选：${[...PART_IDS, 'none'].join(' ')}`); process.exit(2); }
  return o;
}

/** The graph test-affected needs, from the inventory: imports of every file, test literals, plus edges to files that no longer exist. */
export async function loadGraph(root = ROOT, extraPaths = []) {
  const fs = await import('node:fs');
  const inv = buildInventory(root);
  const graph = {};
  const literals = {};
  const tests = [];
  for (const rec of inv.records.values()) {
    graph[rec.path] = rec.imports.map((i) => i.to);
    if (TEST_FILE.test(rec.path)) {
      tests.push(rec.path);
      literals[rec.path] = sourcePathLiterals(fs.readFileSync(path.join(root, rec.path), 'utf8'));
    }
  }
  // a test that reads the wiring through tests/helpers/wiring-source.ts reads main.ts and every wiring file
  for (const [test, files] of Object.entries(wiringReaders(graph, tests))) literals[test] = [...new Set([...(literals[test] ?? []), ...files])];
  // ... and one that reads the renderer through tests/helpers/renderer-source.ts reads src/main.ts and every src/wiring file
  for (const [test, files] of Object.entries(rendererReaders(graph, tests))) literals[test] = [...new Set([...(literals[test] ?? []), ...files])];
  // imports that resolve only to a deleted or renamed changed file still count as edges to it
  const gone = extraPaths.map(norm).filter((p) => !inv.records.has(p));
  if (gone.length) {
    const fileSet = new Set([...inv.records.keys(), ...gone]);
    for (const u of inv.unresolved) { const to = resolveImport(u.from, u.spec, fileSet); if (to && gone.includes(to)) graph[u.from].push(to); }
  }
  const partOf = (f) => inv.records.get(f)?.part ?? null;
  return { graph, literals, tests: tests.sort(), partOf, total: tests.length };
}

function summary(sel, total, changed, opts) {
  const n = sel.selected.size;
  const lines = [];
  if (sel.full) lines.push(`要跑全部：${sel.reason}，选了 ${n} / ${total} 个测试文件。`);
  else if (!changed.length && opts.part) lines.push(`部分 ${opts.part}（${PARTS[opts.part].name}）：选了 ${n} / ${total} 个测试文件，它们直接引用这个部分的文件。`);
  else {
    lines.push(`选了 ${n} / ${total} 个测试文件${opts.part ? `（部分 ${opts.part}：${PARTS[opts.part].name}）` : ''}，因为 ${changed.length} 个改动文件：`);
    const byChange = new Map();
    for (const [, why] of sel.selected) for (const f of why) byChange.set(f, (byChange.get(f) ?? 0) + 1);
    for (const f of changed) if (byChange.has(f)) lines.push(`  ${f} -> ${byChange.get(f)} 个测试`);
    if (sel.unmatched.length) lines.push(`没有测试碰到：${sel.unmatched.join('、')}（文档、素材或没人引用的文件；类型检查另跑）`);
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let changed = [];
  let basis = '';
  const ownerOnly = opts.owned && !opts.part && !opts.files && !opts.base;
  if (opts.files) { changed = opts.files.map(norm); basis = '指定的文件'; }
  else if (ownerOnly) { /* no change input: every test the parts own */ }
  else if (!opts.part || opts.base) { const c = changedFiles(opts.base); changed = c.files.map(norm); basis = `相对 ${c.ref.slice(0, 8)}`; }
  const g = await loadGraph(ROOT, changed);
  let sel;
  if (ownerOnly) {
    const owned = ownedTests(readTestParts(), opts.owned).filter((t) => g.tests.includes(t));
    sel = { full: false, reason: null, selected: new Map(owned.map((t) => [t, [`归 ${opts.owned.join('、')}`]])), unmatched: [] };
  } else if (opts.part && !opts.files && !opts.base) {
    sel = { full: false, reason: null, selected: new Map(g.tests.filter((t) => touchesPart(t, opts.part, g)).map((t) => [t, [`部分 ${opts.part}`]])), unmatched: [] };
  } else {
    if (!changed.length) { console.log(`没有改动（${basis}），不用跑测试。`); return; }
    sel = selectAffected({ graph: g.graph, literals: g.literals, tests: g.tests, changed, part: opts.part, partOf: g.partOf });
  }
  if (opts.owned && !ownerOnly) {
    const keep = new Set(ownedTests(readTestParts(), opts.owned));
    for (const t of [...sel.selected.keys()]) if (!keep.has(t)) sel.selected.delete(t);
    sel.full = false;
  }
  const files = [...sel.selected.keys()].sort();
  console.log(ownerOnly ? `归 ${opts.owned.join('、')} 的测试：选了 ${files.length} / ${g.total} 个测试文件。` : summary(sel, g.total, changed, opts));
  if (opts.list) { for (const f of files) console.log(`  ${f}`); return; }
  if (!files.length) { console.log('没有要跑的测试。'); return; }
  // the same runner and gate as the full suite: test-all with an explicit list (or none, which means everything)
  const args = [path.join(HERE, 'test-all.mjs'), ...(sel.full && !opts.part ? [] : files)];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => {
    const ok = (code ?? (signal ? 1 : 0)) === 0;
    console.log(ok ? `通过：${files.length} 个测试文件。小改动够了；合并大活、打包前仍跑全量 test-all。` : `失败：${files.length} 个测试文件里有没过的（退出码 ${code ?? signal}）。`);
    process.exit(ok ? 0 : 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
