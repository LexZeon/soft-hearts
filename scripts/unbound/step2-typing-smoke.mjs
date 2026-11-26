// Unbound v1 step 2 smoke (docs/claude/2026-11-15-unbound-v1-step2-typing.md): builds the Unbound page, the small input box's page, both
// preloads and a smoke host, then runs them in Electron with the bundled Gene in a small 960x600 window and a temporary user-data folder
// (no real profile, no model call, no global shortcut). About a minute. Run:
//   node scripts/dev/heavy.mjs --label "unbound step2 smoke" -- node scripts/unbound/step2-typing-smoke.mjs
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const local = path.join(root, '.local', 'unbound-step2', 'typing-smoke');
const out = path.join(local, new Date().toISOString().replace(/[:.]/g, '-'));
// The build goes to the system temp folder, not into the OneDrive-synced repository: a file OneDrive is still uploading can be locked
// when the page is read, and the small box's page then fails to load (ERR_FAILED), which cost three smoke runs.
const buildDir = mkdtempSync(path.join(os.tmpdir(), 'unbound-step2-build-'));
mkdirSync(out, { recursive: true });
await viteBuild({ configFile: false, root, base: './', logLevel: 'warn',
  build: { outDir: buildDir, emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { unbound: path.join(root, 'src/unbound/index.html'), unboundInput: path.join(root, 'src/unbound/input.html') } } } });
await esbuild({ entryPoints: { 'unbound-preload': path.join(root, 'electron/unbound/preload.ts'), 'unbound-input-preload': path.join(root, 'electron/unbound/input-preload.ts'), main: path.join(root, 'scripts/unbound/step2-typing-smoke-main.ts') },
  outdir: buildDir, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
const gene = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03');
const userData = mkdtempSync(path.join(os.tmpdir(), 'unbound-step2-smoke-'));
const planFile = path.join(userData, 'plan.json');
writeFileSync(planFile, JSON.stringify({ out, build: buildDir, gene: path.join(gene, 'model/gene.pmx'), stand: path.join(gene, 'motions/pose/stand.vmd'), userData }));
const electron = createRequire(import.meta.url)('electron');
console.log(`step 2 typing smoke → ${out}`);
const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', planFile], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached, stopping the smoke.'); child.kill(); }, 240_000);
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer);
try { rmSync(userData, { recursive: true, force: true }); rmSync(buildDir, { recursive: true, force: true }); } catch { /* a temporary folder; the system cleans it later */ }
console.log(`done (exit ${code}). ${path.join(out, 'results.json')}`);
process.exit(code);
