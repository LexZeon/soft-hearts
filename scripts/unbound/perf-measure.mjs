// Unbound v1 step 1B: measures the real Unbound host and page full screen with the bundled Gene (scripts/unbound/perf-measure-main.ts).
// One run per call, a few minutes (default 3): quiet idle, a peek, walking and weight shifts, a reply bubble, idle again. It records frame
// intervals (fps, p50/p95/p99), the CPU % and working set of each Electron process, and the GPU engine counters when Windows has them.
// It records no screen images, but the window is full screen and shows on your screen for the whole run. Run under the heavy gate:
//   node scripts/dev/heavy.mjs --label perf-high -- node scripts/unbound/perf-measure.mjs --tier high --quiet off --out .local/unbound-perf/<stamp>
// --tier high|medium|low pins a tier; --tier auto lets the page pick (self-test, drop) as in the app. --quiet on|off: the quiet 30 fps rate.
// --reuse-build skips the build when .local/unbound-perf/build exists. Writes run-<label>.json and rebuilds summary.md in --out.
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tier = arg('tier', 'high');
if (!['high', 'medium', 'low', 'auto'].includes(tier)) { console.error('--tier 要是 high、medium、low 或 auto'); process.exit(2); }
const quiet = arg('quiet', 'off') === 'on';
const minutes = Math.max(0.5, Number(arg('minutes', '3')) || 3);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(arg('out', path.join(root, '.local', 'unbound-perf', stamp)));
const label = arg('label', `${tier}-quiet-${quiet ? 'on' : 'off'}`);
const buildDir = path.join(root, '.local', 'unbound-perf', 'build');
mkdirSync(out, { recursive: true });

if (!(process.argv.includes('--reuse-build') && existsSync(path.join(buildDir, 'main.cjs')))) {
  rmSync(buildDir, { recursive: true, force: true });
  await viteBuild({ configFile: false, root, base: './', logLevel: 'warn',
    build: { outDir: buildDir, emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 2000, rollupOptions: { input: { unbound: path.join(root, 'src/unbound/index.html') } } } });
  await esbuild({ entryPoints: { 'unbound-preload': path.join(root, 'electron/unbound/preload.ts'), main: path.join(root, 'scripts/unbound/perf-measure-main.ts') },
    outdir: buildDir, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
}
const gene = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03');
const userData = mkdtempSync(path.join(os.tmpdir(), 'unbound-perf-'));
const planFile = path.join(userData, 'plan.json');
writeFileSync(planFile, JSON.stringify({ out, build: buildDir, gene: path.join(gene, 'model/gene.pmx'), stand: path.join(gene, 'motions/pose/stand.vmd'), userData, tier, quiet, minutes, label }));
const electron = createRequire(import.meta.url)('electron');
console.log(`Unbound perf: tier ${tier}, quiet rate ${quiet ? 'on' : 'off'}, ${minutes} min → ${out}`);
const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', planFile], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached, stopping.'); child.kill(); }, (minutes + 4) * 60_000);
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer);
try { rmSync(userData, { recursive: true, force: true }); } catch { /* a temporary folder */ }

// ---- summary.md from every run-*.json in --out ------------------------------------------------------------------------------------
const runs = readdirSync(out).filter(f => /^run-.*\.json$/.test(f)).sort().map(f => JSON.parse(readFileSync(path.join(out, f), 'utf8')));
const n = (v, d = 1) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
const lines = ['# Unbound 性能测量', '', `- 机器：${runs[0]?.cpuModel ?? '?'}（${runs[0]?.cpuCores ?? '?'} 核）`, `- 屏幕：${JSON.stringify(runs[0]?.display ?? null)}`, `- 每次 ${runs.map(r => r.minutes).join('/')} 分钟；不录屏。`, ''];
lines.push('## 全程（帧间隔 ms，只算全速帧之外也计入的所有帧）', '', '| 档位 | 安静降帧 | 帧数 | p50 | p95 | p99 |', '|---|---|---|---|---|---|');
for (const r of runs) lines.push(`| ${r.tier} | ${r.quietRate ? '开' : '关'} | ${r.overall.frames} | ${n(r.overall.p50)} | ${n(r.overall.p95)} | ${n(r.overall.p99)} |`);
for (const r of runs) {
  lines.push('', `## ${r.label}${r.error ? '（出错）' : ''}`, '', '| 场景 | 秒 | 实际帧率 | 全速帧 p50/p95/p99/max ms | 超预算 %（档位帧率×1.25） | 安静帧数 | CPU% 主/渲染/GPU进程（Electron 自报） | 核对：Windows 处理器时间，占一个核的% 主/渲染/GPU | 内存 MB 主/渲染/GPU | GPU 3D%（本程序/整机） |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const [name, s] of Object.entries(r.scenes)) {
    const g = s.gpu ? `${n(s.gpu.ourProcs3D)} / ${n(s.gpu.systemTotal3D)}` : '-';
    lines.push(`| ${name} | ${n(s.seconds, 0)} | ${n(s.fps)} | ${n(s.full.p50)}/${n(s.full.p95)}/${n(s.full.p99)}/${n(s.full.max)} | ${n(s.full.overBudget)} | ${s.quiet.n} | ${n(s.cpuPercent.main.mean)}/${n(s.cpuPercent.renderer.mean)}/${n(s.cpuPercent.gpu.mean)} | ${n(s.cpuCrossCheckPercentOfOneCore?.main)}/${n(s.cpuCrossCheckPercentOfOneCore?.renderer)}/${n(s.cpuCrossCheckPercentOfOneCore?.gpu)} | ${n(s.workingSetMB.main.mean, 0)}/${n(s.workingSetMB.renderer.mean, 0)}/${n(s.workingSetMB.gpu.mean, 0)} | ${g} |`);
  }
  const smooth = Object.entries(r.scenes).filter(([, s]) => s.headStepPx);
  if (smooth.length) lines.push('', '头部在屏幕上每帧挪多少像素（窗口像素；速度 = 位移/帧间隔，30 帧和 60 帧可比）：', '', '| 场景 | 每帧 p50 | 每帧 p95 | 每帧 max | 速度 p50 px/s | 速度 p95 px/s |', '|---|---|---|---|---|---|', ...smooth.map(([name, s]) => `| ${name} | ${n(s.headStepPx.p50, 3)} | ${n(s.headStepPx.p95, 3)} | ${n(s.headStepPx.max, 3)} | ${n(s.headStepPx.speedPxPerSecP50)} | ${n(s.headStepPx.speedPxPerSecP95)} |`));
  if (r.page?.end) lines.push('', `页面：档位 ${r.page.end.tier}，像素比 ${r.page.end.pixelRatio}（设备 ${r.page.end.devicePixelRatio}），画布 ${r.page.end.canvas?.join('×')}，降档 ${r.page.end.drops} 次，${r.page.end.note || ''}`);
}
writeFileSync(path.join(out, 'summary.md'), `${lines.join('\n')}\n`);
console.log(`done (exit ${code}). ${path.join(out, 'summary.md')}`);
process.exit(code);
