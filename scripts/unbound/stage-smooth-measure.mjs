// 三人同框别卡 measurement (docs/claude/2026-11-24-stage-smooth.md): frame rate, frame times and CPU of one, two or three full-screen instances, with
// the idle-extra pace on (after) and off (before), and the quiet rate on and off. Real Electron, a temporary user-data folder (no app profile, no
// settings, no model calls), the bundled Gene as every card, small preview windows. Run under the heavy gate:
//   node scripts/dev/heavy.mjs --label stage-smooth -- node scripts/unbound/stage-smooth-measure.mjs [--out <folder>] [--seconds 20]
//        [--width 1280 --height 720] [--noguard] [--burn N] [--gpu-switch] [--configs 1:0:1,3:0:1,3:1:1]    (instances:pace:quiet, each 0 or 1; add :poke to click the second one after)
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.resolve(arg('out', path.join(root, '.local', 'stage-smooth', new Date().toISOString().replace(/[:.]/g, '-'))));
const configs = arg('configs', '1:0:1,1:0:0,3:0:1,3:1:1,3:0:0,3:1:0').split(',').map(text => { const [n, pace, quiet, poke] = text.split(':'); return { instances: Number(n), pace: pace === '1', quiet: quiet !== '0', poke: poke === 'poke' }; });
const buildDir = mkdtempSync(path.join(os.tmpdir(), 'stage-smooth-build-'));
mkdirSync(out, { recursive: true });
await viteBuild({ configFile: false, root, base: './', logLevel: 'warn',
  build: { outDir: buildDir, emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { unbound: path.join(root, 'src/unbound/index.html'), unboundInput: path.join(root, 'src/unbound/input.html') } } } });
await esbuild({ entryPoints: { 'unbound-preload': path.join(root, 'electron/unbound/preload.ts'), 'unbound-input-preload': path.join(root, 'electron/unbound/input-preload.ts'), main: path.join(root, 'scripts/unbound/stage-smooth-measure-main.ts') },
  outdir: buildDir, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
const gene = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03');
const electron = createRequire(import.meta.url)('electron');
console.log(`stage smooth measurement -> ${out}`);
const all = [];
// --burn N: N processes spinning on a core each for the whole run (a busy machine: the user's own jobs, a local voice model), to see how the frame times and the guard behave under load.
const burners = Array.from({ length: Number(arg('burn', '0')) }, () => spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
process.on('exit', () => { for (const burner of burners) burner.kill(); }); // also when the run is cut short
for (const [i, config] of configs.entries()) {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'stage-smooth-'));
  const label = `run${i + 1}-n${config.instances}-pace${config.pace ? 'on' : 'off'}-quiet${config.quiet ? 'on' : 'off'}${config.poke ? '-poke' : ''}`;
  writeFileSync(path.join(userData, 'plan.json'), JSON.stringify({ out, build: buildDir, gene: path.join(gene, 'model/gene.pmx'), stand: path.join(gene, 'motions/pose/stand.vmd'), userData, ...config,
    noguard: process.argv.includes('--noguard'), gpuSwitch: process.argv.includes('--gpu-switch'), seconds: Number(arg('seconds', '20')), width: Number(arg('width', '1280')), height: Number(arg('height', '720')), label }));
  const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', path.join(userData, 'plan.json')], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
  const timer = setTimeout(() => { console.error(`time cap: ${label}`); child.kill(); }, 240_000);
  const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
  clearTimeout(timer);
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* temporary */ }
  try { all.push(JSON.parse(readFileSync(path.join(out, `${label}.json`), 'utf8'))); } catch { all.push({ label, error: `exit ${code}` }); }
}
for (const burner of burners) burner.kill();
writeFileSync(path.join(out, 'all.json'), JSON.stringify(all, null, 2));
try { rmSync(buildDir, { recursive: true, force: true }); } catch { /* temporary */ }
console.log(`done. ${path.join(out, 'all.json')}`);
