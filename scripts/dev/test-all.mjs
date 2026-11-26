// I-030: the full test suite under the "我在用电脑" cap. Use this instead of calling tsx --test on everything directly:
//   node scripts/dev/test-all.mjs            (all of tests/*.test.ts and tests/*.test.mjs)
//   node scripts/dev/test-all.mjs <files...> (just these)
//   node scripts/dev/test-all.mjs --by-part  (same run; afterwards the time per owning part and the 20 slowest files)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gateHeavy } from './presence.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const args = process.argv.slice(2);
const byPart = args.includes('--by-part');
const files = args.filter((a) => a !== '--by-part');
const timingFile = byPart ? path.join(os.tmpdir(), `soft-hearts-test-timing-${process.pid}.json`) : null;
const reporters = byPart
  ? ['--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${pathToFileURL(path.join(import.meta.dirname, 'test-timing-reporter.mjs')).href}`, '--test-reporter-destination=stdout']
  : [];
const release = await gateHeavy(files.length ? `tests: ${files.length} files` : 'full test suite');
// 2026-11-20: every test process gets a 4 GB V8 heap cap (inherited NODE_OPTIONS) so a runaway heap fails with "heap out of memory".
// NOT enough alone: the failing deepEqual over three.js meshes grew a process to 46 GB WITH this cap (memory outside the V8 heap);
// the guard for that is tests/test-hygiene.test.ts (no mesh graph in an equality assert).
const heapCap = '--max-old-space-size=4096';
const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, heapCap].filter(Boolean).join(' '), ...(byPart ? { SH_TEST_TIMING_FILE: timingFile } : {}) };
const child = spawn(process.execPath, [tsx, '--test', ...reporters, ...(files.length ? files : ['tests/*.test.ts', 'tests/*.test.mjs'])],
  { cwd: root, stdio: 'inherit', env });

async function printByPart() {
  try {
    const timings = JSON.parse(fs.readFileSync(timingFile, 'utf8'));
    const { JSON_PATH, timingReport } = await import('./test-parts.mjs');
    const map = fs.existsSync(JSON_PATH) ? JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')) : {};
    const { owners, slowest } = timingReport(timings, map);
    const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
    console.log('\n按部分的耗时（各测试文件顶层测试时间之和，不含进程启动；并行跑，加起来大于墙钟时间）：');
    for (const o of owners) console.log(`  ${o.owner.padEnd(11)}${String(o.files).padStart(4)} 个文件  ${s(o.ms).padStart(8)}`);
    console.log('\n最慢的 20 个测试文件：');
    for (const f of slowest) console.log(`  ${s(f.ms).padStart(8)}  ${f.owner.padEnd(11)}${f.file}`);
  } catch (error) {
    console.log(`\n--by-part：没读到耗时（${error instanceof Error ? error.message : error}）`);
  } finally {
    try { fs.rmSync(timingFile, { force: true }); } catch { /* ignore */ }
  }
}

child.on('exit', async (code, signal) => {
  release();
  if (byPart) await printByPart();
  process.exit(code ?? (signal ? 1 : 0));
});
