// Unbound U4 preview (docs/claude/2026-11-14-unbound-night-e4-surfaces.md): builds the preview page (her body + SYNTHETIC windows)
// and runs it in a small Electron window with the bundled Gene, a temporary user-data folder and no real window ever read. Window
// screenshots (capturePage) and results.json go to .local/unbound-u4/<time>/. Run under the heavy gate:
//   node scripts/dev/heavy.mjs --label "unbound u4 surfaces" -- node scripts/unbound/u4-surfaces-preview.mjs
import { build as esbuild } from 'esbuild';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const local = path.join(root, '.local', 'unbound-u4');
const out = path.join(local, new Date().toISOString().replace(/[:.]/g, '-'));
const buildDir = path.join(local, 'build');
mkdirSync(out, { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
await esbuild({ entryPoints: { 'u4-page': path.join(root, 'scripts/unbound/u4-surfaces-page.ts') }, outdir: buildDir, bundle: true, platform: 'browser', target: 'chrome130', format: 'iife', logLevel: 'error' });
await esbuild({ entryPoints: { main: path.join(root, 'scripts/unbound/u4-surfaces-main.ts') }, outdir: buildDir, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
copyFileSync(path.join(root, 'scripts/unbound/u4-surfaces.html'), path.join(buildDir, 'u4-surfaces.html'));
const gene = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03');
const userData = mkdtempSync(path.join(os.tmpdir(), 'unbound-u4-preview-'));
const planFile = path.join(userData, 'plan.json');
writeFileSync(planFile, JSON.stringify({ out, build: buildDir, gene: path.join(gene, 'model/gene.pmx'), stand: path.join(gene, 'motions/pose/stand.vmd'), userData }));
const electron = createRequire(import.meta.url)('electron');
console.log(`U4 surfaces preview → ${out}`);
const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', planFile], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached, stopping the preview.'); child.kill(); }, 300_000);
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer);
try { rmSync(userData, { recursive: true, force: true }); } catch { /* a temporary folder; the system cleans it later */ }
console.log(`done (exit ${code}). ${path.join(out, 'results.json')}`);
process.exit(code);
