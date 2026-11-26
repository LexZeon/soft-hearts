// Unbound U2 peek preview (docs/claude/2026-11-12-unbound-peek.md): builds the Unbound page, its preload and a preview host, then
// runs them in Electron with the bundled Gene in a small 960x600 window (the whole screen's view scaled), a temporary user-data
// folder, and a small stand-in companion window. She comes up to the lens a few times: screenshots at each beat, the frame rate in the
// close-up, the lens softness at three settings, and input cancelling it (a page mouse move; the host's idle reading dropping).
// The idle time is a stand-in the script sets (your real keyboard and mouse are never read); about two and a half minutes. Run:
//   node scripts/dev/heavy.mjs --label "unbound peek preview" -- node scripts/unbound/u2-peek-preview.mjs
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --full: the real screen-wide window (work area, native resolution, transparent, click-through) instead of 960x600; --physics: hair and chest physics on.
const full = process.argv.includes('--full'), withPhysics = process.argv.includes('--physics');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const local = path.join(root, '.local', 'unbound-u2');
const out = path.join(local, (full ? 'full-' : '') + (withPhysics ? 'phys-' : '') + new Date().toISOString().replace(/[:.]/g, '-'));
const buildDir = path.join(local, 'build');
mkdirSync(out, { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
await viteBuild({ configFile: false, root, base: './', logLevel: 'warn',
  build: { outDir: buildDir, emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 2000, rollupOptions: { input: { unbound: path.join(root, 'src/unbound/index.html') } } } });
await esbuild({ entryPoints: { 'unbound-preload': path.join(root, 'electron/unbound/preload.ts'), main: path.join(root, 'scripts/unbound/u2-peek-preview-main.ts') },
  outdir: buildDir, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
const gene = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03');
const userData = mkdtempSync(path.join(os.tmpdir(), 'unbound-u2-preview-'));
const planFile = path.join(userData, 'plan.json');
writeFileSync(planFile, JSON.stringify({ out, build: buildDir, gene: path.join(gene, 'model/gene.pmx'), stand: path.join(gene, 'motions/pose/stand.vmd'), userData, full, withPhysics }));
const electron = createRequire(import.meta.url)('electron');
console.log(`U2 peek preview → ${out}`);
const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', planFile], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached, stopping the preview.'); child.kill(); }, 330_000);
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer);
try { rmSync(userData, { recursive: true, force: true }); } catch { /* a temporary folder; the system cleans it later */ }
console.log(`done (exit ${code}). ${path.join(out, 'results.json')}`);
process.exit(code);
