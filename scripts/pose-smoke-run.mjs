// Runs scripts/pose-smoke.ts in a throw-away Electron profile (see that file). Never touches %APPDATA%\soft-hearts*.
//   node scripts/pose-smoke-run.mjs --bench <dir> --out <result.json>
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = mkdtempSync(path.join(tmpdir(), 'shp-smoke-run-'));
const entry = path.join(temp, 'pose-smoke.cjs');
await build({ entryPoints: ['scripts/pose-smoke.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: entry, external: ['electron'] });
const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const run = spawnSync(electron, [entry, `--user-data-dir=${path.join(temp, 'profile')}`, ...process.argv.slice(2), '--dist', path.resolve('dist-electron'), '--scratch', path.join(temp, 'scratch')],
  { stdio: 'inherit', env });
// Electron and its utility process are gone now, so nothing holds the component DLLs any more.
rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
if (run.error) console.error(run.error);
process.exit(run.status ?? 1);
