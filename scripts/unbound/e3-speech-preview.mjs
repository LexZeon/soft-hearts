// Unbound night experiment E3 preview (docs/claude/2026-11-14-unbound-night-e3-speech.md): builds the Unbound page, its preload
// and a preview host, then runs them in Electron with the bundled Gene in a small 960x600 window, a temporary user-data folder and
// a small stand-in companion window. She looks to her side; a reply streams in (a stand-in text the script sends, no model, no chat).
// Two runs, the opening beat off and on, screenshots at the same moments after the reply's first words. About a minute. Run:
//   node scripts/dev/heavy.mjs --label "unbound e3 speech preview" -- node scripts/unbound/e3-speech-preview.mjs
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const local = path.join(root, '.local', 'unbound-night', 'e3-speech');
const out = path.join(local, new Date().toISOString().replace(/[:.]/g, '-'));
const buildDir = path.join(local, 'build');
mkdirSync(out, { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
await viteBuild({ configFile: false, root, base: './', logLevel: 'warn',
  build: { outDir: buildDir, emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 2000, rollupOptions: { input: { unbound: path.join(root, 'src/unbound/index.html') } } } });
await esbuild({ entryPoints: { 'unbound-preload': path.join(root, 'electron/unbound/preload.ts'), main: path.join(root, 'scripts/unbound/e3-speech-preview-main.ts') },
  outdir: buildDir, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
const gene = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03');
const userData = mkdtempSync(path.join(os.tmpdir(), 'unbound-e3-preview-'));
const planFile = path.join(userData, 'plan.json');
writeFileSync(planFile, JSON.stringify({ out, build: buildDir, gene: path.join(gene, 'model/gene.pmx'), stand: path.join(gene, 'motions/pose/stand.vmd'), userData }));
const electron = createRequire(import.meta.url)('electron');
console.log(`E3 speech preview → ${out}`);
const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', planFile], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached, stopping the preview.'); child.kill(); }, 180_000);
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer);
try { rmSync(userData, { recursive: true, force: true }); } catch { /* a temporary folder; the system cleans it later */ }
console.log(`done (exit ${code}). ${path.join(out, 'results.json')}`);
process.exit(code);
