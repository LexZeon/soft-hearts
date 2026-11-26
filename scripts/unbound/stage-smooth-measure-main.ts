// 三人同框别卡 measurement, the Electron side (scripts/unbound/stage-smooth-measure.mjs builds and starts it, one configuration per start).
// The real stage as the app makes it (electron/unbound/company/build.ts buildUnboundStage) with Electron's real ipcMain and windows, small preview
// windows, the bundled Gene as every card, a temporary user-data folder. For one configuration (how many on stage, the idle-extra pace on or off,
// the quiet rate on or off) it lets the stage settle, then for a few seconds records per window how many frames were drawn and their intervals, and
// per process the CPU the GPU and renderer processes used (app.getAppMetrics), and the canvas each page draws at.
import { app, BrowserWindow, ipcMain, net, protocol, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AssetRegistry } from '../../electron/foundation/assets';
import { createAssetProtocolHandler } from '../../electron/foundation/asset-protocol';
import type { UnboundIpcMain } from '../../electron/unbound/host';
import { asUnboundWindow, primaryDisplayFacts } from '../../electron/unbound/electron-host';
import { buildUnboundStage } from '../../electron/unbound/company/build';
import { MAIN_KEY } from '../../electron/unbound/company/stage';
import { execFile } from 'node:child_process';
import { createUnboundWindow, loadUnboundPage } from '../../electron/unbound/window';
import { readMonitorSizes } from '../../electron/unbound/display-size';
import { companyPorts } from '../../electron/unbound/company/ports';

