// Development check (docs/claude/2026-11-21-unbound-wide.md): is she drawn at her true width / height in full-screen Unbound?
// Builds the Unbound page and preload and scripts/unbound/wide-check-main.ts, then runs one Electron process per viewer distance
// with a given display, her saved place and a model (read only), and prints her on-screen width / height (alpha bounding box).
// A temporary user-data folder; no app profile is read or written. Offscreen by default (nothing shows on the screen).
//   node scripts/dev/heavy.mjs --label wide-check -- node scripts/unbound/wide-check.mjs --out <dir> [--model <pmx|vrm>] [--viewer 55,30]
//     [--display 1536x960] [--work 1536x912] [--across 0.3255] [--depth 5.4675] [--onscreen] [--real-display] [--reuse-build]
// Pictures of a private model go where --out says (never in the repository).
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const gene = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03');
const out = path.resolve(arg('out', path.join(root, '.local', 'unbound-wide')));
const buildDir = path.resolve(arg('build-dir', path.join(root, '.local', 'unbound-wide-build')));
mkdirSync(out, { recursive: true });
if (!(process.argv.includes('--reuse-build') && existsSync(path.join(buildDir, 'main.cjs')))) {
  rmSync(buildDir, { recursive: true, force: true });
  await viteBuild({ configFile: false, root, base: './', logLevel: 'warn',
    build: { outDir: buildDir, emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 6000, rollupOptions: { input: { unbound: path.join(root, 'src/unbound/index.html') } } } });
  await esbuild({ entryPoints: { 'unbound-preload': path.join(root, 'electron/unbound/preload.ts'), main: path.join(root, 'scripts/unbound/wide-check-main.ts') },
    outdir: buildDir, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
}
const size = text => { const [w, h] = String(text).split('x').map(Number); return { w, h }; };
const d = size(arg('display', '1536x960')), wa = size(arg('work', `${d.w}x${d.h - 48}`));
const display = process.argv.includes('--real-display') ? null
  : { bounds: { x: 0, y: 0, width: d.w, height: d.h }, workArea: { x: 0, y: 0, width: wa.w, height: wa.h }, scaleFactor: Number(arg('scale', '1.25')), internal: true };
const modelPath = path.resolve(arg('model', path.join(gene, 'model/gene.pmx')));
const tag = arg('tag', path.basename(modelPath).replace(/\.[^.]+$/, '').slice(0, 24));
const electron = createRequire(import.meta.url)('electron');
const rows = [];
for (const viewer of arg('viewer', 'default,30').split(',')) {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'unbound-wide-'));
  const planFile = path.join(userData, 'plan.json');
  const label = `${tag}-v${viewer}`;
  writeFileSync(planFile, JSON.stringify({ out, build: buildDir, model: modelPath, stand: path.join(gene, 'motions/pose/stand.vmd'), userData, label, display,
    across: Number(arg('across', '0.3255')), depthM: Number(arg('depth', '5.4675')), viewerCm: viewer === 'default' ? null : Number(viewer),
    move: process.argv.includes('--move'), dsf: Number(arg('dsf', '0')) || null, offscreen: !process.argv.includes('--onscreen'), waitMs: Number(arg('wait', '4000')) }));
  const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', planFile], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
  const timer = setTimeout(() => child.kill(), 120_000);
  await new Promise(resolve => { child.on('exit', resolve); child.on('error', resolve); });
  clearTimeout(timer);
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* the system cleans it later */ }
  try { rows.push(JSON.parse(readFileSync(path.join(out, `${label}.json`), 'utf8'))); } catch { rows.push({ label, error: 'no result' }); }
}
for (const row of rows) console.log(`${row.label}: w/h ${row.capture?.aspect ?? '-'} box ${JSON.stringify(row.capture?.box ?? null)} page ${JSON.stringify(row.page ?? null)} ${row.error ?? ''}`);
