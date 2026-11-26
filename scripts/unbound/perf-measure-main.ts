// Unbound v1 step 1B: performance measurement (scripts/unbound/perf-measure.mjs starts this under Electron).
// The real Unbound host, window, preload and page with the bundled Gene, full screen (work area, transparent, click-through, as the
// product), hair/chest physics on, a temporary user-data folder (no app profile, no settings, no calls). The page is loaded with
// ?perf=<tier> (pins the tier: no self-test, no drop, nothing stored) and ?perfquiet=0|1, plus probe=preview for her sway act.
// Scenes in order: quiet idle, a peek, walking and weight shifts, a reply bubble, idle again. Every second's worth of frames is
// drained from the page and tagged with the scene; every 2 s the Electron processes' CPU and working set are read (app.getAppMetrics),
// every ~10 s the GPU engine counters of those processes (Windows performance counters, best effort). It records no screen images.
import { app, BrowserWindow, ipcMain, net, protocol } from 'electron';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssetRegistry } from '../../electron/foundation/assets';
import { createAssetProtocolHandler } from '../../electron/foundation/asset-protocol';
import { UnboundHost, type UnboundIpcMain } from '../../electron/unbound/host';
import { asUnboundWindow, primaryDisplayFacts } from '../../electron/unbound/electron-host';
import { createUnboundWindow, loadUnboundPage } from '../../electron/unbound/window';
import { readMonitorSizes } from '../../electron/unbound/display-size';
import type { MoodReading } from '../../shared/unbound/director';

interface Plan { out: string; build: string; gene: string; stand: string; userData: string; tier: string; quiet: boolean; minutes: number; label: string }
const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1]!, 'utf8')) as Plan;
app.setPath('userData', plan.userData);
app.setName('unbound-perf-measure');
protocol.registerSchemesAsPrivileged([{ scheme: 'mmd-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const log = (line: string) => console.log(`[perf] ${line}`);
const CURIOUS: MoodReading = { D: 75, O: 62, E: 55, N: 50, C: 45, A: 0.2, B: 40, M: 10 };

const pct = (values: number[], p: number) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!; };
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round = (v: number | null, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

interface Frame { ms: number; quiet: boolean; hx: number; hy: number }
interface Sample { t: number; scene: string; procs: { pid: number; type: string; cpu: number; ws: number }[] }
interface GpuSample { t: number; scene: string; byPid: Record<string, { d3: number; all: number }>; total: { d3: number; all: number } | null }

/** GPU engine utilisation per process id, from the Windows counters. Null when the counters are not there. */
function gpuCounters(): Promise<{ byPid: Record<string, { d3: number; all: number }>; total: { d3: number; all: number } } | null> {
  const script = "$ErrorActionPreference='Stop'; try { $s=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples; $o=@{}; foreach($x in $s){ if($x.InstanceName -match '^pid_(\\d+)_.*engtype_(\\w+)'){ $p=$Matches[1]; $t=$Matches[2]; if(-not $o.ContainsKey($p)){ $o[$p]=@{d3=0.0;all=0.0} }; $o[$p].all+=$x.CookedValue; if($t -eq '3D'){ $o[$p].d3+=$x.CookedValue } } }; $o | ConvertTo-Json -Compress } catch { 'null' }";
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const parsed = JSON.parse(stdout.trim() || 'null') as Record<string, { d3: number; all: number }> | null;
        if (!parsed) return resolve(null);
        const total = { d3: 0, all: 0 };
        for (const v of Object.values(parsed)) { total.d3 += v.d3; total.all += v.all; }
        resolve({ byPid: parsed, total });
      } catch { resolve(null); }
    });
  });
}

/** Cumulative processor seconds of every electron process (Get-Process), a cross-check for Electron's own CPU percentage. */
function cpuSeconds(): Promise<Record<string, number>> {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Id, $_.TotalProcessorTime.TotalSeconds }"], { timeout: 15_000, windowsHide: true }, (error, stdout) => {
      const out: Record<string, number> = {};
      if (!error) for (const line of stdout.split(/\r?\n/)) { const [pid, sec] = line.trim().split(' '); if (pid && Number.isFinite(Number(sec))) out[pid] = Number(sec); }
      resolve(out);
    });
  });
}

