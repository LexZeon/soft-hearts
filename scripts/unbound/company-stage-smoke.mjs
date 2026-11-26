// I-209 step 3 smoke (docs/claude/2026-11-24-i209-step3-instances.md): three characters on the stage, each her own Unbound window, host and
// page (scripts/unbound/company-stage-smoke-main.ts runs under Electron). The bundled Gene only (three cards that all use her model), a
// temporary user-data folder (no app profile, no settings, no model calls), small preview windows (960x600, 'fit') instead of full screen.
// It records each page's frame numbers and the stage's view, and screenshots the full-screen box's panel (谁在场 and the senses rows) with
// three on stage, and each window's own picture (Gene only). Run under the heavy gate:
//   node scripts/dev/heavy.mjs --label company-smoke -- node scripts/unbound/company-stage-smoke.mjs --out <folder>
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.resolve(arg('out', path.join(root, '.local', 'unbound-company', new Date().toISOString().replace(/[:.]/g, '-'))));
// The build goes to the system temp folder (a file OneDrive is still uploading can be locked when a page is read).
const buildDir = mkdtempSync(path.join(os.tmpdir(), 'unbound-company-build-'));
mkdirSync(out, { recursive: true });
await viteBuild({ configFile: false, root, base: './', logLevel: 'warn',
  build: { outDir: buildDir, emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { unbound: path.join(root, 'src/unbound/index.html'), unboundInput: path.join(root, 'src/unbound/input.html') } } } });
await esbuild({ entryPoints: { 'unbound-preload': path.join(root, 'electron/unbound/preload.ts'), 'unbound-input-preload': path.join(root, 'electron/unbound/input-preload.ts'), main: path.join(root, 'scripts/unbound/company-stage-smoke-main.ts') },
  outdir: buildDir, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
const gene = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03');
const userData = mkdtempSync(path.join(os.tmpdir(), 'unbound-company-smoke-'));
const planFile = path.join(userData, 'plan.json');
writeFileSync(planFile, JSON.stringify({ out, build: buildDir, gene: path.join(gene, 'model/gene.pmx'), stand: path.join(gene, 'motions/pose/stand.vmd'), userData }));
const electron = createRequire(import.meta.url)('electron');
console.log(`I-209 step 3 smoke → ${out}`);
const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', planFile], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached, stopping the smoke.'); child.kill(); }, 300_000);
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer);
try { rmSync(userData, { recursive: true, force: true }); rmSync(buildDir, { recursive: true, force: true }); } catch { /* temporary folders */ }
console.log(`done (exit ${code}). ${path.join(out, 'results.json')}`);
process.exit(code);