interface Plan { out: string; build: string; gene: string; stand: string; userData: string; instances: number; pace: boolean; quiet: boolean; seconds: number; width: number; height: number; label: string; poke: boolean; noguard: boolean; gpuSwitch: boolean }
const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--plan') + 1]!, 'utf8')) as Plan;
app.setPath('userData', plan.userData);
app.setName('stage-smooth-measure');
if (plan.gpuSwitch) app.commandLine.appendSwitch('force_high_performance_gpu'); // the app's own start-up switch (electron/foundation/gpu-choice), to see that on one chip it changes nothing
protocol.registerSchemesAsPrivileged([{ scheme: 'mmd-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const NEUTRAL = { snapshot: { values: { D: 55, O: 55, E: 50, N: 50, C: 50 }, boredom: 0, longing: 0 }, parameters: { baseline: { D: 50, O: 50, E: 50, N: 50, C: 50 }, evidence: { level: 1 } } };

const rawHandle = ipcMain.handle.bind(ipcMain);
(ipcMain as unknown as { handle: typeof ipcMain.handle }).handle = (channel, listener) => rawHandle(channel, (event, ...args) => {
  if (channel === 'unbound:company-guard') console.log(`[smooth] guard verdict ${JSON.stringify(args[0])} from window ${event.sender.id}`);
  if (channel === 'unbound:company-guard' && plan.noguard) return undefined; // measuring: the frame-cost guard only watches (it would send an extra back and close her window)
  return listener(event, ...args);
});

app.whenReady().then(async () => {
  mkdirSync(plan.out, { recursive: true });
  const assets = new AssetRegistry();
  const model = await assets.register(plan.gene), stand = await assets.register(plan.stand);
  protocol.handle('mmd-asset', createAssetProtocolHandler({ resolve: url => assets.resolve(url), fetchFile: url => net.fetch(url) }));
  const wa = screen.getPrimaryDisplay().workArea;
  const small = new BrowserWindow({ width: 200, height: 260, frame: false, skipTaskbar: true, focusable: false, show: false });
  await small.loadURL('data:text/html,<body></body>');
  const page = { electronDir: plan.build, distDir: plan.build };
  const windows: BrowserWindow[] = [];
  const cards = [{ id: 'gene', name: 'Gene' }, { id: 'gene-2', name: 'Gene 二号', modelPath: plan.gene }, { id: 'gene-3', name: 'Gene 三号', modelPath: plan.gene }];
  const { host, stage } = buildUnboundStage({
    page,
    // no-pet-ok: the wiring's port names for the small window
    pet: () => small, petWanted: () => false, developerMode: () => true,
    source: () => ({ modelUrl: model.url, motion: { pose: stand.url, gesture: null, expression: null, legacy: false }, breath: 0.5, physics: null }),
    reviewed: async () => true, restPose: async () => stand.url, restored: () => {}, publish: () => {},
    company: companyPorts(() => ({ cards: { modelCards: () => cards, presetGeneId: async () => 'gene', publicState: () => ({ activeId: 'gene' }) },
      models: { bundledModel: async () => model, register: file => assets.register(file) } })),
    stage: { mood: () => ({ get: () => NEUTRAL, interaction: () => { throw new Error('no'); } }), peekMood: () => NEUTRAL as never, close: () => undefined, journal: () => {}, frames: (id, row) => { journalRows.push({ id, row }); } },
  }, {
    ipcMain: ipcMain as unknown as UnboundIpcMain, measure: () => readMonitorSizes(), display: primaryDisplayFacts,
    preview: { bounds: { x: wa.x + 40, y: wa.y + 40, width: plan.width, height: plan.height } },
    open: bounds => {
      const win = createUnboundWindow(bounds, page);
      windows.push(win);
      return { window: asUnboundWindow(win), loaded: loadUnboundPage(win, page, { probe: 'preview', perf: 'high', perfquiet: plan.quiet ? '1' : '0', pace: plan.pace ? '1' : '0' }) };
    },
  });
  const journalRows: { id: string | null; row: unknown }[] = [];
  const until = async (test: () => Promise<boolean> | boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(250); } return test(); };
  const probe = <T>(win: BrowserWindow, expression: string) => win.webContents.executeJavaScript(expression) as Promise<T>;
  const result: Record<string, unknown> = { label: plan.label, instances: plan.instances, pace: plan.pace, quiet: plan.quiet, window: [plan.width, plan.height], seconds: plan.seconds };
  let error: string | null = null;
  try {
    host.apply({ active: true });
    if (!await until(() => host.state === 'unbound', 90_000)) throw new Error('the first one did not come out');
    for (let i = 2; i <= plan.instances; i++) { await host.company.set(cards[i - 1]!.id, true); if (!await until(() => stage.present === i, 90_000)) throw new Error(`instance ${i} did not come out`); }
    const t0 = Date.now(); let lastPresent = stage.present;
    const paceLog = setInterval(async () => { const row: string[] = []; for (const win of windows) { if (win.isDestroyed()) continue; try { const v = await probe<{ pace: { idle: boolean; lowered: boolean }; focused: boolean } | null>(win, 'window.__unboundProbe.stage()'); row.push(v ? `${v.focused ? 'F' : '-'}${v.pace.idle ? 'i' : '-'}${v.pace.lowered ? 'L' : '-'}` : 'null'); } catch { row.push('x'); } } console.log(`[smooth] pace ${row.join(' ')} at +${Math.round((Date.now() - t0) / 100) / 10}s`); }, 2_000);
    const watch = setInterval(() => { if (stage.present !== lastPresent) { console.log(`[smooth] present ${lastPresent} -> ${stage.present} at +${Math.round((Date.now() - t0) / 100) / 10}s`); lastPresent = stage.present; } }, 250);
    await sleep(8_000); // first frames, bodies, the shared eye, the quiet rate (1.5 s of nothing moving) and the pixel tier settling
    const live = windows.filter(w => !w.isDestroyed());
    for (const win of live) await probe(win, 'window.__unboundProbe.perfDrain()').catch(() => null);
    const cpu: Record<string, number[]> = {};
    const gpuPid = app.getAppMetrics().find(m => m.type === 'GPU')?.pid ?? 0;
    // The GPU process's use of the graphics chip's 3D engine (Windows' own performance counter, one sample a second), taken in parallel.
    const engine = new Promise<number[]>(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$r = Get-Counter -Counter '\\GPU Engine(pid_${gpuPid}_*)\\Utilization Percentage' -SampleInterval 1 -MaxSamples ${plan.seconds}; $r | ForEach-Object { ($_.CounterSamples | Where-Object { $_.InstanceName -like '*engtype_3d*' } | Measure-Object CookedValue -Sum).Sum }`],
      { timeout: (plan.seconds + 30) * 1000 }, (_error, stdout) => resolve(String(stdout ?? '').split(/\r?\n/).map(line => Number(line.trim())).filter(v => Number.isFinite(v)))));
    const started = Date.now();
    while (Date.now() - started < plan.seconds * 1000) {
      await sleep(1_000);
      for (const m of app.getAppMetrics()) (cpu[m.type === 'Tab' ? `renderer-${m.pid}` : m.type] ??= []).push(m.cpu.percentCPUUsage);
    }
    const elapsed = (Date.now() - started) / 1000;
    const pages = [];
    for (const [index, win] of live.entries()) {
      const info = await probe<{ tier: string; pixelRatio: number; canvas: number[]; devicePixelRatio: number }>(win, 'window.__unboundProbe.perf()');
      const frames = await probe<{ ms: number; quiet: boolean }[]>(win, 'window.__unboundProbe.perfDrain()');
      const ms = frames.map(f => f.ms).filter(v => v < 250).sort((a, b) => a - b), at = (p: number) => ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)]! * 10) / 10 : null;
      pages.push({ window: index + 1, fps: Math.round(frames.length / elapsed * 10) / 10, p50: at(0.5), p95: at(0.95), p99: at(0.99), tier: info.tier, pixelRatio: info.pixelRatio, canvas: info.canvas });
    }
    const avg = (list: number[]) => list.length ? Math.round(list.reduce((s, v) => s + v, 0) / list.length * 10) / 10 : 0;
    const gpu = avg(cpu.GPU ?? []), renderers = Object.entries(cpu).filter(([k]) => k.startsWith('renderer-')).map(([, v]) => avg(v));
    const samples = await engine;
    result.gpu3dPercent = { samples: samples.length, mean: samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length * 10) / 10 : null, max: samples.length ? Math.round(Math.max(...samples) * 10) / 10 : null };
    result.pages = pages; result.cpuPercent = { gpuProcess: gpu, renderers, rendererSum: Math.round(renderers.reduce((s, v) => s + v, 0) * 10) / 10, browser: avg(cpu.Browser ?? []), total: Math.round((gpu + renderers.reduce((s, v) => s + v, 0) + avg(cpu.Browser ?? [])) * 10) / 10 };
    clearInterval(watch); clearInterval(paceLog);
    result.present = stage.present;
    result.gpuSwitch = plan.gpuSwitch;
    result.webglStatus = app.getGPUFeatureStatus().webgl;
    result.renderer = await probe<string | null>(live[0]!, `(() => { const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' }); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : null; })()`).catch(() => null);
    result.focus = MAIN_KEY;
    if (plan.poke) {
      // The one you are with changes: click the second one (the coordinator's own call, as the host's touch does); her page draws at full within a frame.
      stage.address(cards[1]!.id);
      await sleep(600);
      result.afterClick = [];
      for (const win of live) { await probe(win, 'window.__unboundProbe.perfDrain()').catch(() => null); }
      await sleep(3_000);
      for (const [index, win] of live.entries()) { const frames = await probe<{ ms: number }[]>(win, 'window.__unboundProbe.perfDrain()'); (result.afterClick as unknown[]).push({ window: index + 1, fps: Math.round(frames.length / 3 * 10) / 10 }); }
    }
  } catch (failure) { error = String((failure as Error)?.stack ?? failure); }
  result.error = error;
  writeFileSync(path.join(plan.out, `${plan.label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  host.exit(); await sleep(500); host.quit();
  app.exit(error ? 1 : 0);
});