app.whenReady().then(async () => {
  mkdirSync(plan.out, { recursive: true });
  const assets = new AssetRegistry();
  const model = await assets.register(plan.gene), stand = await assets.register(plan.stand);
  protocol.handle('mmd-asset', createAssetProtocolHandler({ resolve: url => assets.resolve(url), fetchFile: url => net.fetch(url) }));
  const pet = new BrowserWindow({ width: 200, height: 260, frame: false, skipTaskbar: true, focusable: false, show: false });
  await pet.loadURL('data:text/html,<body></body>');
  let unboundWindow: BrowserWindow | null = null;
  const host = new UnboundHost({
    ipcMain: ipcMain as unknown as UnboundIpcMain,
    pet: () => pet, petWanted: () => false, developerMode: () => true,
    source: () => ({ modelUrl: model.url, motion: { pose: stand.url, gesture: null, expression: null, legacy: false }, breath: 0.5, physics: { hair: { enabled: true, strength: 0.65 }, chest: { enabled: true, strength: 0.35 }, quality: 'standard' } }),
    reviewed: async () => true, display: primaryDisplayFacts, measure: () => readMonitorSizes(),
    openWindow: bounds => {
      const win = unboundWindow = createUnboundWindow(bounds, { electronDir: plan.build, distDir: plan.build });
      return { window: asUnboundWindow(win), loaded: loadUnboundPage(win, { electronDir: plan.build, distDir: plan.build }, { probe: 'preview', perf: plan.tier, perfquiet: plan.quiet ? '1' : '0' }) };
    },
    restored: () => {}, publish: () => {},
    peek: {
      clock: () => Date.now(), random: () => Math.random(), idleSeconds: () => 0, idleNow: () => 0,
      asleep: () => false, inCall: () => false, userTalking: () => false, mood: () => CURIOUS, lastInteractionAt: () => null, answered: () => true,
      every: (ms, run) => { const t = setInterval(run, ms); return () => clearInterval(t); },
    },
    // Step 4: her own life, quiet ("you are away", no camera) until the 'life' scene, which runs her day fast-forwarded.
    life: {
      clock: () => Date.now(), random: () => Math.random(),
      readings: () => lifeOn ? { idleSeconds: 120, state: 'pause' } : { idleSeconds: 2_000, state: 'away' },
      asleep: () => false, inCall: () => false, waiting: () => false, typing: () => false, readingAloud: () => false, mood: () => CURIOUS,
      lastInteractionAt: () => null, answered: () => true, every: (ms, run) => { const t = setInterval(run, ms); return () => clearInterval(t); },
    },
  });
  let lifeOn = false;
  const until = async (test: () => Promise<boolean> | boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(100); } return test(); };
  const page = <T>(expression: string) => unboundWindow!.webContents.executeJavaScript(expression) as Promise<T>;
  const peekState = () => page<{ phase: string | null; active: boolean }>('window.__unboundProbe.peek()');

  let scene = 'load';
  const frames: Record<string, Frame[]> = {};
  const sceneSeconds: Record<string, number> = {};
  const samples: Sample[] = [], gpuSamples: GpuSample[] = [];
  let sceneStart = Date.now();
  const marks: { scene: string; at: number; cpu: Record<string, number> }[] = [];
  const mark = async (name: string) => { const at = Date.now(); marks.push({ scene: name, at, cpu: await cpuSeconds() }); };
  const enter = (name: string) => { sceneSeconds[scene] = (sceneSeconds[scene] ?? 0) + (Date.now() - sceneStart) / 1000; scene = name; sceneStart = Date.now(); log(`scene ${name}`); void mark(name); };
  let drainBusy = false;
  const drain = async () => {
    if (drainBusy || !unboundWindow || unboundWindow.isDestroyed()) return;
    drainBusy = true;
    try { const got = await page<Frame[]>('window.__unboundProbe.perfDrain()'); (frames[scene] ??= []).push(...got); } catch { /* the page is gone */ } finally { drainBusy = false; }
  };
  const t0 = Date.now();
  const pumpDrain = setInterval(() => { void drain(); }, 1_000);
  const pumpProc = setInterval(() => {
    samples.push({ t: +((Date.now() - t0) / 1000).toFixed(1), scene, procs: app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, cpu: m.cpu.percentCPUUsage, ws: m.memory.workingSetSize })) });
  }, 2_000);
  let gpuBusy = false, gpuAvailable: boolean | null = null;
  const pumpGpu = setInterval(() => {
    if (gpuBusy) return;
    gpuBusy = true;
    const sceneThen = scene;
    void gpuCounters().then(result => {
      gpuAvailable = gpuAvailable === true || !!result;
      if (result) gpuSamples.push({ t: +((Date.now() - t0) / 1000).toFixed(1), scene: sceneThen, byPid: result.byPid, total: result.total });
    }).finally(() => { gpuBusy = false; });
  }, 10_000);

  let error: string | null = null;
  let display: unknown = null, pageInfo: unknown = null, enterMs = 0;
  const total = plan.minutes * 60_000;
  const budgetMs = 1000 / (plan.tier === "low" ? 30 : 60) * 1.25; // the tier's own frame budget (shared/unbound/perf-tiers.ts OVER_BUDGET)
  const left = (share: number) => total * share;
  try {
    const started = Date.now();
    host.apply({ active: true });
    if (!await until(() => host.state === 'unbound', 60_000)) throw new Error(`did not enter: ${host.view().error}`);
    enterMs = Date.now() - started;
    display = host.view().screen; pageInfo = await page('window.__unboundProbe.perf()');
    log(`in (${enterMs} ms) ${JSON.stringify(pageInfo)}`);
    await sleep(3_000); // she is home; the first frames after the fade are not measured
    await drain(); frames.load = []; // warm-up out
    const sceneEnd = (share: number, from: number) => Math.max(0, left(share) - (Date.now() - from));

    // 1. quiet idle
    enter('idle'); let from = Date.now();
    await sleep(left(0.22));

    // 2. a peek: she comes up to the lens, holds, backs off, goes home
    enter('peek'); from = Date.now();
    host.apply({ peekNow: true });
    await until(async () => (await peekState()).phase === 'hold', 40_000);
    await until(async () => !(await peekState()).active, 60_000);
    await sleep(sceneEnd(0.22, from));

    // 3. walking and weight shifts: she walks to a few depths, stands on one foot, sways
    enter('walk'); from = Date.now();
    host.apply({ depthM: 4 }); await until(async () => !(await page<{ moving: boolean }>('window.__unboundProbe.stats()')).moving, 25_000);
    host.apply({ stance: 'left' }); await sleep(4_000);
    host.apply({ stance: 'both' }); await sleep(2_500);
    await page<boolean>("window.__unboundProbe.act('sway')"); await sleep(4_000);
    host.apply({ depthM: 9 }); await until(async () => !(await page<{ moving: boolean }>('window.__unboundProbe.stats()')).moving, 30_000);
    host.apply({ depthM: 6 }); await until(async () => !(await page<{ moving: boolean }>('window.__unboundProbe.stats()')).moving, 30_000);
    await sleep(sceneEnd(0.3, from));

    // 4. a reply: the bubble streams in word by word, lingers, fades
    enter('reply'); from = Date.now();
    const words = '好呀，我在这里呢。你今天过得怎么样？刚才我在想，如果你累了，就先歇一会儿，我陪着你，不用急着回答我什么。'.match(/.{1,3}/gu) ?? [];
    for (const word of words) { host.stream({ id: 'perf-1', kind: 'chat', type: 'delta', text: word }); await sleep(180); }
    host.stream({ id: 'perf-1', kind: 'chat', type: 'done', text: '' });
    await sleep(sceneEnd(0.14, from));

    // 4b. step 4: her own life, her day fast-forwarded (walks, weight shifts, glances, idle pauses one after another)
    enter('life'); from = Date.now();
    lifeOn = true; host.apply({ lifeFast: true });
    await sleep(left(0.2));
    host.apply({ lifeFast: false }); lifeOn = false;
    await until(() => !host.life?.active, 30_000);

    // 5. idle again (the quiet rate comes back after the bubble)
    enter('idle-2');
    await sleep(Math.max(2_000, total - (Date.now() - t0 - 3_000)));
    enter('end');
  } catch (failure) {
    error = String((failure as Error)?.stack ?? failure);
    log(`error ${error}`);
  } finally {
    await sleep(1_500); // the last scene's closing mark
    await drain(); clearInterval(pumpDrain); clearInterval(pumpProc); clearInterval(pumpGpu);
    try { pageInfo = { ...(pageInfo as object), end: await page('window.__unboundProbe.perf()') }; } catch { /* page gone */ }
    // Per scene: frames and process numbers.
    const pidType = new Map<number, string>();
    for (const s of samples) for (const p of s.procs) pidType.set(p.pid, p.type);
    const kind = (type: string) => (type === 'Browser' ? 'main' : type === 'Tab' ? 'renderer' : type === 'GPU' ? 'gpu' : 'other');
    const scenes: Record<string, unknown> = {};
    const names = Object.keys(frames).filter(n => n !== 'load' && n !== 'end');
    for (const name of names) {
      const all = frames[name]!, full = all.filter(f => !f.quiet).map(f => f.ms), quiet = all.filter(f => f.quiet).map(f => f.ms);
      const secs = sceneSeconds[name] ?? 0;
      const cpu: Record<string, { mean: number | null; p95: number | null }> = {}, mem: Record<string, { mean: number | null; max: number | null }> = {};
      for (const k of ['main', 'renderer', 'gpu']) {
        const rows = samples.filter(s => s.scene === name).map(s => s.procs.filter(p => kind(p.type) === k).reduce((a, p) => ({ cpu: a.cpu + p.cpu, ws: a.ws + p.ws }), { cpu: 0, ws: 0 }));
        cpu[k] = { mean: round(mean(rows.map(r => r.cpu))), p95: round(pct(rows.map(r => r.cpu), 0.95)) };
        mem[k] = { mean: round(mean(rows.map(r => r.ws / 1024))), max: round(Math.max(0, ...rows.map(r => r.ws / 1024))) };
      }
      const gpuRows = gpuSamples.filter(g => g.scene === name);
      const pids = new Set([...pidType.keys()].map(String));
      const ours = gpuRows.map(g => Object.entries(g.byPid).filter(([pid]) => pids.has(pid)).reduce((a, [, v]) => ({ d3: a.d3 + v.d3, all: a.all + v.all }), { d3: 0, all: 0 }));
      // Cross-check: processor seconds from Windows between this scene's marks, per process kind, in percent of one core.
      const m0 = marks.find(m => m.scene === name), m1 = m0 ? marks[marks.indexOf(m0) + 1] : undefined;
      const cross: Record<string, number | null> = {};
      if (m0 && m1) for (const k of ['main', 'renderer', 'gpu']) cross[k] = round([...pidType.entries()].filter(([, t]) => kind(t) === k).reduce((a, [pid]) => a + Math.max(0, (m1.cpu[pid] ?? 0) - (m0.cpu[pid] ?? 0)), 0) / ((m1.at - m0.at) / 1000) * 100, 1);
      // Smoothness: how far her head moves on the screen between two drawn frames (window pixels), and per second (so 30 and 60 fps compare).
      const steps: number[] = [], perSecond: number[] = [];
      for (let i = 1; i < all.length; i++) { const d = Math.hypot(all[i]!.hx - all[i - 1]!.hx, all[i]!.hy - all[i - 1]!.hy); if (d < 200 && all[i]!.ms < 100) { steps.push(d); perSecond.push(d / (all[i]!.ms / 1000)); } }
      scenes[name] = {
        headStepPx: { p50: round(pct(steps, 0.5), 3), p95: round(pct(steps, 0.95), 3), max: round(pct(steps, 1), 3), speedPxPerSecP50: round(pct(perSecond, 0.5), 1), speedPxPerSecP95: round(pct(perSecond, 0.95), 1) },
        cpuCrossCheckPercentOfOneCore: cross,
        seconds: round(secs, 1), frames: all.length, fps: round(all.length / Math.max(0.001, secs), 1),
        full: { n: full.length, p50: round(pct(full, 0.5)), p95: round(pct(full, 0.95)), p99: round(pct(full, 0.99)), max: round(pct(full, 1)), overBudget: full.length ? round(full.filter(v => v > budgetMs).length / full.length * 100, 1) : null },
        quiet: { n: quiet.length, p50: round(pct(quiet, 0.5)), p95: round(pct(quiet, 0.95)) },
        cpuPercent: cpu, workingSetMB: mem,
        gpu: gpuRows.length ? { samples: gpuRows.length, ourProcs3D: round(mean(ours.map(o => o.d3))), ourProcsAll: round(mean(ours.map(o => o.all))), systemTotal3D: round(mean(gpuRows.map(g => g.total?.d3 ?? 0))) } : null,
      };
    }
    const everything = names.flatMap(n => frames[n]!);
    const result = {
      label: plan.label, tier: plan.tier, quietRate: plan.quiet, minutes: plan.minutes, enterMs, display, page: pageInfo, cpuCores: os.cpus().length, cpuModel: os.cpus()[0]?.model, gpuCountersAvailable: gpuAvailable,
      overall: { frames: everything.length, p50: round(pct(everything.map(f => f.ms), 0.5)), p95: round(pct(everything.map(f => f.ms), 0.95)), p99: round(pct(everything.map(f => f.ms), 0.99)) },
      scenes, error,
      memoryOverTime: samples.map(s => ({ t: s.t, scene: s.scene, mb: Object.fromEntries(['main', 'renderer', 'gpu'].map(k => [k, round(s.procs.filter(p => kind(p.type) === k).reduce((a, p) => a + p.ws, 0) / 1024, 0)])) })),
      cpuOverTime: samples.map(s => ({ t: s.t, scene: s.scene, pct: Object.fromEntries(['main', 'renderer', 'gpu'].map(k => [k, round(s.procs.filter(p => kind(p.type) === k).reduce((a, p) => a + p.cpu, 0), 1)])) })),
      gpuOverTime: gpuSamples.map(g => ({ t: g.t, scene: g.scene, systemTotal3D: round(g.total?.d3 ?? null), pids: Object.fromEntries(Object.entries(g.byPid).filter(([pid]) => pidType.has(Number(pid))).map(([pid, v]) => [`${kind(pidType.get(Number(pid))!)}:${pid}`, round(v.all)])) })),
    };
    writeFileSync(path.join(plan.out, `run-${plan.label}.json`), JSON.stringify(result, null, 2));
    log(`saved run-${plan.label}.json`);
    host.quit();
    app.exit(error ? 1 : 0);
  }
});
