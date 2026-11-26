// Records the Unbound U2 peek on the real desktop (scripts/unbound/u2-peek-record-main.ts): every window is minimised first so the
// desktop and taskbar show (and restored afterwards), then Electron records the whole primary screen into --out/peek-desktop.webm.
// The recording shows the user's desktop, so --out must be a private folder. About two minutes. Run:
//   node scripts/unbound/u2-peek-record.mjs --out <a private folder>\reports\unbound-peek-desktop
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const at = process.argv.indexOf('--out');
if (at < 0 || !process.argv[at + 1]) { console.error('需要 --out <私人文件夹>：录像里有你的桌面。'); process.exit(2); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(path.resolve(process.argv[at + 1]), new Date().toISOString().replace(/[:.]/g, '-'));
if (out.toLowerCase().startsWith(root.toLowerCase())) { console.error('--out 不能在仓库里（录像里有你的桌面）。'); process.exit(2); }
const buildDir = path.join(root, '.local', 'unbound-record', 'build');
mkdirSync(out, { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
await viteBuild({ configFile: false, root, base: './', logLevel: 'warn',
  build: { outDir: buildDir, emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 2000, rollupOptions: { input: { unbound: path.join(root, 'src/unbound/index.html') } } } });
await esbuild({ entryPoints: { 'unbound-preload': path.join(root, 'electron/unbound/preload.ts'), main: path.join(root, 'scripts/unbound/u2-peek-record-main.ts') },
  outdir: buildDir, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
const gene = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03');
const userData = mkdtempSync(path.join(os.tmpdir(), 'unbound-u2-record-'));
const planFile = path.join(userData, 'plan.json');
writeFileSync(planFile, JSON.stringify({ out, build: buildDir, gene: path.join(gene, 'model/gene.pmx'), stand: path.join(gene, 'motions/pose/stand.vmd'), userData }));
const shell = verb => spawnSync('powershell.exe', ['-NoProfile', '-Command', `(New-Object -ComObject Shell.Application).${verb}()`], { stdio: 'ignore' });
shell('MinimizeAll');
await new Promise(resolve => setTimeout(resolve, 1500));
const electron = createRequire(import.meta.url)('electron');
console.log(`U2 peek recording → ${out}`);
const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', planFile], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached, stopping.'); child.kill(); }, 300_000);
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer);
shell('UndoMinimizeALL');
try { rmSync(userData, { recursive: true, force: true }); } catch { /* a temporary folder; the system cleans it later */ }
console.log(`done (exit ${code}). ${path.join(out, 'peek-desktop.mp4 或 .webm')}`);
process.exit(code);
