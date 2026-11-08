// Local pose-sensing smoke (I-001 stage 1). Real Electron, real utilityProcess, real onnxruntime-node + DirectML,
// but: no download (components are imported from files already on disk, verified against the built-in manifest),
// no real camera (Chromium's fake capture device), no pet or control window, a throw-away user-data dir.
//
//   pnpm build:app            (dist-electron/pose-worker.cjs, pose-sensor-preload.cjs, pose-sensor.html, pose-licenses/)
//   node scripts/pose-smoke-run.mjs --bench <dir with npm/node_modules and models/flat> --out <result.json>
//
// <bench> is the feasibility-test folder (onnxruntime-node 1.31.1 installed with npm, the two ONNX models).
import { app, MessageChannelMain, utilityProcess, BrowserWindow } from 'electron';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PoseComponentStore } from '../electron/pose/component-store';
import { createElectronPoseSensing } from '../electron/pose/electron-wiring';
import { posePlatform } from '../electron/pose/manifest';
import { syntheticFrame } from '../electron/pose/pipeline';
import { parseWorkerMessage } from '../electron/pose/protocol';
import type { PoseSensingView, PoseSignal } from '../shared/pose-signals';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const bench = arg('bench'), out = arg('out'), dist = arg('dist') ?? path.resolve('dist-electron');
if (!bench || !out) throw new Error('usage: --bench <dir> --out <file> [--dist <dist-electron>]');
// The runner passes --scratch and deletes it after Electron has exited (loaded DLLs keep files locked until then).
const scratch = arg('scratch') ?? mkdtempSync(path.join(tmpdir(), 'shp-smoke-'));
app.setPath('userData', path.join(scratch, 'user-data'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream'); // synthetic camera; the real one is never opened
const consoleLines: string[] = [];
app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event: any) => { if (consoleLines.length < 40) consoleLines.push(String(event.message ?? event)); }));
app.on('window-all-closed', () => { /* the sensor window closing must not end the smoke */ });
const result: Record<string, unknown> = { startedAt: new Date().toISOString(), electron: process.versions.electron, arch: process.arch };
const log = (stage: string) => { result.stage = stage; console.log('[pose-smoke]', stage); writeFileSync(out!, JSON.stringify(result, null, 2)); };
const pct = (values: number[], p: number) => { const s = [...values].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1))].toFixed(1); };

function benchFiles(): string[] {
  const nm = path.join(bench!, 'npm', 'node_modules');
  const files = [path.join(bench!, 'models', 'flat', 'det_rtmdet_nano.onnx'), path.join(bench!, 'models', 'flat', 'pose_rtmpose_m_256x192.onnx')];
  const node = path.join(nm, 'onnxruntime-node'), common = path.join(nm, 'onnxruntime-common');
  for (const f of readdirSync(path.join(node, 'dist'))) if (f.endsWith('.js')) files.push(path.join(node, 'dist', f));
  const bin = path.join(node, 'bin', 'napi-v6', 'win32', process.arch);
  for (const f of readdirSync(bin)) files.push(path.join(bin, f));
  for (const f of readdirSync(path.join(common, 'dist', 'cjs'))) if (f.endsWith('.js')) files.push(path.join(common, 'dist', 'cjs', f));
  return files;
}

