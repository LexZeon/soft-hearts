#!/usr/bin/env node
// Which program part owns each test file (docs/claude/2026-11-16-tests-by-part.md). Tests stay in the flat tests/ folder; this
// writes scripts/dev/test-parts.json, a sorted map  test -> { owner, parts }, from the import graph test-affected already builds.
//   node scripts/dev/test-parts.mjs            print the summary (tests per part, tests touching more than 3 parts)
//   node scripts/dev/test-parts.mjs --write    regenerate scripts/dev/test-parts.json
//   node scripts/dev/test-parts.mjs --check    exit 1 when the json is out of date
// "touches": the test imports a source file of the part directly, or a string literal in it names one (the same rule as
// test-affected --part, so tests that read electron/main.ts as text count as touching it).
// "owner": the part among the 12 real parts that most of those touched files belong to (ties: the order of PART_IDS). A test that
// touches no real part is owned by 'foundation' or 'wiring' when it touches those, else by 'none'.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GROUP_IDS, PART_IDS } from './structure-parts.mjs';
import { literalNames, loadGraph } from './test-affected.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
export const JSON_PATH = path.join(HERE, 'test-parts.json');
export const OWNER_IDS = [...GROUP_IDS, 'none'];
export const REGENERATE = 'node scripts/dev/test-parts.mjs --write';

/** The source files a test touches: direct imports plus files named by its path literals. */
export function touchedFiles(test, { graph, literals = {}, partOf }) {
  const files = new Set((graph[test] ?? []).filter((f) => partOf(f)));
  const lits = literals[test] ?? [];
  if (lits.length) for (const f of Object.keys(graph)) if (partOf(f) && !files.has(f) && lits.some((l) => literalNames(l, f))) files.add(f);
  return files;
}

/** Pure: { test: { owner, parts: [group ids in GROUP_IDS order] } } with keys sorted. */
export function computeTestParts({ graph, literals = {}, tests, partOf }) {
  const out = {};
  for (const test of [...tests].sort()) {
    const tally = new Map();
    for (const f of touchedFiles(test, { graph, literals, partOf })) tally.set(partOf(f), (tally.get(partOf(f)) ?? 0) + 1);
    const best = (ids) => ids.filter((id) => tally.has(id)).sort((a, b) => tally.get(b) - tally.get(a) || ids.indexOf(a) - ids.indexOf(b))[0];
    const owner = best(PART_IDS) ?? best(['foundation', 'wiring']) ?? 'none';
    out[test] = { owner, parts: GROUP_IDS.filter((id) => tally.has(id)) };
  }
  return out;
}

/** Tests per owner and how many touch more than `limit` real parts. */
export function summarize(map, { limit = 3 } = {}) {
  const perOwner = Object.fromEntries(OWNER_IDS.map((id) => [id, 0]));
  let wide = 0;
  for (const { owner, parts } of Object.values(map)) {
    perOwner[owner] = (perOwner[owner] ?? 0) + 1;
    if (parts.filter((p) => PART_IDS.includes(p)).length > limit) wide++;
  }
  return { total: Object.keys(map).length, perOwner, wide, limit };
}

export function serialize(map) { return `${JSON.stringify(map, null, 1)}\n`; }

export async function buildTestParts(root = ROOT) {
  const g = await loadGraph(root);
  return { map: computeTestParts(g), g };
}

/** Tests whose path literals name this source file (e.g. electron/main.ts read as text). */
export function readersOf(file, { literals }) {
  return Object.keys(literals).filter((t) => literals[t].some((l) => literalNames(l, file)));
}

/** Pure: per-owner time and the slowest files. timings: { file: ms }. */
export function timingReport(timings, map, { top = 20 } = {}) {
  const byOwner = new Map();
  for (const [file, ms] of Object.entries(timings)) {
    const owner = map[file]?.owner ?? 'none';
    const e = byOwner.get(owner) ?? { owner, ms: 0, files: 0 };
    e.ms += ms; e.files++; byOwner.set(owner, e);
  }
  return {
    owners: [...byOwner.values()].sort((a, b) => b.ms - a.ms),
    slowest: Object.entries(timings).sort((a, b) => b[1] - a[1]).slice(0, top).map(([file, ms]) => ({ file, ms, owner: map[file]?.owner ?? 'none' })),
  };
}

async function main() {
  const flag = process.argv[2];
  const { map, g } = await buildTestParts();
  const text = serialize(map);
  if (flag === '--write') { fs.writeFileSync(JSON_PATH, text); console.log(`写好了 ${path.relative(ROOT, JSON_PATH)}（${Object.keys(map).length} 个测试文件）`); return; }
  if (flag === '--check') {
    const have = fs.existsSync(JSON_PATH) ? fs.readFileSync(JSON_PATH, 'utf8') : '';
    if (have !== text) { console.error(`test-parts.json 过期了，重新生成：${REGENERATE}`); process.exit(1); }
    console.log('test-parts.json 是最新的。'); return;
  }
  const s = summarize(map);
  console.log(`测试文件 ${s.total} 个。按部分：`);
  for (const id of OWNER_IDS) if (s.perOwner[id]) console.log(`  ${id.padEnd(11)}${s.perOwner[id]}`);
  console.log(`碰到超过 ${s.limit} 个部分的：${s.wide} 个`);
  console.log(`把 electron/main.ts 当文本读的：${readersOf('electron/main.ts', g).length} 个`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
