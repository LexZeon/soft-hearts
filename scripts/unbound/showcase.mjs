// Unbound showcase launcher (docs/claude/2026-11-14-lapwing-showcase.md). Builds the showcase page, its preload and host (or
// uses a prebuilt folder), then runs them in Electron with the bundled Gene and a temporary user-data folder (deleted after).
//
//   node scripts/unbound/showcase.mjs --mode record --source claude            # Claude writes it; records a WebM + stills
//   node scripts/unbound/showcase.mjs --mode record --source fake:a            # development: a fixed fake choreography
//   node scripts/unbound/showcase.mjs --mode live --source claude --prebuilt <dir>   # full screen over the desktop, click-through
//   node scripts/unbound/showcase.mjs --build-only --out-build <dir>           # just build (for showcase-live.cmd)
// Options: --seed <0..1> (mood and situation draw; random by default), --physics (hair physics), --out <dir>,
// --idle (round 7: the learned idle under quiet holds and her own world), --model <pmx> (another model, read only; development).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
// --root: the repository (for the bundled Gene and Electron) when this file runs from a copy (showcase-live.cmd's folder).
const root = path.resolve(arg('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')));
const flag = name => process.argv.includes(`--${name}`);
const mode = arg('mode', 'record');
const sourceArg = arg('source', 'fake:a');
const seed = Number(arg('seed', String(Math.random())));
const showcaseDir = path.join(root, '.local', 'unbound-night', 'showcase');

// Round 13 (review): Claude is called only after the user says so, every time (a night's approval does not cover later runs).
// --yes skips the question for a scripted run the user has already approved in words.
if (sourceArg === 'claude' && !flag('yes')) {
  console.log('这次会调用 Claude 2 次（sonnet，最多 4 次），约 0.04 美元，用的是你的 Claude Code 额度。按回车继续，关掉窗口取消。');
  const go = await new Promise(resolve => {
    process.stdin.once('data', () => resolve(true));
    process.stdin.once('end', () => resolve(false));
    process.stdin.resume();
  });
  process.stdin.pause();
  if (!go) { console.log('取消了，没有调用 Claude。'); process.exit(0); }
}

/** Round 13: stop a child and everything it started (Electron's own processes too); on Windows through taskkill /T. */
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
}

async function build(dir) {
  const { build: viteBuild } = await import('vite');
  const { build: esbuild } = await import('esbuild');
  rmSync(dir, { recursive: true, force: true });
  await viteBuild({ configFile: false, root, base: './', logLevel: 'warn',
    build: { outDir: dir, emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 4000, rollupOptions: { input: { showcase: path.join(root, 'src/unbound/showcase/index.html') } } } });
  await esbuild({ entryPoints: { 'showcase-preload': path.join(root, 'scripts/unbound/showcase-preload.ts'), main: path.join(root, 'scripts/unbound/showcase-main.ts') },
    outdir: dir, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
  // The bundled Gene travels with the build (CC BY 4.0, assets/bundled), so the prebuilt folder runs on its own.
  return dir;
}

const prebuilt = arg('prebuilt');
const buildDir = prebuilt ?? (flag('build-only') ? path.resolve(arg('out-build', path.join(showcaseDir, 'build'))) : path.join(showcaseDir, '.build-dev'));
if (!prebuilt) await build(buildDir);
if (flag('build-only')) { console.log(`built → ${buildDir}`); process.exit(0); }
if (!existsSync(path.join(buildDir, 'main.cjs'))) { console.error(`no build in ${buildDir}`); process.exit(1); }

const gene = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(arg('out', path.join(arg('out-root', path.join(showcaseDir, 'runs')), `${stamp}-${mode}-${sourceArg.replace(/[^\w]/g, '').slice(0, 20)}`)));
mkdirSync(out, { recursive: true });
const userData = mkdtempSync(path.join(os.tmpdir(), 'soft-hearts-showcase-'));
// claude | fake:a[,b] | replay:<a run's choreography.json> (re-record what Claude wrote, no new call)
const source = sourceArg === 'claude' ? 'claude' : sourceArg.startsWith('replay:') ? [path.resolve(sourceArg.slice(7))]
  : sourceArg.replace(/^fake:/, '').split(',').map(name => path.join(root, 'scripts/unbound/showcase-fakes', `${name}.json`));
const planFile = path.join(userData, 'plan.json');
// The learned idle's files: this checkout's .local/ml, or the main checkout's when this is a worktree (.claude/worktrees/<name>).
const mlDir = [path.join(root, '.local', 'ml'), path.join(root, '..', '..', '..', '.local', 'ml')].find(dir => existsSync(path.join(dir, 'out2', 'idle-vae.json'))) ?? path.join(root, '.local', 'ml');
writeFileSync(planFile, JSON.stringify({ mode, out, build: buildDir, gene: arg('model') ? path.resolve(arg('model')) : path.join(gene, 'model/gene.pmx') /* --model: another PMX, read only (development) */, stand: path.join(gene, 'motions/pose/stand.vmd'), userData, source, seed, parentPid: process.pid, physics: flag('physics'), lighting: arg('lighting', 'night'),
  // Round 7: --idle lays the learned idle (trained on this machine, .local/ml) under quiet holds; missing files: the procedural one.
  idle: flag('idle') ? { model: path.join(mlDir, 'out2', 'idle-vae.json'), events: path.join(mlDir, 'events') } : null }));
const electron = arg('electron') ?? createRequire(path.join(root, 'package.json'))('electron');
console.log(`showcase ${mode} (${sourceArg}, seed ${seed.toFixed(4)}) → ${out}`);
if (mode === 'live') console.log('她会在屏幕上演一段（大约一分钟，最多两分半），演完自己退出。提前关：按 Ctrl+Alt+Q，或者关掉这个窗口。');
const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', planFile], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached, stopping.'); killTree(child); }, 240_000);
// Ctrl+C or the console closing: take Electron down with us.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, () => { killTree(child); process.exit(130); });
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer);
try { rmSync(userData, { recursive: true, force: true }); } catch { /* temporary; the system cleans it later */ }
console.log(`done (exit ${code}) → ${out}`);
process.exit(code);