/** Fork the real worker, wait for its self-test, then act as the sensor: 60 synthetic frames, one at a time. */
async function workerRun(store: PoseComponentStore, dmlBad: boolean) {
  const paths = store.runtimePaths()!;
  const child = utilityProcess.fork(path.join(dist, 'pose-worker.cjs'), [], { serviceName: 'pose smoke', stdio: 'ignore',
    env: { SystemRoot: process.env.SystemRoot ?? '', windir: process.env.windir ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '' } });
  const started = performance.now();
  const ready = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ready in 120 s')), 120_000);
    child.on('message', raw => { const m = parseWorkerMessage(raw); if (m?.type === 'ready' || m?.type === 'failed' || m?.type === 'paused') { clearTimeout(timer); resolve(m); } });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`worker exited ${code}`)); });
    child.postMessage({ type: 'init', runtimeEntry: paths.runtimeEntry, detector: paths.detector, detectorSha256: paths.detectorSha256,
      pose: paths.pose, poseSha256: paths.poseSha256, prefer: null, dmlBad });
  });
  const readyMs = performance.now() - started;
  if (ready.type !== 'ready') { child.kill(); return { ready, readyMs }; }
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: 'port' }, [port2]);
  const frame = syntheticFrame(320, 240);
  const times: number[] = [];
  const fps: number[] = [];
  let resolveAck: ((fps: number) => void) | null = null;
  port1.on('message', event => { const data = event.data as { type?: string; fps?: number }; if (data?.type === 'ack') { resolveAck?.(data.fps ?? 0); resolveAck = null; } });
  port1.start();
  for (let i = 0; i < 61; i++) {
    const t0 = performance.now();
    const ack = new Promise<number>(resolve => { resolveAck = resolve; });
    port1.postMessage({ type: 'frame', width: 320, height: 240, data: frame.buffer.slice(0) });
    fps.push(await ack);
    if (i > 0) times.push(performance.now() - t0);
  }
  child.postMessage({ type: 'stop' });
  await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000); });
  return { ready, readyMs: Math.round(readyMs), frameRoundTripMs: { n: times.length, p50: pct(times, 50), p90: pct(times, 90), max: pct(times, 100) }, requestedFps: [...new Set(fps)] };
}

app.whenReady().then(async () => {
  try {
    const platform = posePlatform();
    if (!platform) throw new Error('unsupported platform');
    const root = path.join(scratch, 'components');
    const store = new PoseComponentStore({ root, platform, fetch: () => { throw new Error('the smoke never downloads'); }, licenseDir: path.join(dist, 'pose-licenses') });
    const t0 = performance.now();
    const imported = await store.importFiles(benchFiles());
    result.import = { ...imported, ms: Math.round(performance.now() - t0), installed: store.installed };
    log('imported');
    if (!store.installed) throw new Error('import incomplete: the built-in hashes do not match the files');
    result.auto = await workerRun(store, false);
    log('auto done');
    result.cpu = await workerRun(store, true);
    log('cpu done');
    // Full path: host + supervisor + hidden sensor window (fake camera) + worker, switched on and off like the camera switch.
    const views: PoseSensingView['phase'][] = [];
    const signals: PoseSignal[] = [];
    let trays = 0, firstSignalAt = 0;
    const host = createElectronPoseSensing({ directory: dist, componentRoot: root, developerMode: () => true,
      publish: view => { if (views.at(-1) !== view.phase) views.push(view.phase); }, disableCamera: () => { result.disabled = true; },
      promptRaised: () => {}, trayChanged: () => { trays++; }, onSignal: signal => { if (!signals.length) firstSignalAt = performance.now(); signals.push(signal); } });
    await host.init();
    const on = { voiceInput: false, screenSharing: false, cameraSharing: true, cameraLocal: true, voiceOwner: null, cameraOwner: 'controls' as const };
    const startedAt = performance.now();
    host.syncCamera(on);
    log('camera on');
    while (performance.now() - startedAt < 45_000 && signals.length < 6) await new Promise(r => setTimeout(r, 200));
    const windowsWhileOn = BrowserWindow.getAllWindows().length;
    host.syncCamera({ ...on, cameraSharing: false, cameraLocal: undefined, cameraOwner: null });
    await new Promise(r => setTimeout(r, 2500));
    result.fullPath = { phases: views, firstSignalAfterMs: signals.length ? Math.round(firstSignalAt - startedAt) : null, signals: signals.length,
      signalKeys: signals[0] ? Object.keys(signals[0]) : [], lastSignal: signals.at(-1) ?? null, windowsWhileOn, windowsAfterOff: BrowserWindow.getAllWindows().length,
      trayChanges: trays, console: consoleLines, diagnostics: host.diagnostics(), view: host.view() };
    host.dispose();
  } catch (error) { result.error = String(error instanceof Error ? error.stack : error); }
  result.finishedAt = new Date().toISOString();
  writeFileSync(out, JSON.stringify(result, null, 2));
  setTimeout(() => { if (!arg('scratch')) try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ } app.exit(0); }, 1500);
});
